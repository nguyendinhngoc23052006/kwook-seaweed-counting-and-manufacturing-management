-- The owner's ask: "make the log be able to be read by everyone so people
-- know who demoted or promoted who, or at least people of higher power can
-- view those that has power below them but above others so that there
-- can't be abused."
--
-- 20260920000000's org_audit_select policy (its own comment, just above it)
-- anticipates exactly this: "a 'show me this node's audit trail' screen must
-- come through a definer RPC that returns safe columns, not by widening
-- this." 'configure_child_capabilities' already means "can change this
-- node's children's capabilities" -- org_capability_reaches(key, node) with
-- its default p_strict = false also reaches the granting node itself (see
-- org_nodes_reached_with, 20260920000000 section 7), so a holder at node N
-- sees N's own grant history plus every descendant's -- exactly the
-- hierarchy-scoped visibility the owner described, with no new capability
-- type needed.
--
-- DEVIATION FROM THE LITERAL BRIEF -- verified against 20260920000000
-- before writing this: capability grants/revokes are NOT in org_audit.
-- node_capabilities has no org_write_audit trigger (contrast persons,
-- person_bank_details, positions, position_holders, org_nodes, which all
-- do -- section 8.9/8.10 there) and the file says why, right where the
-- other triggers are wired up: "node_capabilities is its own audit trail --
-- it is append-only and carries actor and reason -- so it needs no second
-- copy." A query against org_audit for entity_type = 'node_capabilities'
-- would compile and always return zero rows -- a silently-dead feature, not
-- a working one. This RPC instead reads node_capabilities directly (its
-- real columns: node_id, capability_key, granted, effective_from, reason,
-- created_by) and reshapes each row into the same safe envelope org_audit's
-- comment describes (at / actor_person_id / action / before_json /
-- after_json), so a future audit-trail screen can treat every entity
-- uniformly. before_json is always null here: node_capabilities is
-- append-only, one row per event, so there is no prior-state row to show --
-- unlike org_audit's update/delete rows, which do have one.
--
-- actor_person_id is derived at read time via persons.account_id, the same
-- join org_current_person_id() uses for the caller's own id -- never
-- created_by (a raw auth.users id) itself, same posture org_audit_select's
-- comment already states for actor_account_id.

create or replace function public.org_capability_history(p_node uuid, p_key text default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_agg(
              jsonb_build_object(
                'at', nc.effective_from,
                'actor_person_id', p.id,
                'action', case when nc.granted then 'grant' else 'revoke' end,
                'before_json', null::jsonb,
                'after_json', jsonb_build_object(
                  'capability_key', nc.capability_key,
                  'granted', nc.granted,
                  'reason', nc.reason))
              order by nc.effective_from desc, nc.id desc)
       from public.node_capabilities nc
       left join public.persons p on p.account_id = nc.created_by
      where (public.org_admin()
             or public.org_capability_reaches('configure_child_capabilities', p_node))
        and nc.node_id = p_node
        and (p_key is null or nc.capability_key = p_key)),
    '[]'::jsonb);
$$;

revoke all on function public.org_capability_history(uuid, text) from public, anon;
grant execute on function public.org_capability_history(uuid, text) to authenticated;
