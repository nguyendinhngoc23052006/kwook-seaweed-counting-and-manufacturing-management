-- Applying for a job: the only write an anonymous stranger can make.
--
-- Every other write in this database comes from someone who works here. This
-- one comes from the internet, so it is the single largest piece of attack
-- surface the company has, and it is built as such. The owner's instruction was
-- explicit -- capacity is not a substitute for a door:
--
--   "even with pro i would want my website to be enforced, so of course
--    rate-limit, size cap, one-per-email, honeypot, ... is required"
--
-- All four live below, in SQL, where no client can skip them:
--
--   size cap      -> CHECK constraints on every text column
--   one-per-email -> a unique index on (posting, lower(email))
--   rate limit    -> a fingerprint of the caller's IP, bucketed by the hour
--   honeypot      -> a field no human can see; when it is filled the caller is
--                    told it worked and nothing is written
--
-- Nothing is granted to anon on any table here. The only thing anon may call is
-- org_apply(), which is SECURITY DEFINER and enforces all of the above before
-- it writes a row.

begin;

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  posting_id uuid not null references public.job_postings(id) on delete restrict,

  -- Personal data belonging to someone who does not work here. It lives behind
  -- RLS, never in a migration, and it is deleted when the posting it belongs to
  -- has been closed long enough -- the owner's rule is that what lives behind a
  -- login belongs to the company and what arrives from the public is on loan.
  full_name text not null check (length(btrim(full_name)) between 1 and 120),
  email     text not null check (
    length(email) <= 200 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone     text not null check (length(btrim(phone)) between 5 and 30),

  -- The application itself. Structured rather than a file, because it compares
  -- fairly across people, it is what the scorer reads, and most of the people
  -- this factory hires do not have a CV document at all.
  years_experience int check (years_experience between 0 and 60),
  current_job text check (length(current_job) <= 200),
  why_this_job text check (length(why_this_job) <= 2000),
  cv_text      text check (length(cv_text) <= 20000),

  -- The whole funnel, declared now so that narrowing a CHECK later -- which
  -- means dropping it, rewriting rows and re-adding it -- never has to happen.
  state text not null default 'submitted' check (state in (
    'submitted','scored','invited','tested','interviewing','offered','hired',
    'not_selected','withdrawn')),

  -- Filled when the applicant makes an account to sit the test. They are never
  -- sent a password: they set their own, and by the time an offer exists the
  -- account already does, so hiring is a link rather than an onboarding errand.
  account_id uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now()
);

-- One per person per posting. A second attempt is a mistake or a bot; either
-- way the first one stands.
create unique index if not exists applications_one_per_email_idx
  on public.applications (posting_id, lower(email));

-- The admin list reads one posting at a time, newest first.
create index if not exists applications_by_posting_idx
  on public.applications (posting_id, created_at desc);

-- Rate limiting keeps a FINGERPRINT, never an address: a salted digest is
-- enough to count attempts and is not personal data to lose.
create table if not exists public.application_attempts (
  id bigint generated always as identity primary key,
  fingerprint text not null,
  at timestamptz not null default now()
);
create index if not exists application_attempts_idx
  on public.application_attempts (fingerprint, at desc);

commit;

begin;

-- No client writes these tables. The guard makes that true rather than assumed.
create or replace function public.org_guard_applications()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.application_write', true), '') = '1' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'applications are removed by the retention job, not by hand'
      using errcode = '42501';
  end if;
  raise exception 'an application is written by org_apply(), not by a direct write'
    using errcode = '42501';
end $$;

drop trigger if exists org_guard_applications on public.applications;
create trigger org_guard_applications
  before insert or update or delete on public.applications
  for each row execute function public.org_guard_applications();

commit;

begin;

alter table public.applications        enable row level security;
alter table public.application_attempts enable row level security;

-- Only the two people who run hiring can read an application. No policy on
-- application_attempts at all: nothing but the definer function ever reads it.
drop policy if exists applications_select on public.applications;
create policy applications_select on public.applications for select to authenticated
using ((select public.org_admin()));

grant select on public.applications to authenticated;

commit;

begin;

-- The caller's fingerprint.
--
-- x-forwarded-for is APPENDED TO by each proxy it passes, so it reads
-- "what the client claimed, ..., what the last proxy actually saw". The
-- LEFTMOST entry is therefore fully attacker-controlled -- send a different one
-- every call and every call looks like a new person. The RIGHTMOST is the one
-- our own gateway wrote, and is the only part a caller cannot forge.
--
-- The address is hashed immediately and never stored: a digest is enough to
-- count against and is not personal data to lose.
create or replace function public.org_caller_fingerprint()
returns text language plpgsql stable security definer set search_path = public as $$
declare v_raw text; v_hops text[]; v_ip text;
begin
  begin
    v_raw := current_setting('request.headers', true);
    if v_raw is null or v_raw = '' then return null; end if;
    v_hops := string_to_array((v_raw::jsonb) ->> 'x-forwarded-for', ',');
  exception when others then
    return null;
  end;
  if v_hops is null or array_length(v_hops, 1) is null then return null; end if;
  v_ip := btrim(v_hops[array_length(v_hops, 1)]);
  if v_ip = '' then return null; end if;
  return encode(public.digest('kwook-apply:' || v_ip, 'sha256'), 'hex');
end $$;

commit;

begin;

-- The door.
--
-- p_trap is the honeypot: rendered off-screen, out of the tab order, so a
-- person never fills it and a form-filling bot usually does. When it arrives
-- non-empty the caller is told the application succeeded and nothing is written
-- -- telling a bot it failed only teaches it to try again.
--
-- It is NOT called "website". Browsers autofill a field called website or url
-- from the saved profile, and an autofilled honeypot would silently discard a
-- real person's application while showing them a success page. The name has to
-- be one no autofill heuristic recognises.
drop function if exists public.org_apply(uuid,text,text,text,int,text,text,text,text);
create or replace function public.org_apply(
  p_posting          uuid,
  p_full_name        text,
  p_email            text,
  p_phone            text,
  p_years_experience int  default null,
  p_current_job     text default null,
  p_why_this_job     text default null,
  p_cv_text          text default null,
  p_trap             text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_fingerprint text;
  v_recent int;
  v_cap int;
  v_id uuid;
  v_state text;
  v_closes timestamptz;
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

  -- Five attempts an hour from one address. Enough for a person who mistypes an
  -- email and retries; not enough to enumerate or flood.
  --
  -- When the header is absent there is nothing to count against. Refusing would
  -- mean a gateway change silently stops the company hiring; allowing freely
  -- would mean the one defence the owner called non-negotiable rests entirely on
  -- a header. So the anonymous path gets its OWN shared bucket with a much
  -- tighter ceiling: normal traffic never lands in it, and if the gateway ever
  -- stops forwarding, applications degrade to a trickle instead of either
  -- stopping dead or becoming unlimited.
  v_fingerprint := public.org_caller_fingerprint();
  v_cap := 5;
  if v_fingerprint is null then
    v_fingerprint := '(no-forwarded-for)';
    v_cap := 20;
  end if;

  -- Only this fingerprint's own stale rows: the (fingerprint, at desc) index
  -- covers it, so the sweep is bounded instead of a full scan on every call --
  -- and a full scan is worst exactly when someone is hammering the endpoint.
  delete from public.application_attempts
   where fingerprint = v_fingerprint and at < now() - interval '1 day';
  select count(*) into v_recent from public.application_attempts
   where fingerprint = v_fingerprint and at > now() - interval '1 hour';
  if v_recent >= v_cap then
    raise exception 'too many applications from here in the last hour -- try again later'
      using errcode = '53400';
  end if;
  insert into public.application_attempts (fingerprint) values (v_fingerprint);

  perform set_config('app.application_write', '1', true);
  begin
    insert into public.applications (
      posting_id, full_name, email, phone, years_experience, current_job,
      why_this_job, cv_text)
    values (
      p_posting, btrim(p_full_name), lower(btrim(p_email)), btrim(p_phone),
      p_years_experience,
      nullif(btrim(coalesce(p_current_job,'')),''),
      nullif(btrim(coalesce(p_why_this_job,'')),''),
      nullif(btrim(coalesce(p_cv_text,'')),''))
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

-- What the poster sees.
--
-- The list deliberately does NOT carry why_this_job or cv_text. A popular
-- factory role draws hundreds of applications and cv_text is capped at 20,000
-- characters, so shipping them all would be a multi-megabyte response to draw a
-- list of names. The screen expands one applicant at a time and fetches the
-- long answers then, from org_application_detail() below.
--
-- Keyset paging on created_at, which applications_by_posting_idx already orders.
drop function if exists public.org_applications(uuid);
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
       'created_at', a.created_at) order by a.created_at desc)
       from (select * from public.applications
              where posting_id = p_posting
                and (p_before is null or created_at < p_before)
              order by created_at desc
              limit least(greatest(coalesce(p_limit, 50), 1), 200)) a), '[]'::jsonb) end;
$$;

-- The two long answers, for the one applicant being read right now.
create or replace function public.org_application_detail(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.org_admin() then null else
    (select jsonb_build_object(
       'id', a.id, 'why_this_job', a.why_this_job, 'cv_text', a.cv_text)
       from public.applications a where a.id = p_id) end;
$$;

-- How many have applied, per posting. Cheap enough to ask for every posting at
-- once, and it is the number the desk actually wants on the list screen.
create or replace function public.org_application_counts()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.org_admin() then '{}'::jsonb else coalesce(
    (select jsonb_object_agg(posting_id::text, n)
       from (select posting_id, count(*) n from public.applications
              group by posting_id) c), '{}'::jsonb) end;
$$;

commit;

begin;

revoke all on function public.org_apply(uuid,text,text,text,int,text,text,text,text) from public;
grant execute on function public.org_apply(uuid,text,text,text,int,text,text,text,text) to anon, authenticated;
revoke all on function public.org_applications(uuid,timestamptz,int) from public, anon;
grant execute on function public.org_applications(uuid,timestamptz,int) to authenticated;
revoke all on function public.org_application_detail(uuid)    from public, anon;
grant execute on function public.org_application_detail(uuid) to authenticated;
revoke all on function public.org_application_counts()        from public, anon;
grant execute on function public.org_application_counts()     to authenticated;
revoke all on function public.org_caller_fingerprint()        from public, anon;
revoke all on function public.org_guard_applications()        from public, anon;

commit;
