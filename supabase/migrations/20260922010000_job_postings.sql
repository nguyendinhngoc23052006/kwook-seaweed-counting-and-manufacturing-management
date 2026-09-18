-- The company's front door.
--
-- Everything else in this database is for people who already work here. This is
-- the first table a stranger can read, and the reason it exists is that hiring
-- into the 500-seat structure should start where the empty seat is, not in
-- somebody's inbox.
--
-- Two audiences, two shapes, and they must not be the same shape:
--
--   * Whoever posts the job (the Tổng Giám đốc or the sysadmin -- org_admin()
--     is already exactly those two) sees the whole row, including the scoring
--     thresholds that decide who advances.
--   * The public sees a PROJECTION of it through org_job_board(), which never
--     carries min_score, auto_advance_score or invite_cap. An applicant who
--     knows the bar is 70 writes to the bar. The thresholds are the one part of
--     a posting that has to stay behind the glass.
--
-- So the table is readable only by org_admin(), the public reads two SECURITY
-- DEFINER functions, and anon is granted nothing on the table itself.

begin;

create table if not exists public.job_postings (
  id uuid primary key default gen_random_uuid(),

  title    text not null check (length(btrim(title)) > 0),
  title_en text,
  summary  text,
  -- The JD. Later parts of this flow read it to compose the scoring rubric, so
  -- it is one authored document rather than a pile of columns.
  description text not null check (length(btrim(description)) > 0),

  -- Which box is hiring, and which chair is empty. position_id is nullable
  -- because a posting may precede the seat existing -- you can advertise a role
  -- you are about to create. node_id is not: work happens somewhere.
  node_id     uuid not null references public.org_nodes(id) on delete restrict,
  position_id uuid references public.positions(id) on delete restrict,

  location           text not null check (length(btrim(location)) > 0),
  -- Chosen when the job is posted, not arranged per candidate afterwards. One
  -- less thing for a human to decide 40 times.
  interview_location text not null check (length(btrim(interview_location)) > 0),
  employment_type    text not null default 'full_time'
    check (employment_type in ('full_time','part_time','seasonal','contract')),
  openings int not null default 1 check (openings > 0),

  -- The three numbers that decide who moves, and why arrival order does not.
  --
  -- A CV is scored against the JD's rubric ALONE -- never against other
  -- applicants -- so a score means the same thing whoever else applied. Then:
  --   score >= auto_advance_score  -> invited immediately, no waiting, no queue
  --   score >= min_score           -> held in the pool until closes_at, then the
  --                                   remaining slots go to the top of it
  -- Without the pool, the first invite_cap applicants would be the only ones
  -- ranked, and would take every slot by arriving early rather than by being
  -- better.
  min_score          int not null default 60 check (min_score between 0 and 100),
  auto_advance_score int not null default 85
    check (auto_advance_score between 0 and 100),
  invite_cap         int not null default 10 check (invite_cap > 0),
  constraint job_postings_bar_order check (min_score <= auto_advance_score),

  -- When the pool is cut. Null while the posting is still a draft.
  closes_at timestamptz,

  state text not null default 'draft'
    check (state in ('draft','open','closed','filled')),
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) on delete set null
);

comment on column public.job_postings.min_score is
  'Floor to be eligible at all. Below it, the application is kept and visible to the poster, never auto-rejected.';
comment on column public.job_postings.auto_advance_score is
  'The fast lane. At or above this a candidate is invited the moment they are scored, so strong people never wait on the window.';
comment on column public.job_postings.invite_cap is
  'X -- the total number invited forward. The fast lane draws from it; the pool fills what is left at closes_at.';

-- No index here, deliberately. A company this size posts dozens of roles a
-- year, so the board will read a single page and sort a handful of rows; an
-- index on that is a performance hint that is wrong about its own table. Add
-- one when a query actually gets slow, against a real plan.

commit;

begin;

-- The posting is authored through the RPCs at the bottom of this file, which is
-- where the rules live. This trigger is what makes that the only door.
create or replace function public.org_guard_job_postings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.state <> 'draft' then
      raise exception 'a posting that has been published is closed, never deleted'
        using errcode = '42501';
    end if;
    if not (auth.uid() is null or public.org_admin()) then
      raise exception 'only the Tổng Giám đốc or a sysadmin manages job postings'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if not (auth.uid() is null or public.org_admin()) then
    raise exception 'only the Tổng Giám đốc or a sysadmin manages job postings'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    -- Once it is live, the deal cannot change under the people who already
    -- applied. The JD they read, the bar they were measured against and the
    -- number of slots are all frozen at publication.
    if old.state <> 'draft' then
      if (new.title, new.title_en, new.summary, new.description, new.node_id,
          new.position_id, new.location, new.interview_location,
          new.employment_type, new.openings, new.min_score,
          new.auto_advance_score, new.invite_cap)
         is distinct from
         (old.title, old.title_en, old.summary, old.description, old.node_id,
          old.position_id, old.location, old.interview_location,
          old.employment_type, old.openings, old.min_score,
          old.auto_advance_score, old.invite_cap) then
        raise exception
          'this posting is already live; its terms are fixed for the people who applied under them'
          using errcode = '42501';
      end if;
      -- A deadline may be extended, never brought forward: shortening it would
      -- shut out people who were told they had until Friday.
      if new.closes_at is distinct from old.closes_at
         and (new.closes_at is null or old.closes_at is null
              or new.closes_at < old.closes_at) then
        raise exception 'a closing date can be extended, not brought forward'
          using errcode = '42501';
      end if;
    end if;

    if new.state <> old.state and not (
         (old.state = 'draft'  and new.state = 'open')
      or (old.state = 'open'   and new.state in ('closed','filled'))
      or (old.state = 'closed' and new.state = 'filled')) then
      raise exception 'a posting goes draft -> open -> closed -> filled, not % -> %',
        old.state, new.state using errcode = '22023';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.state := 'draft';
    new.published_at := null;
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;

  return new;
end $$;

drop trigger if exists org_guard_job_postings on public.job_postings;
create trigger org_guard_job_postings
  before insert or update or delete on public.job_postings
  for each row execute function public.org_guard_job_postings();

commit;

begin;

-- 3. Who may read the row itself -----------------------------------------------
-- Only the two people who manage postings. Everyone else -- including every
-- signed-in employee -- reads the public projection, so the thresholds stay
-- behind the glass even from staff.
alter table public.job_postings enable row level security;

drop policy if exists job_postings_select on public.job_postings;
create policy job_postings_select on public.job_postings for select to authenticated
using ((select public.org_admin()));

grant select on public.job_postings to authenticated;

commit;

begin;

-- 4. The public projection ------------------------------------------------------
-- What a stranger sees. Note what is absent: every scoring threshold, the seat
-- id, and who created it.
create or replace function public.org_job_board()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', j.id,
           'title', j.title,
           'title_en', j.title_en,
           'summary', j.summary,
           'location', j.location,
           'employment_type', j.employment_type,
           'openings', j.openings,
           'department', n.name,
           'closes_at', j.closes_at,
           'published_at', j.published_at)
         order by j.published_at desc), '[]'::jsonb)
    from public.job_postings j
    join public.org_nodes n on n.id = j.node_id
   where j.state = 'open';
$$;

-- One posting, by id. Returns null rather than an error for anything not
-- currently open, so a stale link reads as "this role has closed" instead of
-- leaking that the id was real.
create or replace function public.org_job_posting(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'id', j.id,
           'title', j.title,
           'title_en', j.title_en,
           'summary', j.summary,
           'description', j.description,
           'location', j.location,
           'interview_location', j.interview_location,
           'employment_type', j.employment_type,
           'openings', j.openings,
           'department', n.name,
           'closes_at', j.closes_at,
           'published_at', j.published_at)
    from public.job_postings j
    join public.org_nodes n on n.id = j.node_id
   where j.id = p_id and j.state = 'open';
$$;

-- What the poster sees: everything, including the thresholds and the drafts.
create or replace function public.org_job_postings_admin()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.org_admin() then '[]'::jsonb else coalesce(
    (select jsonb_agg(jsonb_build_object(
       'id', j.id, 'title', j.title, 'title_en', j.title_en,
       'summary', j.summary, 'description', j.description,
       'node_id', j.node_id, 'position_id', j.position_id,
       'department', n.name,
       'location', j.location, 'interview_location', j.interview_location,
       'employment_type', j.employment_type, 'openings', j.openings,
       'min_score', j.min_score, 'auto_advance_score', j.auto_advance_score,
       'invite_cap', j.invite_cap, 'closes_at', j.closes_at,
       'state', j.state, 'published_at', j.published_at,
       'created_at', j.created_at)
       order by j.created_at desc)
       from public.job_postings j
       join public.org_nodes n on n.id = j.node_id), '[]'::jsonb) end;
$$;

commit;

begin;

-- 5. Authoring ------------------------------------------------------------------

-- Six callers ask the same question, so it is written once. The guard trigger
-- below asks it too: these functions are SECURITY DEFINER, and a definer
-- function that trusts a trigger to be its only lock is one policy change away
-- from being open. Say it at the door as well.
create or replace function public.org_require_job_admin()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.org_admin() then
    raise exception 'only the Tổng Giám đốc or a sysadmin manages job postings'
      using errcode = '42501';
  end if;
end $$;

create or replace function public.org_post_job(
  p_title              text,
  p_description        text,
  p_node               uuid,
  p_location           text,
  p_interview_location text,
  p_title_en           text default null,
  p_summary            text default null,
  p_position           uuid default null,
  p_employment_type    text default 'full_time',
  p_openings           int  default 1,
  p_min_score          int  default 60,
  p_auto_advance_score int  default 85,
  p_invite_cap         int  default 10)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.org_require_job_admin();
  insert into public.job_postings (
    title, title_en, summary, description, node_id, position_id, location,
    interview_location, employment_type, openings, min_score,
    auto_advance_score, invite_cap)
  values (
    btrim(p_title), nullif(btrim(coalesce(p_title_en,'')),''),
    nullif(btrim(coalesce(p_summary,'')),''), btrim(p_description), p_node,
    p_position, btrim(p_location), btrim(p_interview_location),
    p_employment_type, p_openings, p_min_score, p_auto_advance_score,
    p_invite_cap)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.org_edit_job(
  p_id                 uuid,
  p_title              text,
  p_description        text,
  p_node               uuid,
  p_location           text,
  p_interview_location text,
  p_title_en           text default null,
  p_summary            text default null,
  p_position           uuid default null,
  p_employment_type    text default 'full_time',
  p_openings           int  default 1,
  p_min_score          int  default 60,
  p_auto_advance_score int  default 85,
  p_invite_cap         int  default 10)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.org_require_job_admin();
  update public.job_postings set
    title = btrim(p_title),
    title_en = nullif(btrim(coalesce(p_title_en,'')),''),
    summary = nullif(btrim(coalesce(p_summary,'')),''),
    description = btrim(p_description),
    node_id = p_node,
    position_id = p_position,
    location = btrim(p_location),
    interview_location = btrim(p_interview_location),
    employment_type = p_employment_type,
    openings = p_openings,
    min_score = p_min_score,
    auto_advance_score = p_auto_advance_score,
    invite_cap = p_invite_cap
  where id = p_id;
  if not found then
    raise exception 'no such posting' using errcode = '22023';
  end if;
end $$;

-- Publishing is the moment the terms freeze, so it is its own verb rather than
-- a field on the edit form.
create or replace function public.org_publish_job(
  p_id uuid, p_closes_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.org_require_job_admin();
  if p_closes_at is null or p_closes_at <= now() then
    raise exception 'a posting needs a closing date in the future -- it is what the pool is cut on'
      using errcode = '22023';
  end if;
  update public.job_postings
     set state = 'open', closes_at = p_closes_at, published_at = now()
   where id = p_id and state = 'draft';
  if not found then
    raise exception 'that posting is not a draft' using errcode = '22023';
  end if;
end $$;

-- Discarding a draft is a verb, not a DELETE on the table. With no delete
-- policy, a direct `delete` matches zero rows and reports success -- the guard
-- below never even runs, so the poster is told the posting is gone while it is
-- still there. Routing it through here means the refusal is spoken out loud.
create or replace function public.org_discard_draft_job(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.org_require_job_admin();
  if not exists (select 1 from public.job_postings where id = p_id) then
    raise exception 'no such posting' using errcode = '22023';
  end if;
  if exists (select 1 from public.job_postings where id = p_id and state <> 'draft') then
    raise exception 'this posting has been published; close it instead of deleting it'
      using errcode = '42501';
  end if;
  delete from public.job_postings where id = p_id;
end $$;

create or replace function public.org_close_job(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.org_require_job_admin();
  update public.job_postings set state = 'closed'
   where id = p_id and state = 'open';
  if not found then
    raise exception 'that posting is not open' using errcode = '22023';
  end if;
end $$;

create or replace function public.org_extend_job(
  p_id uuid, p_closes_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.org_require_job_admin();
  update public.job_postings set closes_at = p_closes_at
   where id = p_id and state = 'open';
  if not found then
    raise exception 'that posting is not open' using errcode = '22023';
  end if;
end $$;

commit;

begin;

-- 6. Grants ---------------------------------------------------------------------
-- The board and one posting are the ONLY things a stranger may call. Everything
-- else, including the admin projection, is refused to anon outright rather than
-- relying on the check inside it.
revoke all on function public.org_job_board()                 from public;
revoke all on function public.org_job_posting(uuid)           from public;
revoke all on function public.org_job_postings_admin()        from public, anon;
grant execute on function public.org_job_board()              to anon, authenticated;
grant execute on function public.org_job_posting(uuid)        to anon, authenticated;
grant execute on function public.org_job_postings_admin()     to authenticated;

revoke all on function public.org_post_job(text,text,uuid,text,text,text,text,uuid,text,int,int,int,int) from public, anon;
grant execute on function public.org_post_job(text,text,uuid,text,text,text,text,uuid,text,int,int,int,int) to authenticated;
revoke all on function public.org_edit_job(uuid,text,text,uuid,text,text,text,text,uuid,text,int,int,int,int) from public, anon;
grant execute on function public.org_edit_job(uuid,text,text,uuid,text,text,text,text,uuid,text,int,int,int,int) to authenticated;
revoke all on function public.org_publish_job(uuid,timestamptz) from public, anon;
grant execute on function public.org_publish_job(uuid,timestamptz) to authenticated;
revoke all on function public.org_discard_draft_job(uuid)     from public, anon;
grant execute on function public.org_discard_draft_job(uuid)  to authenticated;
revoke all on function public.org_close_job(uuid)             from public, anon;
grant execute on function public.org_close_job(uuid)          to authenticated;
revoke all on function public.org_extend_job(uuid,timestamptz) from public, anon;
grant execute on function public.org_extend_job(uuid,timestamptz) to authenticated;
revoke all on function public.org_require_job_admin()         from public, anon;
grant execute on function public.org_require_job_admin()      to authenticated;
revoke all on function public.org_guard_job_postings()        from public, anon;

commit;
