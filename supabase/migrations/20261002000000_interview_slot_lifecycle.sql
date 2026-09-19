begin;

-- Interview slots could be added and booked, and nothing else.
--
-- org_add_interview_slots() creates them, org_book_interview_slot() fills one,
-- and there the lifecycle stopped: a slot typed with the wrong time stayed
-- wrong, a slot that was no longer offered could not be withdrawn, and a
-- candidate booked into the wrong one could never be released -- nobody could
-- set applications.interview_slot_id back to null.
--
-- interview_slots has RLS on with NO policies and NO grant to authenticated,
-- so every read and write already goes through a definer RPC. These are three
-- more in that family, not a new write path.

-- Rescheduling. Capacity may not drop below the number of people already
-- standing in the slot: the booked count is derived live from
-- applications.interview_slot_id and never stored, so letting it go under
-- would silently oversubscribe rather than fail.
create or replace function public.org_update_interview_slot(
  p_slot uuid,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_capacity int default null)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_old    record;
  v_booked int;
  v_starts timestamptz;
  v_ends   timestamptz;
  v_cap    int;
begin
  if not public.org_admin() then
    raise exception 'only org_admin manages interview slots' using errcode = '42501';
  end if;
  select * into v_old from public.interview_slots where id = p_slot;
  if v_old.id is null then
    raise exception 'no such slot' using errcode = '22023';
  end if;

  v_starts := coalesce(p_starts_at, v_old.starts_at);
  v_ends   := coalesce(p_ends_at,   v_old.ends_at);
  v_cap    := coalesce(p_capacity,  v_old.capacity);

  if v_ends <= v_starts then
    raise exception 'a slot must end after it starts' using errcode = '22023';
  end if;
  if v_cap < 1 then
    raise exception 'a slot holds at least one candidate' using errcode = '22023';
  end if;

  select count(*) into v_booked from public.applications where interview_slot_id = p_slot;
  if v_cap < v_booked then
    raise exception 'that slot already holds % candidate(s); release somebody first', v_booked
      using errcode = '22023';
  end if;

  update public.interview_slots
     set starts_at = v_starts, ends_at = v_ends, capacity = v_cap
   where id = p_slot;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, action,
                                before_json, after_json)
    values (auth.uid(), 'interview_slot', p_slot::text, 'slot_updated',
      jsonb_build_object('starts_at', v_old.starts_at, 'ends_at', v_old.ends_at,
                         'capacity', v_old.capacity),
      jsonb_build_object('starts_at', v_starts, 'ends_at', v_ends, 'capacity', v_cap));
end $fn$;
revoke all on function public.org_update_interview_slot(uuid, timestamptz, timestamptz, int)
  from public, anon;
grant execute on function public.org_update_interview_slot(uuid, timestamptz, timestamptz, int)
  to authenticated;

-- Withdrawing a slot. Refused while anyone stands in it rather than quietly
-- unbooking them: the FK is ON DELETE SET NULL, so a delete would strip the
-- booking from a candidate who was told a time and never told otherwise.
create or replace function public.org_remove_interview_slot(p_slot uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_booked int;
  v_row    record;
begin
  if not public.org_admin() then
    raise exception 'only org_admin manages interview slots' using errcode = '42501';
  end if;
  select * into v_row from public.interview_slots where id = p_slot;
  if v_row.id is null then
    raise exception 'no such slot' using errcode = '22023';
  end if;
  select count(*) into v_booked from public.applications where interview_slot_id = p_slot;
  if v_booked > 0 then
    raise exception 'that slot holds % candidate(s); release them first', v_booked
      using errcode = '22023';
  end if;

  delete from public.interview_slots where id = p_slot;

  insert into public.org_audit (actor_account_id, entity_type, entity_id, action, before_json)
    values (auth.uid(), 'interview_slot', p_slot::text, 'slot_removed',
      jsonb_build_object('starts_at', v_row.starts_at, 'ends_at', v_row.ends_at,
                         'capacity', v_row.capacity, 'posting_id', v_row.posting_id));
end $fn$;
revoke all on function public.org_remove_interview_slot(uuid) from public, anon;
grant execute on function public.org_remove_interview_slot(uuid) to authenticated;

-- Releasing a booking. The state stays where it is: a candidate whose slot was
-- cancelled is still interviewing, they just have no time yet, and moving them
-- backwards would lie about where they are in the funnel.
create or replace function public.org_release_interview_booking(p_application uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_slot uuid;
begin
  if not public.org_admin() then
    raise exception 'only org_admin manages interview slots' using errcode = '42501';
  end if;
  select interview_slot_id into v_slot from public.applications where id = p_application;
  if not found then
    raise exception 'no such application' using errcode = '22023';
  end if;
  if v_slot is null then
    raise exception 'that application has no booking' using errcode = '22023';
  end if;

  perform set_config('app.application_write', '1', true);
  update public.applications set interview_slot_id = null where id = p_application;
  perform set_config('app.application_write', '', true);

  insert into public.org_audit (actor_account_id, entity_type, entity_id, action, before_json)
    values (auth.uid(), 'application', p_application::text, 'interview_booking_released',
      jsonb_build_object('interview_slot_id', v_slot));
end $fn$;
revoke all on function public.org_release_interview_booking(uuid) from public, anon;
grant execute on function public.org_release_interview_booking(uuid) to authenticated;

commit;
