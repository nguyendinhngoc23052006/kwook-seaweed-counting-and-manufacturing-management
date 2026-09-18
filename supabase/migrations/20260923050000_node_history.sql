-- 8.11 Node history -- org_audit's SELECT policy scopes every row to its own
-- actor_account_id (section 6), which cannot answer "show me this node's
-- history"; this definer RPC reads org_audit directly, filtered to one
-- node's own rows, under the same create_child_node reach that already
-- gates rename/renature/deactivate on that node (8.8's own comment).
create or replace function public.org_node_history(p_node uuid)
returns table (at timestamptz, actor_person_id uuid, action text, before_json jsonb, after_json jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.org_admin() or public.org_capability_reaches('create_child_node', p_node)) then
    return;
  end if;
  return query
    select a.at, a.actor_person_id, a.action, a.before_json, a.after_json
      from public.org_audit a
     where a.entity_type = 'org_nodes'
       and a.entity_id = p_node::text
     order by a.at desc;
end;
$$;

revoke all on function public.org_node_history(uuid) from public, anon;
grant execute on function public.org_node_history(uuid) to authenticated;

-- The `depth < 64` bound in the six walks below is insurance against a
-- hypothetical direct-SQL cycle, never a real limit: org_guard_nodes already
-- refuses any write that would create one, before it could ever be stored.
-- Raised to 100000 for organizations with far more than 64 nested levels.

create or replace function public.org_subtree_ids(p_nodes uuid[])
returns uuid[] language sql stable security definer set search_path = public as $$
  with recursive d as (
    select n.id, 1 as depth from public.org_nodes n where n.id = any(p_nodes)
    union all
    select c.id, d.depth + 1
      from public.org_nodes c join d on c.parent_id = d.id
     where d.depth < 100000
  )
  select coalesce(array_agg(distinct id), '{}'::uuid[]) from d;
$$;

create or replace function public.org_ancestor_ids(p_node uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  with recursive u as (
    select n.id, n.parent_id, 1 as depth from public.org_nodes n where n.id = p_node
    union all
    select p.id, p.parent_id, u.depth + 1
      from public.org_nodes p join u on u.parent_id = p.id
     where u.depth < 100000
  )
  select coalesce(array_agg(distinct id), '{}'::uuid[]) from u;
$$;

create or replace function public.org_node_distance(p_ancestor uuid, p_node uuid)
returns integer language sql stable security definer set search_path = public as $$
  with recursive u as (
    select n.id, n.parent_id, 0 as depth from public.org_nodes n where n.id = p_node
    union all
    select p.id, p.parent_id, u.depth + 1
      from public.org_nodes p join u on u.parent_id = p.id
     where u.depth < 100000
  )
  select depth from u where id = p_ancestor limit 1;
$$;

create or replace function public.org_node_nature(p_node uuid)
returns text language sql stable security definer set search_path = public as $$
  with recursive u as (
    select n.id, n.parent_id, n.nature_key, 1 as depth
      from public.org_nodes n where n.id = p_node
    union all
    select p.id, p.parent_id, p.nature_key, u.depth + 1
      from public.org_nodes p join u on u.parent_id = p.id
     where u.depth < 100000
  )
  select nature_key from u where nature_key is not null order by depth limit 1;
$$;

create or replace function public.org_position_chain(p_position uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  with recursive up as (
    select p.id, p.reports_to_position_id, 1 as depth
      from public.positions p where p.id = p_position
    union all
    select m.id, m.reports_to_position_id, up.depth + 1
      from public.positions m join up on up.reports_to_position_id = m.id
     where up.depth < 100000
  )
  select coalesce(array_agg(distinct id), '{}'::uuid[]) from up;
$$;

create or replace function public.org_tree()
returns jsonb language sql stable security definer set search_path = public as $$
  with recursive
  -- Resolve the current holder for EVERY seat in one pass. The previous shape
  -- asked per position, as a correlated `= any (select ... limit 1)`, which the
  -- planner cannot turn into an index lookup: it became a nested loop over
  -- positions x persons evaluated as a join filter. Measured at 28s on 900
  -- nodes and 5,200 people -- 3.5x Supabase's 8s statement timeout, i.e. the
  -- screen simply never loads. This is the same anti-pattern section 7.4
  -- already re-engineered org_positions_held_by() to avoid; org_tree() had
  -- quietly reintroduced it.
  holder as (
    select distinct on (h.position_id)
           h.position_id, h.person_id
      from public.position_holders h
     where h.effective_from <= now()
     order by h.position_id, h.effective_from desc, h.id desc
  ),
  -- Same argument for capabilities: org_node_has_capability() per node per
  -- capability type was 12 function calls x every node.
  cap as (
    select distinct on (c.node_id, c.capability_key)
           c.node_id, c.capability_key, c.granted
      from public.node_capabilities c
     where c.effective_from <= now()
     order by c.node_id, c.capability_key, c.effective_from desc, c.id desc
  ),
  -- And the inherited nature: one recursive walk for the whole tree instead of
  -- org_node_nature() once per node, each starting its own recursion.
  climb as (
    select n.id as node_id, n.parent_id, n.nature_key, 1 as depth
      from public.org_nodes n
    union all
    select c.node_id, p.parent_id, p.nature_key, c.depth + 1
      from climb c
      join public.org_nodes p on p.id = c.parent_id
     where c.nature_key is null and c.depth < 100000
  ),
  nature as (
    select node_id,
           (array_agg(nature_key order by depth)
              filter (where nature_key is not null))[1] as nature
      from climb group by node_id
  ),
  seats as (
    select p.node_id,
           jsonb_agg(jsonb_build_object(
             'position_id', p.id,
             'title', p.title,
             'rank_key', r.key,
             'rank_ordinal', r.ordinal,
             'reports_to', p.reports_to_position_id,
             'person_id', pe.id,
             'person_name', pe.full_name,
             'employee_code', pe.employee_code)
             order by r.ordinal, p.title) as seats
      from public.positions p
      join public.ranks r on r.id = p.rank_id
      left join holder h on h.position_id = p.id
      left join public.persons pe on pe.id = h.person_id
     where p.abolished_at is null
     group by p.node_id
  ),
  caps as (
    select node_id, jsonb_agg(capability_key order by capability_key) as keys
      from cap where granted group by node_id
  )
  select case when public.org_current_person_id() is null and not public.org_is_sysadmin()
    then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id,
               'parent_id', n.parent_id,
               'name', n.name,
               'name_en', n.name_en,
               'active', n.active,
               'nature', na.nature,
               'nature_set_here', n.nature_key,
               'capabilities', coalesce(cp.keys, '[]'::jsonb),
               'seats', coalesce(s.seats, '[]'::jsonb))
             order by n.sort_order, n.name)
        from public.org_nodes n
        left join nature na on na.node_id = n.id
        left join caps   cp on cp.node_id = n.id
        left join seats  s  on s.node_id  = n.id), '[]'::jsonb)
  end;
$$;
