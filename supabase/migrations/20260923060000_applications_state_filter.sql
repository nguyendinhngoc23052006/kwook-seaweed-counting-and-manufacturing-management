-- 8.12 Applications: default the list to the live pipeline.
--
-- org_applications() had no state filter at all -- submitted through offered
-- sat mixed permanently with the three terminal states (hired, not_selected,
-- withdrawn). A posting that ran for months makes an admin page through every
-- past rejection to find who is still active. Filtering client-side would
-- keep pagination correct only per-page, not against the true filtered set
-- (a page of 50 raw rows could contain zero active applicants), so the filter
-- lives here, same as every other admin list in this schema.
--
-- p_states is trailing with a default, so this is a CREATE OR REPLACE in
-- place -- same function OID, same existing grant, no new overload.
begin;

create or replace function public.org_applications(
  p_posting uuid,
  p_before  timestamptz default null,
  p_limit   int default 50,
  p_states  text[] default null)
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
                -- No caller ever passes an empty array on purpose (it would
                -- mean "show nothing"); coalesce it to the default active set
                -- the same as null, so a client typo degrades to the safe
                -- default rather than an unexplained empty page.
                and state = any(case when p_states is null or p_states = '{}'
                  then array['submitted','scoring','scored','invited','tested',
                              'interviewing','offered']
                  else p_states end)
              order by created_at desc
              limit least(greatest(coalesce(p_limit, 50), 1), 200)) a), '[]'::jsonb) end;
$$;

-- The disclosure's own label needs "how many are closed" before it is ever
-- opened -- cheap aggregate rather than fetching a filtered page just to
-- read its length.
create or replace function public.org_closed_application_count(p_posting uuid)
returns int language sql stable security definer set search_path = public as $$
  select case when not public.org_admin() then 0 else coalesce(
    (select count(*)::int from public.applications
      where posting_id = p_posting
        and state in ('hired', 'not_selected', 'withdrawn')), 0) end;
$$;

commit;

begin;

revoke all on function public.org_applications(uuid,timestamptz,int,text[]) from public, anon;
grant execute on function public.org_applications(uuid,timestamptz,int,text[]) to authenticated;

revoke all on function public.org_closed_application_count(uuid) from public, anon;
grant execute on function public.org_closed_application_count(uuid) to authenticated;

commit;
