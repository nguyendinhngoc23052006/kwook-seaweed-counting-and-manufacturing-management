-- Grant the table privileges the RLS policies were always assuming.
--
-- Every table in this schema had RLS enabled and policies written, and NONE of
-- them were reachable: PostgREST returned 403 "permission denied" on the first
-- authenticated query. RLS filters rows on top of a GRANT; with no grant, the
-- role cannot touch the table at all and the policy never runs.
--
-- Why it happened, so it does not happen again: Supabase's default privileges
-- for the `postgres` role in `public` are
--
--   anon=Dxtm  authenticated=Dxtm  service_role=Dxtm
--   (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN - no SELECT/INSERT/UPDATE/DELETE)
--
-- Tables created in the dashboard get full DML because that path runs as
-- `supabase_admin`, whose default privileges DO include it. Migrations run as
-- `postgres`, so they must grant explicitly. Every future table in this repo
-- needs its grants written next to its policies.
--
-- We deliberately do NOT widen ALTER DEFAULT PRIVILEGES to auto-grant future
-- tables. A forgotten grant fails loudly with a 403; a forgotten RLS enable on
-- an auto-granted table exposes data silently. Loud beats silent on a security
-- boundary.
--
-- Each grant below mirrors that table's existing policies exactly - no command
-- is granted that has no policy behind it. `anon` gets nothing: nothing in this
-- app is public, and /demo touches no table.

-- Read-only for everyone who can see the tenant.
grant select on tenants        to authenticated;
grant select on access_log     to authenticated;

-- Immutable by design: a disputed month still says what it said. SELECT only,
-- so there is no client path to rewrite a report. Generation is server-side.
grant select on reports        to authenticated;

-- Profiles: no INSERT. The on_auth_user_created trigger is SECURITY DEFINER and
-- is the only thing that may create a profile. UPDATE is gated by
-- profile_admin_update.
grant select, update on profiles to authenticated;

-- Device-written event tables: devices INSERT, humans read.
grant select, insert on count_events       to authenticated;
grant select, insert on count_minutes      to authenticated;
grant select, insert on device_heartbeats  to authenticated;
grant select, insert on mode_transitions   to authenticated;
grant select, insert on stream_sessions    to authenticated;

-- compliance_events additionally allows supervisors to mark a review.
grant select, insert, update on compliance_events to authenticated;

-- Admin-managed tables carry an ALL policy, so all four commands.
grant select, insert, update, delete on devices            to authenticated;
grant select, insert, update, delete on stations           to authenticated;
grant select, insert, update, delete on operators          to authenticated;
grant select, insert, update, delete on calibrations       to authenticated;
grant select, insert, update, delete on pairing_codes      to authenticated;
grant select, insert, update, delete on stream_views       to authenticated;
grant select, insert, update, delete on validation_samples to authenticated;

-- These two are bigserial, not identity, so INSERT evaluates nextval() as the
-- caller. Without USAGE the table grant above is not enough and the insert
-- still fails. access_log has no INSERT policy, so its sequence stays ungranted.
grant usage on sequence device_heartbeats_id_seq to authenticated;
grant usage on sequence mode_transitions_id_seq  to authenticated;
