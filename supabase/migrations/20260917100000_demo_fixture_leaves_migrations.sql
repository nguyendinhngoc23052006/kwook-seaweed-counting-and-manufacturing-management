-- A demo fixture does not belong in a migration.
--
-- 20260915080000 seeded three stations - Belt 1, Portioning 1, Main door -
-- next to the tenant row that bootstrap genuinely needs. A migration runs in
-- EVERY environment, so those three arrive in production the first time main
-- deploys, and the owner opens a brand-new factory to find someone else's
-- imaginary one already in it. They have already caused confusion on staging:
-- the Wall showed a station labelled "compliance" because this fixture carried
-- the old algorithm words in `kind`, which is now the owner's own vocabulary.
--
-- The tenant insert STAYS. handle_new_user() resolves a new signup's tenant by
-- taking the oldest tenants row, so with no tenant every signup lands with no
-- profile and nobody can get in. A tenant is infrastructure; a belt is data.
--
-- The fixture moves to supabase/seed.sql, which Supabase applies to preview
-- branches and never to production. That is where a fixture belongs.
--
-- Deliberately conservative: a station goes only if it STILL MATCHES THE SEED
-- exactly - both the name and the old algorithm-word kind - and nothing
-- references it. An owner who renamed its kind, pointed a camera at it, or
-- counted one leaf on it keeps it. Deleting someone's real belt to tidy up a
-- fixture would be far worse than leaving the fixture.
-- Two statements, not one: a data-modifying CTE's deletions are NOT visible to
-- the rest of the same statement, so an `on ... not exists (select from
-- stations)` written inline still sees the rows it just removed and keeps every
-- line. Verified the hard way on a real Postgres - the one-statement version
-- left both demo lines standing.
create temp table removed_demo_stations as
  with gone as (
    delete from stations s
     where (s.name, s.kind) in (
             ('Belt 1', 'counting'),
             ('Portioning 1', 'provisioning'),
             ('Main door', 'compliance')
           )
       and not exists (select 1 from devices           d where d.station_id = s.id)
       and not exists (select 1 from count_minutes     c where c.station_id = s.id)
       and not exists (select 1 from count_events      c where c.station_id = s.id)
       and not exists (select 1 from compliance_events c where c.station_id = s.id)
       and not exists (select 1 from capture_sessions  x where x.station_id = s.id)
       and not exists (select 1 from calibrations      k where k.station_id = s.id)
    returning s.line_id
  )
  select line_id from gone where line_id is not null;

-- Only a line this migration just emptied, and only if it is now empty. Keying
-- on the seed's line names alone would delete a line the owner had created and
-- not yet filled.
delete from lines l
 where l.id in (select line_id from removed_demo_stations)
   and not exists (select 1 from stations s where s.line_id = l.id);

drop table removed_demo_stations;
