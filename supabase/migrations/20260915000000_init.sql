create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- identity

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  kind text not null check (kind in ('device', 'human')),
  role text not null check (role in ('viewer', 'supervisor', 'manager', 'admin')),
  display_name text not null,
  created_at timestamptz not null default now()
);
create index on profiles (tenant_id);

-- Security definer: policies must read the caller's own profile without
-- recursing through profiles' own RLS.
create or replace function current_tenant() returns uuid
  language sql stable security definer set search_path = public as $$
  select tenant_id from profiles where id = auth.uid()
$$;

create or replace function current_kind() returns text
  language sql stable security definer set search_path = public as $$
  select kind from profiles where id = auth.uid()
$$;

create or replace function current_role_name() returns text
  language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function role_rank(r text) returns int
  language sql immutable as $$
  select case r
    when 'viewer' then 1 when 'supervisor' then 2
    when 'manager' then 3 when 'admin' then 4 else 0 end
$$;

create or replace function is_human_at_least(min_role text) returns boolean
  language sql stable security definer set search_path = public as $$
  select current_kind() = 'human' and role_rank(current_role_name()) >= role_rank(min_role)
$$;

-- ---------------------------------------------------------------- estate

create table stations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  line text not null,
  kind text not null check (kind in ('provisioning', 'counting', 'compliance', 'overview')),
  active boolean not null default true
);
create index on stations (tenant_id);

create table devices (
  id uuid primary key references profiles (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  role text not null check (role in ('provisioning', 'counting', 'compliance', 'overview')),
  station_id uuid references stations (id) on delete set null,
  last_seen_at timestamptz,
  app_version text,
  algorithm_version text,
  revoked_at timestamptz
);
create index on devices (tenant_id);

create table operators (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  badge_id text not null,
  active boolean not null default true,
  unique (tenant_id, badge_id)
);

create table pairing_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- ---------------------------------------------------------------- measurement

-- provisioning stations: one row per tray
create table count_events (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  station_id uuid references stations (id) on delete set null,
  operator_id uuid references operators (id) on delete set null,
  captured_at timestamptz not null,
  count int not null check (count >= 0),
  confidence real not null,
  algorithm_version text not null,
  crop_key text,
  blob_count int,
  median_leaf_area_px real,
  otsu_threshold int,
  created_at timestamptz not null default now()
);
create index on count_events (tenant_id, captured_at);
create index on count_events (station_id, captured_at);

-- belt stations: one row per minute
create table count_minutes (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  station_id uuid references stations (id) on delete set null,
  operator_id uuid references operators (id) on delete set null,
  minute timestamptz not null,
  count int not null check (count >= 0),
  mean_area real,
  belt_speed_est real,
  tracks_created int not null default 0,
  tracks_counted int not null default 0,
  achieved_fps real,
  algorithm_version text not null,
  unique (device_id, minute)
);
create index on count_minutes (tenant_id, minute);

create table compliance_events (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  station_id uuid references stations (id) on delete set null,
  operator_id uuid references operators (id) on delete set null,
  captured_at timestamptz not null,
  checks jsonb not null,
  passed boolean not null,
  image_key text,
  model_version text not null,
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz
);
create index on compliance_events (tenant_id, captured_at);

-- ---------------------------------------------------------------- operations

create table device_heartbeats (
  id bigserial primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  at timestamptz not null default now(),
  mode text not null,
  battery_pct int,
  thermal_state text,
  achieved_fps real
);
create index on device_heartbeats (device_id, at desc);

create table mode_transitions (
  id bigserial primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  from_mode text not null,
  to_mode text not null,
  by_user uuid references profiles (id),
  at timestamptz not null default now(),
  reason text
);

create table stream_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text
);

create table stream_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  session_id uuid not null references stream_sessions (id) on delete cascade,
  viewer_id uuid not null references profiles (id) on delete cascade,
  attached_at timestamptz not null default now(),
  detached_at timestamptz
);

create table calibrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  station_id uuid not null references stations (id) on delete cascade,
  param text not null,
  value jsonb not null,
  set_by uuid references profiles (id),
  valid_from timestamptz not null default now()
);

create table validation_samples (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  event_id uuid not null,
  manual_count int not null,
  counted_by uuid references profiles (id),
  at timestamptz not null default now()
);

create table access_log (
  id bigserial primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  actor_id uuid references profiles (id),
  action text not null,
  target text,
  at timestamptz not null default now()
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  generated_at timestamptz not null default now(),
  snapshot jsonb not null,
  algorithm_versions jsonb not null,
  unique (tenant_id, period_start, period_end)
);

-- ---------------------------------------------------------------- RLS
-- Device accounts are WRITE-ONLY. They get INSERT on the tables they produce
-- and SELECT on nothing but their own devices row. This is deliberate: a
-- device credential lives on an unattended phone on a factory floor.

alter table tenants             enable row level security;
alter table profiles            enable row level security;
alter table stations            enable row level security;
alter table devices             enable row level security;
alter table operators           enable row level security;
alter table pairing_codes       enable row level security;
alter table count_events        enable row level security;
alter table count_minutes       enable row level security;
alter table compliance_events   enable row level security;
alter table device_heartbeats   enable row level security;
alter table mode_transitions    enable row level security;
alter table stream_sessions     enable row level security;
alter table stream_views        enable row level security;
alter table calibrations        enable row level security;
alter table validation_samples  enable row level security;
alter table access_log          enable row level security;
alter table reports             enable row level security;

create policy tenant_read on tenants for select
  using (id = current_tenant());

create policy profile_self on profiles for select
  using (id = auth.uid() or is_human_at_least('manager'));

create policy device_self on devices for select
  using (id = auth.uid() or is_human_at_least('viewer'));
create policy device_admin_write on devices for all
  using (is_human_at_least('admin') and tenant_id = current_tenant())
  with check (is_human_at_least('admin') and tenant_id = current_tenant());

create policy station_read on stations for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));
create policy station_admin_write on stations for all
  using (is_human_at_least('admin') and tenant_id = current_tenant())
  with check (is_human_at_least('admin') and tenant_id = current_tenant());

create policy operator_read on operators for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));
create policy operator_admin_write on operators for all
  using (is_human_at_least('admin') and tenant_id = current_tenant())
  with check (is_human_at_least('admin') and tenant_id = current_tenant());

create policy pairing_admin on pairing_codes for all
  using (is_human_at_least('admin') and tenant_id = current_tenant())
  with check (is_human_at_least('admin') and tenant_id = current_tenant());

create policy count_events_device_insert on count_events for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
  );
create policy count_events_read on count_events for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));

create policy count_minutes_device_insert on count_minutes for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
  );
create policy count_minutes_read on count_minutes for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));

create policy compliance_device_insert on compliance_events for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
  );
create policy compliance_read on compliance_events for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));
create policy compliance_review on compliance_events for update
  using (tenant_id = current_tenant() and is_human_at_least('supervisor'))
  with check (tenant_id = current_tenant() and is_human_at_least('supervisor'));

create policy heartbeat_device_insert on device_heartbeats for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
  );
create policy heartbeat_read on device_heartbeats for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));

create policy mode_device_insert on mode_transitions for insert
  with check (current_kind() = 'device' and device_id = auth.uid() and tenant_id = current_tenant());
create policy mode_read on mode_transitions for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));

create policy stream_session_device_write on stream_sessions for insert
  with check (current_kind() = 'device' and device_id = auth.uid() and tenant_id = current_tenant());
create policy stream_session_read on stream_sessions for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));

create policy stream_view_self on stream_views for all
  using (tenant_id = current_tenant() and is_human_at_least('viewer'))
  with check (tenant_id = current_tenant() and viewer_id = auth.uid());

create policy calibration_read on calibrations for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));
create policy calibration_admin on calibrations for all
  using (is_human_at_least('admin') and tenant_id = current_tenant())
  with check (is_human_at_least('admin') and tenant_id = current_tenant());

create policy validation_rw on validation_samples for all
  using (tenant_id = current_tenant() and is_human_at_least('supervisor'))
  with check (tenant_id = current_tenant() and is_human_at_least('supervisor'));

create policy access_log_read on access_log for select
  using (tenant_id = current_tenant() and is_human_at_least('manager'));

-- Reports are written by the scheduled job (service role, which bypasses RLS)
-- and are immutable to everyone else. No update or delete policy exists.
create policy report_read on reports for select
  using (tenant_id = current_tenant() and is_human_at_least('manager'));
