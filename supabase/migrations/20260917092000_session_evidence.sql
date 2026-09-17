-- A session records what the OWNER placed, and how long the camera proved it
-- was there.
--
-- Two holes this closes. First, placement: a phone asserted its own station_id
-- and camera_function when it opened a session (src/services/captureSessions.ts
-- passes both up), so the owner's assignment on the devices row was decoration
-- and the phone's choice was the fact. Second, time: a session that ends
-- because a camera vanished has no honest end - nothing recorded the last
-- moment that camera proved it was alive, so any closing time would be a guess
-- dressed as a measurement.
--
-- So the server takes both back. A before-insert trigger overwrites placement
-- from the devices/stations/lines rows, and every heartbeat advances
-- last_evidence_at on the open session - the one number migration
-- 20260917093000 is allowed to close a vanished session with.

-- ------------------------------------------------- what a session remembers

-- The names are SNAPSHOTS, not lookups. A report about last March must still
-- read "Line 2 / Wash bay / Phone 7" after the line is renamed and the phone
-- relabelled, for the same reason algorithm_version rides every count row: the
-- record says what was true when it was written. station_id keeps pointing at
-- the live row for joins; these three columns are the frozen words.
alter table capture_sessions
  add column line_name text,
  add column station_name text,
  add column device_label text,
  -- The last instant this camera PROVED it was recording (its newest heartbeat,
  -- clamped to server time). Null until the first heartbeat of the session.
  add column last_evidence_at timestamptz;

-- Rows written before this migration keep null names on purpose. Today's names
-- are not evidence of yesterday's placement, and back-filling them would put a
-- guess in the column whose whole job is to be the record.

-- ------------------------------------------------------------ 'lost' as an end

-- The four existing reasons all describe a deliberate act - someone signed out,
-- stopped, revoked, or took the camera off the line. A camera that simply
-- vanished did none of them. Naming it 'lost' keeps "we ended this" and "it
-- stopped answering" distinguishable forever, which is the distinction a
-- supervisor reading uptime actually needs.
alter table capture_sessions drop constraint capture_sessions_end_reason_check;
alter table capture_sessions add constraint capture_sessions_end_reason_check
  check (end_reason in ('signed_out', 'stopped', 'revoked', 'ended_by_owner', 'lost'));

-- ---------------------------------------------- one open session per station

-- Two phones pointed at one station silently DOUBLE its totals: unique
-- (device_id, minute) on count_minutes is per device, so both write their own
-- row for the same minute and every sum over the station adds them together.
-- The station is the unit being measured, so the station is where "one camera
-- at a time" has to be enforced.
--
-- Existing duplicates are closed first, oldest-first, keeping each station's
-- newest open session. ended_at = started_at, not now(): these sessions have no
-- evidence of having run for a single second, and now() would mint uptime out
-- of a data-repair statement. A tuple comparison orders by start with id as the
-- tie-break, so exactly one row per station survives.
update capture_sessions c
   set ended_at = c.started_at, end_reason = 'lost'
 where c.ended_at is null
   and c.station_id is not null
   and exists (
     select 1 from capture_sessions newer
      where newer.ended_at is null
        and newer.station_id = c.station_id
        and (newer.started_at, newer.id) > (c.started_at, c.id)
   );

-- station_id is nullable and nulls are distinct in a unique index, so sessions
-- with no station (a phone still being set up) do not collide with each other.
create unique index capture_sessions_one_open_per_station
  on capture_sessions (station_id) where ended_at is null;

-- -------------------------------------------- the owner is the placement authority

-- The device may not choose where it is or what it does. Whatever a phone puts
-- in station_id and camera_function is overwritten here from ITS OWN devices
-- row, and the three name columns are filled from devices/stations/lines. A
-- compromised or merely out-of-date phone can therefore post anything it likes
-- and the row that lands still says what the owner assigned - placement is
-- structurally server-side, not server-side by convention.
--
-- Security definer because the reads must succeed for the caller that inserts
-- most sessions: a device. Under RLS a device can read its own devices row and
-- its tenant's stations, but `lines` has no device read policy (migration
-- 20260917091000, deliberately - a camera learns its line from this snapshot,
-- not by listing the factory), so an invoker-rights trigger would silently
-- write a null line_name for every camera-started session. The blast radius is
-- three reads and the NEW row: this function writes nothing anywhere else.
--
-- No revoke needed: the function returns trigger, and Postgres refuses to call
-- a trigger function directly from SQL.
create or replace function capture_session_snapshot_placement() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  assigned record;
  occupant_label text;
begin
  select d.name as device_name, d.camera_function, d.station_id,
         s.name as station_name, l.name as line_name
    into assigned
    from devices d
    left join stations s on s.id = d.station_id
    left join lines l on l.id = s.line_id
   where d.id = new.device_id;

  if not found then
    raise exception 'no device row for %', new.device_id
      using errcode = 'foreign_key_violation';
  end if;

  new.station_id := assigned.station_id;
  new.camera_function := assigned.camera_function;
  new.device_label := assigned.device_name;
  new.station_name := assigned.station_name;
  new.line_name := assigned.line_name;

  -- capture_sessions_one_open_per_station is the enforcer; this is the same
  -- rejection with a message a person can act on. Postgres reports a unique
  -- index violation as a constraint name and a uuid, which tells the owner
  -- nothing about which camera is already standing at the station they just
  -- assigned this one to. Concurrent inserts still fall through to the index,
  -- so the guarantee does not depend on this check winning the race.
  if new.station_id is not null and new.ended_at is null then
    select c.device_label into occupant_label
      from capture_sessions c
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

drop trigger if exists capture_session_snapshots_placement on capture_sessions;
create trigger capture_session_snapshots_placement
  before insert on capture_sessions
  for each row execute function capture_session_snapshot_placement();

-- ------------------------------------------- heartbeats are the session's evidence

-- One trigger per fact: device_heartbeats already feeds devices.last_seen_at
-- (migration 20260916000000), and the session's evidence is the same fact read
-- at a different grain. Extending that function keeps a heartbeat writing both
-- projections in one pass instead of two triggers racing over one insert.
--
-- The clamp carries over for the reason that migration states: `at` is an
-- ordinary insertable column no policy constrains, so a stolen phone can post
-- at = '2999-01-01'. Here that would be worse than a wrong Wall reading - it
-- would make the session immortal, since the reaper closes on last_evidence_at
-- and would be handed a time that never arrives. least(new.at, now()) takes the
-- choice away from the device, and the forward-only guard makes a replayed
-- queue of stale heartbeats harmless.
create or replace function device_touch_last_seen() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  update devices
     set last_seen_at = least(new.at, now())
   where id = new.device_id
     and (last_seen_at is null or last_seen_at < least(new.at, now()));

  update capture_sessions
     set last_evidence_at = least(new.at, now())
   where device_id = new.device_id
     and ended_at is null
     and (last_evidence_at is null or last_evidence_at < least(new.at, now()));

  return null;
end $$;

-- ------------------------------------------------------- a drifting clock is visible

-- count_minutes.minute is built from the PHONE's clock (src/pages/Capture.tsx
-- keys each minute off new Date()), and a phone whose clock is twenty minutes
-- out files perfectly well-formed rows against minutes that never happened at
-- the station. Today nothing records that, so the drift is invisible: the count
-- is simply filed under the wrong minute and the shift total quietly moves.
--
-- received_at is the server's own stamp and skew_seconds is the gap between the
-- two. Together they turn an invisible failure into a measurable one - a
-- report's data-quality section can say "this station's clock ran 19 minutes
-- fast" instead of showing a hole at 14:00 and a spike at 14:20.
alter table count_minutes
  add column received_at timestamptz not null default now(),
  add column skew_seconds int;

-- Both are set by the trigger below, not by the default alone: authenticated
-- holds INSERT on the whole table, so a device can name any received_at it
-- likes, and a stamp a device can choose measures nothing. Overwriting in a
-- before-insert trigger is what makes it unforgeable. No security definer and
-- no grants: this touches only the NEW row, and the columns inherit
-- count_minutes' existing privileges.
create or replace function count_minute_stamp_receipt() returns trigger
  language plpgsql as $$
begin
  new.received_at := now();
  new.skew_seconds := extract(epoch from now() - new.minute)::int;
  return new;
end $$;

drop trigger if exists count_minute_stamps_receipt on count_minutes;
create trigger count_minute_stamps_receipt
  before insert on count_minutes
  for each row execute function count_minute_stamp_receipt();

comment on column count_minutes.skew_seconds is
  'Server receipt minus the phone-generated minute key, in seconds. Positive means the phone clock is behind. Data quality, never a correction - the count is filed where the camera said it happened.';

-- ---------------------------------------- the snapshot is not writable by hand

-- A grant, not a policy, because the thing to restrict is WHICH COLUMNS may be
-- written, and RLS cannot see that: session_device_end's with-check pins
-- device_id and tenant_id, and a row passing it may still carry any
-- last_evidence_at the phone chose. Left as-is, a device holding table-wide
-- UPDATE could post last_evidence_at = '2999-01-01' and make itself permanently
-- alive - the exact forgery the heartbeat clamp above exists to deny, walked in
-- through a different door. It could equally rewrite station_name and make its
-- own session say it stood somewhere it never stood.
--
-- What is left is what a client legitimately writes: the end of a session. The
-- snapshot columns are written once by the insert trigger, last_evidence_at
-- only by the heartbeat trigger (security definer, so it is unaffected by this
-- revoke), and the reaper runs as the table owner. Column privileges are
-- checked before any policy, so an attempt fails 42501 whoever makes it.
revoke update on capture_sessions from authenticated;
grant update (ended_at, end_reason) on capture_sessions to authenticated;
