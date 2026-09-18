-- Work: assigned down, submitted up, handed sideways, accepted or bounced.
--
-- This is the feature the capability vocabulary was written for. Until now
-- assign_work_down, accept_or_reject_submission, hand_across_to_peer and
-- set_deadline_and_weight were words with nothing behind them; from here they
-- decide what a seat may actually do.
--
-- THE RULES COME FROM THE ORG DOCUMENT, NOT FROM TASTE:
--
--   ±1 (Mục XIII) -- "chỉ trao đổi công việc, báo cáo, giao việc lên một bậc,
--   xuống một bậc và ngang bậc ... không vượt cấp trong mọi trường hợp."
--   After rút bậc, "one band down" is exactly "my direct reports", because the
--   rút bậc rule already collapsed absent bands into direct reporting edges.
--   So assignment goes to a DIRECT REPORT and nowhere else: a Tổng Giám đốc
--   cannot hand work to a Quản đốc, they hand it to the Giám đốc Khối.
--
--   Ngang bậc / cửa vào -- a peer is any seat at the same band, in ANY khối.
--   Handing sideways is therefore NOT a subtree question, and the check is
--   "do I hold the capability at all", not "does it reach that node".
--
-- WORK IS ASSIGNED TO A SEAT, NEVER TO A PERSON. A task outlives whoever is in
-- the chair; a vacant seat can hold work waiting for a hire. "Who did it" is
-- the event log crossed with the seating record, which is why task_events
-- carries the acting person as a fact rather than tasks carrying a copy.
--
-- WEIGHT AND DEADLINE ARE FIXED AT ASSIGNMENT. A deadline you can move and a
-- weight you can raise afterwards measure nothing, and step 7 derives
-- evaluation from this record.
--
-- RE-RUNNABLE: create table/index if not exists, create or replace function,
-- drop trigger if exists before create.

begin;

-- 1. The two tables -----------------------------------------------------------

create table if not exists public.tasks (
  id                      uuid primary key default gen_random_uuid(),
  title                   text not null check (length(btrim(title)) > 0),
  detail                  text,
  assigned_by_position_id uuid not null references public.positions(id) on delete restrict,
  -- The seat that owns the work NOW. A projection of task_events, maintained by
  -- trigger: handing across moves it, and nothing else does.
  assigned_to_position_id uuid not null references public.positions(id) on delete restrict,
  weight                  numeric(8,2) not null default 1 check (weight > 0),
  due_at                  timestamptz,
  -- Also a projection of task_events. Kept here because every list screen
  -- filters on it and deriving it per row per query is the N+1 this model has
  -- already been bitten by once.
  state                   text not null default 'open'
                            check (state in ('open','submitted','done','cancelled')),
  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users(id) on delete set null
);

comment on column public.tasks.assigned_to_position_id is
  'Projection of task_events. Do not write directly; insert a handed_across event.';
comment on column public.tasks.state is
  'Projection of task_events. Do not write directly; insert the event that causes the transition.';

-- Append-only, like position_holders and node_capabilities. The newest event is
-- what is true now; everything under it is what happened, which is the question
-- evaluation will ask.
create table if not exists public.task_events (
  id              bigint generated always as identity primary key,
  task_id         uuid not null references public.tasks(id) on delete restrict,
  kind            text not null check (kind in
                    ('assigned','submitted','accepted','rejected','handed_across','cancelled')),
  by_position_id  uuid references public.positions(id) on delete restrict,
  by_person_id    uuid references public.persons(id) on delete restrict,
  to_position_id  uuid references public.positions(id) on delete restrict,
  note            text,
  at              timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null
);

create index if not exists tasks_assigned_to_idx on public.tasks (assigned_to_position_id) where state <> 'done';
create index if not exists tasks_assigned_by_idx on public.tasks (assigned_by_position_id) where state <> 'done';
create index if not exists tasks_state_idx       on public.tasks (state);
create index if not exists task_events_task_idx  on public.task_events (task_id, at desc, id desc);

alter table public.tasks       enable row level security;
alter table public.task_events enable row level security;

-- 2. Helper: do I hold this capability anywhere? -------------------------------
-- org_capability_reaches() asks "does my grant cover THAT node", which is the
-- right question for work going down and the wrong one for work going sideways:
-- a peer in another khối is not in my subtree, and the document says the door
-- into another khối is your own band. This asks the other question.
create or replace function public.org_holds(p_key text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from unnest(public.org_my_seat_node_ids()) s(id)
     where public.org_node_has_capability(s.id, p_key));
$$;

-- Does a seat I hold sit directly above this one? This is the ±1 test.
create or replace function public.org_is_my_direct_report(p_position uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.positions p
     where p.id = p_position
       and p.abolished_at is null
       and p.reports_to_position_id = any (
             public.org_positions_held_by(public.org_current_person_id())));
$$;

create or replace function public.org_position_node(p_position uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select node_id from public.positions where id = p_position;
$$;

-- 3. The projection ------------------------------------------------------------
-- task_events is the truth; tasks.state and tasks.assigned_to_position_id are
-- rebuilt from it by this trigger and by nothing else. A human never keeps them
-- in sync, so they cannot drift.
create or replace function public.task_project_state()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_state text;
begin
  v_state := case new.kind
    when 'assigned'      then 'open'
    when 'submitted'     then 'submitted'
    when 'accepted'      then 'done'
    when 'rejected'      then 'open'
    when 'handed_across' then 'open'
    when 'cancelled'     then 'cancelled'
  end;

  perform set_config('app.task_projection', '1', true);
  update public.tasks t
     set state = v_state,
         assigned_to_position_id =
           coalesce(case when new.kind = 'handed_across' then new.to_position_id end,
                    t.assigned_to_position_id)
   where t.id = new.task_id;
  perform set_config('app.task_projection', '0', true);
  return new;
end $$;

-- 4. Authority -----------------------------------------------------------------
-- In BEFORE triggers, not only in policies: every write below arrives through a
-- SECURITY DEFINER RPC, which bypasses RLS entirely. A rule that lives only in a
-- policy is not enforced on the path this feature actually uses.

create or replace function public.org_guard_tasks()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_to_node uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'tasks are never deleted; cancel it instead' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    -- The projection trigger is the only writer. Everything else is refused,
    -- including a well-meaning UPDATE that would quietly rewrite a deadline.
    -- coalesce is load-bearing: current_setting(..., true) returns NULL when the
    -- setting was never set, and NULL <> '1' is NULL, not true -- so the bare
    -- comparison silently lets every direct write through.
    if coalesce(current_setting('app.task_projection', true), '') <> '1' then
      raise exception 'a task is changed by inserting an event, not by updating it'
        using errcode = '42501';
    end if;
    if new.id is distinct from old.id
       or new.title is distinct from old.title
       or new.detail is distinct from old.detail
       or new.weight is distinct from old.weight
       or new.due_at is distinct from old.due_at
       or new.assigned_by_position_id is distinct from old.assigned_by_position_id
       or new.created_at is distinct from old.created_at then
      raise exception 'weight, deadline and the assigning seat are fixed at assignment'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- INSERT.
  new.created_at := now();
  new.created_by := auth.uid();
  new.state := 'open';

  if not exists (select 1 from public.positions p
                  where p.id = new.assigned_to_position_id and p.abolished_at is null) then
    raise exception 'that seat does not exist or has been abolished' using errcode = '22023';
  end if;
  v_to_node := public.org_position_node(new.assigned_to_position_id);

  if auth.uid() is null or public.org_admin() then
    return new;
  end if;

  if not (new.assigned_by_position_id = any (
            public.org_positions_held_by(public.org_current_person_id()))) then
    raise exception 'you can only assign work from a seat you hold' using errcode = '42501';
  end if;

  -- ±1 down. A seat may also give work to itself; that is a note, not a skip.
  if new.assigned_to_position_id <> new.assigned_by_position_id
     and not public.org_is_my_direct_report(new.assigned_to_position_id) then
    raise exception
      'work goes to a direct report. Give it to the seat between you and them instead'
      using errcode = '42501';
  end if;

  if not public.org_capability_reaches('assign_work_down', v_to_node) then
    raise exception 'you cannot assign work into that node' using errcode = '42501';
  end if;

  if (new.due_at is not null or new.weight <> 1)
     and not public.org_capability_reaches('set_deadline_and_weight', v_to_node) then
    raise exception 'you cannot put a deadline or a weight on work in that node'
      using errcode = '42501';
  end if;

  return new;
end $$;

create or replace function public.org_guard_task_events()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t            public.tasks%rowtype;
  v_me         uuid;
  v_my_seats   uuid[];
  v_to_rank    numeric;
  v_from_rank  numeric;
begin
  if tg_op in ('UPDATE','DELETE') then
    raise exception 'task_events is append-only' using errcode = '42501';
  end if;

  select * into t from public.tasks where id = new.task_id;
  if t.id is null then
    raise exception 'unknown task' using errcode = '22023';
  end if;

  v_me := public.org_current_person_id();
  new.at := now();
  new.created_by := auth.uid();
  new.by_person_id := coalesce(new.by_person_id, v_me);

  -- Coherence, for everyone including the sysadmin: a state machine that can be
  -- stepped sideways by a privileged caller is not a state machine.
  if new.kind = 'submitted' and t.state <> 'open' then
    raise exception 'only open work can be submitted (this is %)', t.state using errcode = '22023';
  end if;
  if new.kind in ('accepted','rejected') and t.state <> 'submitted' then
    raise exception 'only submitted work can be accepted or bounced (this is %)', t.state
      using errcode = '22023';
  end if;
  if new.kind in ('handed_across','cancelled') and t.state in ('done','cancelled') then
    raise exception 'this work is already %', t.state using errcode = '22023';
  end if;
  if new.kind = 'handed_across' then
    if new.to_position_id is null then
      raise exception 'hand it across to which seat?' using errcode = '22023';
    end if;
    if new.to_position_id = t.assigned_to_position_id then
      raise exception 'that is the seat that already holds it' using errcode = '22023';
    end if;
    select r.ordinal into v_to_rank from public.positions p
      join public.ranks r on r.id = p.rank_id
     where p.id = new.to_position_id and p.abolished_at is null;
    select r.ordinal into v_from_rank from public.positions p
      join public.ranks r on r.id = p.rank_id
     where p.id = t.assigned_to_position_id;
    if v_to_rank is null then
      raise exception 'that seat does not exist or has been abolished' using errcode = '22023';
    end if;
    if v_to_rank <> v_from_rank then
      raise exception 'sideways means the same band; that seat is not a peer'
        using errcode = '22023';
    end if;
  end if;

  -- The opening event is written by the trigger on tasks, for every task, so no
  -- caller can forget it -- and no caller may forge it either.
  if new.kind = 'assigned' then
    if coalesce(current_setting('app.task_system_event', true), '') <> '1' then
      raise exception 'the assignment event is written by the system' using errcode = '42501';
    end if;
    return new;
  end if;

  if auth.uid() is null or public.org_admin() then
    return new;
  end if;

  v_my_seats := public.org_positions_held_by(v_me);

  if new.kind in ('submitted','handed_across') then
    if not (t.assigned_to_position_id = any (v_my_seats)) then
      raise exception 'that is not your work' using errcode = '42501';
    end if;
    if new.kind = 'handed_across' and not public.org_holds('hand_across_to_peer') then
      raise exception 'you cannot hand work sideways' using errcode = '42501';
    end if;
  elsif new.kind in ('accepted','rejected','cancelled') then
    if not (t.assigned_by_position_id = any (v_my_seats)) then
      raise exception 'only the seat that assigned this can close it' using errcode = '42501';
    end if;
    if new.kind in ('accepted','rejected')
       and not public.org_capability_reaches('accept_or_reject_submission',
                                             public.org_position_node(t.assigned_to_position_id)) then
      raise exception 'you cannot accept or bounce work in that node' using errcode = '42501';
    end if;
  end if;

  new.by_position_id := coalesce(new.by_position_id,
    case when new.kind in ('submitted','handed_across')
         then t.assigned_to_position_id else t.assigned_by_position_id end);
  return new;
end $$;

-- Every task's own first event, written for it so no caller can forget.
create or replace function public.task_write_assigned_event()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.task_system_event', '1', true);
  insert into public.task_events (task_id, kind, by_position_id, by_person_id, note)
  values (new.id, 'assigned', new.assigned_by_position_id,
          public.org_current_person_id(), null);
  perform set_config('app.task_system_event', '0', true);
  return new;
end $$;

drop trigger if exists org_guard_tasks        on public.tasks;
create trigger org_guard_tasks        before insert or update or delete on public.tasks
  for each row execute function public.org_guard_tasks();

drop trigger if exists org_guard_task_events  on public.task_events;
create trigger org_guard_task_events  before insert or update or delete on public.task_events
  for each row execute function public.org_guard_task_events();

drop trigger if exists task_project_state     on public.task_events;
create trigger task_project_state     after insert on public.task_events
  for each row execute function public.task_project_state();

drop trigger if exists task_write_assigned    on public.tasks;
create trigger task_write_assigned    after insert on public.tasks
  for each row execute function public.task_write_assigned_event();

commit;

begin;

-- 5. Who may see what ----------------------------------------------------------
-- Three ways to see a task: it is yours, you gave it, or you may see the
-- workload of the node it sits in. Nothing else, so a peer in another khối
-- cannot browse your work list.
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
using (
  (select public.org_admin())
  or assigned_to_position_id = any (
       public.org_positions_held_by((select public.org_current_person_id())))
  or assigned_by_position_id = any (
       public.org_positions_held_by((select public.org_current_person_id())))
  -- The reach is computed ONCE, as an InitPlan, not once per row. Written as
  -- org_capability_reaches(key, org_position_node(assigned_to_position_id)) the
  -- argument varies per row, so Postgres re-walks the subtree for every task the
  -- reader does not already own -- and `grant select` puts that scan one REST
  -- call away from any signed-in browser.
  -- `any ((select ...))` would be the SET form of ANY and compare a uuid against
  -- a uuid[]. coalesce() keeps the subquery an ARRAY expression, which is the
  -- form that means "is this value one of these", and still runs once.
  or assigned_to_position_id = any (coalesce((
       select array_agg(p.id)
         from public.positions p
        where p.node_id = any (
              public.org_nodes_reached_with('view_subtree_workload'))), '{}'::uuid[]))
);

drop policy if exists task_events_select on public.task_events;
create policy task_events_select on public.task_events for select to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id));

-- Read-only to the browser. Every write goes through the RPCs below, which is
-- what keeps the ±1 rule in one place instead of duplicated in the client.
grant select on public.tasks       to authenticated;
grant select on public.task_events to authenticated;

-- 6. The six things you can do -------------------------------------------------

create or replace function public.org_assign_task(
  p_from_position uuid,
  p_to_position   uuid,
  p_title         text,
  p_detail        text default null,
  p_weight        numeric default 1,
  p_due_at        timestamptz default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.tasks (title, detail, assigned_by_position_id,
                            assigned_to_position_id, weight, due_at)
  values (btrim(p_title), nullif(btrim(coalesce(p_detail,'')),''), p_from_position,
          p_to_position, coalesce(p_weight,1), p_due_at)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.org_submit_task(p_task uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.task_events (task_id, kind, note)
  values (p_task, 'submitted', nullif(btrim(coalesce(p_note,'')),''));
end $$;

create or replace function public.org_accept_task(p_task uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.task_events (task_id, kind, note)
  values (p_task, 'accepted', nullif(btrim(coalesce(p_note,'')),''));
end $$;

create or replace function public.org_reject_task(p_task uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if nullif(btrim(coalesce(p_note,'')),'') is null then
    raise exception 'say why you are bouncing it' using errcode = '22023';
  end if;
  insert into public.task_events (task_id, kind, note)
  values (p_task, 'rejected', btrim(p_note));
end $$;

create or replace function public.org_hand_task_across(
  p_task uuid, p_to_position uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.task_events (task_id, kind, to_position_id, note)
  values (p_task, 'handed_across', p_to_position, nullif(btrim(coalesce(p_note,'')),''));
end $$;

create or replace function public.org_cancel_task(p_task uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.task_events (task_id, kind, note)
  values (p_task, 'cancelled', nullif(btrim(coalesce(p_note,'')),''));
end $$;

-- 7. One read for the whole board ----------------------------------------------
-- Three buckets in one round trip, each already carrying the seat and person
-- names the screen needs. Built the way org_tree() is: resolve the holders once
-- in a CTE rather than per row, because the per-row version of this is the N+1
-- that cost this model 28 seconds once already.
create or replace function public.org_task_board(p_node uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with me as (
    -- A set of seat ids, not an array: "= any (subquery)" is the set form of ANY
    -- and would compare a uuid against a whole uuid[].
    select unnest(public.org_positions_held_by(public.org_current_person_id())) as seat
  ),
  holder as (
    select distinct on (h.position_id) h.position_id, h.person_id
      from public.position_holders h
     where h.effective_from <= now()
     order by h.position_id, h.effective_from desc, h.id desc
  ),
  seat as (
    select p.id, p.title, p.node_id, n.name as node_name, r.key as band,
           r.ordinal, pe.full_name as person_name
      from public.positions p
      join public.org_nodes n on n.id = p.node_id
      join public.ranks r on r.id = p.rank_id
      left join holder h on h.position_id = p.id
      left join public.persons pe on pe.id = h.person_id
  ),
  -- What the viewer may actually do with each task, decided once, here, by the
  -- same rules the triggers enforce. The screen draws a control only when this
  -- says yes -- a button that fails on click reads as a broken app, and a
  -- second round trip per card to find out reads as a slow one.
  can_hand as (select public.org_holds('hand_across_to_peer') as ok),
  visible as (
    select t.*,
           to_jsonb(st) - 'ordinal' as to_seat,
           to_jsonb(sf) - 'ordinal' as by_seat,
           (select jsonb_build_object('kind', e.kind, 'at', e.at, 'note', e.note)
              from public.task_events e where e.task_id = t.id
             order by e.at desc, e.id desc limit 1) as last_event,
           (t.state = 'open'
             and t.assigned_to_position_id in (select seat from me))
             as can_submit,
           (t.state = 'open'
             and t.assigned_to_position_id in (select seat from me)
             and (select ok from can_hand)) as can_hand_across,
           (t.state = 'submitted'
             and t.assigned_by_position_id in (select seat from me)
             and public.org_capability_reaches('accept_or_reject_submission',
                   public.org_position_node(t.assigned_to_position_id))) as can_decide,
           (t.state in ('open','submitted')
             and t.assigned_by_position_id in (select seat from me))
             as can_cancel
      from public.tasks t
      join seat st on st.id = t.assigned_to_position_id
      join seat sf on sf.id = t.assigned_by_position_id
     -- Every bucket below filters to these two states anyway. Without the filter
     -- HERE the CTE is materialised over every task the company has ever had, and
     -- the last_event lookup runs once per closed task nobody will read. The two
     -- partial indexes are written for exactly this predicate.
     where t.state in ('open','submitted')
  )
  select jsonb_build_object(
    -- The seats the reader holds, so the assign screen can ask "from which of
    -- your seats?" without a second round trip, and skip the question entirely
    -- for the overwhelming majority who hold exactly one.
    'my_seats', coalesce((select jsonb_agg(jsonb_build_object(
        'position_id', s.id, 'title', s.title, 'node_id', s.node_id,
        'node_name', s.node_name, 'band', s.band,
        'person_name', s.person_name) order by s.ordinal, s.title)
      from seat s where s.id in (select seat from me)), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(to_jsonb(v) order by v.due_at nulls last, v.created_at)
       from visible v where v.assigned_to_position_id in (select seat from me)
        and v.state in ('open','submitted')), '[]'::jsonb),
    'awaiting', coalesce((select jsonb_agg(to_jsonb(v) order by v.due_at nulls last, v.created_at)
       from visible v where v.assigned_by_position_id in (select seat from me)
        and v.state = 'submitted'), '[]'::jsonb),
    'given', coalesce((select jsonb_agg(to_jsonb(v) order by v.due_at nulls last, v.created_at)
       from visible v where v.assigned_by_position_id in (select seat from me)
        and v.state in ('open','submitted')), '[]'::jsonb),
    'node', case when p_node is null then '[]'::jsonb else coalesce((
       select jsonb_agg(to_jsonb(v) order by v.due_at nulls last, v.created_at)
         from visible v
        where v.state in ('open','submitted')
          and public.org_position_node(v.assigned_to_position_id)
              = any (public.org_subtree_ids(array[p_node]))
          and (public.org_admin()
               or public.org_capability_reaches('view_subtree_workload', p_node))
       ), '[]'::jsonb) end
  );
$$;

-- Seats this person may be given work by me: their direct reports, plus their
-- own seat. The screen asks for this instead of reimplementing ±1 in TypeScript.
create or replace function public.org_assignable_seats(p_from_position uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with holder as (
    select distinct on (h.position_id) h.position_id, h.person_id
      from public.position_holders h
     where h.effective_from <= now()
     order by h.position_id, h.effective_from desc, h.id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'position_id', p.id, 'title', p.title, 'node_id', p.node_id,
           'node_name', n.name, 'band', r.key,
           'person_name', pe.full_name) order by r.ordinal, p.title), '[]'::jsonb)
    from public.positions p
    join public.org_nodes n on n.id = p.node_id
    join public.ranks r on r.id = p.rank_id
    left join holder h on h.position_id = p.id
    left join public.persons pe on pe.id = h.person_id
   where p.abolished_at is null
     and (p.reports_to_position_id = p_from_position or p.id = p_from_position)
     -- You may only ask this about a seat you actually hold. Without it the
     -- seat id is just an argument, and anyone could page through the company's
     -- reporting lines one seat at a time.
     and (public.org_admin()
          or p_from_position = any (
               public.org_positions_held_by(public.org_current_person_id())))
     and (public.org_admin() or public.org_capability_reaches('assign_work_down', p.node_id));
$$;

-- Peers a task can be handed to: same band, any khối, excluding the seat that
-- holds it. The document's "cửa vào" rule, as a query.
create or replace function public.org_peer_seats(p_task uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with holder as (
    select distinct on (h.position_id) h.position_id, h.person_id
      from public.position_holders h
     where h.effective_from <= now()
     order by h.position_id, h.effective_from desc, h.id desc
  ), current as (
    -- The same two conditions org_guard_task_events demands of a 'handed_across'
    -- event: the work is in a seat you hold, and you hold the capability. An
    -- unauthorised caller gets no current seat and therefore an empty list, so a
    -- task id alone never enumerates a band's people.
    select p.id, p.rank_id from public.tasks t
      join public.positions p on p.id = t.assigned_to_position_id
     where t.id = p_task
       and (public.org_admin()
            or (t.assigned_to_position_id = any (
                  public.org_positions_held_by(public.org_current_person_id()))
                and public.org_holds('hand_across_to_peer')))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'position_id', p.id, 'title', p.title, 'node_id', p.node_id,
           'node_name', n.name, 'person_name', pe.full_name) order by n.name, p.title), '[]'::jsonb)
    from public.positions p
    join public.org_nodes n on n.id = p.node_id
    left join holder h on h.position_id = p.id
    left join public.persons pe on pe.id = h.person_id
   where p.abolished_at is null
     and p.rank_id = (select rank_id from current)
     and p.id <> (select id from current);
$$;

grant execute on function public.org_holds(text)                                   to authenticated;
grant execute on function public.org_is_my_direct_report(uuid)                     to authenticated;
grant execute on function public.org_position_node(uuid)                           to authenticated;
grant execute on function public.org_assign_task(uuid, uuid, text, text, numeric, timestamptz) to authenticated;
grant execute on function public.org_submit_task(uuid, text)                       to authenticated;
grant execute on function public.org_accept_task(uuid, text)                       to authenticated;
grant execute on function public.org_reject_task(uuid, text)                       to authenticated;
grant execute on function public.org_hand_task_across(uuid, uuid, text)            to authenticated;
grant execute on function public.org_cancel_task(uuid, text)                       to authenticated;
grant execute on function public.org_task_board(uuid)                              to authenticated;
grant execute on function public.org_assignable_seats(uuid)                        to authenticated;
grant execute on function public.org_peer_seats(uuid)                              to authenticated;

commit;
