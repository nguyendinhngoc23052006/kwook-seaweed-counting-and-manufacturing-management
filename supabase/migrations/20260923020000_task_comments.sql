-- Comments on a task, visible to everyone who works on it.
--
-- "Everyone who works on a task" is the owner's own words, and task_flow.sql
-- already answers who that is: the seat that assigned the work and the seat
-- that currently holds it (assigned_to_position_id is a projection that moves
-- on hand-across, so "currently" matters -- a peer the work was handed away
-- from stops seeing new comments, same as they stop seeing the task itself in
-- tasks_select). org_admin() can additionally see every thread, for support
-- and dispute review, exactly like it can already see every task.
--
-- org_can_see_task() says that once, as a function, so the RLS policy and the
-- two RPCs below ask the identical question -- the failure mode this guards
-- against is a policy and a definer function drifting apart, where a caller
-- who cannot SELECT the row can still INSERT into it because the RPC forgot
-- to re-check.
--
-- RE-RUNNABLE: create table/index if not exists, create or replace function,
-- drop policy/trigger if exists before create.

begin;

-- 1. The table -------------------------------------------------------------
-- Append-only, like task_events: no update policy, no delete policy, and no
-- grant that would let a client attempt either.
create table if not exists public.task_comments (
  id                  uuid primary key default gen_random_uuid(),
  task_id             uuid not null references public.tasks(id) on delete cascade,
  author_position_id  uuid not null references public.positions(id) on delete restrict,
  body                text not null check (length(btrim(body)) between 1 and 4000),
  created_at          timestamptz not null default now()
);

create index if not exists task_comments_task_idx
  on public.task_comments (task_id, created_at, id);

alter table public.task_comments enable row level security;

comment on table public.task_comments is
  'Append-only. Written only by org_add_task_comment(); read directly by nobody -- org_task_comments() is the only door, same posture as applications/job_postings.';

-- 2. Who may see a task's comments -------------------------------------------
-- Admin sees every thread; anyone else sees a thread only through a seat they
-- currently hold that is this task's assigner or its current assignee --
-- exactly the two seats tasks_select (task_flow.sql, section 5) already
-- grants row visibility to on the task itself, asked here per-task instead of
-- per-row so the insert RPC can call it with one argument.
create or replace function public.org_can_see_task(p_task uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.tasks t
     where t.id = p_task
       and (public.org_admin()
            or t.assigned_by_position_id = any (
                 public.org_positions_held_by(public.org_current_person_id()))
            or t.assigned_to_position_id = any (
                 public.org_positions_held_by(public.org_current_person_id())))
  );
$$;

-- 3. RLS ----------------------------------------------------------------------
-- No direct grant is issued on this table (section 6), so these never fire
-- from a client query -- they exist so that if a future migration ever does
-- grant the table directly (the applications/job_postings precedent this
-- migration follows never does), the same rule is already sitting on the row
-- and does not have to be invented under pressure.
drop policy if exists task_comments_select on public.task_comments;
create policy task_comments_select on public.task_comments for select to authenticated
using ((select public.org_can_see_task(task_id)));

drop policy if exists task_comments_insert on public.task_comments;
create policy task_comments_insert on public.task_comments for insert to authenticated
with check ((select public.org_can_see_task(task_id)));

commit;

begin;

-- 4. Post a comment -------------------------------------------------------------
-- "Never trust RLS alone for a definer RPC": this function is SECURITY
-- DEFINER, so it runs with the privileges that created it, not the caller's --
-- the RLS policy above is not in the call path at all here, and the org_can_see_task
-- check below is the actual gate.
--
-- Authorship: a comment is written as whichever of the task's two seats the
-- caller currently holds -- the assignee first (the seat doing the work right
-- now), then the assigner. org_admin() alone widens READ (the third branch of
-- org_can_see_task above) but never widens WRITE: an admin with no seat on
-- this task can read the thread support/dispute-review can already read the
-- task itself, but posting as an unrelated admin would put words in the
-- thread with no real participant behind them, so that caller is refused and
-- told why rather than silently authored as whichever seat happens to be
-- first in some tie-break.
create or replace function public.org_add_task_comment(p_task uuid, p_body text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_task     public.tasks%rowtype;
  v_my_seats uuid[];
  v_author   uuid;
  v_id       uuid;
begin
  if not public.org_can_see_task(p_task) then
    raise exception 'you cannot comment on a task you cannot see' using errcode = '42501';
  end if;

  select * into v_task from public.tasks where id = p_task;

  v_my_seats := public.org_positions_held_by(public.org_current_person_id());

  if v_task.assigned_to_position_id = any (v_my_seats) then
    v_author := v_task.assigned_to_position_id;
  elsif v_task.assigned_by_position_id = any (v_my_seats) then
    v_author := v_task.assigned_by_position_id;
  else
    raise exception
      'only the seat this task was assigned by or to can post a comment -- org_admin alone gives you read access, not authorship'
      using errcode = '42501';
  end if;

  insert into public.task_comments (task_id, author_position_id, body)
  values (p_task, v_author, btrim(p_body))
  returning id into v_id;
  return v_id;
end $$;

-- 5. Read the thread --------------------------------------------------------
-- Oldest first, like a conversation. Returns '[]'::jsonb rather than raising
-- for a task the caller cannot see, matching how the rest of this schema
-- treats "no access" as "nothing to show" for a read path (org_job_board()
-- filters rather than errors; the difference here is the filter is a single
-- task, not a set).
create or replace function public.org_task_comments(p_task uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not public.org_can_see_task(p_task) then '[]'::jsonb else coalesce(
    (select jsonb_agg(jsonb_build_object(
             'id', c.id,
             'author_position_id', c.author_position_id,
             'author_title', p.title,
             'body', c.body,
             'created_at', c.created_at)
           order by c.created_at, c.id)
       from public.task_comments c
       join public.positions p on p.id = c.author_position_id
      where c.task_id = p_task), '[]'::jsonb) end;
$$;

commit;

begin;

-- 6. Grants ---------------------------------------------------------------------
-- No direct table grant, same posture as applications/job_postings: every
-- access goes through the two RPCs. org_can_see_task() is granted too, since
-- it is what the (currently unreachable) RLS policies above call -- if a
-- later migration grants the table directly, that call still needs to work
-- rather than fail with "permission denied for function" on top of it.
revoke all on public.task_comments from anon, authenticated;

revoke all on function public.org_can_see_task(uuid) from public, anon;
grant execute on function public.org_can_see_task(uuid) to authenticated;

revoke all on function public.org_add_task_comment(uuid, text) from public, anon;
grant execute on function public.org_add_task_comment(uuid, text) to authenticated;

revoke all on function public.org_task_comments(uuid) from public, anon;
grant execute on function public.org_task_comments(uuid) to authenticated;

commit;
