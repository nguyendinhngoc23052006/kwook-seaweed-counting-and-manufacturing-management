-- Retire the test-bed: the counting floor moves onto the org camera stack.
--
-- The legacy stack (devices/stations/lines/count_*/capture_sessions, all keyed
-- by tenant_id) existed to prove a phone could count seaweed. It did. The org
-- stack (camera_* keyed by org_node_id) is the real system and is already a
-- column-for-column twin of it -- except for three things the test-bed learned
-- the hard way and the twin never received. Retiring the old one without
-- carrying these across would re-open bugs that are already closed:
--
--   1. A line must be a ROW, not free text. camera_stations.line is a string,
--      which is exactly the state 20260917091000_factory_model.sql fixed for
--      the legacy stack: "Line A", "line a" and " Line A " were three lines on
--      the Wall and nothing could be said ABOUT a line.
--   2. A camera's function comes from its SESSION, stamped server-side (rule 2).
--      camera_stream_sessions is a video-stream record, not this: no function,
--      no station, no one-open-per-device guarantee, no end-on-revoke.
--   3. A device must be able to READ the station list to name where it stands.
--      Both camera_stations policies gate on org_admin() or a capability, and a
--      device account has neither -- it would see an empty picker.
--
-- This migration is additive. The legacy tables still hold their data and are
-- dropped in a separate migration once nothing reads them.

begin;

-- =====================================================================================
-- 1. Lines are rows again
-- =====================================================================================

create table if not exists public.camera_lines (
  id          uuid primary key default gen_random_uuid(),
  org_node_id uuid not null references public.org_nodes(id) on delete restrict,
  name        text not null check (length(btrim(name)) > 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- The whole point of the table: case and stray spaces stop minting new lines.
create unique index if not exists camera_lines_node_name_key
  on public.camera_lines (org_node_id, lower(btrim(name)));
create index if not exists camera_lines_node_idx on public.camera_lines(org_node_id);

alter table public.camera_lines enable row level security;

alter table public.camera_stations
  add column if not exists line_id uuid references public.camera_lines(id) on delete restrict;

-- Backfill: every distinct (node, normalised line text) already on a station
-- becomes a row, and the stations point at it. Runs before the not-null below,
-- so a deployment with existing stations survives it.
insert into public.camera_lines (org_node_id, name)
select distinct s.org_node_id, btrim(s.line)
  from public.camera_stations s
 where s.line_id is null and length(btrim(s.line)) > 0
on conflict do nothing;

update public.camera_stations s
   set line_id = l.id
  from public.camera_lines l
 where s.line_id is null
   and l.org_node_id = s.org_node_id
   and lower(btrim(l.name)) = lower(btrim(s.line));

alter table public.camera_stations drop column if exists line;
alter table public.camera_stations alter column line_id set not null;
create index if not exists camera_stations_line_idx on public.camera_stations(line_id);

drop policy if exists camera_lines_read on public.camera_lines;
create policy camera_lines_read on public.camera_lines for select
  using (public.org_admin()
      or public.org_capability_reaches('view_camera_data', org_node_id)
      or public.org_capability_reaches('manage_camera_devices', org_node_id));

drop policy if exists camera_lines_write on public.camera_lines;
create policy camera_lines_write on public.camera_lines for all
  using (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id))
  with check (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id));

grant select, insert, update, delete on public.camera_lines to authenticated;

-- Naming a line is how a line comes to exist: the admin types "Line A" on the
-- station form and means the one that is already there if there is one. Doing
-- that as select-then-insert from the browser races two admins into a 23505 on
-- the same name. INVOKER rights on purpose -- camera_lines_write is the gate,
-- so this adds no privilege, only atomicity. The do-update is what makes the
-- insert return the existing row's id rather than nothing.
create or replace function public.org_camera_line_id(p_node_id uuid, p_name text)
returns uuid language sql security invoker set search_path = public as $$
  insert into public.camera_lines (org_node_id, name)
  values (p_node_id, btrim(p_name))
  on conflict (org_node_id, lower(btrim(name)))
    do update set name = public.camera_lines.name
  returning id;
$$;

grant execute on function public.org_camera_line_id(uuid, text) to authenticated;

commit;

begin;

-- =====================================================================================
-- 2. A device is a caller too
-- =====================================================================================
--
-- Every gate in the org stack asks about a PERSON (org_admin, a capability
-- reaching a node). A camera account is neither, so it failed every one of
-- them. These two say what a device is allowed to be, once, so the policies
-- below read the same way the human ones do.

create or replace function public.org_camera_is_active_device()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.camera_devices d
     where d.id = auth.uid() and d.revoked_at is null
  );
$$;

create or replace function public.org_camera_device_node()
returns uuid language sql stable security definer set search_path = public as $$
  select d.org_node_id from public.camera_devices d
   where d.id = auth.uid() and d.revoked_at is null;
$$;

grant execute on function public.org_camera_is_active_device() to authenticated;
grant execute on function public.org_camera_device_node() to authenticated;

-- Lesson 3: a camera must be able to name where it stands. Widened to the
-- device's OWN node and nothing more -- what a stolen phone gains is the list
-- of station names on the floor it is already standing on. It still cannot read
-- a count row, another camera's session, or anything about a person.
drop policy if exists camera_stations_read on public.camera_stations;
create policy camera_stations_read on public.camera_stations for select
  using (public.org_admin()
      or public.org_capability_reaches('view_camera_data', org_node_id)
      or public.org_capability_reaches('manage_camera_devices', org_node_id)
      or org_node_id = public.org_camera_device_node());

drop policy if exists camera_lines_read on public.camera_lines;
create policy camera_lines_read on public.camera_lines for select
  using (public.org_admin()
      or public.org_capability_reaches('view_camera_data', org_node_id)
      or public.org_capability_reaches('manage_camera_devices', org_node_id)
      or org_node_id = public.org_camera_device_node());

commit;

begin;

-- =====================================================================================
-- 3. The capture session -- lesson 2
-- =====================================================================================
--
-- What a camera is DOING right now, decided by the owner and stamped here, not
-- read off a URL and not read off the device row. Deliberately separate from
-- camera_stream_sessions: that one records that video was streamed, this one
-- records that counting happened. check_in/check_out are absent from the
-- function list because a door camera runs AttendanceCamera, not a capture.

create table if not exists public.camera_capture_sessions (
  id          uuid primary key default gen_random_uuid(),
  org_node_id uuid not null references public.org_nodes(id) on delete restrict,
  device_id   uuid not null references public.camera_devices(id) on delete cascade,
  station_id  uuid references public.camera_stations(id) on delete set null,
  -- Not named "function": reserved word in Postgres, quoted at every call site.
  camera_function text not null
    check (camera_function in ('provisioning', 'counting', 'compliance', 'overview')),
  -- Frozen words, not lookups. A report about last March must still read
  -- "Line 2 / Wash bay / Phone 7" after the line is renamed and the phone
  -- relabelled -- the same reason algorithm_version rides every count row.
  -- station_id keeps pointing at the live row for joins; these are the record.
  line_name    text,
  station_name text,
  device_label text,
  -- The last instant this camera PROVED it was recording (its newest heartbeat,
  -- clamped to server time). Null until the first heartbeat of the session.
  last_evidence_at timestamptz,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  -- 'lost' is the reaper's word and only the reaper's: the other four describe
  -- a deliberate act someone WATCHED happen. A camera whose battery died did
  -- none of them, and keeping the two distinguishable is what a supervisor
  -- reading uptime actually needs.
  end_reason  text check (end_reason in ('signed_out', 'stopped', 'revoked', 'ended_by_owner', 'lost')),
  algorithm_version text,
  constraint camera_capture_sessions_ends_after_start
    check (ended_at is null or ended_at >= started_at)
);

create index if not exists camera_capture_sessions_node_idx
  on public.camera_capture_sessions (org_node_id, started_at desc);
create index if not exists camera_capture_sessions_station_idx
  on public.camera_capture_sessions (station_id, started_at desc);

-- A phone does ONE thing at a time. Without this a crashed tab that reconnects
-- stacks a second open session and the station counts itself twice.
create unique index if not exists camera_capture_sessions_one_open_per_device
  on public.camera_capture_sessions (device_id) where ended_at is null;

alter table public.camera_capture_sessions enable row level security;

-- org_node_id is stamped from the device's own row and the insert is refused
-- outright if that device has been revoked -- the same trigger every other
-- device-written table in this stack uses.
create or replace trigger camera_stamp_node_id
  before insert on public.camera_capture_sessions
  for each row execute function public.camera_stamp_node_id();

-- Revoking a device takes it off the line in the same instant rather than
-- leaving an open session the Wall still believes in. Here rather than in the
-- admin screen so it holds however the revoke happens.
create or replace function public.camera_end_sessions_on_revoke()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update public.camera_capture_sessions
       set ended_at = now(), end_reason = 'revoked'
     where device_id = new.id and ended_at is null;
  end if;
  return new;
end $$;

drop trigger if exists camera_revoke_ends_sessions on public.camera_devices;
create trigger camera_revoke_ends_sessions
  after update of revoked_at on public.camera_devices
  for each row execute function public.camera_end_sessions_on_revoke();

-- Which stretch of recording produced this minute.
alter table public.camera_count_minutes
  add column if not exists session_id uuid
  references public.camera_capture_sessions(id) on delete set null;
create index if not exists camera_count_minutes_session_idx
  on public.camera_count_minutes (session_id);

-- A device reads its OWN session: that is how it learns which function to run.
-- Not an event table, so rule 1's write-only floor is untouched -- a device
-- still cannot read a single count row, its own included.
drop policy if exists camera_session_self_read on public.camera_capture_sessions;
create policy camera_session_self_read on public.camera_capture_sessions for select
  using (device_id = auth.uid()
      or public.org_admin()
      or public.org_capability_reaches('view_camera_data', org_node_id)
      or public.org_capability_reaches('manage_camera_devices', org_node_id));

drop policy if exists camera_session_device_start on public.camera_capture_sessions;
create policy camera_session_device_start on public.camera_capture_sessions for insert
  with check (device_id = auth.uid()
          and public.org_camera_is_active_device()
          and ended_at is null);

-- A device ends its own session and nothing else. The with-check stops it
-- reassigning itself to another station on the way out.
drop policy if exists camera_session_device_end on public.camera_capture_sessions;
create policy camera_session_device_end on public.camera_capture_sessions for update
  using (device_id = auth.uid() and public.org_camera_is_active_device())
  with check (device_id = auth.uid());

-- Whoever manages cameras at this node ends anyone's session: "take that
-- camera off the line".
drop policy if exists camera_session_manage on public.camera_capture_sessions;
create policy camera_session_manage on public.camera_capture_sessions for all
  using (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id))
  with check (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id));

-- No DELETE anywhere: a session is history and history is not deleted.
--
-- A column grant, not a policy, because the thing to restrict is WHICH COLUMNS
-- may be written and RLS cannot see that: camera_session_device_end's
-- with-check pins device_id, and a row passing it may still carry any
-- last_evidence_at the phone chose -- making itself permanently alive, which is
-- the exact forgery the heartbeat clamp below exists to deny, walked in through
-- a different door. It could equally rewrite station_name and say it stood
-- somewhere it never stood. What is left is what a client legitimately writes:
-- the end of a session. Column privileges are checked before any policy.
grant select, insert on public.camera_capture_sessions to authenticated;
grant update (ended_at, end_reason) on public.camera_capture_sessions to authenticated;

commit;

begin;

-- =====================================================================================
-- 4. The owner is the placement authority -- rule 2, enforced rather than trusted
-- =====================================================================================
--
-- The device may not choose where it is or what it does. Whatever a phone puts
-- in station_id and camera_function is overwritten here from ITS OWN
-- camera_devices row, and the three name columns are filled from
-- devices/stations/lines. A compromised or merely out-of-date phone can post
-- anything it likes and the row that lands still says what the owner assigned.
--
-- This replaces camera_stamp_node_id on this table rather than running beside
-- it: it does that function's whole job (stamp the node, refuse a revoked
-- device) and the placement snapshot in one pass, so there is one writer of NEW.
--
-- Security definer because the reads must succeed for the caller that inserts
-- most sessions: a device.

-- Two phones pointed at one station silently DOUBLE its totals: unique
-- (device_id, minute) on camera_count_minutes is per device, so both write
-- their own row for the same minute and every sum over the station adds them
-- together. The station is the unit being measured, so the station is where
-- "one camera at a time" has to be enforced. Nulls are distinct, so sessions
-- with no station yet do not collide.
create unique index if not exists camera_capture_sessions_one_open_per_station
  on public.camera_capture_sessions (station_id) where ended_at is null;

create or replace function public.camera_capture_snapshot_placement()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  assigned record;
  occupant_label text;
begin
  select d.name as device_name, d.role as camera_function, d.station_id, d.org_node_id,
         d.revoked_at, s.name as station_name, l.name as line_name
    into assigned
    from public.camera_devices d
    left join public.camera_stations s on s.id = d.station_id
    left join public.camera_lines l on l.id = s.line_id
   where d.id = new.device_id;

  if not found then
    raise exception 'no such device' using errcode = '22023';
  end if;
  if assigned.revoked_at is not null then
    raise exception 'this device has been revoked' using errcode = '42501';
  end if;
  if assigned.camera_function not in ('provisioning', 'counting', 'compliance', 'overview') then
    raise exception 'camera % is a % door, not a counting camera', new.device_id, assigned.camera_function
      using errcode = 'check_violation';
  end if;

  new.org_node_id     := assigned.org_node_id;
  new.station_id      := assigned.station_id;
  new.camera_function := assigned.camera_function;
  new.device_label    := assigned.device_name;
  new.station_name    := assigned.station_name;
  new.line_name       := assigned.line_name;

  -- The unique index above is the enforcer; this is the same rejection with a
  -- message a person can act on, since Postgres reports the index violation as
  -- a constraint name and a uuid. Concurrent inserts still fall through to the
  -- index, so the guarantee does not depend on this check winning the race.
  if new.station_id is not null and new.ended_at is null then
    select c.device_label into occupant_label
      from public.camera_capture_sessions c
     where c.station_id = new.station_id and c.ended_at is null
     limit 1;
    if found then
      raise exception
        'station % already has an open capture session (camera %); end it before starting another',
        coalesce(assigned.station_name, new.station_id::text), coalesce(occupant_label, 'unknown')
        using errcode = 'unique_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists camera_stamp_node_id on public.camera_capture_sessions;
drop trigger if exists camera_capture_snapshots_placement on public.camera_capture_sessions;
create trigger camera_capture_snapshots_placement
  before insert on public.camera_capture_sessions
  for each row execute function public.camera_capture_snapshot_placement();

-- Nothing legitimate rewrites an ending: every writer here -- the device, the
-- owner, the revoke trigger, the reaper -- only ever closes a session whose
-- ended_at is still null. A phone that reappears on Monday must not be able to
-- set ended_at back to NULL and claim the weekend, nor launder 'lost' into
-- 'stopped'.
create or replace function public.camera_capture_end_is_final()
returns trigger language plpgsql as $$
begin
  if old.ended_at is not null
     and (new.ended_at is distinct from old.ended_at
          or new.end_reason is distinct from old.end_reason) then
    raise exception 'capture session % ended at % (%); its ending cannot be rewritten',
      old.id, old.ended_at, old.end_reason
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists camera_capture_end_is_final on public.camera_capture_sessions;
create trigger camera_capture_end_is_final
  before update of ended_at, end_reason on public.camera_capture_sessions
  for each row execute function public.camera_capture_end_is_final();

commit;

begin;

-- =====================================================================================
-- 5. Heartbeats are the session's evidence
-- =====================================================================================
--
-- One trigger per fact: camera_device_heartbeats already feeds
-- camera_devices.last_seen_at, and a session's evidence is the same fact at a
-- different grain, so the existing function is extended rather than raced by a
-- second trigger.
--
-- The clamp is new and load-bearing: `at` is an ordinary insertable column no
-- policy constrains, so a stolen phone can post at = '2999-01-01'. Here that
-- would make the session immortal, since the reaper closes on last_evidence_at
-- and would be handed a time that never arrives. least(new.at, now()) takes the
-- choice away from the device; the forward-only guard makes a replayed queue of
-- stale heartbeats harmless.
create or replace function public.camera_bump_last_seen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.camera_devices
     set last_seen_at = least(new.at, now())
   where id = new.device_id
     and (last_seen_at is null or last_seen_at < least(new.at, now()));

  update public.camera_capture_sessions
     set last_evidence_at = least(new.at, now())
   where device_id = new.device_id
     and ended_at is null
     and (last_evidence_at is null or last_evidence_at < least(new.at, now()));

  return null;
end $$;

-- =====================================================================================
-- 6. A drifting phone clock is visible, never corrected
-- =====================================================================================
--
-- camera_count_minutes.minute is built from the PHONE's clock, and a phone
-- twenty minutes out files well-formed rows against minutes that never
-- happened. received_at is the server's own stamp and skew_seconds the gap, so
-- a report's data-quality section can say "this station's clock ran 19 minutes
-- fast" instead of showing a hole at 14:00 and a spike at 14:20.
--
-- Both are set by the trigger, not the default alone: authenticated holds
-- INSERT, so a device could otherwise name its own received_at -- and a stamp a
-- device chooses measures nothing.
alter table public.camera_count_minutes
  add column if not exists received_at timestamptz not null default now(),
  add column if not exists skew_seconds int;

create or replace function public.camera_count_minute_stamp_receipt()
returns trigger language plpgsql as $$
begin
  new.received_at := now();
  new.skew_seconds := extract(epoch from now() - new.minute)::int;
  return new;
end $$;

drop trigger if exists camera_count_minute_stamps_receipt on public.camera_count_minutes;
create trigger camera_count_minute_stamps_receipt
  before insert on public.camera_count_minutes
  for each row execute function public.camera_count_minute_stamp_receipt();

comment on column public.camera_count_minutes.skew_seconds is
  'Server receipt minus the phone-generated minute key, in seconds. Positive means the phone clock is behind. Data quality, never a correction -- the count is filed where the camera said it happened.';

commit;

begin;

-- =====================================================================================
-- 7. The reaper -- close the sessions whose camera vanished, honestly
-- =====================================================================================
--
-- A phone whose battery dies writes no ended_at, so the session stays open
-- forever: the station is permanently occupied and a coverage report counts an
-- empty wall as recorded. These close at the last moment the camera PROVED it
-- was alive --
--
--   ended_at = greatest(last_evidence_at, started_at)     NEVER now()
--
-- now() is the tempting value and it is a lie: a phone that died on Friday and
-- is plugged back in on Monday would be stamped with seventy-two hours of
-- asserted recording. The reaper runs at a time that has nothing to do with the
-- event it describes, so its own clock is not evidence. greatest() ignores
-- NULLs, so a session that died before its first heartbeat closes at
-- started_at -- also the floor the ends-after-start check requires.
--
-- Rule 8: Cron -> Queue, never Cron alone. One job enqueues candidates, a
-- second drains and deletes a message only after that close has committed, so a
-- failed close is retried rather than skipped. Both guarded on availability so
-- the file still dry-runs on a plain Postgres.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgmq') then
    execute 'create extension if not exists pgmq';
    if not exists (select 1 from pgmq.list_queues() where queue_name = 'lost_camera_capture_sessions') then
      perform pgmq.create('lost_camera_capture_sessions');
    end if;
  else
    raise warning 'pgmq unavailable: queue not created, reaper left unscheduled';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron with schema pg_catalog';
    execute 'grant usage on schema cron to postgres';
    execute 'grant all privileges on all tables in schema cron to postgres';
  else
    raise warning 'pg_cron unavailable: reaper left unscheduled';
  end if;
end $$;

-- Staleness threshold: 5 minutes, which is TEN heartbeats at the 30s beat the
-- camera posts. A locked screen clamps browser timers to roughly one per
-- minute, so a camera that is genuinely recording can legitimately go minutes
-- between beats; too short and we amputate every minute it goes on to produce,
-- since ended_at is the last evidence rather than now(). Too long and the
-- replacement phone waits on the cron to free the station.
create or replace function public.enqueue_lost_camera_capture_sessions() returns bigint
  language plpgsql set search_path = public, pgmq as $$
declare
  candidate uuid;
  queued bigint := 0;
begin
  for candidate in
    select s.id from public.camera_capture_sessions s
     where s.ended_at is null
       and greatest(s.last_evidence_at, s.started_at) < now() - interval '5 minutes'
       -- Skip what is already in flight, or a drain that keeps failing collects
       -- one fresh duplicate per session per minute forever.
       and not exists (
         select 1 from pgmq.q_lost_camera_capture_sessions q
          where (q.message ->> 'session_id')::uuid = s.id
       )
  loop
    perform pgmq.send('lost_camera_capture_sessions', jsonb_build_object('session_id', candidate));
    queued := queued + 1;
  end loop;
  return queued;
end $$;

-- Visibility timeout of 120s against a 60s tick: a message being worked is
-- never handed to the next tick too, and a failed close retries two minutes
-- later. The per-message exception block is the point of the queue -- without
-- it one poison session aborts the transaction and takes every other camera's
-- close down with it.
create or replace function public.drain_lost_camera_capture_sessions() returns bigint
  language plpgsql set search_path = public, pgmq as $$
declare
  msg record;
  handled bigint := 0;
begin
  for msg in select * from pgmq.read('lost_camera_capture_sessions', 120, 100)
  loop
    begin
      update public.camera_capture_sessions
         set ended_at = greatest(last_evidence_at, started_at), end_reason = 'lost'
       where id = (msg.message ->> 'session_id')::uuid
         and ended_at is null;
      perform pgmq.delete('lost_camera_capture_sessions', msg.msg_id);
      handled := handled + 1;
    exception
      when others then
        raise warning 'reaper: capture session % not closed (%), left queued',
          msg.message ->> 'session_id', sqlerrm;
    end;
  end loop;
  return handled;
end $$;

-- Postgres grants EXECUTE on new functions to PUBLIC. These close sessions
-- across every node; only the scheduler (running as postgres, the owner) calls them.
revoke execute on function public.enqueue_lost_camera_capture_sessions() from public;
revoke execute on function public.drain_lost_camera_capture_sessions() from public;

do $$
declare
  existing text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pgmq') then
    raise warning 'pg_cron or pgmq absent: reaper functions exist but are not scheduled';
    return;
  end if;

  for existing in
    select jobname from cron.job
     where jobname in ('reap-lost-camera-sessions-enqueue', 'reap-lost-camera-sessions-drain')
  loop
    perform cron.unschedule(existing);
  end loop;

  perform cron.schedule('reap-lost-camera-sessions-enqueue', '* * * * *',
    'select public.enqueue_lost_camera_capture_sessions()');
  perform cron.schedule('reap-lost-camera-sessions-drain', '* * * * *',
    'select public.drain_lost_camera_capture_sessions()');
end $$;

commit;
