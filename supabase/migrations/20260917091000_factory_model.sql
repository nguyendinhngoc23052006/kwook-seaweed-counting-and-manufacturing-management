-- The factory model: a line is a THING, and the owner names the camera's job.
--
-- Two problems, one shape. A line existed only as free text on each station
-- row, so "Line Plant" and "line plant" were two different lines on the Wall
-- (src/pages/Wall.tsx groups on the raw string) and nothing could be said ABOUT
-- a line - not that it was retired, not that it was the same line as the one
-- next to it. And devices.role named a camera's job with the same word the
-- human ladder uses for a person's rank (profiles.role), which is how a URL
-- parameter ever looked like a plausible source for it.
--
-- So: lines become rows, stations point at them, and the camera's job is called
-- camera_function everywhere - matching capture_sessions.camera_function, which
-- migration 20260916170000 already named correctly.
--
-- profiles.role is NOT touched. That is the human ladder (viewer -> owner) that
-- role_rank() and is_human_at_least() read, and it keeps its name.

-- ------------------------------------------------------------------- lines

create table lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete restrict,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- The whole point of the table. Case and stray spaces stop minting new lines:
-- "Line A", "line a" and " Line A " are one row, and the Wall groups on an id.
create unique index lines_tenant_name_key on lines (tenant_id, lower(btrim(name)));

-- ------------------------------------------------- stations point at a line

alter table stations add column line_id uuid references lines (id) on delete restrict;
create index on stations (line_id);

-- Backfill, in this order: mint the lines, then resolve every station, then
-- verify, and only then drop the text. Each step reads what the one before it
-- wrote, so nothing here can run against a half-built table.
insert into lines (tenant_id, name)
select distinct on (s.tenant_id, lower(btrim(s.line))) s.tenant_id, btrim(s.line)
  from stations s
 where btrim(s.line) <> ''
 order by s.tenant_id, lower(btrim(s.line)), s.line;

update stations s
   set line_id = l.id
  from lines l
 where l.tenant_id = s.tenant_id
   and lower(btrim(l.name)) = lower(btrim(s.line));

-- A station whose line is blank resolves to nothing, and dropping the column
-- would erase the only record that it ever had a place on the floor. Fail the
-- migration instead and name the rows: the owner fixes the data, and the
-- migration re-runs. A station silently landing on no line is exactly the loss
-- this whole migration exists to prevent.
do $$
declare
  orphans text;
begin
  select string_agg(format('%s (%s)', name, id), ', ' order by name)
    into orphans
    from stations
   where line_id is null;

  if orphans is not null then
    raise exception
      'refusing to drop stations.line: no line resolved for these stations: %',
      orphans;
  end if;
end $$;

alter table stations drop column line;

-- ---------------------------------------------- devices.role -> the camera's function

-- A value-bearing rename, so everything that says the old name moves with it.
-- Inside the database that is exactly two things - the column and the CHECK
-- constraint init.sql named devices_role_check - because no policy or function
-- body ever read devices.role: the device write policies gate on
-- current_kind(), device_id, tenant_id and is_active_device(), and every
-- is_human_at_least() path reads profiles.role, a different column. Renaming
-- the column carries the constraint's body with it; the constraint's NAME does
-- not follow, hence the second statement.
alter table devices rename column role to camera_function;
alter table devices rename constraint devices_role_check to devices_camera_function_check;

comment on column devices.camera_function is
  'What the owner has this camera doing. The camera reads it; the camera never chooses it.';

-- ---------------------------------------------------------------------- RLS

alter table lines enable row level security;

create policy line_read on lines for select
  using (tenant_id = current_tenant() and is_human_at_least('viewer'));

create policy line_owner_insert on lines for insert
  with check (is_human_at_least('owner') and tenant_id = current_tenant());

create policy line_owner_update on lines for update
  using (is_human_at_least('owner') and tenant_id = current_tenant())
  with check (is_human_at_least('owner') and tenant_id = current_tenant());

-- No device read: a camera learns the line it is standing on from the
-- line_name its own capture_sessions row carries, not by listing the factory.

-- Grants ride beside the policies (see CLAUDE.md): this migration runs as
-- `postgres`, whose default privileges give authenticated only
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, so an ungranted table answers 403 /
-- 42501 before any policy runs. No DELETE, and no delete policy to grant
-- against: a line that closes is `active = false`, because deleting it would
-- have to take its stations - and everything they measured - with it.
grant select, insert, update on lines to authenticated;
