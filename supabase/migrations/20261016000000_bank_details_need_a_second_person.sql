-- Anyone can rewrite their own payroll destination.
--
-- org_bank_person_ids() (20260920000000:703) is a READ helper: it returns the
-- people whose bank details you may SEE, and it appends your own person id
-- unconditionally, because your own payroll row is obviously yours to read.
--
-- person_bank_insert and person_bank_update (20260920000000:1672-1686) reuse
-- that same helper. So the self-append, written to make a row readable, also
-- makes it writable -- and `grant select, insert, update on
-- public.person_bank_details to authenticated` (:1765) is table-level with no
-- column list, so account_number is included.
--
-- Demonstrated on a replay, as Erin, a Cong nhan on a production line holding
-- no capability anywhere:
--
--   org_nodes_reached_with('maintain_bank_details') -> 0 nodes
--   org_bank_person_ids()                           -> {her own person id}
--   update person_bank_details set account_number='MULE-7777' where person_id=hers
--     -> UPDATE 1
--
-- Her attempt on someone else's row touched 0 rows and could not even read it
-- back, so the boundary really is exactly self. That is the whole problem: a
-- payroll destination can be changed by one party, with no approval, no
-- notification, and no second person involved.
--
-- This repo has already diagnosed this exact pattern once, on a less sensitive
-- table. 20260928000000_person_record_authority.sql:50-52 says of the sibling
-- helper: "org_maintainable_person_ids() cannot be used to tell self from
-- subordinate: it appends your own id on purpose, which is exactly what let
-- the self-branch through." It added org_maintains_other() -- the same reach
-- computed WITHOUT the self-append -- and used it to keep your employment
-- record your manager's. The higher-value table never got the same treatment.
--
-- Nothing in the application changes. PersonPage.tsx:98 and :183 already gate
-- the bank editor on capabilityReaches(myReach, 'maintain_bank_details',
-- nodeId), so the UI has never offered self-edit; this makes the database
-- agree with the screen instead of being quietly looser than it.
--
-- Deliberate consequence: someone who holds maintain_bank_details can no
-- longer write their OWN row either. That is the same rule 20260928000000
-- applied to employment records, and on a payroll destination a two-party
-- requirement is the point rather than a side effect. Reading your own row is
-- untouched -- person_bank_select still uses the self-appending helper.
--
-- Not fixed here, and worth knowing: org_audit_select admits a row to the
-- sysadmin, to the actor, or to the subject. When someone rewrites their own
-- details the actor and the subject are the same person, so the audit row is
-- readable by that person and the sysadmin and nobody else -- not their
-- manager, not the CEO. The audit trail alone was never going to catch this.

begin;

-- The reach WITHOUT the self-append, named and shaped after org_maintains_other().
create or replace function public.org_bank_maintains_other(p_person_id uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select coalesce(
    p_person_id is not null
    and p_person_id <> public.org_current_person_id()
    and p_person_id = any (public.org_persons_seated_in(
          public.org_nodes_reached_with('maintain_bank_details'))),
    false);
$fn$;
revoke all on function public.org_bank_maintains_other(uuid) from public, anon;
grant execute on function public.org_bank_maintains_other(uuid) to authenticated;

-- Writes now require a second person. Reads are unchanged.
drop policy if exists person_bank_insert on public.person_bank_details;
create policy person_bank_insert on public.person_bank_details for insert
  with check (
    (select public.org_is_sysadmin())
    or (select public.org_bank_maintains_other(person_bank_details.person_id)));

drop policy if exists person_bank_update on public.person_bank_details;
create policy person_bank_update on public.person_bank_details for update
  using (
    (select public.org_is_sysadmin())
    or (select public.org_bank_maintains_other(person_bank_details.person_id)))
  with check (
    (select public.org_is_sysadmin())
    or (select public.org_bank_maintains_other(person_bank_details.person_id)));

commit;
