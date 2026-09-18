-- service_role could not write profiles/devices/pairing_codes: the pairing
-- Edge Function runs privileged steps as service_role, but tables born from
-- migrations (created by `postgres`) never got Supabase's usual service_role
-- grants - the same default-ACL gap that migration 20260915090000 fixed for
-- `authenticated`, which forgot service_role. That caused "permission denied
-- for table profiles" mid-claim (after the auth user was already created,
-- stranding orphan device accounts).
--
-- service_role is the trusted backend role (BYPASSRLS, never exposed to a
-- browser), so it gets full DML like every dashboard-created table already
-- grants it - and default privileges so future migration tables never repeat
-- this. This does NOT touch anon/authenticated (their loud-failure grants stay
-- table-by-table beside policies, per the repo rule).
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
