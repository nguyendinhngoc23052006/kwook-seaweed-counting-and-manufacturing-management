-- Two access systems have been growing side by side: profiles.role (pending
-- -> viewer -> supervisor -> manager -> owner, gating every camera/station/
-- report policy since day one) and the org/capability model (persons,
-- positions, ranks, org_sysadmins, gating /org). The owner asked for one
-- source of truth rather than two things that can drift.
--
-- The unification does NOT touch is_human_at_least()/role_rank() or any of
-- the ~25 policies that read them -- that surface is wide, camera-critical,
-- and untouched code is code that can't regress. Instead, profiles.role
-- becomes a SYNCED PROJECTION of the org model: whoever holds the root seat
-- or is an org_sysadmin is 'owner'; everyone else's role follows the most
-- senior rank of a position they currently hold. A person with no seat at
-- all is left alone (typically 'pending', from handle_new_user() -- this
-- migration never inserts a profiles row, only updates one that exists).
--
-- This changes where "make someone an owner" happens: not the Supabase
-- dashboard's Table Editor any more (that still WORKS, via the existing
-- profile_owner_update policy, as a manual override) but seating them into
-- the root position, or adding them to org_sysadmins, from the org chart UI.
-- CLAUDE.md's line about that is stale as of this migration; a follow-up doc
-- PR corrects it.

begin;

-- The five ranks that shipped with org_foundation.sql, mapped onto profiles'
-- five-tier ladder by seniority. 'owner' is not a rank at all here -- it's
-- root-seat-or-sysadmin, checked before any rank lookup ever runs.
create or replace function public.org_derive_profile_role(p_account_id uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_person_id uuid;
  v_ordinal int;
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

  -- Most senior held position's rank ordinal (lower ordinal = more senior),
  -- among positions this person is the CURRENT holder of (the latest
  -- effective_from row per position, same "who holds this seat right now"
  -- rule org_positions_held_by already uses).
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
    return null; -- no seat at all -- leave profiles.role exactly as it is
  elsif v_ordinal <= 5000 then
    return 'manager';   -- ceo (1000) / director (3000) / manager (5000)
  elsif v_ordinal <= 7000 then
    return 'supervisor';
  else
    return 'viewer';    -- staff (9000)
  end if;
end $$;

revoke all on function public.org_derive_profile_role(uuid) from public, anon, authenticated;

-- Fires whenever a seat changes hands (position_holders) or the sysadmin
-- roster changes -- the only two facts the derivation reads. Runs as the
-- trigger owner, so it needs no RLS bypass to write profiles.
--
-- A new holder row doesn't just promote its own person -- it also demotes
-- whoever held that SAME position a moment ago (they are no longer "current"
-- per org_positions_held_by's own rule), so both accounts are resynced.
create or replace function public.org_resync_profile_role(p_account_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if p_account_id is null then return; end if;
  v_role := public.org_derive_profile_role(p_account_id);
  if v_role is not null then
    update public.profiles
       set role = v_role
     where id = p_account_id and kind = 'human' and role is distinct from v_role;
  end if;
end $$;

create or replace function public.org_sync_profile_role()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_position_id uuid;
  v_prev_account record;
begin
  if tg_table_name = 'org_sysadmins' then
    perform public.org_resync_profile_role(coalesce(new.account_id, old.account_id));
    return coalesce(new, old);
  end if;

  -- position_holders: resync the row's own person...
  perform public.org_resync_profile_role(
    (select account_id from public.persons where id = coalesce(new.person_id, old.person_id)));

  -- ...and every other person who has ever held the same position, since a
  -- new row here can change who counts as "current" for all of them.
  v_position_id := coalesce(new.position_id, old.position_id);
  for v_prev_account in
    select distinct pe.account_id
      from public.position_holders h
      join public.persons pe on pe.id = h.person_id
     where h.position_id = v_position_id
       and h.person_id is distinct from coalesce(new.person_id, old.person_id)
  loop
    perform public.org_resync_profile_role(v_prev_account.account_id);
  end loop;

  return coalesce(new, old);
end $$;

drop trigger if exists org_sync_profile_role_holders on public.position_holders;
create trigger org_sync_profile_role_holders
  after insert or update or delete on public.position_holders
  for each row execute function public.org_sync_profile_role();

drop trigger if exists org_sync_profile_role_sysadmins on public.org_sysadmins;
create trigger org_sync_profile_role_sysadmins
  after insert or update or delete on public.org_sysadmins
  for each row execute function public.org_sync_profile_role();

-- One-time sync so rows that predate this migration reflect today's org
-- state immediately, not just on the next seat change.
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
