-- =====================================================================
--  RESET THE FLOOR - destroys every camera, station and measurement.
--  Run it in the Supabase dashboard: SQL editor -> New query -> paste ->
--  edit the ONE line marked below -> Run.
-- =====================================================================
--
--  WHAT THIS DESTROYS, permanently and with no undo:
--    * every count (count_events, count_minutes) and every PPE check
--      (compliance_events), with their manual validation samples
--    * every capture session, heartbeat, mode transition and stream row -
--      the whole record of how those numbers were produced
--    * every pairing code, every camera (devices), every station, every line
--    * every station calibration
--    * every account in your tenant EXCEPT yours - camera accounts and human
--      accounts alike, including their auth.users rows
--
--  WHAT SURVIVES:
--    * your auth.users row, your profiles row, your tenant
--    * operators (the badge roster - it is people, not floor equipment)
--    * reports (rule 7: a report snapshot is immutable, so a disputed month
--      still says what it said; on a floor that never went live there are none)
--    * access_log rows that are yours or have no actor
--
--  NEVER RUN THIS AGAINST PRODUCTION ONCE REAL COUNTS EXIST. There is no
--  backup taken here and no way back. It is a SETUP tool: it exists so an
--  owner can wipe a half-built floor and run setup again from clean.
--
--  WHY THIS IS A SCRIPT AND NOT A MIGRATION: migrations are the schema's
--  single source of truth and every environment applies all of them. This
--  deletes DATA. As a migration it would run itself against staging and
--  production on the next deploy, which is precisely the accident it must not
--  be able to cause. Nothing here is committed to the schema; the file is a
--  documented thing you paste, once, on purpose.
--
--  THIS IS THE ONLY PATH THAT REMOVES DEVICE auth.users ROWS.
--  Migration 20260917090000 made every device_id and station_id foreign key
--  ON DELETE RESTRICT, so outside this script deleting a camera - from the
--  dashboard, the SQL editor, service_role, anywhere - is refused by the
--  database while a single count still points at it. That is the point: a
--  camera is an INSTRUMENT, and deleting the instrument must never delete what
--  it measured. Here it is safe for exactly one reason: the measurements are
--  deleted in the SAME transaction, in the order the constraints demand, so
--  nothing is ever orphaned and nothing is silently detached from the line it
--  came off. Take any delete below out of this script and it will fail - as
--  designed.
--
--  RLS is not what lets this run: the SQL editor runs as `postgres`, which
--  owns these tables and is therefore not subject to their policies. The
--  foreign keys still apply to it, which is why the order below matters.
--
--  DRY RUN: change the final `commit;` to `rollback;` and run it once.
--  Nothing is destroyed and any blocking constraint is named in the error.
--  (Supabase's editor only shows the LAST statement's result, so on a dry run
--  the survivor report below it is not displayed - its job there is to prove
--  the script executes cleanly end to end.)
--
--  Expect a "there is already a transaction in progress" notice; the editor
--  opens its own transaction and the `begin;` below joins it. Harmless.
-- =====================================================================

begin;

-- ------------------------------------------------- the one line you edit

-- Your owner email, exactly as it appears in Authentication -> Users.
create temporary table wipe_target on commit drop as
select u.id as owner_user_id, p.tenant_id, p.role
  from auth.users u
  join profiles p on p.id = u.id
 where lower(u.email) = lower('YOU@EXAMPLE.COM');   -- <<< EDIT THIS

-- A wipe that guesses its survivor is unacceptable: if the email matches no
-- account, or somehow more than one, nothing is deleted. And the survivor must
-- actually be the owner - leaving a 'pending' or 'viewer' account as the only
-- account in the tenant would lock the factory out of its own dashboard, and
-- role_rank() ranks unknown roles 0, so nobody could promote anybody back.
do $$
declare
  found_rows int;
  found_role text;
begin
  select count(*) into found_rows from wipe_target;

  if found_rows = 0 then
    raise exception
      'reset-floor: no account matches that email. Nothing was deleted. Check Authentication -> Users for the exact address.';
  elsif found_rows > 1 then
    raise exception
      'reset-floor: % accounts match that email. Nothing was deleted - refusing to guess which one survives.', found_rows;
  end if;

  select role into found_role from wipe_target;
  if found_role <> 'owner' then
    raise exception
      'reset-floor: that account has role "%", not "owner". Nothing was deleted - promote it in Table Editor -> profiles -> role first, or this wipe would leave the tenant with no owner.', found_role;
  end if;
end $$;

-- ------------------------------------------------------ 1. the measurements

-- Polymorphic: validation_samples.event_id points at a count_events OR a
-- compliance_events row with no foreign key to enforce it, so it is deleted
-- first by hand rather than by a constraint.
delete from validation_samples where tenant_id = (select tenant_id from wipe_target);

delete from count_events      where tenant_id = (select tenant_id from wipe_target);
delete from count_minutes     where tenant_id = (select tenant_id from wipe_target);
delete from compliance_events where tenant_id = (select tenant_id from wipe_target);

-- ------------------------------------------ 2. how they were produced

-- stream_views before stream_sessions (its session_id cascades, but doing it
-- explicitly keeps the order readable). capture_sessions after count_minutes,
-- which points at it.
delete from stream_views      where tenant_id = (select tenant_id from wipe_target);
delete from stream_sessions   where tenant_id = (select tenant_id from wipe_target);
delete from device_heartbeats where tenant_id = (select tenant_id from wipe_target);
delete from mode_transitions  where tenant_id = (select tenant_id from wipe_target);
delete from capture_sessions  where tenant_id = (select tenant_id from wipe_target);

-- --------------------------------------------------------- 3. pairing codes

delete from pairing_codes where tenant_id = (select tenant_id from wipe_target);

-- ------------------------------------------------------- 4. calibrations

-- calibrations.station_id is RESTRICT, so these go before stations - and
-- calibrations.set_by points at profiles, so they go before the accounts too.
delete from calibrations where tenant_id = (select tenant_id from wipe_target);

-- ------------------------------------------------------------ 5. cameras

-- Everything that referenced a device is gone, so RESTRICT now lets go.
delete from devices where tenant_id = (select tenant_id from wipe_target);

-- ----------------------------------------------------------- 6. accounts

-- access_log.actor_id references profiles with no ON DELETE action, so a
-- single export logged by a doomed account would block the whole wipe. Your
-- own rows and rows with no actor are kept.
delete from access_log
 where tenant_id = (select tenant_id from wipe_target)
   and actor_id is not null
   and actor_id <> (select owner_user_id from wipe_target);

-- profiles.id -> auth.users is ON DELETE CASCADE, so the profile rows are
-- deleted first and their auth users removed by id in the same statement.
-- Auth's own children (identities, sessions, refresh tokens) cascade from
-- auth.users. An auth account with no profile row belongs to no tenant and can
-- do nothing, so it is left alone - the survivor report counts them.
with doomed as (
  delete from profiles
   where tenant_id = (select tenant_id from wipe_target)
     and id <> (select owner_user_id from wipe_target)
  returning id
)
delete from auth.users u using doomed d where u.id = d.id;

-- -------------------------------------------------------------- 7. the floor

-- This also clears the three bootstrap seed stations from migration
-- 20260915080000 - 'Belt 1', 'Portioning 1' and 'Main door', whose `kind`
-- values were 'counting', 'provisioning' and 'compliance'. Those are words for
-- what a CAMERA computes, not for what a place IS, which is why the Wall showed
-- a station labelled "compliance". Migration 20260916170000 dropped the CHECK
-- that forced them, so the stations you create next carry your own words.
delete from stations where tenant_id = (select tenant_id from wipe_target);

-- Lines last: stations.line_id is RESTRICT. These are the rows migration
-- 20260917091000 minted from the old stations.line text ('Line A', 'Plant').
delete from lines where tenant_id = (select tenant_id from wipe_target);

-- -------------------------------------------------- 8. the reaper's backlog

-- Queued messages naming sessions that no longer exist are harmless - the
-- drain closes nothing and deletes the message - but clearing them keeps the
-- floor clean. Guarded so this script still runs on a database that has not
-- applied 20260917093000.
-- The inner statement is EXECUTEd as a string because plpgsql analyses a whole
-- IF expression before evaluating it: naming pgmq.list_queues() directly would
-- fail with "schema pgmq does not exist" on the very database the guard exists
-- to protect.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pgmq') then
    execute $q$
      select pgmq.purge_queue('lost_capture_sessions')
       where exists (select 1 from pgmq.list_queues() where queue_name = 'lost_capture_sessions')
    $q$;
  end if;
end $$;

-- ------------------------------------------------------- what survived

select *
  from (values
    ( 1, 'your tenant',            (select count(*) from tenants where id = (select tenant_id from wipe_target))),
    ( 2, 'your profile',           (select count(*) from profiles where id = (select owner_user_id from wipe_target))),
    ( 3, 'other profiles',         (select count(*) from profiles where id <> (select owner_user_id from wipe_target))),
    ( 4, 'auth users (all)',       (select count(*) from auth.users)),
    ( 5, 'devices',                (select count(*) from devices)),
    ( 6, 'stations',               (select count(*) from stations)),
    ( 7, 'lines',                  (select count(*) from lines)),
    ( 8, 'count_events',           (select count(*) from count_events)),
    ( 9, 'count_minutes',          (select count(*) from count_minutes)),
    (10, 'compliance_events',      (select count(*) from compliance_events)),
    (11, 'capture_sessions',       (select count(*) from capture_sessions)),
    (12, 'device_heartbeats',      (select count(*) from device_heartbeats)),
    (13, 'mode_transitions',       (select count(*) from mode_transitions)),
    (14, 'stream_sessions',        (select count(*) from stream_sessions)),
    (15, 'stream_views',           (select count(*) from stream_views)),
    (16, 'pairing_codes',          (select count(*) from pairing_codes)),
    (17, 'calibrations',           (select count(*) from calibrations)),
    (18, 'validation_samples',     (select count(*) from validation_samples)),
    (19, 'operators (kept)',       (select count(*) from operators)),
    (20, 'reports (kept)',         (select count(*) from reports)),
    (21, 'access_log (kept)',      (select count(*) from access_log))
  ) as survived(ord, thing, row_count)
 order by ord;

-- Leave as commit; to keep the wipe. Change to rollback; for a dry run.
commit;
