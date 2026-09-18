-- 8.11 Check-in / check-out cameras.
--
-- Two phones at the doors: one where people come in, one at the only way out.
-- A person stands in the camera's zone, it flashes, takes a picture, turns the
-- face into a 128-number embedding ON THE PHONE (TensorFlow.js), and sends only
-- those numbers. The server matches them against the embeddings enrolled from
-- people's profile pictures and logs a check-in or check-out at that moment,
-- which the hours report pairs up.
--
-- The nine rules, applied to faces:
--   1. The phone is write-only. It never reads a person, a photo or an
--      embedding; matching happens inside one SECURITY DEFINER RPC.
--   2. Which door the phone is at comes from camera_devices.role, set by a
--      manager who holds manage_camera_devices -- never from the phone.
--   3. model_version rides on every embedding and every capture: two versions
--      of the nets are not comparable, and the RPC refuses to compare them.
--   4. Every capture has a deterministic id (device, person, minute); a retry
--      lands on the row that is already there.
--   6. No picture from the door is ever stored. The enrolment photo (a profile
--      picture a manager or the person chose) lives in a private bucket.
--
-- Privilege follows the org model: the hours report is a new capability
-- (view_attendance_below) granted per unit by whoever configures capabilities
-- above it; enrolment rides the existing maintain_person_profile capability or
-- the person's own row.

begin;

-- =====================================================================================
-- 1. Two new roles for the org camera stack
-- =====================================================================================

alter table public.camera_devices drop constraint camera_devices_role_check;
alter table public.camera_devices add constraint camera_devices_role_check
  check (role in ('provisioning', 'counting', 'compliance', 'overview', 'check_in', 'check_out'));

-- Zone, proximity, cooldown, threshold -- per device, editable from the org hub
-- through org_camera_set_attendance_config() below. Free jsonb, validated there;
-- the phone clamps whatever it reads as a second boundary.
alter table public.camera_devices
  add column if not exists attendance_config jsonb not null default '{}'::jsonb
  check (jsonb_typeof(attendance_config) = 'object');

-- Same body as 20260920010000_camera_devices.sql section 8, plus the two roles and
-- one fix: the on_auth_user_created trigger makes every new auth user a 'pending'
-- HUMAN profile, and nothing ever changed that for org cameras -- so a camera
-- created here signed in to the "waiting for approval" screen and could never
-- reach a capture view. pair-claim already flips its devices to kind='device';
-- this does the same, in the one place the row is written.
create or replace function public.org_camera_create_device(
  p_account_id uuid,
  p_node_id uuid,
  p_name text,
  p_role text,
  p_created_by_account_id uuid,
  p_station_id uuid default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_role not in ('provisioning', 'counting', 'compliance', 'overview', 'check_in', 'check_out') then
    raise exception 'invalid device role: %', p_role using errcode = '22023';
  end if;
  if not exists (select 1 from public.org_nodes where id = p_node_id) then
    raise exception 'no such node' using errcode = '22023';
  end if;
  if p_station_id is not null
     and not exists (select 1 from public.camera_stations where id = p_station_id) then
    raise exception 'no such station' using errcode = '22023';
  end if;

  insert into public.camera_devices (id, org_node_id, station_id, name, role, created_by)
    values (p_account_id, p_node_id, p_station_id, btrim(p_name), p_role, p_created_by_account_id);

  update public.profiles set kind = 'device', role = 'viewer' where id = p_account_id;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action, after_json)
    values (p_created_by_account_id, 'camera_device', p_account_id::text, p_node_id, 'device_created',
      jsonb_build_object('name', btrim(p_name), 'role', p_role, 'station_id', p_station_id));
end $$;

-- =====================================================================================
-- 2. The capability that gates the hours report
-- =====================================================================================

insert into public.capability_types (key, sort_order, note)
select 'view_attendance_below', 150,
       'See check-in / check-out records and on-site hours of people at or below this node'
 where not exists (select 1 from public.capability_types x where x.key = 'view_attendance_below');

commit;

begin;

-- =====================================================================================
-- 3. Enrolled faces -- append-only, the newest row per person is the reference
-- =====================================================================================
--
-- No grant to any client role at all: an embedding is biometric data and nothing
-- in a browser needs the numbers, only the yes/no the matching RPC gives back.
-- The org hub learns "is this person enrolled, since when, by whom, which photo"
-- through org_face_enrollment() below.

create table if not exists public.person_face_embeddings (
  id            bigserial primary key,
  person_id     uuid not null references public.persons(id) on delete restrict,
  embedding     real[] not null check (array_length(embedding, 1) = 128),
  model_version text not null check (length(btrim(model_version)) > 0),
  photo_path    text not null check (length(btrim(photo_path)) > 0),
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null
);
create index if not exists person_face_embeddings_person_idx
  on public.person_face_embeddings(person_id, created_at desc);
alter table public.person_face_embeddings enable row level security;
revoke all on public.person_face_embeddings from public, anon, authenticated;

create or replace function public.org_guard_face_embeddings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'person_face_embeddings is append-only; enrol again to replace a face'
    using errcode = '42501';
end $$;
drop trigger if exists org_guard_face_embeddings on public.person_face_embeddings;
create trigger org_guard_face_embeddings
  before update or delete on public.person_face_embeddings
  for each row execute function public.org_guard_face_embeddings();

-- =====================================================================================
-- 4. Captures -- one row per recognised person per door per minute
-- =====================================================================================

create table if not exists public.camera_attendance_events (
  id            uuid primary key,
  org_node_id   uuid not null references public.org_nodes(id) on delete restrict,
  device_id     uuid not null references public.camera_devices(id) on delete restrict,
  person_id     uuid not null references public.persons(id) on delete restrict,
  kind          text not null check (kind in ('check_in', 'check_out')),
  captured_at   timestamptz not null,
  distance      real not null,
  model_version text not null,
  created_at    timestamptz not null default now()
);
create index if not exists camera_attendance_events_person_idx
  on public.camera_attendance_events(person_id, captured_at);
create index if not exists camera_attendance_events_node_idx
  on public.camera_attendance_events(org_node_id, captured_at);
alter table public.camera_attendance_events enable row level security;

-- Faces the door did not recognise: no person, no numbers, no picture -- just
-- enough to see how often recognition fails at a given door and tune it.
create table if not exists public.camera_attendance_misses (
  id            bigserial primary key,
  org_node_id   uuid not null references public.org_nodes(id) on delete restrict,
  device_id     uuid not null references public.camera_devices(id) on delete restrict,
  captured_at   timestamptz not null,
  best_distance real,
  model_version text not null
);
create index if not exists camera_attendance_misses_device_idx
  on public.camera_attendance_misses(device_id, captured_at desc);
alter table public.camera_attendance_misses enable row level security;

-- Readable by whoever holds view_attendance_below over the PERSON's unit (the
-- report is about people, not about which door they used), or org_admin().
-- There is no INSERT policy: the only writer is the capture RPC below. A camera
-- device gets no SELECT here at all (rule 1).
drop policy if exists camera_attendance_events_read on public.camera_attendance_events;
create policy camera_attendance_events_read on public.camera_attendance_events for select
  using ((select public.org_admin())
      or person_id = any (coalesce((select public.org_persons_seated_in(
           public.org_nodes_reached_with('view_attendance_below'))), '{}'::uuid[])));

drop policy if exists camera_attendance_misses_read on public.camera_attendance_misses;
create policy camera_attendance_misses_read on public.camera_attendance_misses for select
  using ((select public.org_admin())
      or (select public.org_capability_reaches('view_attendance_below', org_node_id))
      or (select public.org_capability_reaches('manage_camera_devices', org_node_id)));

revoke all on public.camera_attendance_events from public, anon, authenticated;
grant select on public.camera_attendance_events to authenticated;
revoke all on public.camera_attendance_misses from public, anon, authenticated;
grant select on public.camera_attendance_misses to authenticated;

commit;

begin;

-- =====================================================================================
-- 5. The capture door -- what a check-in / check-out phone calls
-- =====================================================================================
--
-- Identity is auth.uid(): the caller must be an un-revoked camera_devices row
-- whose role is one of the two door roles. Which door is not an argument.

create or replace function public.camera_attendance_capture(
  p_embedding real[],
  p_captured_at timestamptz default now(),
  p_model_version text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_device    public.camera_devices%rowtype;
  v_at        timestamptz;
  v_threshold real;
  v_cooldown  int;
  v_person    uuid;
  v_distance  real;
  v_name      text;
  v_last_at   timestamptz;
  v_id        uuid;
begin
  select * into v_device from public.camera_devices where id = auth.uid();
  if v_device.id is null then
    raise exception 'not a camera device' using errcode = '42501';
  end if;
  if v_device.revoked_at is not null then
    raise exception 'this device has been revoked' using errcode = '42501';
  end if;
  if v_device.role not in ('check_in', 'check_out') then
    raise exception 'this camera is not a check-in or check-out door' using errcode = '42501';
  end if;
  if p_embedding is null or array_length(p_embedding, 1) <> 128 then
    raise exception 'an embedding is 128 numbers' using errcode = '22023';
  end if;
  if p_model_version is null or length(btrim(p_model_version)) = 0 then
    raise exception 'model_version is required' using errcode = '22023';
  end if;

  -- A phone's clock is a suggestion: never in the future, never more than a
  -- day behind (an outbox replay older than that is history, not attendance).
  v_at := least(coalesce(p_captured_at, now()), now());
  if v_at < now() - interval '1 day' then
    raise exception 'capture too old to record' using errcode = '22023';
  end if;

  v_threshold := coalesce((v_device.attendance_config ->> 'match_threshold')::real, 0.6);
  v_cooldown  := coalesce((v_device.attendance_config ->> 'cooldown_seconds')::int, 120);

  update public.camera_devices
     set last_seen_at = greatest(coalesce(last_seen_at, v_at), v_at)
   where id = v_device.id;

  -- Nearest enrolled face, among active people, made by the same model.
  select l.person_id, l.dist into v_person, v_distance
    from (
      select e.person_id,
             sqrt(sum((z.a - z.b)::double precision ^ 2))::real as dist
        from (
          select distinct on (f.person_id) f.person_id, f.embedding
            from public.person_face_embeddings f
            join public.persons pe on pe.id = f.person_id and pe.status = 'active'
           where f.model_version = p_model_version
           order by f.person_id, f.created_at desc
        ) e
        cross join lateral unnest(e.embedding, p_embedding) as z(a, b)
       group by e.person_id
    ) l
   order by l.dist
   limit 1;

  if v_person is null or v_distance > v_threshold then
    insert into public.camera_attendance_misses (org_node_id, device_id, captured_at, best_distance, model_version)
      values (v_device.org_node_id, v_device.id, v_at, v_distance, p_model_version);
    return jsonb_build_object('status', 'no_match', 'distance', v_distance, 'kind', v_device.role);
  end if;

  select coalesce(nullif(pe.display_name, ''), pe.full_name) into v_name
    from public.persons pe where pe.id = v_person;

  -- Symmetric window: an outbox replay can deliver captures out of order, and a
  -- later one already on file suppresses an earlier one just the same. With a
  -- cooldown of 0 the window is empty and only the deterministic id dedupes.
  select max(ev.captured_at) into v_last_at
    from public.camera_attendance_events ev
   where ev.device_id = v_device.id and ev.person_id = v_person
     and ev.captured_at > v_at - make_interval(secs => v_cooldown)
     and ev.captured_at < v_at + make_interval(secs => v_cooldown);
  if v_last_at is not null then
    return jsonb_build_object('status', 'cooldown', 'kind', v_device.role,
      'person_name', v_name, 'distance', v_distance, 'last_at', v_last_at);
  end if;

  -- Deterministic id: this device, this person, this minute (rule 4).
  v_id := md5(v_device.id::text || '|' || v_person::text || '|'
              || to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'))::uuid;
  begin
    insert into public.camera_attendance_events
      (id, org_node_id, device_id, person_id, kind, captured_at, distance, model_version)
    values
      (v_id, v_device.org_node_id, v_device.id, v_person, v_device.role, v_at, v_distance, p_model_version);
  exception when unique_violation then
    null; -- a retry of a capture already recorded
  end;

  return jsonb_build_object('status', 'matched', 'kind', v_device.role,
    'person_name', v_name, 'distance', v_distance, 'captured_at', v_at);
end $$;

-- =====================================================================================
-- 6. Enrolment -- a manager of the person, or the person themselves
-- =====================================================================================

create or replace function public.org_enroll_face(
  p_person_id uuid,
  p_embedding real[],
  p_model_version text,
  p_photo_path text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from public.persons where id = p_person_id) then
    raise exception 'unknown person' using errcode = '22023';
  end if;
  if not (public.org_admin() or p_person_id = any (public.org_maintainable_person_ids())) then
    raise exception 'you cannot enrol a face for that person' using errcode = '42501';
  end if;
  if p_embedding is null or array_length(p_embedding, 1) <> 128 then
    raise exception 'an embedding is 128 numbers' using errcode = '22023';
  end if;
  if p_model_version is null or length(btrim(p_model_version)) = 0 then
    raise exception 'model_version is required' using errcode = '22023';
  end if;
  -- The photo must sit in this person's own folder of the bucket -- the same
  -- rule the storage policy enforces on the upload itself.
  if p_photo_path is null or position(p_person_id::text || '/' in p_photo_path) <> 1 then
    raise exception 'photo_path must be inside the person''s own folder' using errcode = '22023';
  end if;

  insert into public.person_face_embeddings (person_id, embedding, model_version, photo_path, created_by)
    values (p_person_id, p_embedding, p_model_version, p_photo_path, auth.uid())
    returning id into v_id;

  insert into public.org_audit (actor_account_id, subject_person_id, entity_type, entity_id, action, after_json)
    values (auth.uid(), p_person_id, 'person_face', p_person_id::text, 'face_enrolled',
      jsonb_build_object('model_version', p_model_version, 'photo_path', p_photo_path));

  return v_id;
end $$;

-- What the org hub shows next to a person: enrolled or not, and the photo to
-- mint a signed URL for. Numbers never leave the database.
create or replace function public.org_face_enrollment(p_person_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then null
    when not (public.org_admin()
              or p_person_id = public.org_current_person_id()
              or p_person_id = any (public.org_visible_person_ids())) then null
    else (
      select jsonb_build_object(
        'enrolled_at', f.created_at,
        'model_version', f.model_version,
        'photo_path', f.photo_path)
      from public.person_face_embeddings f
      where f.person_id = p_person_id
      order by f.created_at desc
      limit 1)
  end;
$$;

-- =====================================================================================
-- 7. Per-device attendance settings -- manage_camera_devices over the device's unit
-- =====================================================================================

create or replace function public.org_camera_set_attendance_config(
  p_device_id uuid,
  p_config jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_node   uuid;
  v_zone   jsonb;
  v_clean  jsonb := '{}'::jsonb;
  v_num    numeric;
begin
  select org_node_id into v_node from public.camera_devices
   where id = p_device_id and revoked_at is null;
  if v_node is null then
    raise exception 'no such active device' using errcode = '22023';
  end if;
  if not public.org_camera_can_manage(v_node) then
    raise exception 'you cannot manage cameras at this node' using errcode = '42501';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'config must be an object' using errcode = '22023';
  end if;

  -- Only known keys survive, each within its range. Anything else is dropped.
  v_zone := p_config -> 'zone';
  if v_zone is not null then
    if jsonb_typeof(v_zone) <> 'object'
       or not ((v_zone->>'x')::numeric between 0 and 1 and (v_zone->>'y')::numeric between 0 and 1
           and (v_zone->>'w')::numeric between 0.05 and 1 and (v_zone->>'h')::numeric between 0.05 and 1
           and (v_zone->>'x')::numeric + (v_zone->>'w')::numeric <= 1
           and (v_zone->>'y')::numeric + (v_zone->>'h')::numeric <= 1) then
      raise exception 'zone must be fractions inside the frame' using errcode = '22023';
    end if;
    v_clean := v_clean || jsonb_build_object('zone', jsonb_build_object(
      'x', (v_zone->>'x')::numeric, 'y', (v_zone->>'y')::numeric,
      'w', (v_zone->>'w')::numeric, 'h', (v_zone->>'h')::numeric));
  end if;

  v_num := (p_config->>'min_face_ratio')::numeric;
  if v_num is not null then
    if v_num < 0.05 or v_num > 1 then raise exception 'min_face_ratio must be within 0.05..1' using errcode = '22023'; end if;
    v_clean := v_clean || jsonb_build_object('min_face_ratio', v_num);
  end if;
  v_num := (p_config->>'stable_frames')::numeric;
  if v_num is not null then
    if v_num < 1 or v_num > 30 then raise exception 'stable_frames must be within 1..30' using errcode = '22023'; end if;
    v_clean := v_clean || jsonb_build_object('stable_frames', round(v_num));
  end if;
  v_num := (p_config->>'match_threshold')::numeric;
  if v_num is not null then
    if v_num < 0.1 or v_num > 1.5 then raise exception 'match_threshold must be within 0.1..1.5' using errcode = '22023'; end if;
    v_clean := v_clean || jsonb_build_object('match_threshold', v_num);
  end if;
  v_num := (p_config->>'cooldown_seconds')::numeric;
  if v_num is not null then
    if v_num < 0 or v_num > 86400 then raise exception 'cooldown_seconds must be within 0..86400' using errcode = '22023'; end if;
    v_clean := v_clean || jsonb_build_object('cooldown_seconds', round(v_num));
  end if;
  v_num := (p_config->>'flash_ms')::numeric;
  if v_num is not null then
    if v_num < 0 or v_num > 3000 then raise exception 'flash_ms must be within 0..3000' using errcode = '22023'; end if;
    v_clean := v_clean || jsonb_build_object('flash_ms', round(v_num));
  end if;
  if p_config ? 'facing' then
    if p_config->>'facing' not in ('user', 'environment') then
      raise exception 'facing must be user or environment' using errcode = '22023';
    end if;
    v_clean := v_clean || jsonb_build_object('facing', p_config->>'facing');
  end if;

  update public.camera_devices set attendance_config = v_clean where id = p_device_id;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action, after_json)
    values (auth.uid(), 'camera_device', p_device_id::text, v_node, 'attendance_config_set', v_clean);
end $$;

-- =====================================================================================
-- 8. The hours report -- people at or below a unit, per day, Vietnam time
-- =====================================================================================
--
-- A check-in pairs with the next event for the same person if that event is a
-- check-out no more than 16 hours later; the seconds between them count as on
-- site. An in followed by another in, or by an out a day later, leaves the
-- first unpaired (missed the out door); an out with no in before it is unpaired
-- the other way. Both are counted and shown, never silently dropped -- a day
-- with a missing punch says so instead of reporting a 22-hour shift.
--
-- Days are Vietnam days: one explicit zone here, so the same row means the same
-- thing whichever browser opens the report. A pair is booked on the day of its
-- check-in, so a night shift stays whole.

create or replace function public.org_attendance_rows(
  p_node uuid,
  p_since timestamptz,
  p_until timestamptz)
returns table (
  person_id uuid,
  full_name text,
  employee_code text,
  day date,
  first_in timestamptz,
  last_out timestamptz,
  seconds_on_site bigint,
  check_ins int,
  check_outs int,
  unpaired_ins int,
  unpaired_outs int)
language sql stable security definer set search_path = public as $$
  with ordered as (
    select ev.person_id, ev.kind, ev.captured_at,
           (ev.captured_at at time zone 'Asia/Ho_Chi_Minh')::date as day,
           lead(ev.kind) over w as next_kind,
           lead(ev.captured_at) over w as next_at,
           lag(ev.kind) over w as prev_kind,
           lag(ev.captured_at) over w as prev_at
      from public.camera_attendance_events ev
     where ev.captured_at >= p_since and ev.captured_at < p_until
       and ev.person_id = any (public.org_persons_seated_in(public.org_subtree_ids(array[p_node])))
    window w as (partition by ev.person_id order by ev.captured_at, ev.id)
  ), scoped as (
    select o.*,
           o.kind = 'check_in' and o.next_kind = 'check_out'
             and o.next_at - o.captured_at <= interval '16 hours' as is_paired_in,
           o.kind = 'check_out' and o.prev_kind = 'check_in'
             and o.captured_at - o.prev_at <= interval '16 hours' as is_paired_out
      from ordered o
  )
  select s.person_id,
         pe.full_name,
         pe.employee_code,
         s.day,
         min(s.captured_at) filter (where s.kind = 'check_in')  as first_in,
         max(s.captured_at) filter (where s.kind = 'check_out') as last_out,
         coalesce(sum(extract(epoch from (s.next_at - s.captured_at))) filter (where s.is_paired_in), 0)::bigint as seconds_on_site,
         count(*) filter (where s.kind = 'check_in')::int  as check_ins,
         count(*) filter (where s.kind = 'check_out')::int as check_outs,
         count(*) filter (where s.kind = 'check_in' and not s.is_paired_in)::int as unpaired_ins,
         count(*) filter (where s.kind = 'check_out' and not s.is_paired_out)::int as unpaired_outs
    from scoped s
    join public.persons pe on pe.id = s.person_id
   group by s.person_id, pe.full_name, pe.employee_code, s.day
   order by s.day desc, pe.full_name;
$$;

create or replace function public.org_attendance_report(
  p_node uuid,
  p_since timestamptz,
  p_until timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.org_admin() or public.org_capability_reaches('view_attendance_below', p_node)) then
    raise exception 'you cannot view attendance at this node' using errcode = '42501';
  end if;
  if p_until < p_since then
    raise exception 'p_until must not be before p_since' using errcode = '22023';
  end if;
  if p_until - p_since > interval '62 days' then
    raise exception 'a report covers at most 62 days at a time' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(r)) from public.org_attendance_rows(p_node, p_since, p_until) r),
                  '[]'::jsonb);
end $$;

-- Same rows, and the export is written to the audit trail -- the shape
-- org_camera_export_counts already uses.
create or replace function public.org_attendance_export(
  p_node uuid,
  p_since timestamptz,
  p_until timestamptz)
returns table (
  person_id uuid,
  full_name text,
  employee_code text,
  day date,
  first_in timestamptz,
  last_out timestamptz,
  seconds_on_site bigint,
  check_ins int,
  check_outs int,
  unpaired_ins int,
  unpaired_outs int)
language plpgsql security definer set search_path = public as $$
begin
  if not (public.org_admin() or public.org_capability_reaches('view_attendance_below', p_node)) then
    raise exception 'you cannot view attendance at this node' using errcode = '42501';
  end if;
  if p_until < p_since then
    raise exception 'p_until must not be before p_since' using errcode = '22023';
  end if;
  if p_until - p_since > interval '62 days' then
    raise exception 'an export covers at most 62 days at a time' using errcode = '22023';
  end if;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, node_id, action, after_json)
    values (auth.uid(), 'attendance_export', p_node::text, p_node, 'data_exported',
      jsonb_build_object('since', p_since, 'until', p_until));

  return query select * from public.org_attendance_rows(p_node, p_since, p_until);
end $$;

commit;

begin;

-- =====================================================================================
-- 9. Storage: the person-photos bucket, same shape as cv-uploads
-- =====================================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('person-photos', 'person-photos', false, 5242880, array['image/jpeg', 'image/png'])
  on conflict (id) do update set
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The path's first folder is the person id. Upload: whoever may maintain that
-- person (or the person themselves). Read: whoever may see that person.
create or replace function public.org_person_photo_upload_is_open(p_path text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_person uuid;
begin
  begin
    v_person := (storage.foldername(p_path))[1]::uuid;
  exception when others then
    return false;
  end;
  return auth.uid() is not null
     and (public.org_admin() or v_person = any (public.org_maintainable_person_ids()));
end $$;

create or replace function public.org_person_photo_read_is_open(p_path text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_person uuid;
begin
  begin
    v_person := (storage.foldername(p_path))[1]::uuid;
  exception when others then
    return false;
  end;
  return auth.uid() is not null
     and (public.org_admin()
          or v_person = public.org_current_person_id()
          or v_person = any (public.org_visible_person_ids()));
end $$;

grant select on storage.buckets to authenticated;
grant insert on storage.objects to authenticated;
grant select on storage.objects to authenticated;

drop policy if exists "person_photos_insert" on storage.objects;
create policy "person_photos_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'person-photos' and public.org_person_photo_upload_is_open(name));

drop policy if exists "person_photos_select" on storage.objects;
create policy "person_photos_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'person-photos' and public.org_person_photo_read_is_open(name));

commit;

begin;

-- =====================================================================================
-- 10. Grants
-- =====================================================================================

revoke all on function public.org_guard_face_embeddings() from public, anon, authenticated;

revoke all on function public.camera_attendance_capture(real[], timestamptz, text) from public, anon;
grant execute on function public.camera_attendance_capture(real[], timestamptz, text) to authenticated;

revoke all on function public.org_enroll_face(uuid, real[], text, text) from public, anon;
grant execute on function public.org_enroll_face(uuid, real[], text, text) to authenticated;

revoke all on function public.org_face_enrollment(uuid) from public, anon;
grant execute on function public.org_face_enrollment(uuid) to authenticated;

revoke all on function public.org_camera_set_attendance_config(uuid, jsonb) from public, anon;
grant execute on function public.org_camera_set_attendance_config(uuid, jsonb) to authenticated;

revoke all on function public.org_attendance_rows(uuid, timestamptz, timestamptz) from public, anon, authenticated;

revoke all on function public.org_attendance_report(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.org_attendance_report(uuid, timestamptz, timestamptz) to authenticated;

revoke all on function public.org_attendance_export(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.org_attendance_export(uuid, timestamptz, timestamptz) to authenticated;

revoke all on function public.org_person_photo_upload_is_open(text) from public, anon;
grant execute on function public.org_person_photo_upload_is_open(text) to authenticated;
revoke all on function public.org_person_photo_read_is_open(text) from public, anon;
grant execute on function public.org_person_photo_read_is_open(text) to authenticated;

commit;
