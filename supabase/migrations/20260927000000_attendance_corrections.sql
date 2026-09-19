begin;

-- Attendance corrections.
--
-- A punch could be created by a door and never touched again. Nothing could
-- add a missed punch, void a wrong one, or so much as LIST the individual
-- punches behind a report row -- so an operator could see that Tuesday was
-- wrong and had no way to find out which punch caused it, let alone fix it.
-- Payroll reads org_attendance_rows, so every one of those errors is a wrong
-- payment that stays wrong forever.
--
-- The fix is NOT an UPDATE on camera_attendance_events. That row is a
-- measurement a machine took, and rule 3's logic applies to it the way it
-- applies to a leaf count: a disputed month must still be able to say what
-- the camera actually saw. So corrections are a separate append-only ledger
-- that the report folds in, exactly like node_capabilities and
-- position_holders -- the correction is a new fact about an old fact, never
-- an edit of it.

-- =====================================================================================
-- 1. The capability
-- =====================================================================================
--
-- Deliberately its own capability rather than riding maintain_person_profile.
-- Correcting attendance moves money; fixing a phone number does not. Bundling
-- them would mean everyone who may tidy a contact detail may also add hours to
-- a payslip, which is the single highest-value fraud in this app.
insert into public.capability_types (key, sort_order, note)
select 'correct_attendance', 170,
       'Add a missed punch or void a wrong one for people at or below this node. Moves money: every correction is attributed and permanent'
 where not exists (select 1 from public.capability_types x where x.key = 'correct_attendance');

-- =====================================================================================
-- 2. The ledger
-- =====================================================================================
create table if not exists public.attendance_adjustments (
  id             bigserial primary key,
  person_id      uuid not null references public.persons(id) on delete restrict,
  org_node_id    uuid not null references public.org_nodes(id) on delete restrict,
  action         text not null check (action in ('add', 'void')),
  -- 'add' carries the punch it invents; 'void' carries the punch it cancels.
  kind           text check (kind in ('check_in', 'check_out')),
  at             timestamptz,
  voids_event_id uuid references public.camera_attendance_events(id) on delete restrict,
  reason         text not null check (length(btrim(reason)) between 3 and 500),
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  constraint attendance_adjustments_shape check (
    (action = 'add'  and kind is not null and at is not null and voids_event_id is null)
    or
    (action = 'void' and kind is null and at is null and voids_event_id is not null)
  )
);

-- One void per event: voiding twice is meaningless and would double-count in
-- any future "how many corrections" report.
create unique index if not exists attendance_adjustments_one_void_per_event
  on public.attendance_adjustments(voids_event_id)
  where voids_event_id is not null;

create index if not exists attendance_adjustments_person_idx
  on public.attendance_adjustments(person_id, at);

alter table public.attendance_adjustments enable row level security;

-- =====================================================================================
-- 3. Who may correct
-- =====================================================================================
create or replace function public.org_may_correct_attendance(p_person_id uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select coalesce(
    public.org_admin()
    or (p_person_id is not null
        and p_person_id <> public.org_current_person_id()
        and p_person_id = any (public.org_persons_seated_in(
              public.org_nodes_reached_with('correct_attendance')))),
    false);
$fn$;
revoke all on function public.org_may_correct_attendance(uuid) from public, anon;
grant execute on function public.org_may_correct_attendance(uuid) to authenticated;

-- Nobody corrects their own attendance, admin or not. That is the whole point
-- of a door: if the person whose hours are being counted can write the hours,
-- the camera was theatre. org_admin() is exempted from the reach test above,
-- never from this one.
create or replace function public.org_guard_attendance_adjustments()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_event_person uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'attendance adjustments are append-only; add a correcting row instead'
      using errcode = '42501';
  end if;

  if new.person_id = public.org_current_person_id() then
    raise exception 'you cannot correct your own attendance' using errcode = '42501';
  end if;

  if not public.org_may_correct_attendance(new.person_id) then
    raise exception 'you cannot correct attendance for that person' using errcode = '42501';
  end if;

  -- A void must name a punch that belongs to the person being corrected,
  -- or one row could cancel a punch of somebody else entirely.
  if new.action = 'void' then
    select ev.person_id into v_event_person
      from public.camera_attendance_events ev where ev.id = new.voids_event_id;
    if v_event_person is null then
      raise exception 'unknown attendance event' using errcode = '22023';
    end if;
    if v_event_person <> new.person_id then
      raise exception 'that punch belongs to somebody else' using errcode = '42501';
    end if;
  end if;

  -- An added punch may not be in the future: hours cannot be claimed in
  -- advance, and the report's pairing window would read it as an open shift.
  if new.action = 'add' and new.at > now() + interval '1 minute' then
    raise exception 'a punch cannot be added in the future' using errcode = '22023';
  end if;

  new.created_by := auth.uid();
  return new;
end $fn$;
revoke all on function public.org_guard_attendance_adjustments() from public, anon, authenticated;

drop trigger if exists org_guard_attendance_adjustments on public.attendance_adjustments;
create trigger org_guard_attendance_adjustments
  before insert or update or delete on public.attendance_adjustments
  for each row execute function public.org_guard_attendance_adjustments();

-- =====================================================================================
-- 4. RLS and grants
-- =====================================================================================
--
-- Readable by anyone who may already read this person's attendance, so a
-- correction is as visible as the number it changed -- a ledger only the
-- corrector can read is not a check on the corrector.
drop policy if exists attendance_adjustments_select on public.attendance_adjustments;
create policy attendance_adjustments_select on public.attendance_adjustments for select
  using (
    (select public.org_admin())
    or person_id = (select public.org_current_person_id())
    or (select public.org_capability_reaches('view_attendance_below', org_node_id))
  );

drop policy if exists attendance_adjustments_insert on public.attendance_adjustments;
create policy attendance_adjustments_insert on public.attendance_adjustments for insert
  with check ((select public.org_may_correct_attendance(person_id)));

-- No update, no delete: there is no policy for them and the guard refuses
-- them as well, so neither a forgotten policy nor a future one can open it.
grant select, insert on public.attendance_adjustments to authenticated;
grant usage, select on sequence public.attendance_adjustments_id_seq to authenticated;

commit;

begin;

-- =====================================================================================
-- 5. Reading a person's punches
-- =====================================================================================
--
-- org_nodes_reached_with() is seat-based and knows nothing about a sysadmin,
-- so every gate in this file pairs it with org_admin() the way
-- org_attendance_report already does. A sysadmin holds no seat and would
-- otherwise be refused by their own database.
--
-- Nothing here widens camera_attendance_events: rule 1 stands, the table still
-- has no SELECT policy and no device can read a thing. These are definer RPCs
-- gated on a human's capability, exactly like org_attendance_rows.
create or replace function public.org_attendance_punches(
  p_node uuid, p_since timestamptz, p_until timestamptz)
returns table (
  event_id uuid,
  adjustment_id bigint,
  person_id uuid,
  full_name text,
  employee_code text,
  kind text,
  at timestamptz,
  source text,
  reason text)
language plpgsql stable security definer set search_path = public as $fn$
declare
  -- Held in a variable, not a CTE: a parenthesised SELECT as the operand of
  -- ANY() is read as the SUBQUERY form, so `uuid = any ((select ids ...))`
  -- compares uuid to uuid[] and fails to parse.
  v_ids uuid[];
begin
  if not (public.org_admin() or public.org_capability_reaches('view_attendance_below', p_node)) then
    raise exception 'you cannot view attendance at this node' using errcode = '42501';
  end if;
  if p_until < p_since then
    raise exception 'p_until must not be before p_since' using errcode = '22023';
  end if;
  if p_until - p_since > interval '62 days' then
    raise exception 'a punch list covers at most 62 days at a time' using errcode = '22023';
  end if;
  v_ids := public.org_persons_seated_in_during(
              public.org_subtree_ids(array[p_node]), p_since, p_until);

  return query
    select ev.id, null::bigint, ev.person_id, pe.full_name, pe.employee_code,
           ev.kind, ev.captured_at, 'camera'::text, null::text
      from public.camera_attendance_events ev
      join public.persons pe on pe.id = ev.person_id
     where ev.captured_at >= p_since and ev.captured_at < p_until
       and ev.person_id = any (v_ids)
       and not exists (select 1 from public.attendance_adjustments a
                        where a.voids_event_id = ev.id)
    union all
    select null::uuid, a.id, a.person_id, pe.full_name, pe.employee_code,
           a.kind, a.at, 'added'::text, a.reason
      from public.attendance_adjustments a
      join public.persons pe on pe.id = a.person_id
     where a.action = 'add'
       and a.at >= p_since and a.at < p_until
       and a.person_id = any (v_ids)
     order by 3, 7;
end $fn$;
revoke all on function public.org_attendance_punches(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.org_attendance_punches(uuid, timestamptz, timestamptz) to authenticated;

-- The voided punches, so a correction is reviewable rather than a silent
-- disappearance: a reader can see the punch WAS there and who cancelled it.
create or replace function public.org_attendance_voided(
  p_node uuid, p_since timestamptz, p_until timestamptz)
returns table (
  event_id uuid,
  person_id uuid,
  full_name text,
  kind text,
  at timestamptz,
  reason text,
  voided_at timestamptz,
  voided_by uuid)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not (public.org_admin() or public.org_capability_reaches('view_attendance_below', p_node)) then
    raise exception 'you cannot view attendance at this node' using errcode = '42501';
  end if;
  return query
    select ev.id, ev.person_id, pe.full_name, ev.kind, ev.captured_at,
           a.reason, a.created_at, a.created_by
      from public.attendance_adjustments a
      join public.camera_attendance_events ev on ev.id = a.voids_event_id
      join public.persons pe on pe.id = ev.person_id
     where a.action = 'void'
       and ev.captured_at >= p_since and ev.captured_at < p_until
       and ev.person_id = any (public.org_persons_seated_in(
             public.org_subtree_ids(array[p_node])))
     order by ev.captured_at desc;
end $fn$;
revoke all on function public.org_attendance_voided(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.org_attendance_voided(uuid, timestamptz, timestamptz) to authenticated;

commit;

begin;

-- =====================================================================================
-- 6. The report, now reading corrected punches
-- =====================================================================================
--
-- The row gains a `corrected` flag, so the return type changes and CREATE OR
-- REPLACE cannot do it -- both functions are dropped and rebuilt. They must
-- move together: org_attendance_export declares its own 11-column RETURNS
-- TABLE and does `return query select * from org_attendance_rows(...)`, so
-- adding a column to one without the other fails at runtime with "structure of
-- query does not match function result type". org_attendance_report is jsonb
-- via to_jsonb() and simply gains the field.
--
-- WHICH punches are counted is all that changes. The window functions, the
-- 16-hour pairing cap and the Asia/Ho_Chi_Minh day boundary are carried over
-- from 20260924040000 unchanged, because HOW they are counted is still right.
drop function if exists public.org_attendance_export(uuid, timestamptz, timestamptz);
drop function if exists public.org_attendance_rows(uuid, timestamptz, timestamptz);

-- Carried over verbatim from 20260924040000 -- the 16-hour edge window, the
-- in_range filter, org_persons_seated_in_during(), is_open_in and on_site all
-- stay exactly as the hardening left them. The ONE change is the source: a
-- `punches` CTE of corrected punches instead of camera_attendance_events
-- directly. Rebuilding this from the pre-hardening version would have
-- resurrected every bug that migration fixed -- a night shift across the range
-- edge reading as two missing punches, and on_site vanishing from the row.
create function public.org_attendance_rows(
  p_node uuid,
  p_since timestamptz,
  p_until timestamptz)
returns table (
  person_id uuid,
  full_name text,
  employee_code text,
  day date,
  first_in timestamptz,
  last_out timestamptz,
  seconds_on_site bigint,
  check_ins int,
  check_outs int,
  unpaired_ins int,
  unpaired_outs int,
  on_site boolean,
  corrected boolean)
language sql stable security definer set search_path = public as $fn$
  with punches as (
    select ev.id::text as src_id, ev.person_id, ev.kind, ev.captured_at
      from public.camera_attendance_events ev
     where ev.captured_at >= p_since - interval '16 hours'
       and ev.captured_at < p_until + interval '16 hours'
       and ev.person_id = any (public.org_persons_seated_in_during(
             public.org_subtree_ids(array[p_node]), p_since, p_until))
       and not exists (select 1 from public.attendance_adjustments a
                        where a.voids_event_id = ev.id)
    union all
    -- An added punch joins the same window, so a correction can close a night
    -- shift that straddles the range edge exactly like a real punch would.
    select 'adj-' || a.id::text, a.person_id, a.kind, a.at
      from public.attendance_adjustments a
     where a.action = 'add'
       and a.at >= p_since - interval '16 hours'
       and a.at < p_until + interval '16 hours'
       and a.person_id = any (public.org_persons_seated_in_during(
             public.org_subtree_ids(array[p_node]), p_since, p_until))
  ), ordered as (
    select p.person_id, p.kind, p.captured_at,
           p.captured_at >= p_since and p.captured_at < p_until as in_range,
           (p.captured_at at time zone 'Asia/Ho_Chi_Minh')::date as day,
           lead(p.kind) over w as next_kind,
           lead(p.captured_at) over w as next_at,
           lag(p.kind) over w as prev_kind,
           lag(p.captured_at) over w as prev_at
      from punches p
    window w as (partition by p.person_id order by p.captured_at, p.src_id)
  ), scoped as (
    select o.*,
           o.kind = 'check_in' and o.next_kind = 'check_out'
             and o.next_at - o.captured_at <= interval '16 hours' as is_paired_in,
           o.kind = 'check_out' and o.prev_kind = 'check_in'
             and o.captured_at - o.prev_at <= interval '16 hours' as is_paired_out,
           o.kind = 'check_in' and o.next_kind is null
             and now() - o.captured_at < interval '16 hours' as is_open_in
      from ordered o
     where o.in_range
  ), adjusted_days as (
    -- Every day a correction touched, whichever direction. An added punch
    -- dates itself; a voided one is dated by the punch it cancelled, which is
    -- no longer in `punches` at all -- so a flag derived from the counted rows
    -- could never see a void, and a voided day would report machine-clean
    -- numbers that a human had changed.
    select a.person_id,
           (coalesce(a.at, ev.captured_at) at time zone 'Asia/Ho_Chi_Minh')::date as day
      from public.attendance_adjustments a
      left join public.camera_attendance_events ev on ev.id = a.voids_event_id
     where a.person_id = any (public.org_persons_seated_in_during(
             public.org_subtree_ids(array[p_node]), p_since, p_until))
       and coalesce(a.at, ev.captured_at) >= p_since
       and coalesce(a.at, ev.captured_at) < p_until
  )
  select s.person_id,
         pe.full_name,
         pe.employee_code,
         s.day,
         min(s.captured_at) filter (where s.kind = 'check_in')  as first_in,
         max(s.captured_at) filter (where s.kind = 'check_out') as last_out,
         coalesce(sum(extract(epoch from (s.next_at - s.captured_at))) filter (where s.is_paired_in), 0)::bigint as seconds_on_site,
         count(*) filter (where s.kind = 'check_in')::int  as check_ins,
         count(*) filter (where s.kind = 'check_out')::int as check_outs,
         count(*) filter (where s.kind = 'check_in' and not s.is_paired_in and not s.is_open_in)::int as unpaired_ins,
         count(*) filter (where s.kind = 'check_out' and not s.is_paired_out)::int as unpaired_outs,
         bool_or(s.is_open_in) as on_site,
         exists (select 1 from adjusted_days d
                  where d.person_id = s.person_id and d.day = s.day) as corrected
    from scoped s
    join public.persons pe on pe.id = s.person_id
   group by s.person_id, pe.full_name, pe.employee_code, s.day
   order by s.day desc, pe.full_name;
$fn$;
revoke all on function public.org_attendance_rows(uuid, timestamptz, timestamptz) from public, anon, authenticated;

create function public.org_attendance_export(
  p_node uuid,
  p_since timestamptz,
  p_until timestamptz)
returns table (
  person_id uuid,
  full_name text,
  employee_code text,
  day date,
  first_in timestamptz,
  last_out timestamptz,
  seconds_on_site bigint,
  check_ins int,
  check_outs int,
  unpaired_ins int,
  unpaired_outs int,
  on_site boolean,
  corrected boolean)
language plpgsql security definer set search_path = public as $fn$
begin
  if not (public.org_admin() or public.org_capability_reaches('view_attendance_below', p_node)) then
    raise exception 'you cannot view attendance at this node' using errcode = '42501';
  end if;
  if p_until < p_since then
    raise exception 'p_until must not be before p_since' using errcode = '22023';
  end if;
  if p_until - p_since > interval '62 days' then
    raise exception 'an export covers at most 62 days at a time' using errcode = '22023';
  end if;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action, after_json)
    values (auth.uid(), 'attendance_export', p_node::text, p_node, 'data_exported',
      jsonb_build_object('since', p_since, 'until', p_until));

  return query select * from public.org_attendance_rows(p_node, p_since, p_until);
end $fn$;
revoke all on function public.org_attendance_export(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.org_attendance_export(uuid, timestamptz, timestamptz) to authenticated;

commit;
