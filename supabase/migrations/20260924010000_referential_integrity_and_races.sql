-- 8.13 Referential integrity for measurements, and two unlocked read-modify-write races.
--
-- Two unrelated defects, fixed together because both were found in the same audit pass.

begin;

-- CLAUDE.md: "every FK from a measurement to devices or stations is ON DELETE
-- RESTRICT and delete is revoked on both". 20260920010000_camera_devices.sql
-- shipped every device/station FK as CASCADE instead -- deleting a camera's
-- auth user (or a station) would silently wipe every count/compliance/heartbeat
-- row it ever produced. camera_devices.id -> auth.users(id) is the one
-- exception that is NOT a mistake: it IS the device account itself, so
-- RESTRICT here is what makes "revoke, never delete, while it has counted
-- anything" true -- the same fix shape, not a special case.
alter table public.camera_devices
  drop constraint camera_devices_id_fkey,
  add constraint camera_devices_id_fkey
    foreign key (id) references auth.users(id) on delete restrict;

alter table public.camera_count_events
  drop constraint camera_count_events_device_id_fkey,
  add constraint camera_count_events_device_id_fkey
    foreign key (device_id) references public.camera_devices(id) on delete restrict;

alter table public.camera_count_minutes
  drop constraint camera_count_minutes_device_id_fkey,
  add constraint camera_count_minutes_device_id_fkey
    foreign key (device_id) references public.camera_devices(id) on delete restrict;

alter table public.camera_compliance_events
  drop constraint camera_compliance_events_device_id_fkey,
  add constraint camera_compliance_events_device_id_fkey
    foreign key (device_id) references public.camera_devices(id) on delete restrict;

alter table public.camera_device_heartbeats
  drop constraint camera_device_heartbeats_device_id_fkey,
  add constraint camera_device_heartbeats_device_id_fkey
    foreign key (device_id) references public.camera_devices(id) on delete restrict;

alter table public.camera_mode_transitions
  drop constraint camera_mode_transitions_device_id_fkey,
  add constraint camera_mode_transitions_device_id_fkey
    foreign key (device_id) references public.camera_devices(id) on delete restrict;

alter table public.camera_stream_sessions
  drop constraint camera_stream_sessions_device_id_fkey,
  add constraint camera_stream_sessions_device_id_fkey
    foreign key (device_id) references public.camera_devices(id) on delete restrict;

-- camera_calibrations.station_id: a calibration is a record of a station's
-- own physical setup, not a measurement that can outlive it the way a count
-- can outlive a retired station label -- RESTRICT, same as the device FKs
-- above. (camera_devices/camera_count_events/camera_count_minutes/
-- camera_compliance_events.station_id stay ON DELETE SET NULL: a station is a
-- location label a measurement can legitimately outlive once DELETE is
-- revoked below, and only the FKs named above were asked for.)
alter table public.camera_calibrations
  drop constraint camera_calibrations_station_id_fkey,
  add constraint camera_calibrations_station_id_fkey
    foreign key (station_id) references public.camera_stations(id) on delete restrict;

commit;

begin;

-- 20260920010000_camera_devices.sql granted DELETE on camera_stations and
-- camera_operators to authenticated with no RLS narrowing DELETE specifically
-- -- the same "delete is revoked" rule above applies to the tables a camera
-- or count row points AT, not only to camera_devices itself. select/insert/
-- update and every existing policy are untouched.
revoke delete on public.camera_stations from authenticated;
revoke delete on public.camera_operators from authenticated;

commit;

begin;

-- task_comments.task_id -> tasks(id) was CASCADE. tasks are never deleted
-- (org_guard_tasks in task_flow.sql raises on tg_op = 'DELETE') and carry no
-- DELETE grant, so this CASCADE can never actually fire -- tightened to
-- RESTRICT for consistency with every other never-delete table in this
-- schema (position_holders, node_capabilities, task_events), not a behavior
-- change today.
alter table public.task_comments
  drop constraint task_comments_task_id_fkey,
  add constraint task_comments_task_id_fkey
    foreign key (task_id) references public.tasks(id) on delete restrict;

commit;

begin;

-- notifications.person_id -> persons(id) was CASCADE. persons are never
-- deleted via their own guard trigger and carry no DELETE grant either --
-- same unreachable-CASCADE tightening as task_comments above.
alter table public.notifications
  drop constraint notifications_person_id_fkey,
  add constraint notifications_person_id_fkey
    foreign key (person_id) references public.persons(id) on delete restrict;

commit;

begin;

-- org_guard_task_events (task_flow.sql) read the task's current state with a
-- plain, unlocked SELECT before branching on it. Two concurrent RPCs on the
-- same task (e.g. org_accept_task + org_reject_task, both requiring state =
-- 'submitted') can each read the same pre-transition snapshot, both pass
-- their precondition, and both commit -- two contradictory events appended
-- for one task. Same idiom already used three times in this schema for the
-- identical class of race (org_guard_position_holders and
-- org_guard_node_capabilities in 20260920000000_org_foundation.sql, the
-- org_guard_nodes reparent lock in 20260924000000_freeze_inactive_subtrees.sql):
-- one pg_advisory_xact_lock keyed on the row being raced over, taken before
-- the read that decides the branch. Body reproduced verbatim from
-- task_flow.sql:225-320 except for that one added line.
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

  perform pg_advisory_xact_lock(hashtext('tasks' || new.task_id::text));
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

commit;

begin;

-- org_book_interview_slot (interview_scheduling.sql) counted current bookings
-- against capacity with no lock. Two concurrent bookings of the last open
-- seat can both read the same pre-booking count, both pass "count < capacity",
-- and both commit -- overbooking the slot. Same idiom as the fix above:
-- one pg_advisory_xact_lock keyed on the slot being raced over, taken
-- immediately before the count query it protects. Body reproduced verbatim
-- from interview_scheduling.sql:124-183 except for that one added line.
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

  perform pg_advisory_xact_lock(hashtext('interview_slot' || p_slot::text));
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
