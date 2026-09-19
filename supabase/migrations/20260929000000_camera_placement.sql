begin;

-- Camera placement, after pairing.
--
-- camera_devices is SELECT-only to every client -- two read policies, a SELECT
-- grant, and no INSERT, UPDATE or DELETE policy at all -- so a camera's name,
-- its role (which door it is), its station and its unit were frozen the moment
-- the create-camera-device function made it. A camera moved to another doorway
-- kept reporting the old one, and the only way to change any of it was to
-- revoke the device and pair a new one, which orphans nothing but does start
-- its attendance history over.
--
-- CLAUDE.md rule 2 says the function comes from the server and the owner is
-- the single placement authority, deciding line, station and function in one
-- place. Until now the owner could decide that exactly once.
--
-- The table stays SELECT-only: every write here already goes through a definer
-- RPC in the org_camera_* family (create, revoke, set_attendance_config), so
-- this is a fourth one rather than the first write policy. That keeps rule 1's
-- shape -- a device credential can read its own row and write nothing.

create or replace function public.org_camera_update_device(
  p_device_id uuid,
  p_name text default null,
  p_role text default null,
  p_station_id uuid default null,
  p_clear_station boolean default false,
  p_node_id uuid default null)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_node_id     uuid;
  v_old         record;
  v_target_node uuid;
begin
  select * into v_old from public.camera_devices where id = p_device_id;
  if v_old.id is null then
    raise exception 'no such device' using errcode = '22023';
  end if;
  v_node_id := v_old.org_node_id;

  if not public.org_camera_can_manage(v_node_id) then
    raise exception 'you cannot manage cameras at this node' using errcode = '42501';
  end if;

  -- Moving a camera needs the capability at BOTH ends, the same way moving a
  -- seat does: otherwise a manager could push a device into a unit they have
  -- no authority over and keep reading its attendance from the old one.
  v_target_node := coalesce(p_node_id, v_node_id);
  if v_target_node <> v_node_id and not public.org_camera_can_manage(v_target_node) then
    raise exception 'you cannot manage cameras at the destination node' using errcode = '42501';
  end if;
  if not exists (select 1 from public.org_nodes n where n.id = v_target_node and n.active) then
    raise exception 'a camera must sit in an active node' using errcode = '22023';
  end if;

  -- The allowed roles are not repeated here. camera_devices' own CHECK
  -- constraint is the one source of truth for them, and a copy in this
  -- function would be a second list to keep in sync -- it already drifted
  -- once in the draft of this migration, which listed four of the six.

  -- A station is node-scoped, so a camera may only be attached to one in the
  -- unit it will actually sit in. Without this a device could be pointed at a
  -- station in another branch and report under it.
  if p_station_id is not null and not exists (
       select 1 from public.camera_stations s
        where s.id = p_station_id and s.org_node_id = v_target_node and s.active) then
    raise exception 'that station is not an active station in the destination unit'
      using errcode = '22023';
  end if;

  update public.camera_devices
     set name       = coalesce(nullif(btrim(p_name), ''), name),
         role       = coalesce(p_role, role),
         station_id = case when p_clear_station then null
                           else coalesce(p_station_id, station_id) end,
         org_node_id = v_target_node
   where id = p_device_id;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action,
                                before_json, after_json)
    values (auth.uid(), 'camera_device', p_device_id::text, v_target_node, 'device_updated',
      jsonb_build_object('name', v_old.name, 'role', v_old.role,
                         'station_id', v_old.station_id, 'org_node_id', v_old.org_node_id),
      jsonb_build_object('name', coalesce(nullif(btrim(p_name), ''), v_old.name),
                         'role', coalesce(p_role, v_old.role),
                         'station_id', case when p_clear_station then null
                                            else coalesce(p_station_id, v_old.station_id) end,
                         'org_node_id', v_target_node));
end $fn$;
revoke all on function public.org_camera_update_device(uuid, text, text, uuid, boolean, uuid)
  from public, anon;
grant execute on function public.org_camera_update_device(uuid, text, text, uuid, boolean, uuid)
  to authenticated;

-- Un-revoking. A camera revoked by mistake had no way back: revoked_at is set
-- by an RPC and cleared by nothing, so the phone was cut off permanently and
-- the only route was a new pairing under a new identity.
create or replace function public.org_camera_restore_device(p_device_id uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_node_id uuid;
begin
  select org_node_id into v_node_id from public.camera_devices
   where id = p_device_id and revoked_at is not null;
  if v_node_id is null then
    raise exception 'no such revoked device' using errcode = '22023';
  end if;
  if not public.org_camera_can_manage(v_node_id) then
    raise exception 'you cannot manage cameras at this node' using errcode = '42501';
  end if;

  update public.camera_devices set revoked_at = null where id = p_device_id;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action)
    values (auth.uid(), 'camera_device', p_device_id::text, v_node_id, 'device_restored');
end $fn$;
revoke all on function public.org_camera_restore_device(uuid) from public, anon;
grant execute on function public.org_camera_restore_device(uuid) to authenticated;

commit;
