-- QR pairing: any browser can become a camera, no signup, no account typed.
--
-- The camera generates a high-entropy secret locally, shows it as a QR, and
-- polls redeem_pairing() with it. NOTHING exists server-side until a signed-in
-- ADMIN scans the QR and claims it (the pair-claim Edge Function creates the
-- device account, its rows, and a one-time login token, storing only hashes).
-- There is no public "request to join" endpoint - an unclaimed camera is a
-- local secret and a spinner, so account-creation spam is structurally
-- impossible, not rate-limited.
--
-- Identity is the devices ROW, not the phone: unpair (revoked_at) cuts the
-- phone off but keeps every row the camera ever wrote; re-claiming a new QR
-- onto a new row is cheap, and history always stays in the tenant's data.

alter table pairing_codes add column token_hash text;

-- Anonymous, single-use redemption. The camera calls this while it waits.
-- 256-bit device-generated codes make guessing infeasible; FOR UPDATE makes
-- double-redeem impossible; the token leaves the row the moment it is read.
create or replace function redeem_pairing(code text) returns text
  language plpgsql security definer set search_path = public, extensions as $$
declare
  t text;
  h text;
begin
  h := encode(digest(code, 'sha256'), 'hex');

  select p.token_hash into t
    from pairing_codes p
   where p.code_hash = h
     and p.used_at is null
     and p.token_hash is not null
     and p.expires_at > now()
   for update;

  if t is null then
    return null; -- not claimed yet (or expired/used) - the camera keeps waiting
  end if;

  update pairing_codes
     set used_at = now(), token_hash = null
   where code_hash = h;

  return t;
end $$;

revoke all on function redeem_pairing(text) from public;
grant execute on function redeem_pairing(text) to anon, authenticated;

-- Unpairing must cut writes in the DATABASE, not just the UI: a phone with a
-- live session for a revoked device gets nothing past this.
create or replace function is_active_device() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from devices d where d.id = auth.uid() and d.revoked_at is null
  )
$$;

drop policy count_events_device_insert on count_events;
create policy count_events_device_insert on count_events for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
    and is_active_device()
  );

drop policy count_minutes_device_insert on count_minutes;
create policy count_minutes_device_insert on count_minutes for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
    and is_active_device()
  );

drop policy compliance_device_insert on compliance_events;
create policy compliance_device_insert on compliance_events for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
    and is_active_device()
  );

drop policy heartbeat_device_insert on device_heartbeats;
create policy heartbeat_device_insert on device_heartbeats for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
    and is_active_device()
  );

drop policy mode_device_insert on mode_transitions;
create policy mode_device_insert on mode_transitions for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
    and is_active_device()
  );

drop policy stream_session_device_write on stream_sessions;
create policy stream_session_device_write on stream_sessions for insert
  with check (
    current_kind() = 'device'
    and device_id = auth.uid()
    and tenant_id = current_tenant()
    and is_active_device()
  );
