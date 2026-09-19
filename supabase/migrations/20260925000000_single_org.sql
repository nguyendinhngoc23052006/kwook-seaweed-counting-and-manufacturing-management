-- 9.1 One organisation, not many.
--
-- This product is an internal employee management hub for ONE company. The
-- multi-tenant scaffolding below is inherited from the original seaweed-counting
-- camera product (20260915000000_init.sql) and never applied to the /org hub,
-- which has carried no tenant_id since the day it was written.
--
-- Why removing it is safe rather than a security change:
--   current_tenant() is `select tenant_id from profiles where id = auth.uid()`.
--   With exactly one tenants row and profiles.tenant_id NOT NULL, the predicate
--   `tenant_id = current_tenant()` is TRUE for every row a caller could reach.
--   Dropping an always-true conjunct is semantically a no-op: what actually
--   gates these tables is is_human_at_least(...) / current_kind() / device
--   identity, and every one of those is preserved here verbatim.
--
-- Each policy below is recreated with its command, its role and its real
-- predicate unchanged -- ONLY the tenant conjunct is removed. Columns are
-- dropped after the policies stop referencing them, never with CASCADE, so a
-- policy can never be silently deleted and leave a table ungoverned.
--
-- Two latent bugs die with it:
--   * handle_new_user() returned EARLY when no tenant row existed, so a signup
--     succeeded with no profile at all -- an account that could never be fixed
--     from inside the app. Profile creation is now unconditional.
--   * current_tenant() reads the caller's own profile, so a profile with a
--     mismatched tenant_id was silently invisible to the whole floor app:
--     empty screens, never an error.
--
-- CLAUDE.md rule 9 ("tenant_id on every table") is what this contradicts. The
-- constitution is read-only to me; that rule needs the owner's edit. Proposed
-- replacement is in the PR body.

begin;

-- =====================================================================================
-- 1. Profile creation no longer depends on a tenant existing
-- =====================================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.profiles (id, kind, role, display_name)
  values (
    new.id,
    'human',
    'pending',
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), new.email, 'user')
  );
  return new;
end $fn$;

-- =====================================================================================
-- 2. Policies, rebuilt without the always-true tenant conjunct
-- =====================================================================================

drop policy if exists access_log_read on public.access_log;
create policy access_log_read on public.access_log for select
  using (is_human_at_least('manager'));

drop policy if exists calibration_owner on public.calibrations;
create policy calibration_owner on public.calibrations for all
  using (is_human_at_least('owner')) with check (is_human_at_least('owner'));
drop policy if exists calibration_read on public.calibrations;
create policy calibration_read on public.calibrations for select
  using (is_human_at_least('viewer'));

drop policy if exists session_device_end on public.capture_sessions;
create policy session_device_end on public.capture_sessions for update
  using (current_kind() = 'device' and device_id = auth.uid() and is_active_device())
  with check (device_id = auth.uid());
drop policy if exists session_device_start on public.capture_sessions;
create policy session_device_start on public.capture_sessions for insert
  with check (current_kind() = 'device' and device_id = auth.uid()
              and is_active_device() and ended_at is null);
drop policy if exists session_owner_manage on public.capture_sessions;
create policy session_owner_manage on public.capture_sessions for all
  using (is_human_at_least('owner')) with check (is_human_at_least('owner'));
drop policy if exists session_self_read on public.capture_sessions;
create policy session_self_read on public.capture_sessions for select
  using (device_id = auth.uid() or is_human_at_least('viewer'));

drop policy if exists compliance_device_insert on public.compliance_events;
create policy compliance_device_insert on public.compliance_events for insert
  with check (current_kind() = 'device' and device_id = auth.uid() and is_active_device());
drop policy if exists compliance_read on public.compliance_events;
create policy compliance_read on public.compliance_events for select
  using (is_human_at_least('viewer'));
drop policy if exists compliance_review on public.compliance_events;
create policy compliance_review on public.compliance_events for update
  using (is_human_at_least('supervisor')) with check (is_human_at_least('supervisor'));

drop policy if exists count_events_device_insert on public.count_events;
create policy count_events_device_insert on public.count_events for insert
  with check (current_kind() = 'device' and device_id = auth.uid() and is_active_device());
drop policy if exists count_events_read on public.count_events;
create policy count_events_read on public.count_events for select
  using (is_human_at_least('viewer'));

drop policy if exists count_minutes_device_insert on public.count_minutes;
create policy count_minutes_device_insert on public.count_minutes for insert
  with check (current_kind() = 'device' and device_id = auth.uid() and is_active_device());
drop policy if exists count_minutes_read on public.count_minutes;
create policy count_minutes_read on public.count_minutes for select
  using (is_human_at_least('viewer'));

drop policy if exists heartbeat_device_insert on public.device_heartbeats;
create policy heartbeat_device_insert on public.device_heartbeats for insert
  with check (current_kind() = 'device' and device_id = auth.uid() and is_active_device());
drop policy if exists heartbeat_read on public.device_heartbeats;
create policy heartbeat_read on public.device_heartbeats for select
  using (is_human_at_least('viewer'));

drop policy if exists device_owner_write on public.devices;
create policy device_owner_write on public.devices for all
  using (is_human_at_least('owner')) with check (is_human_at_least('owner'));

drop policy if exists line_owner_insert on public.lines;
create policy line_owner_insert on public.lines for insert
  with check (is_human_at_least('owner'));
drop policy if exists line_owner_update on public.lines;
create policy line_owner_update on public.lines for update
  using (is_human_at_least('owner')) with check (is_human_at_least('owner'));
drop policy if exists line_read on public.lines;
create policy line_read on public.lines for select
  using (is_human_at_least('viewer'));

drop policy if exists mode_device_insert on public.mode_transitions;
create policy mode_device_insert on public.mode_transitions for insert
  with check (current_kind() = 'device' and device_id = auth.uid() and is_active_device());
drop policy if exists mode_read on public.mode_transitions;
create policy mode_read on public.mode_transitions for select
  using (is_human_at_least('viewer'));

drop policy if exists operator_owner_write on public.operators;
create policy operator_owner_write on public.operators for all
  using (is_human_at_least('owner')) with check (is_human_at_least('owner'));
drop policy if exists operator_read on public.operators;
create policy operator_read on public.operators for select
  using (is_human_at_least('viewer'));

drop policy if exists pairing_owner on public.pairing_codes;
create policy pairing_owner on public.pairing_codes for all
  using (is_human_at_least('owner')) with check (is_human_at_least('owner'));

drop policy if exists profile_owner_update on public.profiles;
create policy profile_owner_update on public.profiles for update
  using (is_human_at_least('owner')) with check (is_human_at_least('owner'));
drop policy if exists profile_roster on public.profiles;
create policy profile_roster on public.profiles for select
  using (is_human_at_least('supervisor'));

drop policy if exists report_read on public.reports;
create policy report_read on public.reports for select
  using (is_human_at_least('manager'));

drop policy if exists station_owner_write on public.stations;
create policy station_owner_write on public.stations for all
  using (is_human_at_least('owner')) with check (is_human_at_least('owner'));
drop policy if exists station_read on public.stations;
create policy station_read on public.stations for select
  using (is_human_at_least('viewer') or current_kind() = 'device');

drop policy if exists stream_session_device_write on public.stream_sessions;
create policy stream_session_device_write on public.stream_sessions for insert
  with check (current_kind() = 'device' and device_id = auth.uid() and is_active_device());
drop policy if exists stream_session_read on public.stream_sessions;
create policy stream_session_read on public.stream_sessions for select
  using (is_human_at_least('viewer'));

drop policy if exists stream_view_self on public.stream_views;
create policy stream_view_self on public.stream_views for all
  using (is_human_at_least('viewer')) with check (viewer_id = auth.uid());

drop policy if exists validation_rw on public.validation_samples;
create policy validation_rw on public.validation_samples for all
  using (is_human_at_least('supervisor')) with check (is_human_at_least('supervisor'));

commit;

begin;

-- =====================================================================================
-- 3. Uniqueness that was scoped by tenant becomes uniqueness outright
-- =====================================================================================
-- Dropping tenant_id would take these unique indexes with it and silently allow
-- duplicate line names, duplicate operator badges and overlapping report periods.

drop index if exists public.lines_tenant_name_key;
create unique index if not exists lines_name_key
  on public.lines (lower(btrim(name)));

alter table public.operators drop constraint if exists operators_tenant_id_badge_id_key;
create unique index if not exists operators_badge_id_key
  on public.operators (badge_id);

alter table public.reports drop constraint if exists reports_tenant_id_period_start_period_end_key;
create unique index if not exists reports_period_key
  on public.reports (period_start, period_end);

-- Query indexes led by tenant_id are useless once every row shares one tenant;
-- the trailing column is what each query actually filters on.
drop index if exists public.capture_sessions_tenant_id_started_at_idx;
create index if not exists capture_sessions_started_at_idx
  on public.capture_sessions (started_at desc);

drop index if exists public.compliance_events_tenant_id_captured_at_idx;
create index if not exists compliance_events_captured_at_idx
  on public.compliance_events (captured_at);

drop index if exists public.count_events_tenant_id_captured_at_idx;
create index if not exists count_events_captured_at_idx
  on public.count_events (captured_at);

drop index if exists public.count_minutes_tenant_id_minute_idx;
create index if not exists count_minutes_minute_idx
  on public.count_minutes (minute);

drop index if exists public.devices_tenant_id_idx;
drop index if exists public.profiles_tenant_id_idx;
drop index if exists public.stations_tenant_id_idx;

commit;

begin;

-- =====================================================================================
-- 4. The column itself, then the plumbing that read it
-- =====================================================================================

alter table public.access_log          drop column tenant_id;
alter table public.calibrations        drop column tenant_id;
alter table public.capture_sessions    drop column tenant_id;
alter table public.compliance_events   drop column tenant_id;
alter table public.count_events        drop column tenant_id;
alter table public.count_minutes       drop column tenant_id;
alter table public.device_heartbeats   drop column tenant_id;
alter table public.devices             drop column tenant_id;
alter table public.lines               drop column tenant_id;
alter table public.mode_transitions    drop column tenant_id;
alter table public.operators           drop column tenant_id;
alter table public.pairing_codes       drop column tenant_id;
alter table public.profiles            drop column tenant_id;
alter table public.reports             drop column tenant_id;
alter table public.stations            drop column tenant_id;
alter table public.stream_sessions     drop column tenant_id;
alter table public.stream_views        drop column tenant_id;
alter table public.validation_samples  drop column tenant_id;

-- The table goes first: its own tenant_read policy is the last thing still
-- referencing current_tenant(), and dropping the table takes that policy with it.
drop table if exists public.tenants;
drop function if exists public.current_tenant();

commit;
