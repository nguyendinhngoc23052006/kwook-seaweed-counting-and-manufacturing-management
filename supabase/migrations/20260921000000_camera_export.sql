-- Camera capability model, finished: viewing and exporting are the same
-- permission, and managing the camera system is the other one.
--
-- camera_devices.sql catalogued three keys -- manage_camera_devices,
-- view_camera_data, export_camera_data -- with export marked "enforced once
-- export tooling ships". Nothing ever checked it: every policy in that file
-- gates read access on view_camera_data OR manage_camera_devices only. A
-- capability nothing enforces is worse than no capability at all -- an admin
-- screen listing it would offer a grant that does nothing. The intended
-- shape turns out to be two capabilities, not three: whoever can view a
-- node's camera data can also export it, and management is separate. So
-- export_camera_data is retired here rather than left to rot, and the export
-- RPC below is gated on view_camera_data like every other read in this file.

begin;

-- =====================================================================================
-- 1. Retire export_camera_data -- guarded, not a bare delete, in case some
--    environment already granted it (node_capabilities.capability_key is
--    `references capability_types(key) on delete restrict`, so a genuine
--    grant would otherwise abort this migration rather than silently drop
--    a real permission).
-- =====================================================================================

do $$
begin
  if exists (select 1 from public.node_capabilities where capability_key = 'export_camera_data') then
    raise warning 'camera export: export_camera_data has existing grants in node_capabilities -- '
      'left in the catalogue rather than deleted. Investigate before removing by hand.';
  else
    delete from public.capability_types where key = 'export_camera_data';
  end if;
end $$;

-- =====================================================================================
-- 2. org_camera_export_counts -- the export door. Same reach as reading the
--    fleet (view_camera_data or manage_camera_devices, or org_admin()), and
--    every call is audited -- this repo's own rule that every export writes
--    an access-log row.
-- =====================================================================================

create or replace function public.org_camera_export_counts(
  p_node_id uuid,
  p_since timestamptz default now() - interval '30 days',
  p_until timestamptz default now())
returns table (
  device_id uuid,
  station_id uuid,
  minute timestamptz,
  count int,
  algorithm_version text)
language plpgsql security definer set search_path = public as $$
begin
  if not (public.org_admin()
      or public.org_capability_reaches('view_camera_data', p_node_id)
      or public.org_capability_reaches('manage_camera_devices', p_node_id)) then
    raise exception 'you cannot view cameras at this node' using errcode = '42501';
  end if;
  if p_until < p_since then
    raise exception 'p_until must not be before p_since' using errcode = '22023';
  end if;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action, after_json)
    values (auth.uid(), 'camera_export', p_node_id::text, p_node_id, 'data_exported',
      jsonb_build_object('since', p_since, 'until', p_until));

  return query
    select m.device_id, m.station_id, m.minute, m.count, m.algorithm_version
      from public.camera_count_minutes m
     where m.org_node_id = p_node_id
       and m.minute >= p_since
       and m.minute <  p_until
     order by m.minute;
end $$;

revoke all on function public.org_camera_export_counts(uuid,timestamptz,timestamptz) from public, anon;
grant execute on function public.org_camera_export_counts(uuid,timestamptz,timestamptz) to authenticated;

commit;
