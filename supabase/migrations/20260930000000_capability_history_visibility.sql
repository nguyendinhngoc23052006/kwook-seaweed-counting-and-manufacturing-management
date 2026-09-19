begin;

-- The capability log rendered nothing for everyone except an admin.
--
-- node_capabilities_select admits anyone the model knows -- org_foundation's
-- 10.7 says so in as many words: "capability grants are deliberately
-- transparent to everyone the model knows: 'why can this person do that?'
-- should be answerable by the person it is about, and a ledger only the
-- powerful can read is not a check on the powerful."
--
-- org_capability_history() then demanded org_admin() or a
-- configure_child_capabilities reach over the node. So an ordinary seated
-- person could read the grant ROWS (which is what the disclosure's own counter
-- counts, via listNodeGrants) and got an empty array from the history RPC that
-- reshapes those same rows. Reproduced on a full replay as a staff holder:
-- the button counted 1 and the panel showed 0, which reads as a broken log
-- rather than as a refusal -- exactly how it was reported.
--
-- The RPC adds no data of its own; it reads node_capabilities and rebuilds the
-- rows into org_audit's envelope. Gating the reshaping more tightly than the
-- table it reads from was the incoherence, so the gate now matches the policy.
-- Nothing is widened: a caller who cannot read the rows still gets [].
create or replace function public.org_capability_history(p_node uuid, p_key text default null)
returns jsonb
language sql stable security definer set search_path = public as $fn$
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
      where (public.org_current_person_id() is not null or public.org_is_sysadmin())
        and nc.node_id = p_node
        and (p_key is null or nc.capability_key = p_key)),
    '[]'::jsonb);
$fn$;
revoke all on function public.org_capability_history(uuid, text) from public, anon;
grant execute on function public.org_capability_history(uuid, text) to authenticated;

commit;
