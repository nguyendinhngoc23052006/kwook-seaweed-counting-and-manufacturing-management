-- Camera / vision devices, folded in from the standalone seaweed-counting app.
--
-- Single-tenant: written fresh in this database, so there is no live tenant_id
-- column to preserve -- Kwook is the only org here, full stop. A station is a
-- physical camera position; org_node_id is what every capability check keys
-- on, exactly like every other feature in this schema.
--
-- Device pairing is unchanged in spirit: a device is a real auth.users row
-- (email+password, generated once and shown once) tied 1:1 to a camera_devices
-- row. Only the ADMIN side is new: creating and revoking a device requires
-- org_admin() (sysadmin or CEO) or a delegated capability -- never a parallel
-- role system. Device write-only / no-self-elevation guarantees are unchanged.

begin;

-- =====================================================================================
-- 1. Three new capabilities, appended to the existing catalogue
-- =====================================================================================

insert into public.capability_types (key, sort_order, note)
select v.key, v.sort_order, v.note
  from (values
    ('manage_camera_devices', 130, 'Pair, revoke and configure camera devices at or below this node'),
    ('view_camera_data',      140, 'See device fleet health, counts and compliance checks at or below this node'),
    ('export_camera_data',    150, 'Export raw camera event data -- catalogued now, enforced once export tooling ships')
  ) as v(key, sort_order, note)
 on conflict (key) do nothing;

-- =====================================================================================
-- 2. Stations and operators -- physical placement, plain capability-gated tables
-- =====================================================================================
--
-- No auth-account creation involved here, so unlike devices these need no RPC
-- layer at all -- a capability-gated RLS policy is the whole story, exactly
-- like every other simple admin-CRUD table in this schema.

create table if not exists public.camera_stations (
  id         uuid primary key default gen_random_uuid(),
  org_node_id uuid not null references public.org_nodes(id) on delete restrict,
  name       text not null check (length(btrim(name)) > 0),
  line       text not null,
  kind       text not null check (kind in ('provisioning', 'counting', 'compliance', 'overview')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists camera_stations_node_idx on public.camera_stations(org_node_id);
alter table public.camera_stations enable row level security;

create table if not exists public.camera_operators (
  id         uuid primary key default gen_random_uuid(),
  org_node_id uuid not null references public.org_nodes(id) on delete restrict,
  name       text not null check (length(btrim(name)) > 0),
  badge_id   text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_node_id, badge_id)
);
create index if not exists camera_operators_node_idx on public.camera_operators(org_node_id);
alter table public.camera_operators enable row level security;

drop policy if exists camera_stations_read on public.camera_stations;
create policy camera_stations_read on public.camera_stations for select
  using (public.org_admin()
      or public.org_capability_reaches('view_camera_data', org_node_id)
      or public.org_capability_reaches('manage_camera_devices', org_node_id));
drop policy if exists camera_stations_write on public.camera_stations;
create policy camera_stations_write on public.camera_stations for all
  using (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id))
  with check (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id));

drop policy if exists camera_operators_read on public.camera_operators;
create policy camera_operators_read on public.camera_operators for select
  using (public.org_admin()
      or public.org_capability_reaches('view_camera_data', org_node_id)
      or public.org_capability_reaches('manage_camera_devices', org_node_id));
drop policy if exists camera_operators_write on public.camera_operators;
create policy camera_operators_write on public.camera_operators for all
  using (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id))
  with check (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id));

grant select, insert, update, delete on public.camera_stations to authenticated;
grant select, insert, update, delete on public.camera_operators to authenticated;

-- =====================================================================================
-- 3. camera_devices -- a real auth account per device, no INSERT/UPDATE grant to anyone
-- =====================================================================================
--
-- Creating a device means creating a Supabase Auth user, which only the Admin
-- API can do (never plain RLS). So this table takes NO insert/update grant at
-- all for anon/authenticated -- the only ways in are the two SECURITY DEFINER
-- RPCs below, which write with their OWN privilege as the function's definer
-- regardless of the caller's table grants. That is the guard; there is
-- nothing left for a guard trigger to add here.

create table if not exists public.camera_devices (
  id               uuid primary key references auth.users(id) on delete cascade,
  org_node_id      uuid not null references public.org_nodes(id) on delete restrict,
  station_id       uuid references public.camera_stations(id) on delete set null,
  name             text not null check (length(btrim(name)) > 0),
  role             text not null check (role in ('provisioning', 'counting', 'compliance', 'overview')),
  last_seen_at     timestamptz,
  app_version      text,
  algorithm_version text,
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id) on delete set null
);
create index if not exists camera_devices_node_idx on public.camera_devices(org_node_id);
alter table public.camera_devices enable row level security;

drop policy if exists camera_devices_self on public.camera_devices;
create policy camera_devices_self on public.camera_devices for select
  using (id = auth.uid());
drop policy if exists camera_devices_human_read on public.camera_devices;
create policy camera_devices_human_read on public.camera_devices for select
  using (public.org_admin()
      or public.org_capability_reaches('view_camera_data', org_node_id)
      or public.org_capability_reaches('manage_camera_devices', org_node_id));

revoke all on public.camera_devices from public, anon, authenticated;
grant select on public.camera_devices to anon, authenticated;

commit;

begin;

-- =====================================================================================
-- 4. Event tables -- device writes its own rows, humans read by capability
-- =====================================================================================
--
-- org_node_id is stamped by a trigger from the device's own row (section 6),
-- never sent by the device -- a device cannot claim to belong to a different
-- node than the one it was created under.

create table if not exists public.camera_count_events (
  id                 uuid primary key,
  org_node_id        uuid not null references public.org_nodes(id) on delete restrict,
  device_id          uuid not null references public.camera_devices(id) on delete cascade,
  station_id         uuid references public.camera_stations(id) on delete set null,
  operator_id        uuid references public.camera_operators(id) on delete set null,
  captured_at        timestamptz not null,
  count              int not null check (count >= 0),
  confidence         real not null,
  algorithm_version  text not null,
  crop_key           text,
  blob_count         int,
  median_leaf_area_px real,
  otsu_threshold     int,
  created_at         timestamptz not null default now()
);
create index if not exists camera_count_events_node_idx on public.camera_count_events(org_node_id, captured_at);
create index if not exists camera_count_events_station_idx on public.camera_count_events(station_id, captured_at);
alter table public.camera_count_events enable row level security;

create table if not exists public.camera_count_minutes (
  id                uuid primary key,
  org_node_id       uuid not null references public.org_nodes(id) on delete restrict,
  device_id         uuid not null references public.camera_devices(id) on delete cascade,
  station_id        uuid references public.camera_stations(id) on delete set null,
  operator_id       uuid references public.camera_operators(id) on delete set null,
  minute            timestamptz not null,
  count             int not null check (count >= 0),
  mean_area         real,
  belt_speed_est    real,
  tracks_created    int not null default 0,
  tracks_counted    int not null default 0,
  achieved_fps      real,
  algorithm_version text not null,
  unique (device_id, minute)
);
create index if not exists camera_count_minutes_node_idx on public.camera_count_minutes(org_node_id, minute);
alter table public.camera_count_minutes enable row level security;

create table if not exists public.camera_compliance_events (
  id            uuid primary key,
  org_node_id   uuid not null references public.org_nodes(id) on delete restrict,
  device_id     uuid not null references public.camera_devices(id) on delete cascade,
  station_id    uuid references public.camera_stations(id) on delete set null,
  operator_id   uuid references public.camera_operators(id) on delete set null,
  captured_at   timestamptz not null,
  checks        jsonb not null,
  passed        boolean not null,
  image_key     text,
  model_version text not null,
  reviewed_by   uuid references public.persons(id) on delete set null,
  reviewed_at   timestamptz
);
create index if not exists camera_compliance_events_node_idx on public.camera_compliance_events(org_node_id, captured_at);
alter table public.camera_compliance_events enable row level security;

create table if not exists public.camera_device_heartbeats (
  id            bigserial primary key,
  org_node_id   uuid not null references public.org_nodes(id) on delete restrict,
  device_id     uuid not null references public.camera_devices(id) on delete cascade,
  at            timestamptz not null default now(),
  mode          text not null,
  battery_pct   int,
  thermal_state text,
  achieved_fps  real
);
create index if not exists camera_device_heartbeats_device_idx on public.camera_device_heartbeats(device_id, at desc);
alter table public.camera_device_heartbeats enable row level security;

create table if not exists public.camera_mode_transitions (
  id          bigserial primary key,
  org_node_id uuid not null references public.org_nodes(id) on delete restrict,
  device_id   uuid not null references public.camera_devices(id) on delete cascade,
  from_mode   text not null,
  to_mode     text not null,
  by_user     uuid references public.persons(id) on delete set null,
  at          timestamptz not null default now(),
  reason      text
);
alter table public.camera_mode_transitions enable row level security;

-- No real streaming yet (the ported Wall/fleet screen still shows a
-- placeholder, matching the source app's own honesty about this). These two
-- tables exist so the capability gate and audit shape are ready the day a
-- real player is wired in -- not to invent streaming infrastructure early.

create table if not exists public.camera_stream_sessions (
  id          uuid primary key default gen_random_uuid(),
  org_node_id uuid not null references public.org_nodes(id) on delete restrict,
  device_id   uuid not null references public.camera_devices(id) on delete cascade,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  end_reason  text
);
alter table public.camera_stream_sessions enable row level security;

create table if not exists public.camera_stream_views (
  id          uuid primary key default gen_random_uuid(),
  org_node_id uuid not null references public.org_nodes(id) on delete restrict,
  session_id  uuid not null references public.camera_stream_sessions(id) on delete cascade,
  viewer_id   uuid not null references public.persons(id) on delete cascade,
  attached_at timestamptz not null default now(),
  detached_at timestamptz
);
alter table public.camera_stream_views enable row level security;

create table if not exists public.camera_calibrations (
  id          uuid primary key default gen_random_uuid(),
  org_node_id uuid not null references public.org_nodes(id) on delete restrict,
  station_id  uuid not null references public.camera_stations(id) on delete cascade,
  param       text not null,
  value       jsonb not null,
  set_by      uuid references public.persons(id) on delete set null,
  valid_from  timestamptz not null default now()
);
alter table public.camera_calibrations enable row level security;

create table if not exists public.camera_validation_samples (
  id           uuid primary key default gen_random_uuid(),
  org_node_id  uuid not null references public.org_nodes(id) on delete restrict,
  event_id     uuid not null,
  manual_count int not null,
  counted_by   uuid references public.persons(id) on delete set null,
  at           timestamptz not null default now()
);
alter table public.camera_validation_samples enable row level security;

commit;

begin;

-- =====================================================================================
-- 5. RLS for the event tables -- device inserts its own, humans read by capability
-- =====================================================================================

drop policy if exists camera_count_events_device_insert on public.camera_count_events;
create policy camera_count_events_device_insert on public.camera_count_events for insert
  with check (device_id = auth.uid());
drop policy if exists camera_count_events_read on public.camera_count_events;
create policy camera_count_events_read on public.camera_count_events for select
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id));

drop policy if exists camera_count_minutes_device_insert on public.camera_count_minutes;
create policy camera_count_minutes_device_insert on public.camera_count_minutes for insert
  with check (device_id = auth.uid());
drop policy if exists camera_count_minutes_upsert on public.camera_count_minutes;
create policy camera_count_minutes_upsert on public.camera_count_minutes for update
  using (device_id = auth.uid()) with check (device_id = auth.uid());
drop policy if exists camera_count_minutes_read on public.camera_count_minutes;
create policy camera_count_minutes_read on public.camera_count_minutes for select
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id));

drop policy if exists camera_compliance_device_insert on public.camera_compliance_events;
create policy camera_compliance_device_insert on public.camera_compliance_events for insert
  with check (device_id = auth.uid());
drop policy if exists camera_compliance_read on public.camera_compliance_events;
create policy camera_compliance_read on public.camera_compliance_events for select
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id));
drop policy if exists camera_compliance_review on public.camera_compliance_events;
create policy camera_compliance_review on public.camera_compliance_events for update
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id))
  with check (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id));

drop policy if exists camera_heartbeats_device_insert on public.camera_device_heartbeats;
create policy camera_heartbeats_device_insert on public.camera_device_heartbeats for insert
  with check (device_id = auth.uid());
drop policy if exists camera_heartbeats_read on public.camera_device_heartbeats;
create policy camera_heartbeats_read on public.camera_device_heartbeats for select
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id));

drop policy if exists camera_mode_device_insert on public.camera_mode_transitions;
create policy camera_mode_device_insert on public.camera_mode_transitions for insert
  with check (device_id = auth.uid());
drop policy if exists camera_mode_read on public.camera_mode_transitions;
create policy camera_mode_read on public.camera_mode_transitions for select
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id));

drop policy if exists camera_stream_session_device_write on public.camera_stream_sessions;
create policy camera_stream_session_device_write on public.camera_stream_sessions for insert
  with check (device_id = auth.uid());
drop policy if exists camera_stream_session_read on public.camera_stream_sessions;
create policy camera_stream_session_read on public.camera_stream_sessions for select
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id));

drop policy if exists camera_stream_view_self on public.camera_stream_views;
create policy camera_stream_view_self on public.camera_stream_views for all
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id))
  with check (viewer_id = public.org_current_person_id());

drop policy if exists camera_calibration_read on public.camera_calibrations;
create policy camera_calibration_read on public.camera_calibrations for select
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id));
drop policy if exists camera_calibration_write on public.camera_calibrations;
create policy camera_calibration_write on public.camera_calibrations for all
  using (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id))
  with check (public.org_admin() or public.org_capability_reaches('manage_camera_devices', org_node_id));

drop policy if exists camera_validation_rw on public.camera_validation_samples;
create policy camera_validation_rw on public.camera_validation_samples for all
  using (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id))
  with check (public.org_admin() or public.org_capability_reaches('view_camera_data', org_node_id));

-- bigserial PKs need their sequence's own USAGE grant for a direct device
-- insert to advance them; every other table here is either RPC-written
-- (whose SECURITY DEFINER privilege covers this for free) or uuid-keyed.
grant usage, select on sequence public.camera_device_heartbeats_id_seq to authenticated;
grant usage, select on sequence public.camera_mode_transitions_id_seq to authenticated;

grant select, insert on public.camera_count_events        to authenticated;
grant select, insert, update on public.camera_count_minutes to authenticated;
grant select, insert, update on public.camera_compliance_events to authenticated;
grant select, insert on public.camera_device_heartbeats   to authenticated;
grant select, insert on public.camera_mode_transitions    to authenticated;
grant select, insert on public.camera_stream_sessions     to authenticated;
grant select, insert, update on public.camera_stream_views to authenticated;
grant select on public.camera_calibrations                to authenticated;
grant insert, update, delete on public.camera_calibrations to authenticated;
grant select, insert on public.camera_validation_samples  to authenticated;

-- =====================================================================================
-- 6. Two small triggers -- derive, never duplicate-write
-- =====================================================================================
--
-- org_node_id is never sent by the device; it is stamped from the device's
-- OWN row, so a device can never claim a different node than the one it was
-- created under. last_seen_at is never written directly either -- a device
-- only ever inserts a heartbeat, and this bumps the parent row from that,
-- the same "derive, don't duplicate-write" rule this schema already follows
-- for org_tree and org_audit.
--
-- This is also the ONLY place a revoked device is actually stopped -- the
-- device's own app already refuses to run once it sees revoked_at (UX), but
-- that check is client-side only; every table this trigger guards is where
-- the real, server-side refusal lives.

create or replace function public.camera_stamp_node_id()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_revoked timestamptz;
begin
  select org_node_id, revoked_at into new.org_node_id, v_revoked
    from public.camera_devices where id = new.device_id;
  if new.org_node_id is null then
    raise exception 'no such device' using errcode = '22023';
  end if;
  if v_revoked is not null then
    raise exception 'this device has been revoked' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace trigger camera_stamp_node_id before insert on public.camera_count_events
  for each row execute function public.camera_stamp_node_id();
create or replace trigger camera_stamp_node_id before insert on public.camera_count_minutes
  for each row execute function public.camera_stamp_node_id();
-- Also on UPDATE: the device's own upsert-retry path (an outbox replay that
-- lands on an already-synced minute) goes through UPDATE, not INSERT, and
-- would otherwise skip the revoked-device check above.
create or replace trigger camera_stamp_node_id_upd before update on public.camera_count_minutes
  for each row execute function public.camera_stamp_node_id();
create or replace trigger camera_stamp_node_id before insert on public.camera_compliance_events
  for each row execute function public.camera_stamp_node_id();
create or replace trigger camera_stamp_node_id before insert on public.camera_device_heartbeats
  for each row execute function public.camera_stamp_node_id();
create or replace trigger camera_stamp_node_id before insert on public.camera_mode_transitions
  for each row execute function public.camera_stamp_node_id();
create or replace trigger camera_stamp_node_id before insert on public.camera_stream_sessions
  for each row execute function public.camera_stamp_node_id();

create or replace function public.camera_bump_last_seen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.camera_devices set last_seen_at = new.at where id = new.device_id;
  return new;
end $$;

create or replace trigger camera_bump_last_seen after insert on public.camera_device_heartbeats
  for each row execute function public.camera_bump_last_seen();

commit;

begin;

-- =====================================================================================
-- 7. org_camera_can_manage -- the one check the Edge Function calls with the
--    CALLER'S OWN token, before it ever switches to the service role
-- =====================================================================================

create or replace function public.org_camera_can_manage(p_node_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_admin() or public.org_capability_reaches('manage_camera_devices', p_node_id);
$$;

-- =====================================================================================
-- 8. org_camera_create_device -- service_role only. The Edge Function has
--    already verified the caller via (7) and already created the auth.users
--    row via the Admin API before calling this; this is only the write-back.
-- =====================================================================================
--
-- p_created_by_account_id is recorded for the audit trail only -- it is NOT
-- re-checked here, because by the time a service-role call reaches this
-- function the original caller's identity is no longer carried in auth.uid().
-- The capability check in (7), made with the caller's own token, is the
-- actual gate; this function's own grant (service_role only, below) is what
-- stops anyone from calling it directly and skipping that gate.

create or replace function public.org_camera_create_device(
  p_account_id uuid,
  p_node_id uuid,
  p_name text,
  p_role text,
  p_created_by_account_id uuid,
  p_station_id uuid default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_role not in ('provisioning', 'counting', 'compliance', 'overview') then
    raise exception 'invalid device role: %', p_role using errcode = '22023';
  end if;
  if not exists (select 1 from public.org_nodes where id = p_node_id) then
    raise exception 'no such node' using errcode = '22023';
  end if;
  if p_station_id is not null
     and not exists (select 1 from public.camera_stations where id = p_station_id) then
    raise exception 'no such station' using errcode = '22023';
  end if;

  insert into public.camera_devices (id, org_node_id, station_id, name, role, created_by)
    values (p_account_id, p_node_id, p_station_id, btrim(p_name), p_role, p_created_by_account_id);

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action, after_json)
    values (p_created_by_account_id, 'camera_device', p_account_id::text, p_node_id, 'device_created',
      jsonb_build_object('name', btrim(p_name), 'role', p_role, 'station_id', p_station_id));
end $$;

-- =====================================================================================
-- 9. org_camera_revoke_device -- authenticated, guarded internally (same
--    shape as every other capability-gated RPC in this schema; no Admin API
--    involved, so no Edge Function is needed for this one).
-- =====================================================================================

create or replace function public.org_camera_revoke_device(p_device_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_node_id uuid;
begin
  select org_node_id into v_node_id from public.camera_devices
   where id = p_device_id and revoked_at is null;
  if v_node_id is null then
    raise exception 'no such active device' using errcode = '22023';
  end if;
  if not public.org_camera_can_manage(v_node_id) then
    raise exception 'you cannot manage cameras at this node' using errcode = '42501';
  end if;

  update public.camera_devices set revoked_at = now() where id = p_device_id;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action)
    values (auth.uid(), 'camera_device', p_device_id::text, v_node_id, 'device_revoked');
end $$;

-- =====================================================================================
-- 10. Grants
-- =====================================================================================

revoke all on function public.org_camera_can_manage(uuid) from public;
grant execute on function public.org_camera_can_manage(uuid) to authenticated;

revoke all on function public.org_camera_create_device(uuid,uuid,text,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.org_camera_create_device(uuid,uuid,text,text,uuid,uuid) to service_role;

revoke all on function public.org_camera_revoke_device(uuid) from public, anon;
grant execute on function public.org_camera_revoke_device(uuid) to authenticated;

commit;
