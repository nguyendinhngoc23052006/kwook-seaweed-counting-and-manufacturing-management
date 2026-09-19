-- Rank authority: an inferior may not edit a superior's seat.
--
-- `appoint_into_seat_below` is granted to a NODE, and org_guard_positions /
-- org_guard_position_holders only ever asked whether the actor's capability
-- REACHED that node. Nothing compared the actor's own rank to the rank of the
-- seat being written, so two holders seated in the same node were equals to
-- the database however far apart they sat on the chart.
--
-- Reproduced on the staging branch before this migration was written, inside a
-- rolled-back transaction: a supervisor (ordinal 7000) holding
-- `appoint_into_seat_below` on their own unit re-ranked a peer manager seat
-- (5000) down to staff (9000) and renamed it, and the guard raised nothing.
-- The existing checks are all structural -- a manager may not sit below its own
-- reports -- and structure is satisfied by demoting someone who has no reports.
--
-- The capability is named for what it was always meant to mean. This is the
-- check that makes the name true.

-- The most senior rank the caller effectively holds. `org_positions_held_by`
-- (not the `_currently_` variant) is deliberate: a seat inside an archived
-- branch confers nothing, so it must not confer authority either. NULL when
-- the caller holds no live seat at all.
create or replace function public.org_my_rank_ordinal()
returns numeric language sql stable security definer set search_path = public as $$
  select min(r.ordinal)
    from public.positions p
    join public.ranks r on r.id = p.rank_id
   where p.id = any (public.org_positions_held_by(public.org_current_person_id()));
$$;
revoke all on function public.org_my_rank_ordinal() from public, anon;
grant execute on function public.org_my_rank_ordinal() to authenticated;

-- Strictly junior, and coalesced to false. For a caller with no seat
-- org_my_rank_ordinal() is NULL, and `9000 > NULL` is NULL, so a bare
-- `if not (...) then raise` would never fire -- the exact three-valued hole
-- that 20260924040000 had to close elsewhere. No seat means no seniority over
-- anyone, so NULL must read as "refuse", never as "allow".
create or replace function public.org_outranks(p_ordinal numeric)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_ordinal > public.org_my_rank_ordinal(), false);
$$;
revoke all on function public.org_outranks(numeric) from public, anon;
grant execute on function public.org_outranks(numeric) to authenticated;

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
  if not exists (select 1 from public.org_nodes n where n.id = new.node_id and n.active) then
    raise exception 'a seat must sit in an active node' using errcode = '22023';
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
revoke all on function public.org_guard_positions() from public, anon, authenticated;

-- Seating carries the same hole: reaching the node was enough to put a person
-- into any seat in it, including one ranked above the actor.
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
revoke all on function public.org_guard_position_holders() from public, anon, authenticated;
