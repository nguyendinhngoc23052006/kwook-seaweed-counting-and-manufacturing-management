-- 8.10 Privilege flows only from a seat in an active unit.
--
-- Freezing an archived unit (8.9) stopped it growing, but everyone already seated in
-- it kept everything that seat conferred: capability reach, branch scope, the task
-- board, org_admin() for a root-adjacent seat, and the profiles.role projection that
-- gates the camera/station/report policies app-wide. The decision: a seat inside an
-- archived unit confers nothing until the unit is reactivated or the person is seated
-- somewhere live. "Deleted" seats (abolished) already conferred nothing; archived ones
-- now behave the same way.
--
-- One choke point. org_positions_held_by() is what every reach, scope, task-board,
-- root-seat and role derivation reads to learn "the seats I hold right now", so the
-- filter lives there and there only. The two self-edit guards keep reading the
-- UNFILTERED set through the new org_positions_currently_held_by(): a person must not
-- be able to edit their own archived seat (say, raise its rank) from a live seat
-- elsewhere and have that land the moment the unit comes back.

begin;

-- The old body of org_positions_held_by, verbatim: the current holder of every
-- non-abolished seat, whatever unit it sits in.
create or replace function public.org_positions_currently_held_by(p_person uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct cand.position_id), '{}'::uuid[])
    from (select distinct h.position_id
            from public.position_holders h
           where p_person is not null and h.person_id = p_person) cand
    join lateral (
      select h2.person_id
        from public.position_holders h2
       where h2.position_id = cand.position_id
         and h2.effective_from <= now()
       order by h2.effective_from desc, h2.id desc
       limit 1
    ) cur on cur.person_id = p_person
    join public.positions p on p.id = cand.position_id and p.abolished_at is null;
$$;

create or replace function public.org_positions_held_by(p_person uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct p.id), '{}'::uuid[])
    from public.positions p
   where p.id = any (public.org_positions_currently_held_by(p_person))
     and public.org_node_effectively_active(p.node_id);
$$;

revoke all on function public.org_positions_currently_held_by(uuid) from public, anon;
grant execute on function public.org_positions_currently_held_by(uuid) to authenticated;

commit;

begin;

-- profiles.role now reads the same filtered seat set instead of re-deriving "current
-- holder" inline, so the two can never disagree. A person the org model knows who holds
-- no live seat drops to 'pending' -- the role every account starts at -- rather than
-- being left at whatever their last seat granted. An account with no persons row at
-- all is still left alone: it was never in this model.
create or replace function public.org_derive_profile_role(p_account_id uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_person_id uuid;
  v_seats uuid[];
  v_ordinal numeric;
begin
  if p_account_id is null then
    return null;
  end if;

  if exists (
    select 1 from public.org_sysadmins s
     where s.account_id = p_account_id and s.active
  ) then
    return 'owner';
  end if;

  select id into v_person_id from public.persons where account_id = p_account_id;
  if v_person_id is null then
    return null;
  end if;

  v_seats := public.org_positions_held_by(v_person_id);

  if exists (
    select 1 from public.positions p
     where p.id = any (v_seats) and p.reports_to_position_id is null
  ) then
    return 'owner';
  end if;

  select min(r.ordinal) into v_ordinal
    from public.positions p
    join public.ranks r on r.id = p.rank_id
   where p.id = any (v_seats);

  if v_ordinal is null then
    return 'pending';
  elsif v_ordinal <= 5000 then
    return 'manager';   -- ceo (1000) / director (3000) / manager (5000)
  elsif v_ordinal <= 7000 then
    return 'supervisor';
  else
    return 'viewer';    -- staff (9000)
  end if;
end $$;

-- Two more facts now change a derived role, so two more tables resync it: a unit
-- going inactive or active again (everyone seated anywhere beneath it), and a seat
-- being abolished, re-ranked or moved. The affected people are found through the
-- raw holder rows on purpose -- the filtered helpers would return nobody for a
-- subtree that has just been archived, which is exactly the moment they must be
-- demoted.
create or replace function public.org_sync_profile_role()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_position_id uuid;
  v_own_person  uuid;
  v_prev_account record;
  v_account record;
begin
  if tg_table_name = 'org_sysadmins' then
    perform public.org_resync_profile_role(coalesce(new.account_id, old.account_id));
    return coalesce(new, old);
  end if;

  if tg_table_name = 'org_nodes' then
    for v_account in
      select distinct pe.account_id
        from public.persons pe
       where pe.account_id is not null
         and pe.id = any (public.org_persons_seated_in(public.org_subtree_ids(array[new.id])))
    loop
      perform public.org_resync_profile_role(v_account.account_id);
    end loop;
    return new;
  end if;

  -- The row types differ per table, so each branch reads its own record fields and
  -- hands the shared loop plain variables -- a positions row has no person_id, and
  -- PL/pgSQL resolves record fields when the statement is planned, not when the OR
  -- short-circuits.
  if tg_table_name = 'positions' then
    v_position_id := new.id;
    v_own_person  := null;
  else
    -- position_holders: resync the row's own person...
    v_own_person  := coalesce(new.person_id, old.person_id);
    v_position_id := coalesce(new.position_id, old.position_id);
    perform public.org_resync_profile_role(
      (select account_id from public.persons where id = v_own_person));
  end if;

  -- ...and every other person who has ever held the same position, since a new row
  -- here (or a change to the seat itself) can change who counts as "current" for all
  -- of them and what that seat is worth.
  for v_prev_account in
    select distinct pe.account_id
      from public.position_holders h
      join public.persons pe on pe.id = h.person_id
     where h.position_id = v_position_id
       and pe.account_id is not null
       and (v_own_person is null or h.person_id is distinct from v_own_person)
  loop
    perform public.org_resync_profile_role(v_prev_account.account_id);
  end loop;

  return coalesce(new, old);
end $$;

drop trigger if exists org_sync_profile_role_nodes on public.org_nodes;
create trigger org_sync_profile_role_nodes
  after update of active on public.org_nodes
  for each row when (old.active is distinct from new.active)
  execute function public.org_sync_profile_role();

drop trigger if exists org_sync_profile_role_positions on public.positions;
create trigger org_sync_profile_role_positions
  after update of abolished_at, rank_id, node_id on public.positions
  for each row execute function public.org_sync_profile_role();

commit;

begin;

-- The self-edit guard reads the unfiltered seat set (see the header). Everything else
-- in this function is 20260924000000_freeze_inactive_subtrees.sql's body, verbatim.
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
    if old.id = any (public.org_positions_currently_held_by(public.org_current_person_id())) then
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

-- The root unit is the company itself: archiving it would freeze every write in the
-- tree and, with privilege now flowing only from active seats, take org_admin() away
-- from the CEO seated in it -- a lockout with no UI way back. Refused unconditionally.
-- Everything else is 20260924000000_freeze_inactive_subtrees.sql's body, verbatim.
create or replace function public.org_guard_nodes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'nodes are never deleted; set active = false' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.parent_id is null and old.active and not new.active then
    raise exception 'the root unit cannot be deactivated' using errcode = '22023';
  end if;
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'a node cannot be its own parent' using errcode = '22023';
    end if;
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

commit;

begin;

-- One-time resync so anyone already seated only inside an archived unit is demoted
-- now, not on their next seat change.
do $$
declare v_profile record; v_role text;
begin
  for v_profile in select id from public.profiles where kind = 'human' loop
    v_role := public.org_derive_profile_role(v_profile.id);
    if v_role is not null then
      update public.profiles set role = v_role
       where id = v_profile.id and role is distinct from v_role;
    end if;
  end loop;
end $$;

commit;
