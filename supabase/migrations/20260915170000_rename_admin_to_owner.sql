-- Rename the top human role 'admin' -> 'owner': the person owns the cameras
-- attached to their profile. This is a VALUE rename across the security layer,
-- so every piece moves together in one migration (connected-line rule):
-- the check constraint, role_rank (which every is_human_at_least gate reads),
-- existing rows, and every policy whose text says 'admin'. Miss the policies
-- and is_human_at_least('admin') would rank an unknown role 0 and let everyone
-- through - so they are all recreated with 'owner'.

-- Drop the old constraint FIRST (it still forbids 'owner'), migrate the rows
-- while no constraint is in force, then add the new one (which forbids the now
-- absent 'admin'). Any other order trips one constraint or the other.
alter table profiles drop constraint profiles_role_check;
update profiles set role = 'owner' where role = 'admin';
alter table profiles add constraint profiles_role_check
  check (role in ('pending', 'viewer', 'supervisor', 'manager', 'owner'));

create or replace function role_rank(r text) returns int
  language sql immutable as $$
  select case r
    when 'viewer' then 1 when 'supervisor' then 2
    when 'manager' then 3 when 'owner' then 4 else 0 end
$$;

drop policy device_admin_write on devices;
create policy device_owner_write on devices for all
  using (is_human_at_least('owner') and tenant_id = current_tenant())
  with check (is_human_at_least('owner') and tenant_id = current_tenant());

drop policy station_admin_write on stations;
create policy station_owner_write on stations for all
  using (is_human_at_least('owner') and tenant_id = current_tenant())
  with check (is_human_at_least('owner') and tenant_id = current_tenant());

drop policy operator_admin_write on operators;
create policy operator_owner_write on operators for all
  using (is_human_at_least('owner') and tenant_id = current_tenant())
  with check (is_human_at_least('owner') and tenant_id = current_tenant());

drop policy pairing_admin on pairing_codes;
create policy pairing_owner on pairing_codes for all
  using (is_human_at_least('owner') and tenant_id = current_tenant())
  with check (is_human_at_least('owner') and tenant_id = current_tenant());

drop policy calibration_admin on calibrations;
create policy calibration_owner on calibrations for all
  using (is_human_at_least('owner') and tenant_id = current_tenant())
  with check (is_human_at_least('owner') and tenant_id = current_tenant());

drop policy profile_admin_update on profiles;
create policy profile_owner_update on profiles for update
  using (is_human_at_least('owner') and tenant_id = current_tenant())
  with check (is_human_at_least('owner') and tenant_id = current_tenant());
