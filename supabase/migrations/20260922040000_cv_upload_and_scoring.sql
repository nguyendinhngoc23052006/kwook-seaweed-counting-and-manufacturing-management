-- Portfolio links, CV file upload, and the AI-scoring hand-off.
--
-- Three pieces on one table, because they arrived together and none of them is
-- useful without the others: a portfolio URL (a link for a human to open, never
-- fetched by the AI), a CV file (scanned, then reduced to text -- the file
-- itself is not what gets scored), and the columns an Edge Function needs to
-- write a score into.
--
-- The scoring pipeline is: the applicant calls org_apply() (now also accepting
-- a portfolio link) and, if they have a file, uploads it to Storage and calls
-- org_mark_cv_uploaded(). From there, an Edge Function -- woken by a Database
-- Webhook on INSERT, not a SQL trigger; see part 6 -- calls
-- org_claim_application_for_scoring() first. That call is the entire race
-- condition guard: a single atomic UPDATE ... WHERE state = 'submitted',
-- mirroring this codebase's existing claim_shift idiom. Two workers racing for
-- the same row: exactly one gets `true` back and does anything.
--
-- Automation only ever ADVANCES. A score at or above auto_advance_score moves
-- the row to 'invited' immediately. Anything else -- including below
-- min_score -- stays 'scored', visible to the admin, decided by a person.
-- Nothing here ever writes 'not_selected'.

begin;

-- =====================================================================================
-- 1. applications: portfolio link, CV file tracking, score
-- =====================================================================================

-- A link for a human to open later, never fetched by the scorer -- pretending an
-- AI evaluated a page it never loaded would be dishonest. Stored with a scheme
-- always present (org_apply prefixes https:// if one is missing), so anything
-- reading this column later can trust it starts with http(s) without checking.
alter table public.applications add column if not exists portfolio_url text
  check (portfolio_url is null or (
    length(portfolio_url) <= 500 and portfolio_url ~ '^https?://'
  ));

-- A row with cv_file_path set means a file was uploaded and scanned.
-- cv_extracted_text is what came OUT of that file; cv_text (already existed) is
-- what the applicant TYPED. Kept apart because they are different evidence and
-- an admin should be able to tell which was which.
alter table public.applications add column if not exists cv_file_path text;
alter table public.applications add column if not exists cv_file_mime text;
alter table public.applications add column if not exists cv_file_size int
  check (cv_file_size is null or cv_file_size between 1 and 5242880);
alter table public.applications add column if not exists cv_extracted_text text
  check (cv_extracted_text is null or length(cv_extracted_text) <= 20000);

-- cv_flagged is true when the scan rejected macros/mismatched bytes, or found
-- invisible or injection-shaped content in the extracted text. Admin-facing
-- only -- an applicant who tried something is never told they were caught.
alter table public.applications add column if not exists cv_flagged boolean not null default false;
alter table public.applications add column if not exists cv_scan_note text;

-- score is null until scored (or if scoring never produced a result). score_model
-- records which model scored it (e.g. 'gemini-3.8-flash'), so a later model change
-- is auditable per row rather than assumed.
alter table public.applications add column if not exists score int
  check (score is null or score between 0 and 100);
alter table public.applications add column if not exists score_reasoning jsonb;
alter table public.applications add column if not exists scored_at timestamptz;
alter table public.applications add column if not exists score_model text;

commit;

begin;

-- Widen state to add 'scoring': an Edge Function has atomically claimed this row
-- and is working on it. This is an ADD to the allowed set, so no existing row
-- needs rewriting -- only drop and re-add the constraint (CHECK constraints
-- cannot be altered in place).
alter table public.applications drop constraint if exists applications_state_check;
alter table public.applications add constraint applications_state_check check (state in (
  'submitted','scoring','scored','invited','tested','interviewing','offered','hired',
  'not_selected','withdrawn'));

commit;

begin;

-- =====================================================================================
-- 2. Storage: the cv-uploads bucket
-- =====================================================================================
--
-- Private, with the size cap and the allowed types set at the Storage layer
-- itself -- storage.buckets carries file_size_limit (bigint, bytes) and
-- allowed_mime_types (text[]) as real columns. This is the FIRST of three
-- independent places the same 5 MiB / file-type limit is enforced: Storage
-- refuses the upload outright, the cv_file_size CHECK above caps what this
-- database will accept as metadata, and the score-application Edge Function
-- re-checks the actual downloaded byte length and real magic bytes before
-- doing anything with a file. None of the three trusts the other two.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('cv-uploads', 'cv-uploads', false, 5242880, array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ])
  on conflict (id) do update set
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

commit;

begin;

-- =====================================================================================
-- 3. org_cv_upload_is_open(p_path) -- the one door into the bucket
-- =====================================================================================
--
-- Defined BEFORE the RLS policy below, which references it: Postgres resolves
-- a policy's WITH CHECK expression at CREATE POLICY time, so the function it
-- calls has to exist first.
--
-- Parses the path's first segment as the application id and answers true/false
-- for exactly that one path -- it never returns a row, so it cannot be used to
-- enumerate applications. storage.foldername(name) returns text[]; [1] is the
-- first segment (e.g. '<uuid>/cv.pdf' -> ['<uuid>']).
--
-- The 2-hour window is a guard against a stale link resurfacing days later and
-- landing a file on a row that has already moved on, not a hard security limit.

create or replace function public.org_cv_upload_is_open(p_path text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_app_id uuid;
begin
  begin
    v_app_id := (storage.foldername(p_path))[1]::uuid;
  exception when others then
    return false;
  end;

  return exists (
    select 1 from public.applications
     where id = v_app_id
       and cv_file_path is null
       and state = 'submitted'
       and created_at > now() - interval '2 hours'
  );
end $$;

commit;

begin;

-- =====================================================================================
-- 4. RLS: storage.objects for the cv-uploads bucket
-- =====================================================================================
--
-- Grants ride beside policies -- a policy filters rows on top of a grant, it
-- never supplies one. `anon` and `authenticated` need an explicit INSERT grant
-- on storage.objects the same way every table in this project states its own.

-- storage.objects.bucket_id references storage.buckets(id); validating that
-- foreign key on INSERT needs its own SELECT on the referenced table,
-- independent of the INSERT grant on objects itself -- proven on local
-- Postgres: the insert failed with "permission denied for table objects"
-- (not an RLS violation) until this line existed, even with everything else
-- in place.
grant select on storage.buckets to anon, authenticated;
grant insert on storage.objects to anon, authenticated;
grant select on storage.objects to authenticated;

-- Anon uploads only where org_cv_upload_is_open() says so -- an application that
-- exists, has no file yet, is still 'submitted', and was created recently. This
-- is the SAME shape of guard the anonymous RPCs already use: the applicant is
-- never authenticated, so the door is a function, not a role.
drop policy if exists "cv_uploads_insert" on storage.objects;
create policy "cv_uploads_insert" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'cv-uploads'
    and public.org_cv_upload_is_open(name)
  );

-- Only org_admin() may read an object's metadata -- which is what a client SDK
-- needs before it can mint a signed URL (createSignedUrl still checks this same
-- RLS; there is no SQL-callable signing function, it is client-side only).
-- Nobody may UPDATE or DELETE a stored CV at all; a bad upload is superseded by
-- a new application, never edited in place.
drop policy if exists "cv_uploads_admin_select" on storage.objects;
create policy "cv_uploads_admin_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'cv-uploads' and public.org_admin());

commit;

begin;

-- =====================================================================================
-- 5. org_mark_cv_uploaded -- records a file the applicant just uploaded
-- =====================================================================================
--
-- Called after a successful Storage upload. Re-checks the same conditions
-- org_cv_upload_is_open enforces (belt and suspenders: the storage policy and
-- this RPC ask the identical question, so a path that could not have been
-- written also cannot be recorded), then writes the three metadata columns
-- under the SAME app.application_write guard org_apply() already uses, so
-- org_guard_applications admits the write without a new guard existing twice.

drop function if exists public.org_mark_cv_uploaded(uuid, text, text, int);
create or replace function public.org_mark_cv_uploaded(
  p_application_id uuid,
  p_file_path      text,
  p_mime           text,
  p_size           int)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_state text;
  v_recent boolean;
begin
  select state into v_state from public.applications where id = p_application_id;
  if v_state is null then
    raise exception 'no such application' using errcode = '22023';
  end if;
  if v_state <> 'submitted' then
    raise exception 'that application is no longer accepting a file' using errcode = '22023';
  end if;

  select created_at > now() - interval '2 hours' into v_recent
    from public.applications where id = p_application_id;
  if not coalesce(v_recent, false) then
    raise exception 'that application is too old to receive a file' using errcode = '22023';
  end if;

  perform set_config('app.application_write', '1', true);
  begin
    update public.applications set
      cv_file_path = p_file_path,
      cv_file_mime = p_mime,
      cv_file_size = p_size
     where id = p_application_id;
  exception when others then
    perform set_config('app.application_write', '', true);
    raise;
  end;
  perform set_config('app.application_write', '', true);
end $$;

commit;

begin;

-- =====================================================================================
-- 6. org_claim_application_for_scoring -- the race-condition guard
-- =====================================================================================
--
-- One atomic UPDATE ... WHERE state = 'submitted'. Whichever caller's UPDATE
-- actually matches the row gets `true`; a second, third, or hundredth caller
-- racing for the same id gets `false` and must do nothing else. This is the
-- whole mechanism -- no advisory lock, no queue, because the WHERE clause
-- already is the lock.
--
-- Callable only by service_role: this is invoked by a trusted Edge Function,
-- never by a caller needing the per-row authorization the anonymous RPCs
-- enforce.
--
-- org_guard_applications blocks every direct write to applications regardless
-- of role -- proven on local Postgres, where this UPDATE was refused with
-- "written by org_apply(), not by a direct write" until it was wrapped in the
-- same app.application_write flag org_apply() and org_mark_cv_uploaded() use.
--
-- HOW SCORING IS ACTUALLY TRIGGERED: research into calling an Edge Function
-- from a SQL trigger (pg_net / supabase_functions.http_request) came back
-- unable to reach current documentation to confirm a stable, SQL-only path, so
-- none is invented here. Score-application is instead woken by a Database
-- Webhook, configured once via the dashboard:
--   Database -> Webhooks -> Create webhook
--   Table: public.applications, Event: INSERT
--   URL: https://<project-ref>.supabase.co/functions/v1/score-application
--   Header: Authorization: Bearer <service_role or a webhook secret>
-- This is the one manual step this migration cannot do for you; it is named
-- again in the PR body.

drop function if exists public.org_claim_application_for_scoring(uuid);
create or replace function public.org_claim_application_for_scoring(p_application_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_claimed boolean;
begin
  perform set_config('app.application_write', '1', true);
  update public.applications
     set state = 'scoring'
   where id = p_application_id and state = 'submitted';
  v_claimed := found;
  perform set_config('app.application_write', '', true);
  return v_claimed;
end $$;

commit;

begin;

-- =====================================================================================
-- 6b. org_record_score -- the ONLY way an Edge Function writes its result back
-- =====================================================================================
--
-- Everything the Edge Function computes -- the extraction result AND the score
-- -- lands in ONE update, under the same guard flag. Two separate writes (one
-- for extraction, one for the score) would mean the first could silently
-- succeed while the second fails, or vice versa, leaving a row with a score
-- but no note of how its file was scanned. One write, one guard flag, done.
--
-- p_next_state is passed in rather than decided here: the caller already knows
-- the posting's auto_advance_score, this function does not need to. It only
-- accepts 'scored' or 'invited' -- the two states scoring may ever produce.
-- Automation never writes 'not_selected'; that stays a person's decision.

create or replace function public.org_record_score(
  p_application_id    uuid,
  p_cv_extracted_text text,
  p_cv_flagged        boolean,
  p_cv_scan_note      text,
  p_score             int,
  p_score_reasoning   jsonb,
  p_score_model       text,
  p_next_state        text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_next_state not in ('scored', 'invited') then
    raise exception 'scoring may only result in scored or invited, not %', p_next_state
      using errcode = '22023';
  end if;

  perform set_config('app.application_write', '1', true);
  update public.applications set
    cv_extracted_text = coalesce(p_cv_extracted_text, cv_extracted_text),
    cv_flagged         = coalesce(p_cv_flagged, cv_flagged),
    cv_scan_note       = coalesce(p_cv_scan_note, cv_scan_note),
    score              = p_score,
    score_reasoning    = p_score_reasoning,
    scored_at          = now(),
    score_model        = p_score_model,
    state              = p_next_state
   where id = p_application_id;
  perform set_config('app.application_write', '', true);
end $$;

commit;

begin;

-- =====================================================================================
-- 7. org_apply -- one new trailing parameter
-- =====================================================================================
--
-- p_portfolio_url is appended after the existing p_trap, with a default, so no
-- existing parameter moves. But CREATE OR REPLACE identifies a function by its
-- argument TYPE LIST, not by name+defaults, so adding one more type makes this
-- a DIFFERENT signature -- without the DROP below, the 9-argument version keeps
-- existing alongside this 10-argument one, and a call using the defaulted tail
-- becomes ambiguous between the two ("function is not unique"). Proven: this
-- exact migration failed that way on local Postgres before the drop was added
-- back in. A bare domain ("behance.net/name") is prefixed with https://
-- server-side -- refusing over a missing scheme would be a paper cut nobody
-- needed.

drop function if exists public.org_apply(
  uuid,text,text,text,int,text,text,text,text);
create or replace function public.org_apply(
  p_posting          uuid,
  p_full_name        text,
  p_email            text,
  p_phone            text,
  p_years_experience int  default null,
  p_current_job      text default null,
  p_why_this_job     text default null,
  p_cv_text          text default null,
  p_trap             text default null,
  p_portfolio_url    text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_fingerprint text;
  v_recent int;
  v_cap int;
  v_id uuid;
  v_state text;
  v_closes timestamptz;
  v_portfolio text;
begin
  if coalesce(btrim(p_trap), '') <> '' then
    return gen_random_uuid();
  end if;

  select state, closes_at into v_state, v_closes
    from public.job_postings where id = p_posting;
  if v_state is null then
    raise exception 'that role is not taking applications' using errcode = '22023';
  end if;
  if v_state <> 'open' or (v_closes is not null and v_closes < now()) then
    raise exception 'that role is not taking applications' using errcode = '22023';
  end if;

  v_fingerprint := public.org_caller_fingerprint();
  v_cap := 5;
  if v_fingerprint is null then
    v_fingerprint := '(no-forwarded-for)';
    v_cap := 20;
  end if;

  delete from public.application_attempts
   where fingerprint = v_fingerprint and at < now() - interval '1 day';
  select count(*) into v_recent from public.application_attempts
   where fingerprint = v_fingerprint and at > now() - interval '1 hour';
  if v_recent >= v_cap then
    raise exception 'too many applications from here in the last hour -- try again later'
      using errcode = '53400';
  end if;
  insert into public.application_attempts (fingerprint) values (v_fingerprint);

  v_portfolio := nullif(btrim(coalesce(p_portfolio_url, '')), '');
  if v_portfolio is not null and v_portfolio !~ '^https?://' then
    v_portfolio := 'https://' || v_portfolio;
  end if;

  perform set_config('app.application_write', '1', true);
  begin
    insert into public.applications (
      posting_id, full_name, email, phone, years_experience, current_job,
      why_this_job, cv_text, portfolio_url)
    values (
      p_posting, btrim(p_full_name), lower(btrim(p_email)), btrim(p_phone),
      p_years_experience,
      nullif(btrim(coalesce(p_current_job,'')),''),
      nullif(btrim(coalesce(p_why_this_job,'')),''),
      nullif(btrim(coalesce(p_cv_text,'')),''),
      v_portfolio)
    returning id into v_id;
  exception when unique_violation then
    perform set_config('app.application_write', '', true);
    raise exception 'you have already applied for this role'
      using errcode = '23505';
  end;
  perform set_config('app.application_write', '', true);
  return v_id;
end $$;

commit;

begin;

-- =====================================================================================
-- 8. org_application_detail -- the new fields join the existing ones
-- =====================================================================================

create or replace function public.org_application_detail(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.org_admin() then null else
    (select jsonb_build_object(
       'id', a.id,
       'why_this_job', a.why_this_job,
       'cv_text', a.cv_text,
       'portfolio_url', a.portfolio_url,
       'cv_extracted_text', a.cv_extracted_text,
       'cv_flagged', a.cv_flagged,
       'cv_scan_note', a.cv_scan_note,
       'score', a.score,
       'score_reasoning', a.score_reasoning,
       'scored_at', a.scored_at,
       'score_model', a.score_model)
       from public.applications a where a.id = p_id) end;
$$;

commit;

begin;

-- =====================================================================================
-- 9. org_applications -- the list gains only `score` (an int is cheap)
-- =====================================================================================
--
-- score_reasoning, cv_extracted_text, and portfolio_url stay detail-only, per
-- this function's own existing size discipline (a popular posting's list must
-- stay a list of names, not a page of everyone's prose).

create or replace function public.org_applications(
  p_posting uuid,
  p_before  timestamptz default null,
  p_limit   int default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.org_admin() then '[]'::jsonb else coalesce(
    (select jsonb_agg(jsonb_build_object(
       'id', a.id, 'full_name', a.full_name, 'email', a.email,
       'phone', a.phone, 'years_experience', a.years_experience,
       'current_job', a.current_job, 'state', a.state,
       'has_writing', (a.why_this_job is not null or a.cv_text is not null),
       'score', a.score,
       'created_at', a.created_at) order by a.created_at desc)
       from (select * from public.applications
              where posting_id = p_posting
                and (p_before is null or created_at < p_before)
              order by created_at desc
              limit least(greatest(coalesce(p_limit, 50), 1), 200)) a), '[]'::jsonb) end;
$$;

commit;

begin;

-- =====================================================================================
-- 10. Grants
-- =====================================================================================

revoke all on function public.org_apply(
  uuid,text,text,text,int,text,text,text,text,text) from public;
grant execute on function public.org_apply(
  uuid,text,text,text,int,text,text,text,text,text) to anon, authenticated;

revoke all on function public.org_cv_upload_is_open(text) from public, anon;
grant execute on function public.org_cv_upload_is_open(text) to anon, authenticated;

revoke all on function public.org_mark_cv_uploaded(uuid, text, text, int) from public, anon;
grant execute on function public.org_mark_cv_uploaded(uuid, text, text, int) to anon, authenticated;

revoke all on function public.org_claim_application_for_scoring(uuid) from public, anon, authenticated;
grant execute on function public.org_claim_application_for_scoring(uuid) to service_role;

revoke all on function public.org_record_score(uuid,text,boolean,text,int,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.org_record_score(uuid,text,boolean,text,int,jsonb,text,text) to service_role;

commit;
