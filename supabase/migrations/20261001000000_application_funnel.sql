begin;

-- The hiring funnel had no writer.
--
-- applications.state admits ten values -- submitted, scoring, scored, invited,
-- tested, interviewing, offered, hired, not_selected, withdrawn -- and exactly
-- two of the transitions were ever written: the scoring Edge Function moves
-- submitted -> scoring -> scored, and org_book_interview_slot moves tested ->
-- interviewing. Everything after that stage existed as a string in a CHECK
-- constraint and nothing else. Nobody could invite a candidate, record that
-- they were tested, make an offer, hire them, or turn them down.
--
-- org_guard_applications refuses every direct write unless app.application_write
-- is set, and only a definer function sets it, so this is a definer RPC in the
-- same shape as org_book_interview_slot rather than a new policy.

-- The transitions that are allowed, in one place, so the funnel is a shape
-- rather than ten strings anyone may write in any order. Terminal states are
-- terminal: a hired candidate is not re-opened by editing a dropdown, and the
-- retention job -- not a person -- is what eventually removes the row.
create or replace function public.org_application_next_states(p_state text)
returns text[] language sql immutable set search_path = public as $fn$
  select case p_state
    when 'submitted'    then array['invited','not_selected','withdrawn']
    when 'scoring'      then array['not_selected','withdrawn']
    when 'scored'       then array['invited','not_selected','withdrawn']
    when 'invited'      then array['tested','not_selected','withdrawn']
    when 'tested'       then array['interviewing','offered','not_selected','withdrawn']
    when 'interviewing' then array['offered','not_selected','withdrawn']
    when 'offered'      then array['hired','not_selected','withdrawn']
    else array[]::text[]
  end;
$fn$;
revoke all on function public.org_application_next_states(text) from public, anon;
grant execute on function public.org_application_next_states(text) to authenticated;

create or replace function public.org_advance_application(
  p_application uuid, p_state text, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_state   text;
  v_posting uuid;
begin
  perform public.org_require_job_admin();

  select state, posting_id into v_state, v_posting
    from public.applications where id = p_application;
  if v_state is null then
    raise exception 'no such application' using errcode = '22023';
  end if;
  if v_state = p_state then
    raise exception 'that application is already %', p_state using errcode = '22023';
  end if;
  if not (p_state = any (public.org_application_next_states(v_state))) then
    raise exception 'an application cannot go from % to %', v_state, p_state
      using errcode = '22023';
  end if;
  -- Turning somebody down is a decision a person owns, so it carries a reason.
  -- The other moves do not need one: "invited" explains itself.
  if p_state = 'not_selected' and coalesce(length(btrim(p_note)), 0) < 3 then
    raise exception 'a rejection needs a reason' using errcode = '22023';
  end if;

  perform set_config('app.application_write', '1', true);
  update public.applications set state = p_state where id = p_application;
  perform set_config('app.application_write', '', true);

  insert into public.org_audit (actor_account_id, entity_type, entity_id, action,
                                before_json, after_json)
    values (auth.uid(), 'application', p_application::text, 'application_state_changed',
            jsonb_build_object('state', v_state),
            jsonb_build_object('state', p_state, 'note', nullif(btrim(p_note), ''),
                               'posting_id', v_posting));
end $fn$;
revoke all on function public.org_advance_application(uuid, text, text) from public, anon;
grant execute on function public.org_advance_application(uuid, text, text) to authenticated;

commit;
