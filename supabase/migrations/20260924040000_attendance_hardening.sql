-- 8.12 Attendance hardening -- what the first review of 20260924030000 found.
--
-- Fix-forward: 20260924030000 is already applied on the preview branch, so
-- every change here is a new statement, never an edit of the old file.
--
--   1. Self-enrolment is a privilege (enroll_own_face), not a default: with it
--      open to everyone, any worker could enrol a colleague's face as their own
--      and be checked in from home.
--   2. Three-valued logic: a caller with no persons row (a door, a fresh signup)
--      made `not (false or null or false)` skip a gate. Every gate is now
--      coalesced to false.
--   3. A door may not backdate: the phone's clock is trusted to two minutes.
--   4. The capture RPC no longer echoes the nearest-neighbour distance (an
--      oracle for reconstructing a template) and refuses more than 20 captures
--      a minute from one door.
--   5. A door matches only people seated at or below its own unit.
--   6. Cooldown is per person and door kind, so two doors of the same kind do
--      not double-log.
--   7. The report covers everyone who held a seat under the unit at any point
--      in the range (departed and transferred people keep their hours), pairs
--      across the range edges, and tells an open shift apart from a missing
--      punch.
--   8. match_threshold is capped at 0.8; the enrolment photo must exist.

begin;

-- =====================================================================================
-- 1. Self-enrolment as a capability; one gate shared by the RPC and the storage policy
-- =====================================================================================

insert into public.capability_types (key, sort_order, note)
select 'enroll_own_face', 160,
       'Enrol one''s own face for the check-in / check-out doors; a manager holding maintain_person_profile can always enrol people below'
 where not exists (select 1 from public.capability_types x where x.key = 'enroll_own_face');

create or replace function public.org_face_enrollment_is_open(p_person_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    public.org_admin()
    or (p_person_id <> public.org_current_person_id()
        and p_person_id = any (public.org_persons_seated_in(
              public.org_nodes_reached_with('maintain_person_profile'))))
    or (p_person_id = public.org_current_person_id()
        and public.org_i_hold('enroll_own_face')),
    false);
$$;

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
  if not public.org_face_enrollment_is_open(p_person_id) then
    raise exception 'you cannot enrol a face for that person' using errcode = '42501';
  end if;
  if p_embedding is null or array_length(p_embedding, 1) <> 128 then
    raise exception 'an embedding is 128 numbers' using errcode = '22023';
  end if;
  if p_model_version is null or length(btrim(p_model_version)) = 0 then
    raise exception 'model_version is required' using errcode = '22023';
  end if;
  if p_photo_path is null or position(p_person_id::text || '/' in p_photo_path) <> 1 then
    raise exception 'photo_path must be inside the person''s own folder' using errcode = '22023';
  end if;
  -- The audit trail's one reviewable piece of evidence must exist.
  if not exists (select 1 from storage.objects o
                  where o.bucket_id = 'person-photos' and o.name = p_photo_path) then
    raise exception 'photo not found' using errcode = '22023';
  end if;

  insert into public.person_face_embeddings (person_id, embedding, model_version, photo_path, created_by)
    values (p_person_id, p_embedding, p_model_version, p_photo_path, auth.uid())
    returning id into v_id;

  insert into public.org_audit (actor_account_id, subject_person_id, entity_type, entity_id, action, after_json)
    values (auth.uid(), p_person_id, 'person_face', p_person_id::text, 'face_enrolled',
      jsonb_build_object('model_version', p_model_version, 'photo_path', p_photo_path,
                         'self', p_person_id = public.org_current_person_id()));

  return v_id;
end $$;

create or replace function public.org_person_photo_upload_is_open(p_path text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_person uuid;
begin
  begin
    v_person := (storage.foldername(p_path))[1]::uuid;
  exception when others then
    return false;
  end;
  return auth.uid() is not null and public.org_face_enrollment_is_open(v_person);
end $$;

-- =====================================================================================
-- 2. Reads coalesce to deny
-- =====================================================================================

create or replace function public.org_face_enrollment(p_person_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when not coalesce(public.org_admin()
                      or p_person_id = any (public.org_visible_person_ids()), false) then null
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
     and coalesce(public.org_admin() or v_person = any (public.org_visible_person_ids()), false);
end $$;

commit;

begin;

-- =====================================================================================
-- 3-6. The capture door
-- =====================================================================================

create index if not exists camera_attendance_events_device_idx
  on public.camera_attendance_events(device_id, captured_at desc);

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
  v_recent    int;
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

  -- The phone's clock is trusted to two minutes either way; anything else is
  -- a phone lying, not a phone drifting.
  v_at := greatest(least(coalesce(p_captured_at, now()), now()), now() - interval '2 minutes');

  -- A door sees a face every few seconds at most; anything faster is a
  -- credential being used as a probe.
  select count(*) into v_recent
    from (select 1 from public.camera_attendance_events e
           where e.device_id = v_device.id and e.captured_at > now() - interval '1 minute'
          union all
          select 1 from public.camera_attendance_misses m
           where m.device_id = v_device.id and m.captured_at > now() - interval '1 minute') r;
  if v_recent >= 20 then
    raise exception 'too many captures from this door' using errcode = '54000';
  end if;

  v_threshold := least(coalesce((v_device.attendance_config ->> 'match_threshold')::real, 0.6), 0.8);
  v_cooldown  := coalesce((v_device.attendance_config ->> 'cooldown_seconds')::int, 120);

  update public.camera_devices
     set last_seen_at = greatest(coalesce(last_seen_at, v_at), v_at)
   where id = v_device.id;

  -- Nearest enrolled face among active people seated at or below this door's
  -- unit, made by the same model. A site door lives on the site node.
  select l.person_id, l.dist into v_person, v_distance
    from (
      select e.person_id,
             sqrt(sum((z.a - z.b)::double precision ^ 2))::real as dist
        from (
          select distinct on (f.person_id) f.person_id, f.embedding
            from public.person_face_embeddings f
            join public.persons pe on pe.id = f.person_id and pe.status = 'active'
           where f.model_version = p_model_version
             and f.person_id = any (public.org_persons_seated_in(
                   public.org_subtree_ids(array[v_device.org_node_id])))
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
    return jsonb_build_object('status', 'no_match', 'kind', v_device.role);
  end if;

  select coalesce(nullif(pe.display_name, ''), pe.full_name) into v_name
    from public.persons pe where pe.id = v_person;

  -- One punch of this kind per person per cooldown, whichever door saw them;
  -- symmetric because replays arrive out of order.
  select max(ev.captured_at) into v_last_at
    from public.camera_attendance_events ev
   where ev.person_id = v_person and ev.kind = v_device.role
     and ev.captured_at > v_at - make_interval(secs => v_cooldown)
     and ev.captured_at < v_at + make_interval(secs => v_cooldown);
  if v_last_at is not null then
    return jsonb_build_object('status', 'cooldown', 'kind', v_device.role,
      'person_name', v_name, 'last_at', v_last_at);
  end if;

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
    'person_name', v_name, 'captured_at', v_at);
end $$;

-- =====================================================================================
-- 7. The hours report: as-of scoping, edge pairing, open shifts
-- =====================================================================================

-- Everyone who held a seat under these nodes at any moment of [p_since, p_until):
-- the holder row started before the range ended and its successor (the next
-- holder or vacancy on that seat) started after the range began.
create or replace function public.org_persons_seated_in_during(
  p_nodes uuid[],
  p_since timestamptz,
  p_until timestamptz)
returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce((
    select array_agg(distinct h.person_id)
      from public.positions po
      join public.position_holders h on h.position_id = po.id
      left join lateral (
        select min(n.effective_from) as ended_at
          from public.position_holders n
         where n.position_id = h.position_id
           and (n.effective_from, n.id) > (h.effective_from, h.id)) e on true
     where po.node_id = any (p_nodes)
       and h.person_id is not null
       and h.effective_from < p_until
       and coalesce(e.ended_at, 'infinity'::timestamptz) > p_since), '{}'::uuid[]);
$$;

drop function if exists public.org_attendance_export(uuid, timestamptz, timestamptz);
drop function if exists public.org_attendance_rows(uuid, timestamptz, timestamptz);

create function public.org_attendance_rows(
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
  unpaired_outs int,
  on_site boolean)
language sql stable security definer set search_path = public as $$
  -- Events 16 h either side of the range take part in pairing, so a night
  -- shift straddling the edge is not two missing punches; only events inside
  -- the range are reported. An open check-in younger than 16 h is someone on
  -- site right now, not a missing punch.
  with ordered as (
    select ev.person_id, ev.kind, ev.captured_at,
           ev.captured_at >= p_since and ev.captured_at < p_until as in_range,
           (ev.captured_at at time zone 'Asia/Ho_Chi_Minh')::date as day,
           lead(ev.kind) over w as next_kind,
           lead(ev.captured_at) over w as next_at,
           lag(ev.kind) over w as prev_kind,
           lag(ev.captured_at) over w as prev_at
      from public.camera_attendance_events ev
     where ev.captured_at >= p_since - interval '16 hours'
       and ev.captured_at < p_until + interval '16 hours'
       and ev.person_id = any (public.org_persons_seated_in_during(
             public.org_subtree_ids(array[p_node]), p_since, p_until))
    window w as (partition by ev.person_id order by ev.captured_at, ev.id)
  ), scoped as (
    select o.*,
           o.kind = 'check_in' and o.next_kind = 'check_out'
             and o.next_at - o.captured_at <= interval '16 hours' as is_paired_in,
           o.kind = 'check_out' and o.prev_kind = 'check_in'
             and o.captured_at - o.prev_at <= interval '16 hours' as is_paired_out,
           o.kind = 'check_in' and o.next_kind is null
             and now() - o.captured_at < interval '16 hours' as is_open_in
      from ordered o
     where o.in_range
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
         count(*) filter (where s.kind = 'check_in' and not s.is_paired_in and not s.is_open_in)::int as unpaired_ins,
         count(*) filter (where s.kind = 'check_out' and not s.is_paired_out)::int as unpaired_outs,
         bool_or(s.is_open_in) as on_site
    from scoped s
    join public.persons pe on pe.id = s.person_id
   group by s.person_id, pe.full_name, pe.employee_code, s.day
   order by s.day desc, pe.full_name;
$$;

create function public.org_attendance_export(
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
  unpaired_outs int,
  on_site boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(public.org_admin() or public.org_capability_reaches('view_attendance_below', p_node), false) then
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

create or replace function public.org_attendance_report(
  p_node uuid,
  p_since timestamptz,
  p_until timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.org_admin() or public.org_capability_reaches('view_attendance_below', p_node), false) then
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

-- =====================================================================================
-- 8. match_threshold cap
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
  if not coalesce(public.org_camera_can_manage(v_node), false) then
    raise exception 'you cannot manage cameras at this node' using errcode = '42501';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'config must be an object' using errcode = '22023';
  end if;

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
  -- face-api distances between two different people sit around 0.6-0.9; a
  -- threshold above 0.8 would make every visitor "match" whoever is closest.
  v_num := (p_config->>'match_threshold')::numeric;
  if v_num is not null then
    if v_num < 0.1 or v_num > 0.8 then raise exception 'match_threshold must be within 0.1..0.8' using errcode = '22023'; end if;
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
-- 9. Grants (create or replace keeps ACLs; the dropped-and-recreated ones need theirs)
-- =====================================================================================

revoke all on function public.org_face_enrollment_is_open(uuid) from public, anon, authenticated;
revoke all on function public.org_persons_seated_in_during(uuid[], timestamptz, timestamptz) from public, anon, authenticated;

revoke all on function public.org_attendance_rows(uuid, timestamptz, timestamptz) from public, anon, authenticated;

revoke all on function public.org_attendance_export(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.org_attendance_export(uuid, timestamptz, timestamptz) to authenticated;

commit;
