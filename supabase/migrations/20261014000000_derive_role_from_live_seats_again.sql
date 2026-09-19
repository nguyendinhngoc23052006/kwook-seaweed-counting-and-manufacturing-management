-- Repairing a regression I shipped in 20261012000000.
--
-- That migration fixed a real bug -- retiring a sysadmin left them 'owner'
-- because the roster was read with `exists (... and s.active)` instead of the
-- latest row. The fix was right. The way it was written was not: the new body
-- was based on the definition in 20260923000000_role_unification.sql, which
-- is not the live one. org_derive_profile_role had been redefined since, and
-- the later definition is the one that was running.
--
-- 20260924020000_privileges_from_active_seats.sql:60 had stopped querying
-- position_holders inline and switched to org_positions_held_by(), whose own
-- last definition (20260928000000_person_record_authority.sql:34) filters a
-- seat out when EITHER its node is not effectively active OR the holder's
-- status is not 'active'. It had also changed the no-seat answer from NULL
-- ("leave profiles.role alone") to 'pending'.
--
-- Rewriting the body from the older file silently reverted all three. Measured
-- on a replay of the merged migrations:
--
--   staff whose entire branch was switched off  -> 'viewer'   (should be 'pending')
--   manager marked departed                     -> 'manager'  (should be 'pending')
--
-- Both are the exact failures 20260924020000 and 20260928000000 were written
-- to fix. profiles.role is the key the whole legacy floor app checks -- camera,
-- station, wall, report -- so an archived unit or an offboarded person kept
-- their access to it.
--
-- This restores the live body and keeps the retirement fix on top of it:
--
--   * the sysadmin roster is read as the LATEST row, not any historical one,
--     so standing down takes effect (the 20261012000000 fix, preserved);
--   * seats come from org_positions_held_by(), so an archived branch and a
--     departed person both confer nothing (restored);
--   * no live seat means 'pending', for everyone and not just ex-sysadmins
--     (restored) -- which also covers the retired sysadmin case on its own;
--   * an account with no persons row is still left alone, because it was
--     never in this model -- unless it is a retired sysadmin, whose 'owner'
--     is precisely what standing down is supposed to remove.
--
-- The lesson, recorded here because the next person will hit it too: this
-- schema has 152 distinct functions redefined across 51 migrations and the
-- LAST definition is the one that runs. Grep every definition of a function
-- before replacing it; reading one file is how you revert three fixes.

begin;

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

  -- The CURRENT sysadmin state, read the way org_is_sysadmin() reads it. A
  -- plain `exists (... and s.active)` matches a superseded row forever, which
  -- is what let a retired sysadmin keep 'owner'.
  if coalesce((
    select s.active
      from public.org_sysadmins s
     where s.account_id = p_account_id
     order by s.effective_from desc, s.id desc
     limit 1), false)
  then
    return 'owner';
  end if;

  select id into v_person_id from public.persons where account_id = p_account_id;
  if v_person_id is null then
    -- Never in this model, so nothing to project -- except for someone who
    -- WAS a sysadmin, where leaving the stored role alone means leaving
    -- 'owner' standing.
    return case
      when exists (select 1 from public.org_sysadmins s where s.account_id = p_account_id)
      then 'pending'
      else null
    end;
  end if;

  -- The one seat set. It excludes seats in units that are not effectively
  -- active and seats held by anyone whose person status is not 'active', so
  -- archiving a branch and offboarding a person both take effect here without
  -- this function knowing either rule.
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

revoke all on function public.org_derive_profile_role(uuid) from public, anon, authenticated;

commit;
