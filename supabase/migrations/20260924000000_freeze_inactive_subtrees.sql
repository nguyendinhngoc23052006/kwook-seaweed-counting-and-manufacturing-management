-- 8.9 Archive means frozen, not merely hidden.
--
-- Deactivating a node only ever changed what OrgChartPage/NodePage render (they walk
-- the ancestor chain client-side and stop drawing a subtree once any ancestor is
-- inactive). Nothing server-side ever read `active`: a capability holder could keep
-- adding children, seating people into existing seats, or granting new capabilities
-- inside a "retired" branch the whole time it was hidden, and none of it would be
-- visible until someone reactivated the branch and the accumulated changes appeared
-- with no warning that they happened during the archived window.
--
-- `active` also does not cascade to descendants (each node owns its own flag, so a
-- child created under an inactive parent defaults active=true) -- so a bare
-- "new.node_id.active" check is not enough; it is trivially defeated by one extra
-- level of node creation. This helper walks the FULL ancestor chain (org_ancestor_ids
-- already includes the node itself) so every guard agrees on one answer: a node is
-- "effectively active" only if it, and everything above it, is active.
create or replace function public.org_node_effectively_active(p_node uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from public.org_nodes n
     where n.id = any (public.org_ancestor_ids(p_node))
       and not n.active
  );
$$;

-- Cleanup (vacating a seat, revoking a capability, abolishing/retitling an existing
-- position) is never blocked by this -- an archived branch must stay tidy-able.
-- Only NEW structure, staffing, or authority is frozen, and it is frozen for
-- everyone: the checks below run unconditionally, before each trigger's own
-- org_admin() bypass, so even the sysadmin/CEO must reactivate a branch before
-- building on it rather than the freeze being a permission any role can wave past.

create or replace function public.org_guard_nodes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'nodes are never deleted; set active = false' using errcode = '42501';
  end if;
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'a node cannot be its own parent' using errcode = '22023';
    end if;
    -- A reparent races against a concurrent reparent of an unrelated node: two
    -- sessions could each read the other's still-uncommitted ancestor chain and
    -- both pass the cycle check before either commits, producing a real cycle
    -- neither one alone would create. One global lock closes it -- reparenting
    -- is already rare and reserved to the sysadmin/CEO (see the decision above
    -- this function in 8.8's original comment).
    if tg_op = 'UPDATE' and new.parent_id is distinct from old.parent_id then
      perform pg_advisory_xact_lock(hashtext('org_nodes_reparent'));
    end if;
    if new.id = any (public.org_ancestor_ids(new.parent_id)) then
      raise exception 'that parent would create a cycle' using errcode = '22023';
    end if;
    if (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id)
       and not public.org_node_effectively_active(new.parent_id) then
      raise exception 'cannot add or move a node under an inactive unit -- reactivate it first'
        using errcode = '22023';
    end if;
  end if;

  if auth.uid() is null or public.org_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.parent_id is null then
      raise exception 'only the sysadmin or the CEO creates the root node' using errcode = '42501';
    end if;
    if not public.org_capability_reaches('create_child_node', new.parent_id) then
      raise exception 'you cannot add a child to that node' using errcode = '42501';
    end if;
  else
    if new.parent_id is distinct from old.parent_id then
      raise exception 'moving a node is reserved to the sysadmin or the CEO' using errcode = '42501';
    end if;
    if not public.org_capability_reaches('create_child_node', old.id) then
      raise exception 'you cannot edit that node' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function public.org_guard_position_holders()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_node      uuid;
  v_abolished timestamptz;
  v_status    text;
  v_max       timestamptz;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'position_holders is append-only; insert a new effective-dated row'
      using errcode = '42501';
  end if;

  select p.node_id, p.abolished_at into v_node, v_abolished
    from public.positions p where p.id = new.position_id;
  if v_node is null then
    raise exception 'unknown seat' using errcode = '22023';
  end if;
  if v_abolished is not null and new.person_id is not null then
    raise exception 'that seat has been abolished' using errcode = '22023';
  end if;
  -- Vacating (person_id null) always passes -- only a new appointment is frozen.
  if new.person_id is not null and not public.org_node_effectively_active(v_node) then
    raise exception 'cannot appoint into an inactive unit -- reactivate it first'
      using errcode = '22023';
  end if;
  if new.person_id is not null then
    select pe.status into v_status from public.persons pe where pe.id = new.person_id;
    if v_status is null then
      raise exception 'unknown person' using errcode = '22023';
    end if;
    if v_status = 'departed' then
      raise exception 'a departed person cannot be seated' using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('position_holders' || new.position_id::text));
  select max(h.effective_from) into v_max
    from public.position_holders h
   where h.position_id = new.position_id and h.effective_from <= now();
  if v_max is not null and new.effective_from < v_max then
    raise exception 'cannot backdate a seating before the newest effective row (%)', v_max
      using errcode = '22023';
  end if;

  if auth.uid() is null or public.org_admin() then
    return new;
  end if;
  if new.person_id is not null and new.person_id = public.org_current_person_id() then
    raise exception 'you cannot seat yourself' using errcode = '42501';
  end if;
  if not public.org_capability_reaches('appoint_into_seat_below', v_node) then
    raise exception 'you cannot appoint into that node' using errcode = '42501';
  end if;
  if new.person_id is not null
     and public.org_person_node_ids(new.person_id) <> '{}'::uuid[]
     and not public.org_person_in_my_scope(new.person_id) then
    raise exception 'that person already holds a seat outside your branch' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.org_guard_node_capabilities()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_max timestamptz;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'capability grants are append-only; insert a row with granted = false to revoke'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('node_capabilities' || new.node_id::text || new.capability_key));
  select max(c.effective_from) into v_max
    from public.node_capabilities c
   where c.node_id = new.node_id
     and c.capability_key = new.capability_key
     and c.effective_from <= now();
  if v_max is not null and new.effective_from < v_max then
    raise exception 'cannot backdate a grant before the newest effective row (%)', v_max
      using errcode = '22023';
  end if;
  -- Revoking (granted = false) always passes -- only a new grant is frozen.
  if new.granted and not public.org_node_effectively_active(new.node_id) then
    raise exception 'cannot grant a capability on an inactive unit -- reactivate it first'
      using errcode = '22023';
  end if;

  if auth.uid() is null or public.org_admin() then
    return new;
  end if;
  if not public.org_capability_reaches('configure_child_capabilities', new.node_id, true) then
    raise exception 'you may only configure a node strictly below one of your own seats'
      using errcode = '42501';
  end if;
  if new.granted and not public.org_i_hold(new.capability_key) then
    raise exception 'you cannot grant a capability you do not hold yourself (%)', new.capability_key
      using errcode = '42501';
  end if;
  return new;
end $$;

-- Upgrades the one guard that already checked `active` (8.4's original comment: "a
-- seat must sit in an active node") in two ways: (a) from a bare column read to the
-- ancestor-aware helper, since a seat's own node can be active while sitting under an
-- inactive grandparent; (b) scoped to only fire when a seat is actually being placed
-- or moved into a node (INSERT, or an UPDATE that changes node_id) rather than on
-- every update -- the previous unconditional form blocked abolishing, retitling or
-- re-ranking an existing seat the moment its node went inactive, even for the CEO.
create or replace function public.org_guard_positions()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_mine numeric;
  v_mgr  numeric;
  v_bad  integer;
  v_live integer;
begin
  -- Coherence ---------------------------------------------------------------------
  select r.ordinal into v_mine from public.ranks r where r.id = new.rank_id;
  if v_mine is null then
    raise exception 'unknown rank' using errcode = '22023';
  end if;
  if (tg_op = 'INSERT' or new.node_id is distinct from old.node_id)
     and not public.org_node_effectively_active(new.node_id) then
    raise exception 'a seat must sit in an active unit -- reactivate it first' using errcode = '22023';
  end if;

  if new.reports_to_position_id is not null then
    if new.reports_to_position_id = new.id then
      raise exception 'a seat cannot report to itself' using errcode = '22023';
    end if;
    select r.ordinal into v_mgr
      from public.positions p join public.ranks r on r.id = p.rank_id
     where p.id = new.reports_to_position_id and p.abolished_at is null;
    if v_mgr is null then
      raise exception 'the manager seat must exist and be live' using errcode = '22023';
    end if;
    if v_mgr > v_mine then
      raise exception 'a manager''s rank may not sit below their report''s rank'
        using errcode = '22023';
    end if;
    if new.id = any (public.org_position_chain(new.reports_to_position_id)) then
      raise exception 'that reporting edge would create a cycle' using errcode = '22023';
    end if;
  end if;

  select count(*) into v_bad
    from public.positions p join public.ranks r on r.id = p.rank_id
   where p.reports_to_position_id = new.id and p.abolished_at is null and r.ordinal < v_mine;
  if v_bad > 0 then
    raise exception 'this rank would sit below % of this seat''s own reports', v_bad
      using errcode = '22023';
  end if;

  -- A seat with live reports cannot be retired: the edges pointing at it would be left
  -- pointing at a dead seat, and for the root seat it is what keeps the tree rooted.
  if tg_op = 'UPDATE' and new.abolished_at is not null and old.abolished_at is null then
    select count(*) into v_live from public.positions p
     where p.reports_to_position_id = new.id and p.abolished_at is null;
    if v_live > 0 then
      raise exception 'that seat still has % live report(s); move them first', v_live
        using errcode = '22023';
    end if;
  end if;

  -- Authority ---------------------------------------------------------------------
  if auth.uid() is null or public.org_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not public.org_capability_reaches('appoint_into_seat_below', new.node_id) then
      raise exception 'you cannot create a seat in that node' using errcode = '42501';
    end if;
  else
    -- You may not edit your own seat. Self-appointment is the primitive every
    -- escalation chain needs, so it is refused here as well as in 8.5.
    if old.id = any (public.org_positions_held_by(public.org_current_person_id())) then
      raise exception 'you cannot edit your own seat' using errcode = '42501';
    end if;
    if not public.org_capability_reaches('appoint_into_seat_below', old.node_id)
       or not public.org_capability_reaches('appoint_into_seat_below', new.node_id) then
      raise exception 'you must be able to appoint in both the old and the new node'
        using errcode = '42501';
    end if;
  end if;

  -- A new manager edge must land inside your own branch, or a manager could hang their
  -- own seat directly off the CEO and corrupt the chart evaluation is derived from.
  if new.reports_to_position_id is not null
     and (tg_op = 'INSERT' or new.reports_to_position_id is distinct from old.reports_to_position_id)
     and not (public.org_position_node(new.reports_to_position_id) = any (public.org_my_scope_node_ids())) then
    raise exception 'the manager seat must be inside your own branch' using errcode = '42501';
  end if;

  return new;
end $$;

revoke all on function public.org_node_effectively_active(uuid) from public, anon;
grant execute on function public.org_node_effectively_active(uuid) to authenticated;
