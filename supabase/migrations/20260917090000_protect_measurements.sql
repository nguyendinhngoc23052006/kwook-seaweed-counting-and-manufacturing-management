-- A camera is an INSTRUMENT, not a parent. Protect the MEASUREMENT.
--
-- Today this schema protects the reviewer and not the measurement. Look at the
-- two FKs side by side:
--
--   compliance_events.reviewed_by -> profiles   (no ON DELETE, so NO ACTION)
--   count_minutes.device_id       -> devices    (ON DELETE CASCADE)
--
-- The first means you cannot delete a human who once ticked a PPE review. The
-- second means you CAN delete a camera and take a month of production with it.
-- A supervisor's signature is guarded; 21,005 counted leaves are not. That is
-- backwards, and it is not theoretical: deleting one devices row on a real
-- Postgres reproduction destroyed exactly that many counted leaves across
-- count_events, count_minutes and compliance_events, plus every heartbeat, mode
-- transition and session that described how they were produced.
--
-- A measurement belongs to the tenant, the station and the stretch of time it
-- describes. The device that produced it is PROVENANCE, recorded in the same
-- spirit as algorithm_version - a fact about how the number came to exist, not
-- an owner with the right to erase it. Provenance may never be a delete path.
--
-- So every device_id and station_id FK below is recreated ON DELETE RESTRICT.
-- Same columns, same targets; only the delete action changes. station_id stays
-- NULLABLE - a station may still be unknown, it may no longer be deletable.
--
-- Why an FK and not a revoked grant: a grant binds `authenticated` and stops
-- there. service_role holds `grant all` (20260915180000) and BYPASSRLS, and the
-- Supabase dashboard runs as a superuser role, so neither RLS nor any grant is
-- in the way of a Dashboard -> Authentication -> Users -> delete click - which
-- today cascades auth.users -> profiles -> devices -> every event the camera
-- ever wrote. A foreign key constraint binds ALL of them: service_role, the SQL
-- editor, the dashboard, a future Edge Function. RESTRICT is the only form of
-- this protection that actually holds, so RESTRICT is what we write.
--
-- RESTRICT, not NO ACTION, on purpose: NO ACTION is deferrable and is satisfied
-- if some other cascade removes the referencing row first in the same statement
-- - which is precisely the auth.users cascade above. RESTRICT refuses
-- regardless of what else the statement is doing.
--
-- Retirement of a camera or a place is a STATE, not a deletion:
-- devices.revoked_at (which already ends open sessions) and stations.active.

-- --------------------------------------------------- devices as provenance

alter table count_events
  drop constraint count_events_device_id_fkey,
  add constraint count_events_device_id_fkey
    foreign key (device_id) references devices (id) on delete restrict;

alter table count_minutes
  drop constraint count_minutes_device_id_fkey,
  add constraint count_minutes_device_id_fkey
    foreign key (device_id) references devices (id) on delete restrict;

alter table compliance_events
  drop constraint compliance_events_device_id_fkey,
  add constraint compliance_events_device_id_fkey
    foreign key (device_id) references devices (id) on delete restrict;

alter table device_heartbeats
  drop constraint device_heartbeats_device_id_fkey,
  add constraint device_heartbeats_device_id_fkey
    foreign key (device_id) references devices (id) on delete restrict;

alter table mode_transitions
  drop constraint mode_transitions_device_id_fkey,
  add constraint mode_transitions_device_id_fkey
    foreign key (device_id) references devices (id) on delete restrict;

alter table stream_sessions
  drop constraint stream_sessions_device_id_fkey,
  add constraint stream_sessions_device_id_fkey
    foreign key (device_id) references devices (id) on delete restrict;

alter table pairing_codes
  drop constraint pairing_codes_device_id_fkey,
  add constraint pairing_codes_device_id_fkey
    foreign key (device_id) references devices (id) on delete restrict;

alter table capture_sessions
  drop constraint capture_sessions_device_id_fkey,
  add constraint capture_sessions_device_id_fkey
    foreign key (device_id) references devices (id) on delete restrict;

-- The link that makes the dashboard click destructive: devices.id inherits its
-- primary key from profiles, which cascades from auth.users. Deleting the auth
-- user walked that chain all the way to the event tables. It stops here.
alter table devices
  drop constraint devices_id_fkey,
  add constraint devices_id_fkey
    foreign key (id) references profiles (id) on delete restrict;

-- ----------------------------------------------- stations as the place named

-- These were ON DELETE SET NULL, which is quieter than CASCADE and worse in one
-- specific way: it does not destroy the row, it destroys the row's ANSWER to
-- "where was this counted?". A month of counts silently detaches from the line
-- it came off, and no error is ever raised. A station that closed is
-- stations.active = false.

alter table count_events
  drop constraint count_events_station_id_fkey,
  add constraint count_events_station_id_fkey
    foreign key (station_id) references stations (id) on delete restrict;

alter table count_minutes
  drop constraint count_minutes_station_id_fkey,
  add constraint count_minutes_station_id_fkey
    foreign key (station_id) references stations (id) on delete restrict;

alter table compliance_events
  drop constraint compliance_events_station_id_fkey,
  add constraint compliance_events_station_id_fkey
    foreign key (station_id) references stations (id) on delete restrict;

alter table capture_sessions
  drop constraint capture_sessions_station_id_fkey,
  add constraint capture_sessions_station_id_fkey
    foreign key (station_id) references stations (id) on delete restrict;

alter table devices
  drop constraint devices_station_id_fkey,
  add constraint devices_station_id_fkey
    foreign key (station_id) references stations (id) on delete restrict;

alter table calibrations
  drop constraint calibrations_station_id_fkey,
  add constraint calibrations_station_id_fkey
    foreign key (station_id) references stations (id) on delete restrict;

-- ---------------------------------------------------------------- the grant

-- device_owner_write / station_owner_write / operator_owner_write are FOR ALL
-- policies, and 20260915090000 granted DELETE on all three tables. An owner's
-- token can therefore delete a camera straight through PostgREST today, even
-- though the UI ships no such button - the API is the surface, not the screen.
-- Nothing in this codebase issues a delete against these tables, so taking the
-- privilege away removes a capability we never used.
--
-- The FKs above are what actually stops the delete; this revoke stops an
-- authenticated caller from even reaching them, so the failure a stray client
-- sees is "permission denied" rather than a constraint violation reported from
-- deep inside a cascade. Retirement is revoked_at / active = false.
revoke delete on devices   from authenticated;
revoke delete on stations  from authenticated;
revoke delete on operators from authenticated;

-- Deliberately NOT protected here: validation_samples.event_id has no FK at
-- all, because it is polymorphic - it points at a count_events row OR a
-- compliance_events row. A single FK would be wrong against either target. It
-- is tech debt tracked separately, not an oversight.
