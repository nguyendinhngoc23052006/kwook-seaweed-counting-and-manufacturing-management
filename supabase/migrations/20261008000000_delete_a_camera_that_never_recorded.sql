-- A camera that never recorded anything can be deleted. One that did, cannot.
--
-- CLAUDE.md has always said both halves: "deleting a camera that has counted
-- anything -- from the API or from a dashboard click on its auth user -- is
-- refused rather than silently destroying the measurements", and "a camera that
-- never counted can be deleted outright; the database, not the UI, decides
-- which case you are in."
--
-- Only the refusing half was ever built. 20260924010000 made every measurement
-- FK ON DELETE RESTRICT and pointed camera_devices.id at auth.users the same
-- way, which is correct and is what stops a dashboard click from wiping a
-- month of counts. But nothing was ever given the other path, so a camera
-- created by mistake -- paired to the wrong phone, named wrong, never started --
-- could not be removed by anybody, from anywhere. Deleting its auth user is
-- refused by the camera row; deleting the camera row has no grant and no RPC.
--
-- This is that path, and the database stays the one deciding which case it is.

begin;

-- The check is the DELETE itself. Counting the tables that reference a camera
-- would be a list to keep in sync, and the day someone adds a table and forgets
-- it, this function would cheerfully delete a camera with history in it. The
-- foreign keys already know; attempting the delete asks them, and a new table
-- with a RESTRICT FK is covered the moment it exists without touching this.
create or replace function public.org_camera_delete_device(p_device_id uuid)
returns void
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_node uuid;
  v_name text;
begin
  select org_node_id, name into v_node, v_name
    from public.camera_devices where id = p_device_id;
  if v_node is null then
    raise exception 'no such camera' using errcode = '22023';
  end if;
  if not public.org_camera_can_manage(v_node) then
    raise exception 'you cannot manage cameras at this node' using errcode = '42501';
  end if;

  begin
    delete from public.camera_devices where id = p_device_id;
  exception when foreign_key_violation then
    raise exception
      'camera "%" has already recorded data, so it cannot be deleted. Revoke it instead: that stops it at once and keeps everything it measured.',
      v_name using errcode = '23503';
  end;

  -- The account goes with the camera. Leaving it behind would be an auth user
  -- that nothing in the app can see, name or remove -- the orphan pair-claim
  -- rolls back so carefully to avoid creating in the first place.
  delete from auth.users where id = p_device_id;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action, after_json)
    values (auth.uid(), 'camera_device', p_device_id::text, v_node, 'device_deleted',
      jsonb_build_object('name', v_name));
end $fn$;

revoke all on function public.org_camera_delete_device(uuid) from public;
grant execute on function public.org_camera_delete_device(uuid) to authenticated;

commit;
