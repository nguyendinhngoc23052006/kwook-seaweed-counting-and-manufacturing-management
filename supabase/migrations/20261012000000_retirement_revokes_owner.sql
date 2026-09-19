-- Retiring a sysadmin took the org keys and left the floor keys.
--
-- org_sysadmins is append-only: org_retire_sysadmin() records a retirement by
-- inserting a NEW row with active = false, leaving the original active = true
-- row in place. Two functions then read that history and disagree.
--
-- org_is_sysadmin() reads it correctly -- `order by effective_from desc, id
-- desc limit 1`, i.e. the CURRENT state.
--
-- org_derive_profile_role() (20260924020000, section 8.2) reads it as
-- `exists (... where s.account_id = p and s.active)`, with no ordering and no
-- effective-dating. The original active = true row satisfies that forever, so
-- the derivation returns 'owner' for an account that org_is_sysadmin() has
-- already stopped recognising.
--
-- Demonstrated on a full replay of every migration into an empty database:
-- after retiring the seeded sysadmin, org_is_sysadmin's latest-row check
-- returned false while org_derive_profile_role returned 'owner' and
-- profiles.role stayed 'owner'.
--
-- That matters because 'owner' is the top of the legacy role ladder
-- (role_rank, 20260915170000) and is_human_at_least('owner') is what gates
-- the write policies on devices, stations, lines and capture_sessions. So a
-- retired sysadmin kept full write access to the entire camera and floor
-- stack -- the one thing retirement exists to remove.
--
-- Reading the roster correctly is not enough on its own. The derivation
-- returns NULL for an account with no seat, and org_resync_profile_role()
-- treats NULL as "leave profiles.role exactly as it is" -- deliberately, so
-- that an account which never had a seat is never demoted by a trigger that
-- fired for someone else. For a retired sysadmin that is the bug again:
-- the derivation stops saying 'owner' and the stored 'owner' simply stays.
-- So an account that HAS sysadmin history, is not currently a sysadmin, and
-- holds no seat now resolves to 'pending' -- the same place a brand-new
-- account starts, which is the honest description of someone who holds
-- neither the roster nor a chair. An account with no sysadmin history is
-- unaffected and still returns NULL.
--
-- No backfill: the only way an account becomes retired is an insert into
-- org_sysadmins, and that insert fires the role-sync trigger, which now calls
-- this corrected derivation. Staging currently holds exactly one sysadmin,
-- still active, so no stored role changes when this lands.
--
-- Only the sysadmin branch changes. The seat-based branches below it are
-- untouched, including the ordinal RANGES, which is what lets a rank like
-- middle_manager (6000) resolve without an edit here.

begin;

create or replace function public.org_derive_profile_role(p_account_id uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_person_id uuid;
  v_ordinal numeric;
  v_was_sysadmin boolean;
begin
  if p_account_id is null then
    return null;
  end if;

  -- The CURRENT sysadmin state, read the same way org_is_sysadmin() reads it.
  -- A plain `exists (... and s.active)` matches a superseded row forever.
  if coalesce((
    select s.active
      from public.org_sysadmins s
     where s.account_id = p_account_id
     order by s.effective_from desc, s.id desc
     limit 1), false)
  then
    return 'owner';
  end if;

  -- Not a sysadmin now. Were they ever? If so, every "no seat" path below
  -- must demote rather than leave the old 'owner' standing.
  v_was_sysadmin := exists (
    select 1 from public.org_sysadmins s where s.account_id = p_account_id);

  select id into v_person_id from public.persons where account_id = p_account_id;
  if v_person_id is null then
    return case when v_was_sysadmin then 'pending' else null end;
  end if;

  if exists (
    select 1
      from public.position_holders h
      join public.positions p on p.id = h.position_id and p.abolished_at is null
     where h.person_id = v_person_id
       and h.effective_from <= now()
       and p.reports_to_position_id is null
       and not exists (
         select 1 from public.position_holders h2
          where h2.position_id = h.position_id
            and h2.effective_from > h.effective_from
       )
  ) then
    return 'owner';
  end if;

  select min(r.ordinal) into v_ordinal
    from public.position_holders h
    join public.positions p on p.id = h.position_id and p.abolished_at is null
    join public.ranks r on r.id = p.rank_id
   where h.person_id = v_person_id
     and h.effective_from <= now()
     and not exists (
       select 1 from public.position_holders h2
        where h2.position_id = h.position_id
          and h2.effective_from > h.effective_from
     );

  if v_ordinal is null then
    -- No seat at all: leave profiles.role exactly as it is, unless this
    -- account is a retired sysadmin, whose 'owner' is what we came to remove.
    return case when v_was_sysadmin then 'pending' else null end;
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
