-- A posting does not name a box in the org tree.
--
-- 20260919090000 gave job_postings a required node_id and an optional
-- position_id, on the argument that "a posting is a vacant seat" and hiring
-- would therefore be seating. Tracing it afterwards, that argument was about
-- columns nothing read:
--
--   * node_id was used for exactly one thing -- joining org_nodes to print a
--     department label on the advert. No policy, no filter, no branch.
--   * position_id was WRITTEN AND NEVER READ. Not once, anywhere.
--
-- And the premise was wrong. Seating someone needs a POSITION, and the position
-- is chosen when you hire, because that is the first moment anyone knows which
-- team the person actually fits. A field filled weeks earlier by someone
-- guessing, which then gets overridden, is worse than no field: it is a picker
-- of 180 boxes standing between the owner and publishing a job.
--
-- The seat belongs to the hire, not to the advert. When hiring-into-a-seat is
-- built it will hang off the APPLICATION -- "this person was seated here" -- not
-- off the posting.
--
-- This migration therefore deletes rather than adds: two columns, one join, one
-- jsonb key and two function parameters.

begin;

-- 1. The projections first, so nothing references the columns when they go.
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
           'closes_at', j.closes_at,
           'published_at', j.published_at)
         order by j.published_at desc), '[]'::jsonb)
    from public.job_postings j
   where j.state = 'open';
$$;

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
           'closes_at', j.closes_at,
           'published_at', j.published_at)
    from public.job_postings j
   where j.id = p_id and j.state = 'open';
$$;

create or replace function public.org_job_postings_admin()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.org_admin() then '[]'::jsonb else coalesce(
    (select jsonb_agg(jsonb_build_object(
       'id', j.id, 'title', j.title, 'title_en', j.title_en,
       'summary', j.summary, 'description', j.description,
       'location', j.location, 'interview_location', j.interview_location,
       'employment_type', j.employment_type, 'openings', j.openings,
       'min_score', j.min_score, 'auto_advance_score', j.auto_advance_score,
       'invite_cap', j.invite_cap, 'closes_at', j.closes_at,
       'state', j.state, 'published_at', j.published_at,
       'created_at', j.created_at)
       order by j.created_at desc)
       from public.job_postings j), '[]'::jsonb) end;
$$;

commit;

begin;

-- 2. The guard's frozen-terms comparison names every column whose value a live
--    posting may not change. Two of them are about to stop existing.
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
    if old.state <> 'draft' then
      if (new.title, new.title_en, new.summary, new.description, new.location,
          new.interview_location, new.employment_type, new.openings,
          new.min_score, new.auto_advance_score, new.invite_cap)
         is distinct from
         (old.title, old.title_en, old.summary, old.description, old.location,
          old.interview_location, old.employment_type, old.openings,
          old.min_score, old.auto_advance_score, old.invite_cap) then
        raise exception
          'this posting is already live; its terms are fixed for the people who applied under them'
          using errcode = '42501';
      end if;
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

commit;

begin;

-- 3. The authoring verbs lose two parameters each. A signature change needs the
--    old one dropped first -- create or replace cannot remove a parameter.
drop function if exists public.org_post_job(text,text,uuid,text,text,text,text,uuid,text,int,int,int,int);
create or replace function public.org_post_job(
  p_title              text,
  p_description        text,
  p_location           text,
  p_interview_location text,
  p_title_en           text default null,
  p_summary            text default null,
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
    title, title_en, summary, description, location, interview_location,
    employment_type, openings, min_score, auto_advance_score, invite_cap)
  values (
    btrim(p_title), nullif(btrim(coalesce(p_title_en,'')),''),
    nullif(btrim(coalesce(p_summary,'')),''), btrim(p_description),
    btrim(p_location), btrim(p_interview_location), p_employment_type,
    p_openings, p_min_score, p_auto_advance_score, p_invite_cap)
  returning id into v_id;
  return v_id;
end $$;

drop function if exists public.org_edit_job(uuid,text,text,uuid,text,text,text,text,uuid,text,int,int,int,int);
create or replace function public.org_edit_job(
  p_id                 uuid,
  p_title              text,
  p_description        text,
  p_location           text,
  p_interview_location text,
  p_title_en           text default null,
  p_summary            text default null,
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

commit;

begin;

-- 4. Now the columns themselves.
alter table public.job_postings drop column if exists node_id;
alter table public.job_postings drop column if exists position_id;

commit;

begin;

revoke all on function public.org_post_job(text,text,text,text,text,text,text,int,int,int,int) from public, anon;
grant execute on function public.org_post_job(text,text,text,text,text,text,text,int,int,int,int) to authenticated;
revoke all on function public.org_edit_job(uuid,text,text,text,text,text,text,text,int,int,int,int) from public, anon;
grant execute on function public.org_edit_job(uuid,text,text,text,text,text,text,text,int,int,int,int) to authenticated;

commit;
