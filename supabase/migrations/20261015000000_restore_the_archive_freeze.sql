-- Restore the archive freeze that 20260926000000 silently reverted.
--
-- 20260924000000_freeze_inactive_subtrees.sql put an ancestor-aware freeze in
-- both seat guards, above each trigger's administrator exemption, so that even
-- the chief executive has to reactivate a branch before building on it. Its own
-- comment explains why the check cannot be a bare `n.active`: that form "is
-- trivially defeated by one extra level of node creation".
--
-- 20260926000000_rank_authority.sql then rewrote both guards to add the rank
-- rules. Its bodies were based on the pre-freeze definitions, so
-- org_guard_positions came back with exactly the bare `n.active` check the
-- freeze had replaced, and org_guard_position_holders came back with no
-- appoint-into-inactive check at all. The refusal message "cannot appoint into
-- an inactive unit -- reactivate it first" has not existed in the running
-- database since.
--
-- Measured on a replay of the merged migrations. Switch off Khoi A only,
-- leaving its child Phong A1 with active = true:
--
--   Phong A1: own active flag = true, org_node_effectively_active = FALSE
--   create a seat there  -> ALLOWED
--   seat a person there  -> ALLOWED
--
-- Archiving a unit is the product's way of saying nothing new happens here, and
-- both of the things that freeze exists to stop were possible one level down.
--
-- The same rewrite over-corrected in the other direction too: a bare check
-- fires on every UPDATE, not only when a seat arrives in a unit, so a seat
-- inside an archived branch could not be abolished either -- archiving made a
-- branch permanently untidyable. The restored form checks on INSERT or on a
-- move, which is what 20260924000000 wrote.
--
-- This is the same mistake as 20261014000000 on this branch, made earlier and
-- by the same mechanism: rewriting a function body from a definition that is
-- not the live one. Both guards below are the CURRENT 20260926000000 bodies
-- copied verbatim, with only the two freeze checks put back -- every rank rule
-- that migration added is untouched.

begin;

create or replace function public.org_guard_positions()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_mine numeric;
  v_old  numeric;
  v_mgr  numeric;
  v_bad  integer;
  v_live integer;
begin
  -- Coherence ---------------------------------------------------------------------
  select r.ordinal into v_mine from public.ranks r where r.id = new.rank_id;
  if v_mine is null then
    raise exception 'unknown rank' using errcode = '22023';
  end if;
  -- Ancestor-aware, and only when the seat arrives in a unit. A bare check on
  -- the unit's own flag is defeated by one extra level of node creation, and
  -- checking it on every UPDATE also froze the tidying-up (abolishing a seat)
  -- that archiving a branch is supposed to leave possible.
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
    -- NEW: a seat you create must sit below you. Without this, a supervisor
    -- who may appoint in their own unit could mint a director seat in it and
    -- then seat an ally above themselves.
    if not public.org_outranks(v_mine) then
      raise exception 'you may only create a seat below your own rank' using errcode = '42501';
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
    -- NEW: both the seat as it stands and as it would become must sit below
    -- you. Checking only the new rank would let an inferior demote a superior
    -- (the reproduced case); checking only the old would let them promote a
    -- junior seat above themselves in one statement.
    select r.ordinal into v_old from public.ranks r where r.id = old.rank_id;
    if not public.org_outranks(v_old) then
      raise exception 'you may only change a seat below your own rank' using errcode = '42501';
    end if;
    if not public.org_outranks(v_mine) then
      raise exception 'you may not raise a seat to or above your own rank' using errcode = '42501';
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

create or replace function public.org_guard_position_holders()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_node      uuid;
  v_abolished timestamptz;
  v_status    text;
  v_max       timestamptz;
  v_rank      numeric;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'position_holders is append-only; insert a new effective-dated row'
      using errcode = '42501';
  end if;

  select p.node_id, p.abolished_at, r.ordinal into v_node, v_abolished, v_rank
    from public.positions p
    join public.ranks r on r.id = p.rank_id
   where p.id = new.position_id;
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

  -- One transaction-scoped lock per timeline closes the read-then-write race in the
  -- backdate check below: two concurrent inserts would otherwise both read the same
  -- max() and both pass. It costs nothing at this write volume.
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
  -- NEW: and the seat must be below you. Vacating is the same write with a
  -- null person, so this also stops an inferior emptying a superior's seat.
  if not public.org_outranks(v_rank) then
    raise exception 'you may only seat or vacate a seat below your own rank' using errcode = '42501';
  end if;
  if new.person_id is not null
     and public.org_person_node_ids(new.person_id) <> '{}'::uuid[]
     and not public.org_person_in_my_scope(new.person_id) then
    raise exception 'that person already holds a seat outside your branch' using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function public.org_guard_positions() from public, anon, authenticated;
revoke all on function public.org_guard_position_holders() from public, anon, authenticated;

commit;
