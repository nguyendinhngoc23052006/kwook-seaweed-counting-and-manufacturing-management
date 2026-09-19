begin;

-- A face could be enrolled and replaced, never removed.
--
-- org_guard_face_embeddings refuses every update and delete outright --
-- "append-only; enrol again to replace a face" -- and that is right for a
-- correction: the newest row wins and the history of what the door compared
-- against is kept. But it left no way to WITHDRAW a face at all. Somebody
-- enrolled by mistake, or who has left, kept a live 128-number biometric
-- template in the database forever, and the only offered remedy was to supply
-- another one.
--
-- Biometric data is the one kind this app holds where keeping it is the harm.
-- A departed person is already excluded from matching (the matcher joins
-- persons on status = 'active', 20260924040000:220), so this is not about
-- recognition -- it is about not holding a template nobody has a reason to
-- hold. Data minimisation wants the rows gone, not tombstoned, so this really
-- deletes and records that it did.

create or replace function public.org_withdraw_face(p_person_id uuid, p_reason text)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- The same reach that may enrol a face may withdraw one. Anything narrower
  -- would mean the person who made the mistake cannot undo it.
  if not (public.org_admin() or p_person_id = any (public.org_maintainable_person_ids())) then
    raise exception 'you cannot withdraw a face for that person' using errcode = '42501';
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 3 then
    raise exception 'withdrawing a face needs a reason' using errcode = '22023';
  end if;

  select count(*) into v_count from public.person_face_embeddings where person_id = p_person_id;
  if v_count = 0 then
    raise exception 'that person has no enrolled face' using errcode = '22023';
  end if;

  -- The guard refuses deletes to everyone; this is the one deliberate,
  -- audited exception, opened for one statement the way the task and
  -- application projections do it.
  perform set_config('app.face_withdrawal', '1', true);
  delete from public.person_face_embeddings where person_id = p_person_id;
  perform set_config('app.face_withdrawal', '', true);

  -- The audit keeps that it happened, who did it and why. It deliberately does
  -- NOT keep the template -- writing the numbers into org_audit to record their
  -- deletion would defeat the deletion.
  insert into public.org_audit (actor_account_id, entity_type, entity_id, action, after_json)
    values (auth.uid(), 'person_face', p_person_id::text, 'face_withdrawn',
      jsonb_build_object('rows', v_count, 'reason', btrim(p_reason)));

  return v_count;
end $fn$;
revoke all on function public.org_withdraw_face(uuid, text) from public, anon;
grant execute on function public.org_withdraw_face(uuid, text) to authenticated;

create or replace function public.org_guard_face_embeddings()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  -- coalesce is load-bearing: current_setting(..., true) is NULL when never
  -- set, and NULL <> '1' is NULL rather than true, which would let every
  -- delete through -- the same trap org_guard_tasks documents.
  if tg_op = 'DELETE'
     and coalesce(current_setting('app.face_withdrawal', true), '') = '1' then
    return old;
  end if;
  raise exception 'person_face_embeddings is append-only; enrol again to replace a face, or withdraw it'
    using errcode = '42501';
end $fn$;
revoke all on function public.org_guard_face_embeddings() from public, anon, authenticated;

commit;
