begin;

-- Appointing a sysadmin was a rule with no door.
--
-- org_guard_sysadmins says, in as many words, "only a sitting sysadmin
-- appoints another" -- a rule that could never fire, because org_sysadmins has
-- a SELECT policy and a SELECT grant and nothing else. No INSERT policy, no
-- INSERT grant. The only sysadmin that ever existed was the one org_foundation
-- seeded by matching an email, and the account holding the top privilege in
-- this system could neither hand it to a colleague nor give it up.
--
-- That is a single point of failure with no recovery: one lost login and the
-- org model is permanently unadministrable, which is exactly the state
-- org_foundation's own self-check refuses to deploy into.
--
-- The table stays SELECT-only and append-only. These are definer RPCs, and the
-- guard above still runs on the insert they make, so the rule finally has the
-- door it was written for.

-- Appointment is by email because that is what a human knows. auth.users is
-- not readable by any client, so resolving it is the definer's job -- and the
-- caller is already the most privileged account in the system, so confirming
-- that an address exists tells them nothing they could not otherwise learn.
create or replace function public.org_appoint_sysadmin(p_email text, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_account uuid;
begin
  if not public.org_is_sysadmin() then
    raise exception 'only a sitting sysadmin appoints another' using errcode = '42501';
  end if;

  select id into v_account from auth.users
   where lower(email) = lower(btrim(p_email));
  if v_account is null then
    raise exception 'no account with that email has ever signed in' using errcode = '22023';
  end if;

  if coalesce((select s.active from public.org_sysadmins s
                where s.account_id = v_account
                order by s.effective_from desc, s.id desc limit 1), false) then
    raise exception 'that account is already a sysadmin' using errcode = '22023';
  end if;

  insert into public.org_sysadmins (account_id, active, note)
  values (v_account, true, nullif(btrim(coalesce(p_note, '')), ''));

  insert into public.org_audit (actor_account_id, entity_type, entity_id, action, after_json)
    values (auth.uid(), 'org_sysadmin', v_account::text, 'sysadmin_appointed',
            jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;
revoke all on function public.org_appoint_sysadmin(text, text) from public, anon;
grant execute on function public.org_appoint_sysadmin(text, text) to authenticated;

-- Standing down. Refused when it would empty the room: a model with no active
-- sysadmin cannot create the first seat or write the first grant and is inert
-- forever, which is the precise condition org_foundation's self-check exists
-- to prevent. Appoint your successor first.
create or replace function public.org_retire_sysadmin(p_account_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_active int;
begin
  if not public.org_is_sysadmin() then
    raise exception 'only a sitting sysadmin retires another' using errcode = '42501';
  end if;

  if not coalesce((select s.active from public.org_sysadmins s
                    where s.account_id = p_account_id
                    order by s.effective_from desc, s.id desc limit 1), false) then
    raise exception 'that account is not a sitting sysadmin' using errcode = '22023';
  end if;

  select count(*) into v_active from (
    select distinct on (s.account_id) s.account_id, s.active
      from public.org_sysadmins s
     order by s.account_id, s.effective_from desc, s.id desc) current
   where current.active;
  if v_active <= 1 then
    raise exception 'that is the last sysadmin; appoint a successor first'
      using errcode = '22023';
  end if;

  insert into public.org_sysadmins (account_id, active, note)
  values (p_account_id, false, nullif(btrim(coalesce(p_note, '')), ''));

  insert into public.org_audit (actor_account_id, entity_type, entity_id, action, after_json)
    values (auth.uid(), 'org_sysadmin', p_account_id::text, 'sysadmin_retired',
            jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;
revoke all on function public.org_retire_sysadmin(uuid, text) from public, anon;
grant execute on function public.org_retire_sysadmin(uuid, text) to authenticated;

-- Who currently sits. org_sysadmins' own SELECT policy shows a caller their
-- own row only (or everything, to a sysadmin), and the email lives in
-- auth.users which no client may read -- so a sysadmin could not see who else
-- holds the keys.
create or replace function public.org_sysadmin_list()
returns table (account_id uuid, email text, since timestamptz, note text)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not public.org_is_sysadmin() then
    raise exception 'only a sysadmin sees the sysadmin list' using errcode = '42501';
  end if;
  return query
    select current.account_id, u.email::text, current.effective_from, current.note
      from (select distinct on (s.account_id) s.account_id, s.active, s.effective_from, s.note
              from public.org_sysadmins s
             order by s.account_id, s.effective_from desc, s.id desc) current
      join auth.users u on u.id = current.account_id
     where current.active
     order by current.effective_from;
end $fn$;
revoke all on function public.org_sysadmin_list() from public, anon;
grant execute on function public.org_sysadmin_list() to authenticated;

commit;
