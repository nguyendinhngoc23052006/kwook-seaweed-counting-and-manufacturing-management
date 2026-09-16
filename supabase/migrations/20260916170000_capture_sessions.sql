-- A camera is a SESSION, not a permanent fixture.
--
-- Until now a phone WAS a station's camera forever: devices.role and
-- devices.station_id were durable properties, so a phone signed off at the end
-- of a shift still belonged to its line, and the wall could only watch its
-- heartbeat go stale. "Signed off on purpose" and "fell off the wall" were the
-- same fact to this system, which is the one distinction a supervisor actually
-- needs.
--
-- The real unit is a stretch of recording: THIS phone, running THIS function,
-- at THIS station, from this moment until it stops. One phone runs doorway
-- compliance today and belt counting tomorrow - two sessions, both kept. Ending
-- a session takes the camera off the line immediately, with no ageing and no
-- guessing.
--
-- devices stays the durable identity - every event table points at it, pairing
-- creates it, revoking it cuts the phone off. What it stops owning is the LIVE
-- assignment. devices.role and devices.station_id survive only as the defaults
-- the next session is pre-filled with; nothing reads them to decide what is
-- happening now. One fact, one place: liveness is an open session plus a recent
-- heartbeat, and nothing else.

-- ------------------------------------------------------------------ stations

-- A station's kind is the OWNER's word for what the place is - "Wash bay",
-- "Packing table", "Rear door". It was a four-value CHECK borrowed from what a
-- camera COMPUTES ('counting', 'provisioning'), which conflated the spot on the
-- floor with the algorithm pointed at it. The function moves to the session
-- below, where it belongs; the name of the place belongs to the factory.
alter table stations drop constraint stations_kind_check;

comment on column stations.kind is
  'Free text, owner-defined: what this place IS. Not what a camera does here - that is capture_sessions.camera_function.';

-- Existing rows keep whatever they were given; they are the owner's data now
-- and the Stations screen edits them freely.

-- ----------------------------------------------------------------- sessions

create table capture_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  station_id uuid references stations (id) on delete set null,
  -- Not named "function": that is a reserved word in Postgres and would need
  -- quoting at every call site. Values are the code-backed catalog in
  -- src/lib/functionsCatalog.ts - a function only exists if something can run it.
  camera_function text not null
    check (camera_function in ('provisioning', 'counting', 'compliance', 'overview')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason in ('signed_out', 'stopped', 'revoked', 'ended_by_owner')),
  algorithm_version text,
  constraint capture_sessions_ends_after_start check (ended_at is null or ended_at >= started_at)
);

create index on capture_sessions (tenant_id, started_at desc);
create index on capture_sessions (station_id, started_at desc);

-- A phone does ONE thing at a time. Without this a crashed tab that reconnects
-- would stack a second open session and the station would count itself twice
-- in any per-session rollup.
create unique index capture_sessions_one_open_per_device
  on capture_sessions (device_id) where ended_at is null;

-- Revoking a device must take it off the line in the same instant, not leave an
-- open session the wall still believes in. Doing it here rather than in the
-- Admin screen means it holds however the revoke happens.
create or replace function end_sessions_on_revoke() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update capture_sessions
       set ended_at = now(), end_reason = 'revoked'
     where device_id = new.id and ended_at is null;
  end if;
  return new;
end $$;

drop trigger if exists device_revoke_ends_sessions on devices;
create trigger device_revoke_ends_sessions
  after update of revoked_at on devices
  for each row execute function end_sessions_on_revoke();

-- --------------------------------------------------------------- provenance

-- Which stretch of recording produced this minute. Nullable: every row written
-- before this migration has no session, and a count is still valid without one.
alter table count_minutes add column session_id uuid references capture_sessions (id) on delete set null;
create index on count_minutes (session_id);

-- ---------------------------------------------------------------------- RLS

alter table capture_sessions enable row level security;

-- A device may read its OWN session - that is how it learns which function to
-- run, and rule 2 says the role comes from the server. This is not an event
-- table, so rule 1's write-only floor is untouched: a device still cannot read
-- a single count row, its own included.
create policy session_self_read on capture_sessions for select
  using (
    device_id = auth.uid()
    or (tenant_id = current_tenant() and is_human_at_least('viewer'))
  );

create policy session_device_start on capture_sessions for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
    and is_active_device()
    and ended_at is null
  );

-- A device ends its own session and nothing else. The with-check keeps it from
-- reassigning itself to another station or tenant on the way out.
create policy session_device_end on capture_sessions for update
  using (
    current_kind() = 'device'
    and device_id = auth.uid()
    and is_active_device()
  )
  with check (device_id = auth.uid() and tenant_id = current_tenant());

-- The owner ends anyone's session: this is "take that camera off the line".
create policy session_owner_manage on capture_sessions for all
  using (is_human_at_least('owner') and tenant_id = current_tenant())
  with check (is_human_at_least('owner') and tenant_id = current_tenant());

-- Grants ride beside the policies (see CLAUDE.md): a migration runs as
-- `postgres`, whose default privileges hand authenticated nothing usable, so an
-- ungranted table 403s before a policy ever runs. No DELETE anywhere - a session
-- is history and history is not deleted.
grant select, insert, update on capture_sessions to authenticated;

-- ------------------------------------------------- stations, read by cameras

-- A camera must be able to NAME where it is standing: the setup screen on the
-- phone asks which station this session is at, and station_read required
-- is_human_at_least('viewer'), which requires current_kind() = 'human'. A device
-- therefore saw an empty picker - verified against a real Postgres, not assumed.
--
-- Widened to the device's own tenant and nothing more. What a stolen phone gains
-- is the list of station names on the floor it is already standing on; it still
-- cannot read a single count row, another camera's session, or anything about a
-- person. That is the narrowest grant that makes on-device setup possible.
--
-- Note for the fact layer (issue #18): the station on a session is ASSERTED by
-- the device, as station_id on a count row always has been. Binding a count to
-- the station its open session names belongs server-side and is tracked there,
-- not bolted on here.
drop policy station_read on stations;
create policy station_read on stations for select
  using (
    tenant_id = current_tenant()
    and (is_human_at_least('viewer') or current_kind() = 'device')
  );
