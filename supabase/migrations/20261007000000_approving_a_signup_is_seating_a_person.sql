-- Approving a sign-up means SEATING someone, not editing their role.
--
-- The legacy admin screen approved a pending account by writing profiles.role
-- directly. Since 20260923000000 that column is a synced PROJECTION of seats --
-- a trigger rewrites it on every seat and sysadmin change -- so an approval
-- made that way survives only until the next seat change overwrites it. The
-- screen has been quietly wrong ever since, and it is deleted in this PR.
--
-- The org-native act is: a person record exists, a seat is held, and the login
-- is attached to that person. The role then follows from the seat and cannot
-- drift, because nothing writes it by hand.
--
-- What was missing was only the ability to SEE which accounts have no person
-- yet. persons.account_id was already writable by the sysadmin or the CEO and
-- by nobody else (org_guard_persons, 20260928000000); attaching one meant
-- knowing a uuid that no screen displayed, so in practice it meant opening the
-- dashboard. This closes that.

begin;

-- Camera accounts are auth.users too, and every claimed camera would otherwise
-- appear here as a person waiting to be approved. They are excluded by what
-- they are, not by a naming convention on their e-mail.
--
-- Security definer to read auth.users at all, and gated INSIDE the body on
-- org_admin() -- the same gate org_guard_persons enforces on the write this
-- list exists to feed. A non-admin gets an empty list rather than an error:
-- the control that consumes it is only drawn for admins anyway, so an empty
-- result is never the thing a real caller sees.
create or replace function public.org_unattached_accounts()
returns table (account_id uuid, email text, signed_up_at timestamptz)
language sql stable security definer set search_path = public, auth as $fn$
  select u.id, u.email::text, u.created_at
    from auth.users u
   where public.org_admin()
     and not exists (select 1 from public.persons p where p.account_id = u.id)
     and not exists (select 1 from public.camera_devices d where d.id = u.id)
   order by u.created_at desc
   limit 200;
$fn$;

revoke all on function public.org_unattached_accounts() from public;
grant execute on function public.org_unattached_accounts() to authenticated;

commit;
