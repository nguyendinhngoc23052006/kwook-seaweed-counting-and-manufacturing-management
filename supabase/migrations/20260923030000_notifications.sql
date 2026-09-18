-- Notifications: a person's own inbox for the events that touch their seats.
--
-- Every row is written by a SECURITY DEFINER trigger reacting to a fact that
-- already happened (a task event, a comment, a capability grant/revoke) --
-- never by a direct client insert. That mirrors task_events/task_comments:
-- the append-only source of truth is elsewhere, this table is a derived
-- fan-out of "who should hear about this", and it is disposable in the sense
-- that losing a row loses a ping, never a fact.
--
-- WHO GETS NOTIFIED is "the other side of the seat that caused the event" --
-- see each trigger below for the concrete per-kind rule. "Current holder(s)
-- of a position" is resolved the same way org_positions_held_by's inverse
-- works: position_holders, latest effective_from, position not abolished. A
-- vacant seat resolves to zero holders and the trigger inserts nothing for
-- it -- a notification with no addressee is not an error, it's a no-op.
--
-- RE-RUNNABLE: create table/index if not exists, create or replace function,
-- drop trigger if exists before create.

begin;

-- 1. The table ----------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references public.persons(id) on delete cascade,
  kind       text not null check (kind in (
               'task_assigned', 'task_submitted', 'task_accepted', 'task_rejected',
               'task_handed_across', 'task_commented', 'capability_changed')),
  payload    jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_person_idx
  on public.notifications (person_id, created_at desc, id desc);
-- org_unread_notification_count() filters on exactly this pair.
create index if not exists notifications_unread_idx
  on public.notifications (person_id) where read_at is null;

alter table public.notifications enable row level security;

comment on table public.notifications is
  'Written only by trigger (task_events, task_comments, node_capabilities). No client insert -- org_notifications()/org_mark_notification_read() are the only doors a browser uses, same posture as task_comments.';

-- 2. RLS ------------------------------------------------------------------------
-- Select: your own rows only. Update: your own rows only, and the column
-- grant below (section 6) is what actually confines the write to read_at --
-- Postgres requires column-level UPDATE privilege on every column named in a
-- SET list even when the value is unchanged, so there is no policy predicate
-- that could let a client rewrite kind/payload/person_id even by accident.
-- No insert policy and no delete policy at all: RLS default-denies both for
-- every role except the table owner, which is exactly the two triggers'
-- SECURITY DEFINER context and nothing else.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
using (person_id = (select public.org_current_person_id()));

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated
using (person_id = (select public.org_current_person_id()))
with check (person_id = (select public.org_current_person_id()));

commit;

begin;

-- 3. Helper: who currently holds a seat -----------------------------------------
-- Same shape as org_positions_held_by's per-position lookup, just inverted:
-- given a position, the person in its newest position_holders row (if the
-- position is not abolished and that row names a person at all). Zero or one
-- person, never more -- a position has exactly one current occupant or none.
create or replace function public.org_position_current_holders(p_position uuid)
returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(h.person_id), '{}'::uuid[])
    from public.positions p
    join lateral (
      select ph.person_id
        from public.position_holders ph
       where ph.position_id = p.id
         and ph.effective_from <= now()
       order by ph.effective_from desc, ph.id desc
       limit 1
    ) h on true
   where p.id = p_position
     and p.abolished_at is null
     and h.person_id is not null;
$$;

revoke all on function public.org_position_current_holders(uuid) from public, anon, authenticated;

-- 4. Trigger on task_events -------------------------------------------------------
-- Direction, per kind, is "the seat that did NOT act":
--   assigned  -> the assignee just received work they didn't ask for.
--   accepted  -> the assignee, whose submission was just approved.
--   submitted / rejected / handed_across / cancelled -> the assigner, since
--   the assignee's own seat is the one that acted in all four (submitting,
--   being bounced back to work, handing the seat itself off, or having the
--   assigner close the task out from under them is still the assigner's own
--   act in the case of 'cancelled'). This is the literal targeting rule this
--   migration was specified against; it is deliberately NOT re-derived here.
--
-- 'cancelled' has no matching value in notifications.kind's CHECK (above) --
-- there is no task_cancelled row to write -- so it raises no notification.
-- Silently skipping it (rather than inventing a kind the table doesn't
-- declare) is the only option that doesn't fail the CHECK and roll back the
-- cancellation itself.
create or replace function public.notify_on_task_event()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_task       public.tasks%rowtype;
  v_notif_kind text;
  v_target_pos uuid;
  v_person     uuid;
begin
  select * into v_task from public.tasks where id = new.task_id;

  v_notif_kind := case new.kind
    when 'assigned'      then 'task_assigned'
    when 'submitted'     then 'task_submitted'
    when 'accepted'      then 'task_accepted'
    when 'rejected'      then 'task_rejected'
    when 'handed_across' then 'task_handed_across'
    else null -- 'cancelled': see comment above.
  end;

  if v_notif_kind is null then
    return new;
  end if;

  v_target_pos := case new.kind
    when 'assigned' then v_task.assigned_to_position_id
    when 'accepted' then v_task.assigned_to_position_id
    else v_task.assigned_by_position_id -- submitted / rejected / handed_across
  end;

  for v_person in select unnest(public.org_position_current_holders(v_target_pos))
  loop
    insert into public.notifications (person_id, kind, payload)
    values (v_person, v_notif_kind,
      jsonb_build_object(
        'task_id', v_task.id,
        'title', v_task.title,
        'event_id', new.id,
        'event_kind', new.kind,
        'note', new.note,
        'at', new.at)
      || case when new.kind = 'handed_across'
              then jsonb_build_object('to_position_id', new.to_position_id)
              else '{}'::jsonb
         end);
  end loop;

  return new;
end $$;

drop trigger if exists notify_on_task_event on public.task_events;
create trigger notify_on_task_event after insert on public.task_events
  for each row execute function public.notify_on_task_event();

-- 5. Trigger on task_comments -------------------------------------------------
-- The other side of whoever posted: assigner if the author held (or holds)
-- the assignee seat, assignee if the author held the assigner seat. An admin
-- who can see the thread (org_can_see_task's third branch) without holding
-- either seat is neither, so both sides hear about it.
create or replace function public.notify_on_task_comment()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_task    public.tasks%rowtype;
  v_targets uuid[];
  v_person  uuid;
begin
  select * into v_task from public.tasks where id = new.task_id;

  if new.author_position_id = v_task.assigned_to_position_id then
    v_targets := array[v_task.assigned_by_position_id];
  elsif new.author_position_id = v_task.assigned_by_position_id then
    v_targets := array[v_task.assigned_to_position_id];
  else
    v_targets := array[v_task.assigned_by_position_id, v_task.assigned_to_position_id];
  end if;

  -- distinct: a self-assigned task (assigned_by = assigned_to) commented on
  -- by neither seat's holder would otherwise resolve the same position twice.
  for v_person in
    select distinct h
      from unnest(v_targets) t(pos)
      cross join lateral unnest(public.org_position_current_holders(t.pos)) h
  loop
    insert into public.notifications (person_id, kind, payload)
    values (v_person, 'task_commented',
      jsonb_build_object(
        'task_id', v_task.id,
        'title', v_task.title,
        'comment_id', new.id,
        'author_position_id', new.author_position_id,
        'body', new.body,
        'created_at', new.created_at));
  end loop;

  return new;
end $$;

drop trigger if exists notify_on_task_comment on public.task_comments;
create trigger notify_on_task_comment after insert on public.task_comments
  for each row execute function public.notify_on_task_comment();

-- 6. Trigger on node_capabilities -----------------------------------------------
-- Every person seated at the node right now, granted or revoked alike -- the
-- capability holder needs to know either way. node_capabilities is
-- append-only in practice (org_foundation.sql: "no UPDATE and no DELETE on
-- this table at any layer"), but the spec for this trigger is INSERT OR
-- UPDATE, so both are covered rather than assumed away.
create or replace function public.notify_on_capability_change()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_person uuid;
begin
  for v_person in select unnest(public.org_persons_seated_in(array[new.node_id]))
  loop
    insert into public.notifications (person_id, kind, payload)
    values (v_person, 'capability_changed',
      jsonb_build_object(
        'node_id', new.node_id,
        'capability_key', new.capability_key,
        'granted', new.granted,
        'reason', new.reason,
        'effective_from', new.effective_from));
  end loop;

  return new;
end $$;

drop trigger if exists notify_on_capability_change on public.node_capabilities;
create trigger notify_on_capability_change after insert or update on public.node_capabilities
  for each row execute function public.notify_on_capability_change();

commit;

begin;

-- 7. The three RPCs ---------------------------------------------------------------
-- Keyset-paged, newest-first, same style as org_applications: p_before filters
-- strictly older than the last row the caller has already seen.
create or replace function public.org_notifications(p_before timestamptz default null, p_limit int default 50)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object(
       'id', n.id, 'kind', n.kind, 'payload', n.payload,
       'read_at', n.read_at, 'created_at', n.created_at) order by n.created_at desc)
       from (select * from public.notifications
              where person_id = public.org_current_person_id()
                and (p_before is null or created_at < p_before)
              order by created_at desc
              limit least(greatest(coalesce(p_limit, 50), 1), 200)) n), '[]'::jsonb);
$$;

-- Only your own row; a no-op (not an error) when it's already read or isn't
-- yours -- the same query shape for "not found" and "not yours" so neither
-- case leaks which one happened.
create or replace function public.org_mark_notification_read(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.notifications
     set read_at = now()
   where id = p_id
     and person_id = public.org_current_person_id()
     and read_at is null;
end $$;

create or replace function public.org_unread_notification_count()
returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int
    from public.notifications
   where person_id = public.org_current_person_id()
     and read_at is null;
$$;

commit;

begin;

-- 8. Grants -----------------------------------------------------------------------
-- Direct table access matches exactly what the two RLS policies allow: read
-- your own rows, flip read_at on your own rows. Nothing else -- no insert, no
-- delete, no other column of update -- and none of it to anon.
revoke all on public.notifications from anon, authenticated;

grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

revoke all on function public.org_notifications(timestamptz, int) from public, anon;
grant execute on function public.org_notifications(timestamptz, int) to authenticated;

revoke all on function public.org_mark_notification_read(uuid) from public, anon;
grant execute on function public.org_mark_notification_read(uuid) to authenticated;

revoke all on function public.org_unread_notification_count() from public, anon;
grant execute on function public.org_unread_notification_count() to authenticated;

commit;
