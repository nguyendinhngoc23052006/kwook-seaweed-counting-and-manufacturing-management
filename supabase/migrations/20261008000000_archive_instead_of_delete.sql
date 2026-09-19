-- "Delete" hides a camera. It never destroys one.
--
-- A camera is the parent of everything it measured, so deleting one either
-- takes that history with it or is refused. 20260924010000 chose refused --
-- correctly -- and the result was a camera created by mistake that nobody could
-- remove from anywhere: deleting its auth user is refused by the camera row,
-- and deleting the camera row has no grant and no RPC.
--
-- The button people want is not "destroy this". It is "stop showing me this".
-- Those are different asks and only one of them has to touch the data. So this
-- is a third lifecycle state, after active and revoked:
--
--   active    in use
--   revoked   stopped, still listed, restorable  (revoked_at)
--   archived  gone from every screen, data intact (archived_at)
--
-- Archiving implies revoking: a camera nobody can see must not still be
-- writing rows. The reverse is not true -- revoking is the ordinary "take it
-- off the floor", and it stays visible so somebody can put it back.
--
-- Archived rows stay readable by the sysadmin or the CEO, and by nobody else.
-- "Invisible to everyone with no way back" sounds like what was asked for until
-- the first mis-click, after which a camera with a year of counts is gone from
-- every screen and only a hand-written query can find it again. One list, one
-- Restore, and the mistake costs a click instead of an engineer.

begin;

alter table public.camera_devices
  add column if not exists archived_at timestamptz;

create index if not exists camera_devices_archived_idx
  on public.camera_devices (org_node_id) where archived_at is null;

-- The read policies decide who sees an archived camera, so the filter lives
-- there rather than in every query: a screen that forgets to filter still
-- cannot show one, and neither can anything else holding an API key.
drop policy if exists camera_devices_human_read on public.camera_devices;
create policy camera_devices_human_read on public.camera_devices for select
  using (
    (archived_at is null
      and (public.org_admin()
        or public.org_capability_reaches('view_camera_data', org_node_id)
        or public.org_capability_reaches('manage_camera_devices', org_node_id)))
    or (archived_at is not null and public.org_admin())
  );

-- A camera reads its own row to learn what it is. An archived one is off the
-- floor by definition, so it stops being able to -- which is what makes the
-- phone fall back to its "this camera has been unpaired" screen rather than
-- carrying on against a row nobody can see.
drop policy if exists camera_devices_self on public.camera_devices;
create policy camera_devices_self on public.camera_devices for select
  using (id = auth.uid() and archived_at is null);

commit;

begin;

create or replace function public.org_camera_archive_device(p_device_id uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
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

  -- coalesce, not overwrite: a camera revoked last March and archived today
  -- was off the floor in March, and that is the date its history should read.
  update public.camera_devices
     set archived_at = now(),
         revoked_at = coalesce(revoked_at, now())
   where id = p_device_id and archived_at is null;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action, after_json)
    values (auth.uid(), 'camera_device', p_device_id::text, v_node, 'device_archived',
      jsonb_build_object('name', v_name));
end $fn$;

-- Restoring brings it back as REVOKED, not running. Archiving took it off the
-- floor; undoing the hiding should not silently put a camera back to work in a
-- doorway nobody has looked at since.
create or replace function public.org_camera_unarchive_device(p_device_id uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_node uuid;
  v_name text;
begin
  select org_node_id, name into v_node, v_name
    from public.camera_devices where id = p_device_id;
  if v_node is null then
    raise exception 'no such camera' using errcode = '22023';
  end if;
  -- Only whoever can see an archived camera may bring one back.
  if not public.org_admin() then
    raise exception 'only the sysadmin or the CEO restores an archived camera'
      using errcode = '42501';
  end if;

  update public.camera_devices set archived_at = null
   where id = p_device_id and archived_at is not null;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action, after_json)
    values (auth.uid(), 'camera_device', p_device_id::text, v_node, 'device_unarchived',
      jsonb_build_object('name', v_name));
end $fn$;

revoke all on function public.org_camera_archive_device(uuid) from public;
revoke all on function public.org_camera_unarchive_device(uuid) from public;
grant execute on function public.org_camera_archive_device(uuid) to authenticated;
grant execute on function public.org_camera_unarchive_device(uuid) to authenticated;

commit;
