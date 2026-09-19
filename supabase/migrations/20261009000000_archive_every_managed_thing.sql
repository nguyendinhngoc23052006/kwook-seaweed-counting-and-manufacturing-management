-- "Delete" hides. It never destroys. Now for everything a person manages.
--
-- 20261008000000 proved the shape on cameras. Every managed entity already had
-- two of the three states and none had the third:
--
--   active    in use
--   retired   stopped, still listed, restorable   (active / status / abolished_at / state)
--   archived  gone from every screen, data intact (archived_at)
--
-- Retiring and archiving answer different questions. "This line is not running
-- any more" is a fact about the factory and belongs on the screen. "I never
-- want to see this again" is a fact about the person looking, and hiding it
-- does not have to touch a single row it produced.
--
-- What is NOT here, deliberately: org_audit, access_log, attendance and count
-- rows, applications, notifications, task_comments, node_capabilities. Those
-- are RECORDS, not things you manage -- an audit row you can hide is an audit
-- row that cannot be trusted. camera_operators is absent too: it has a schema
-- and no code references, and lifecycle on a table nothing uses is decoration.
--
-- Who may hide is whoever may already change the thing -- the same gate, never
-- a new one. Who may bring it back is the sysadmin or the CEO, uniformly,
-- because an archived row is invisible to everyone else and someone has to be
-- able to see a mistake in order to undo it.

begin;

alter table public.org_nodes       add column if not exists archived_at timestamptz;
alter table public.persons         add column if not exists archived_at timestamptz;
alter table public.positions       add column if not exists archived_at timestamptz;
alter table public.ranks           add column if not exists archived_at timestamptz;
alter table public.camera_stations add column if not exists archived_at timestamptz;
alter table public.camera_lines    add column if not exists archived_at timestamptz;
alter table public.job_postings    add column if not exists archived_at timestamptz;
alter table public.tasks           add column if not exists archived_at timestamptz;

-- Partial indexes on the live rows: every list in the app is "the ones not
-- hidden", which is the overwhelming majority, and this keeps that the cheap
-- path rather than a filter applied after the fact.
create index if not exists org_nodes_live_idx       on public.org_nodes (parent_id)      where archived_at is null;
create index if not exists persons_live_idx         on public.persons (status)           where archived_at is null;
create index if not exists positions_live_idx       on public.positions (node_id)        where archived_at is null;
create index if not exists camera_stations_live_idx on public.camera_stations (org_node_id) where archived_at is null;
create index if not exists camera_lines_live_idx    on public.camera_lines (org_node_id) where archived_at is null;
create index if not exists job_postings_live_idx    on public.job_postings (state)       where archived_at is null;
create index if not exists tasks_live_idx           on public.tasks (state)              where archived_at is null;

commit;

begin;

-- =====================================================================================
-- The read policies, each keeping its own audience and adding the same filter
-- =====================================================================================
--
-- The filter belongs here and not in each query: a screen that forgets it still
-- cannot show an archived row, and neither can anything else holding a key.

drop policy if exists org_nodes_select on public.org_nodes;
create policy org_nodes_select on public.org_nodes for select
  using (
    (archived_at is null
      and ((select public.org_current_person_id()) is not null or (select public.org_is_sysadmin())))
    or (archived_at is not null and (select public.org_admin()))
  );

drop policy if exists persons_select on public.persons;
create policy persons_select on public.persons for select
  using (
    (archived_at is null
      and (account_id = (select auth.uid())
        or (select public.org_is_sysadmin())
        or (select public.org_holds_root_seat())
        or (id = any (coalesce((select public.org_visible_person_ids()), '{}'::uuid[])))))
    or (archived_at is not null and (select public.org_admin()))
  );

drop policy if exists positions_select on public.positions;
create policy positions_select on public.positions for select
  using (
    (archived_at is null
      and ((select public.org_current_person_id()) is not null or (select public.org_is_sysadmin())))
    or (archived_at is not null and (select public.org_admin()))
  );

drop policy if exists ranks_select on public.ranks;
create policy ranks_select on public.ranks for select
  using (
    (archived_at is null and (select auth.uid()) is not null)
    or (archived_at is not null and (select public.org_admin()))
  );

drop policy if exists camera_stations_read on public.camera_stations;
create policy camera_stations_read on public.camera_stations for select
  using (
    (archived_at is null
      and (public.org_admin()
        or public.org_capability_reaches('view_camera_data', org_node_id)
        or public.org_capability_reaches('manage_camera_devices', org_node_id)
        or org_node_id = public.org_camera_device_node()))
    or (archived_at is not null and public.org_admin())
  );

drop policy if exists camera_lines_read on public.camera_lines;
create policy camera_lines_read on public.camera_lines for select
  using (
    (archived_at is null
      and (public.org_admin()
        or public.org_capability_reaches('view_camera_data', org_node_id)
        or public.org_capability_reaches('manage_camera_devices', org_node_id)
        or org_node_id = public.org_camera_device_node()))
    or (archived_at is not null and public.org_admin())
  );

-- The public job board is not RLS -- it is a definer function reading as the
-- owner -- so an archived posting would have gone on being advertised to
-- strangers. It filters on state alone; now it filters on both.
create or replace function public.org_job_board()
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', j.id,
           'title', j.title,
           'title_en', j.title_en,
           'summary', j.summary,
           'location', j.location,
           'employment_type', j.employment_type,
           'openings', j.openings,
           'closes_at', j.closes_at,
           'published_at', j.published_at)
         order by j.published_at desc), '[]'::jsonb)
    from public.job_postings j
   where j.state = 'open' and j.archived_at is null;
$fn$;

commit;

begin;

-- =====================================================================================
-- One archive, one unarchive
-- =====================================================================================
--
-- One function rather than sixteen scattered ones, because the interesting part
-- is WHO MAY DO IT and that is worth reading in a single place. The gate per
-- entity is the gate that entity already uses for changing it -- copied from
-- its own write policy, never widened.

create or replace function public.org_archive(p_entity text, p_id uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_ok boolean := false;
begin
  if p_entity = 'org_node' then
    select public.org_admin() or public.org_capability_reaches('create_child_node', n.id)
      into v_ok from public.org_nodes n where n.id = p_id;
    if not coalesce(v_ok, false) then
      raise exception 'you cannot change that unit' using errcode = '42501';
    end if;
    -- A unit takes its subtree with it. Hiding a department while its teams
    -- stay on the chart would leave them parented to something nobody can see.
    update public.org_nodes set archived_at = now()
     where id = any (public.org_subtree_ids(array[p_id])) and archived_at is null;

  elsif p_entity = 'person' then
    select public.org_admin()
        or p.id = any (coalesce(public.org_maintainable_person_ids(), '{}'::uuid[]))
      into v_ok from public.persons p where p.id = p_id;
    if not coalesce(v_ok, false) then
      raise exception 'you cannot change that person' using errcode = '42501';
    end if;
    update public.persons set archived_at = now() where id = p_id and archived_at is null;

  elsif p_entity = 'position' then
    select public.org_admin()
        or public.org_capability_reaches('appoint_into_seat_below', p.node_id)
      into v_ok from public.positions p where p.id = p_id;
    if not coalesce(v_ok, false) then
      raise exception 'you cannot change that seat' using errcode = '42501';
    end if;
    update public.positions set archived_at = now() where id = p_id and archived_at is null;

  elsif p_entity = 'rank' then
    if not public.org_admin() then
      raise exception 'only the sysadmin or the CEO changes the rank ladder' using errcode = '42501';
    end if;
    update public.ranks set archived_at = now() where id = p_id and archived_at is null;

  elsif p_entity = 'camera_station' then
    select public.org_admin() or public.org_capability_reaches('manage_camera_devices', s.org_node_id)
      into v_ok from public.camera_stations s where s.id = p_id;
    if not coalesce(v_ok, false) then
      raise exception 'you cannot manage cameras at this node' using errcode = '42501';
    end if;
    update public.camera_stations set archived_at = now() where id = p_id and archived_at is null;

  elsif p_entity = 'camera_line' then
    select public.org_admin() or public.org_capability_reaches('manage_camera_devices', l.org_node_id)
      into v_ok from public.camera_lines l where l.id = p_id;
    if not coalesce(v_ok, false) then
      raise exception 'you cannot manage cameras at this node' using errcode = '42501';
    end if;
    update public.camera_lines set archived_at = now() where id = p_id and archived_at is null;

  elsif p_entity = 'job_posting' then
    if not public.org_admin() then
      raise exception 'you cannot change that posting' using errcode = '42501';
    end if;
    update public.job_postings set archived_at = now() where id = p_id and archived_at is null;

  elsif p_entity = 'task' then
    select public.org_admin()
        or t.assigned_by_position_id = any (
             public.org_positions_held_by(public.org_current_person_id()))
      into v_ok from public.tasks t where t.id = p_id;
    if not coalesce(v_ok, false) then
      raise exception 'only whoever set that task, or an admin, can hide it' using errcode = '42501';
    end if;
    update public.tasks set archived_at = now() where id = p_id and archived_at is null;

  else
    raise exception 'cannot archive a %', p_entity using errcode = '22023';
  end if;

  if not found then
    raise exception 'no such % to hide', p_entity using errcode = '22023';
  end if;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, action)
    values (auth.uid(), p_entity, p_id::text, 'archived');
end $fn$;

-- Bringing something back is the sysadmin's or the CEO's, whatever it is: an
-- archived row is invisible to everyone else, so nobody else can even see the
-- mistake they would be undoing.
create or replace function public.org_unarchive(p_entity text, p_id uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.org_admin() then
    raise exception 'only the sysadmin or the CEO restores a hidden record'
      using errcode = '42501';
  end if;

  if    p_entity = 'org_node' then
    update public.org_nodes set archived_at = null
     where id = any (public.org_subtree_ids(array[p_id])) and archived_at is not null;
  elsif p_entity = 'person'         then update public.persons         set archived_at = null where id = p_id;
  elsif p_entity = 'position'       then update public.positions       set archived_at = null where id = p_id;
  elsif p_entity = 'rank'           then update public.ranks           set archived_at = null where id = p_id;
  elsif p_entity = 'camera_station' then update public.camera_stations set archived_at = null where id = p_id;
  elsif p_entity = 'camera_line'    then update public.camera_lines    set archived_at = null where id = p_id;
  elsif p_entity = 'job_posting'    then update public.job_postings    set archived_at = null where id = p_id;
  elsif p_entity = 'task'           then update public.tasks           set archived_at = null where id = p_id;
  else
    raise exception 'cannot restore a %', p_entity using errcode = '22023';
  end if;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, action)
    values (auth.uid(), p_entity, p_id::text, 'unarchived');
end $fn$;

revoke all on function public.org_archive(text, uuid) from public;
revoke all on function public.org_unarchive(text, uuid) from public;
grant execute on function public.org_archive(text, uuid) to authenticated;
grant execute on function public.org_unarchive(text, uuid) to authenticated;

commit;
