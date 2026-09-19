begin;

-- Two holes in the person record, found while building offboarding.
--
-- 1. A person with a login could rewrite their OWN employment record.
--    persons_update admits `account_id = auth.uid()` with no column restriction,
--    and org_guard_persons blocks only employee_code, id and account_id.
--    Reproduced on a full replay as `authenticated`: a worker set their own
--    status to 'departed', rewrote their own national_id, backdated their own
--    hire_date and changed their own legal name -- all ALLOWED. The app's own
--    self-service form only ever sends display_name and phone, so nothing
--    legitimate depended on the rest being open.
--
-- 2. Departing somebody did not take their authority away. persons.status is
--    read when SEATING a person (8.5) and when matching a face, and nowhere
--    else -- so a departed person who was already seated kept the seat, kept
--    every capability it reached, and kept using them. Offboarding would have
--    been a label.

-- =====================================================================================
-- 1. A seat confers nothing unless its holder is active
-- =====================================================================================
--
-- The choke point, not a new one: org_positions_held_by is what every
-- capability check reaches through (org_nodes_reached_with ->
-- org_my_seat_node_ids -> here), and 20260924020000 already used it to make an
-- archived unit's seats confer nothing. A suspended or departed holder is the
-- same shape of fact, so it belongs in the same place rather than in each of
-- the callers.
--
-- Nothing is deleted: the person, the seat, the holder row and every hour they
-- ever worked stay exactly as they are. Reactivating restores the lot, the way
-- reactivating a unit does.
create or replace function public.org_positions_held_by(p_person uuid)
returns uuid[] language sql stable security definer set search_path = public as $fn$
  select coalesce(array_agg(distinct p.id), '{}'::uuid[])
    from public.positions p
   where p.id = any (public.org_positions_currently_held_by(p_person))
     and public.org_node_effectively_active(p.node_id)
     and exists (select 1 from public.persons pe
                  where pe.id = p_person and pe.status = 'active');
$fn$;
revoke all on function public.org_positions_held_by(uuid) from public, anon;
grant execute on function public.org_positions_held_by(uuid) to authenticated;

-- =====================================================================================
-- 2. Your contact details are yours; your employment record is your manager's
-- =====================================================================================
--
-- org_maintainable_person_ids() cannot be used to tell self from subordinate:
-- it appends your own id on purpose, which is exactly what let the self-branch
-- through. The test here is the reach WITHOUT that append.
create or replace function public.org_maintains_other(p_person_id uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select coalesce(
    p_person_id is not null
    and p_person_id <> public.org_current_person_id()
    and p_person_id = any (public.org_persons_seated_in(
          public.org_nodes_reached_with('maintain_person_profile'))),
    false);
$fn$;
revoke all on function public.org_maintains_other(uuid) from public, anon;
grant execute on function public.org_maintains_other(uuid) to authenticated;

create or replace function public.org_guard_persons()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'persons are never deleted (employee codes must never be reused); set status = ''departed'''
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.employee_code := 'KV-' || lpad(nextval('public.employee_code_seq')::text, 6, '0');
    new.created_at := now();
    new.created_by := auth.uid();
    new.updated_at := now();
    new.updated_by := auth.uid();
    if new.account_id is not null and auth.uid() is not null and not public.org_admin() then
      raise exception 'only the sysadmin or the CEO links a person to an account'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.employee_code is distinct from old.employee_code then
    raise exception 'an employee code is issued once and never changes' using errcode = '42501';
  end if;
  if new.id is distinct from old.id then
    raise exception 'a person id is permanent' using errcode = '42501';
  end if;
  if new.account_id is distinct from old.account_id
     and auth.uid() is not null and not public.org_admin() then
    raise exception 'only the sysadmin or the CEO links or unlinks an account'
      using errcode = '42501';
  end if;

  -- The employment record. Editable by an admin or by somebody who maintains
  -- this person and is not this person; never by the subject themselves, whose
  -- own status is the one field that decides whether they still work here.
  if auth.uid() is not null
     and not public.org_admin()
     and not public.org_maintains_other(new.id) then
    if new.status is distinct from old.status
       or new.full_name is distinct from old.full_name
       or new.date_of_birth is distinct from old.date_of_birth
       or new.national_id is distinct from old.national_id
       or new.hire_date is distinct from old.hire_date
       or new.employment_note is distinct from old.employment_note then
      raise exception 'you may change your contact details, not your employment record'
        using errcode = '42501';
    end if;
  end if;

  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $fn$;
revoke all on function public.org_guard_persons() from public, anon, authenticated;

commit;
