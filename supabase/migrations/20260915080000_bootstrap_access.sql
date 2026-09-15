-- Bootstrap: without this, signing up creates an auth.users row and nothing
-- else. profiles has no INSERT policy and no code path writes it, so every
-- login resolves to a null profile and the app bounces back to the sign-in
-- screen with correct credentials. Nobody can ever get in.

-- ---------------------------------------------------------------- the tenant

insert into tenants (name) values ('Kwook');

insert into stations (tenant_id, name, line, kind)
select id, 'Belt 1', 'Line A', 'counting' from tenants
union all
select id, 'Portioning 1', 'Line A', 'provisioning' from tenants
union all
select id, 'Main door', 'Plant', 'compliance' from tenants;

-- ------------------------------------------------- profile on user creation

-- SECURITY DEFINER because it writes profiles, which has no INSERT policy by
-- design: a profile is never created by a client, only by this trigger.
create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  t_id uuid;
  first_admin boolean;
begin
  select id into t_id from tenants order by created_at limit 1;

  -- No tenant yet: let the signup succeed rather than failing it. An admin
  -- can attach the profile later; a failed signup would be far harder to
  -- recover from than a missing profile.
  if t_id is null then
    return new;
  end if;

  select not exists (
    select 1 from profiles where tenant_id = t_id and role = 'admin'
  ) into first_admin;

  insert into profiles (id, tenant_id, kind, role, display_name)
  values (
    new.id,
    t_id,
    'human',
    case when first_admin then 'admin' else 'viewer' end,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), new.email, 'user')
  )
  on conflict (id) do nothing;

  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ------------------------------------------------------- admin can promote

-- An admin turns a freshly signed-up account into a device (kind = 'device')
-- and assigns its role and station. Without an UPDATE policy the admin UI can
-- read profiles and change nothing.
create policy profile_admin_update on profiles for update
  using (is_human_at_least('admin') and tenant_id = current_tenant())
  with check (is_human_at_least('admin') and tenant_id = current_tenant());

-- Humans in the tenant need to see each other for the admin list to be usable;
-- the existing profile_self policy only exposed your own row plus managers'.
create policy profile_roster on profiles for select
  using (tenant_id = current_tenant() and is_human_at_least('supervisor'));
