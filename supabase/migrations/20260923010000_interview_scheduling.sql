-- Interview scheduling: the poster adds however many time-ranges they want
-- per posting, and a candidate who has reached the interview stage picks one
-- themselves from what's open -- self-service booking, same anonymous-write
-- posture as org_apply() (no account, rate-limited, fails closed).
--
-- One list of slots per POSTING, not per candidate: the owner said "as many
-- as they want", and a shared pool is what scales -- ten candidates draw from
-- the same calendar instead of the admin hand-building ten private lists.

begin;

create table if not exists public.interview_slots (
  id uuid primary key default gen_random_uuid(),
  posting_id uuid not null references public.job_postings(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at   timestamptz not null check (ends_at > starts_at),
  -- How many candidates one slot can hold -- a group-interview block, or 1
  -- for a private one-on-one. Booked count is counted live from
  -- applications.interview_slot_id, never stored, so it can't drift.
  capacity int not null default 1 check (capacity > 0),
  created_at timestamptz not null default now()
);
create index if not exists interview_slots_posting_idx
  on public.interview_slots (posting_id, starts_at);

alter table public.applications
  add column if not exists interview_slot_id uuid references public.interview_slots(id) on delete set null;
create index if not exists applications_interview_slot_idx
  on public.applications (interview_slot_id);

commit;

begin;

-- No client writes this table directly -- every write goes through
-- org_add_interview_slots() or org_book_interview_slot(), same posture as
-- job_postings/applications.
alter table public.interview_slots enable row level security;
revoke all on public.interview_slots from anon, authenticated;

commit;

begin;

-- The poster's side: add N slots at once. org_admin()-gated like every other
-- job_postings write.
drop function if exists public.org_add_interview_slots(uuid, jsonb);
create or replace function public.org_add_interview_slots(p_posting uuid, p_slots jsonb)
returns setof uuid
language plpgsql security definer set search_path = public as $$
declare
  v_slot jsonb;
  v_id uuid;
begin
  if not public.org_admin() then
    raise exception 'only org_admin can add interview slots' using errcode = '42501';
  end if;
  if not exists (select 1 from public.job_postings where id = p_posting) then
    raise exception 'no such posting' using errcode = '22023';
  end if;
  for v_slot in select * from jsonb_array_elements(p_slots) loop
    insert into public.interview_slots (posting_id, starts_at, ends_at, capacity)
    values (
      p_posting,
      (v_slot->>'starts_at')::timestamptz,
      (v_slot->>'ends_at')::timestamptz,
      coalesce((v_slot->>'capacity')::int, 1))
    returning id into v_id;
    return next v_id;
  end loop;
end $$;

-- The admin management view: every slot for a posting, booked or not, with
-- who's booked into each (org_admin-only -- carries applicant names).
drop function if exists public.org_admin_interview_slots(uuid);
create or replace function public.org_admin_interview_slots(p_posting uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.org_admin() then '[]'::jsonb else coalesce(
    (select jsonb_agg(jsonb_build_object(
       'id', s.id, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
       'capacity', s.capacity,
       'booked', coalesce((
         select jsonb_agg(jsonb_build_object('application_id', a.id, 'full_name', a.full_name))
           from public.applications a where a.interview_slot_id = s.id), '[]'::jsonb))
       order by s.starts_at)
       from public.interview_slots s where s.posting_id = p_posting), '[]'::jsonb) end;
$$;

commit;

begin;

-- The candidate's side: no account, so the application id already in their
-- browser (returned by org_apply(), same as the CV-upload gate uses it) is
-- the capability token. Only offered once they're actually at the interview
-- stage -- a fresh 'submitted' application enumerating posting ids learns
-- nothing about anyone's calendar.
drop function if exists public.org_interview_slots_for_application(uuid);
create or replace function public.org_interview_slots_for_application(p_application uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object(
       'id', open_slot.id, 'starts_at', open_slot.starts_at,
       'ends_at', open_slot.ends_at, 'remaining', open_slot.remaining)
       order by open_slot.starts_at)
       from (
         select s.id, s.starts_at, s.ends_at,
                s.capacity - (select count(*) from public.applications b
                               where b.interview_slot_id = s.id) as remaining
           from public.applications a
           join public.interview_slots s on s.posting_id = a.posting_id
          where a.id = p_application
            and a.state in ('tested', 'interviewing')
            and s.starts_at > now()
       ) open_slot
      where open_slot.remaining > 0
    ), '[]'::jsonb);
$$;

-- The booking write. Rate-limited by the same caller-fingerprint bucket
-- org_apply() uses -- a slot-booking endpoint with no login is exactly the
-- kind of attack surface that rule requires capping.
drop function if exists public.org_book_interview_slot(uuid, uuid);
create or replace function public.org_book_interview_slot(p_application uuid, p_slot uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_state text;
  v_posting uuid;
  v_slot_posting uuid;
  v_capacity int;
  v_booked int;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_fingerprint text;
  v_recent int;
begin
  select state, posting_id into v_state, v_posting from public.applications where id = p_application;
  if v_state is null then
    raise exception 'no such application' using errcode = '22023';
  end if;
  if v_state not in ('tested', 'interviewing') then
    raise exception 'this application is not at the interview stage' using errcode = '22023';
  end if;

  select posting_id, capacity, starts_at, ends_at into v_slot_posting, v_capacity, v_starts_at, v_ends_at
    from public.interview_slots where id = p_slot;
  if v_slot_posting is null or v_slot_posting <> v_posting then
    raise exception 'that slot is not for this posting' using errcode = '22023';
  end if;
  if v_starts_at <= now() then
    raise exception 'that slot has already passed' using errcode = '22023';
  end if;

  -- Same anonymous-endpoint rate limit org_apply() uses -- caps how many
  -- booking attempts one address can make in an hour, not how many
  -- applications exist (that cap is org_apply()'s own).
  v_fingerprint := public.org_caller_fingerprint();
  if v_fingerprint is null then
    v_fingerprint := '(no-forwarded-for)';
  end if;
  select count(*) into v_recent from public.application_attempts
   where fingerprint = v_fingerprint and at > now() - interval '1 hour';
  if v_recent >= 20 then
    raise exception 'too many attempts from here in the last hour -- try again later'
      using errcode = '53400';
  end if;
  insert into public.application_attempts (fingerprint) values (v_fingerprint);

  select count(*) into v_booked from public.applications where interview_slot_id = p_slot;
  if v_booked >= v_capacity then
    raise exception 'that slot is full' using errcode = '23505';
  end if;

  perform set_config('app.application_write', '1', true);
  update public.applications
     set interview_slot_id = p_slot,
         state = case when state = 'tested' then 'interviewing' else state end
   where id = p_application;
  perform set_config('app.application_write', '', true);

  return jsonb_build_object('starts_at', v_starts_at, 'ends_at', v_ends_at);
end $$;

commit;

begin;

revoke all on function public.org_add_interview_slots(uuid, jsonb) from public, anon;
grant execute on function public.org_add_interview_slots(uuid, jsonb) to authenticated;
revoke all on function public.org_admin_interview_slots(uuid) from public, anon;
grant execute on function public.org_admin_interview_slots(uuid) to authenticated;
revoke all on function public.org_interview_slots_for_application(uuid) from public;
grant execute on function public.org_interview_slots_for_application(uuid) to anon, authenticated;
revoke all on function public.org_book_interview_slot(uuid, uuid) from public;
grant execute on function public.org_book_interview_slot(uuid, uuid) to anon, authenticated;

commit;
