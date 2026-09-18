-- Open signup, closed access: every new account is PENDING until the owner
-- promotes it by hand in the Supabase dashboard (Table Editor -> profiles ->
-- role). Chosen by the owner over closed signup + hand-created accounts.
--
-- Why this is safe with signup open:
--   * role_rank() returns 0 for any role it does not know, so 'pending' fails
--     every is_human_at_least() gate with no policy changes. A pending account
--     can read exactly two things: its own profiles row (the waiting screen
--     needs it) and the tenant's name row. It can write nothing anywhere -
--     device INSERT policies require kind='device', which only an admin grants.
--   * The first-account-becomes-admin rule is DELETED here. It existed so a
--     closed system could bootstrap itself; with signup open it would be a race
--     to own the tenant. Nobody becomes admin except by the owner's hand in the
--     dashboard.
--   * Signup flooding is bounded by Supabase's rate limit (sign_in_sign_ups,
--     config.toml) and floods only produce inert pending rows.

alter table profiles drop constraint profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('pending', 'viewer', 'supervisor', 'manager', 'admin'));

create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  t_id uuid;
begin
  select id into t_id from tenants order by created_at limit 1;

  -- No tenant yet: let the signup succeed rather than failing it. An admin
  -- can attach the profile later; a failed signup would be far harder to
  -- recover from than a missing profile.
  if t_id is null then
    return new;
  end if;

  insert into profiles (id, tenant_id, kind, role, display_name)
  values (
    new.id,
    t_id,
    'human',
    'pending',
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), new.email, 'user')
  );
  return new;
end $$;
