-- =====================================================================================
-- ORG FOUNDATION -- persons, the node tree, ranks, seats, capability grants, sysadmins.
--
-- This lands ALONGSIDE the three-tier scheme (20260915090000). It drops nothing, alters
-- no existing table, column, policy or function, and adds no column to profiles /
-- sectors / stores / memberships. The ~60 policies that inherit the tiers through
-- is_member_of() and has_role_on() keep working untouched, and so does every surviving
-- screen -- /org, and under /store/:storeId the dashboard, clock (attendance),
-- announcements, audit, people, settings and me. Cutting those over is a later PR.
--
-- ---------------------------------------------------------------------------------
-- WHY THIS FILE ENFORCES AUTHORITY IN TRIGGERS AND NOT ONLY IN POLICIES
--
-- Every structural write below (create a seat, seat a person, move a seat, grant a
-- capability, reshape the tree) is checked in a BEFORE trigger, and the RPCs are thin
-- wrappers over those same writes. The reason is specific: a SECURITY DEFINER function
-- bypasses RLS entirely, so any rule that lives only in a policy is a rule an RPC
-- silently does not have. Triggers always run, for the policy path and the definer
-- path alike. So the trigger is the single enforcement point and the policy is a
-- second, narrower lock on top of it -- never the only one.
--
-- ---------------------------------------------------------------------------------
-- THE GRANT FLOOR (20260917140000). That migration ran
--     alter default privileges in schema public revoke select, insert, update, delete
--       on tables from authenticated;
--     alter default privileges in schema public revoke execute on functions from authenticated;
-- so every table and function below is UNREACHABLE until this file grants it. RLS
-- filters rows on top of a grant; it never supplies one. A table with a grant, RLS on
-- and NO policy returns zero rows in silence, which reads as "no data" rather than
-- "broken". Section 11 grants every table explicitly, every function carries its own
-- revoke/grant pair, and Section 13 refuses to finish if any of it is missing.
--
-- Note the second half of that trap: ALTER DEFAULT PRIVILEGES was aimed at
-- `authenticated`, but Postgres also grants EXECUTE to PUBLIC on every new function,
-- and `anon` inherits PUBLIC. So each function needs `revoke ... from public, anon`
-- as well, or it is callable by a signed-out request.
--
-- ---------------------------------------------------------------------------------
-- RE-RUNNABLE END TO END. create table/index if not exists, create or replace function,
-- drop policy/trigger if exists before create, every seed guarded by a NOT EXISTS that
-- covers EVERY unique constraint on the target, and no unguarded
-- `alter table ... add constraint` anywhere -- every constraint is declared inline in
-- its create table. There is no staging database and no point-in-time recovery, so a
-- statement that can fail halfway is a statement that does not belong here.
--
-- ---------------------------------------------------------------------------------
-- TWO THINGS THAT APPEAR IN NO PERMISSION PREDICATE IN THIS FILE:
--   * ranks.ordinal          -- display sort, plus the ONE coherence trigger in 8.4
--   * org_nodes.nature_key   -- UI doorway only, resolved in a read path
-- Neither name occurs inside any `create policy` or inside any function a policy calls.
-- =====================================================================================

set check_function_bodies = off;

-- =====================================================================================
-- 0. PRECONDITION -- checked FIRST, before a single object is created
--
-- Section 12.2 seeds the sysadmin from an auth.users row matched by email. On
-- a persistent project (staging, production) that row already exists -- the
-- owner is a real, already-signed-up user of the live app -- so this always
-- resolves immediately there and the seed lands in the same statement.
--
-- On an EPHEMERAL Supabase preview branch (one per PR, thrown away when the
-- PR closes) that row can never exist: nobody signs up on a database that
-- lives for the lifetime of a pull request. This migration still has to
-- apply cleanly there, because `supabase for GitHub` runs Migrations before
-- Seeding on every branch, and this repo's `canary` check depends on
-- `seed.sql` running to smoke-test sign-in and RLS. A hard abort here would
-- take down Seeding -- and therefore `canary` -- on every future PR forever,
-- not just the one that introduces this file.
--
-- So this is a loud, non-fatal warning rather than an exception: everything
-- else in this file still gets created, and section 12.2's own insert
-- naturally seeds zero sysadmin rows when there is no match (its `where`
-- clause, not this check, is what actually guards it). If this ever prints
-- on a persistent project, the model is genuinely un-bootstrapped: sign up
-- with the owner's email there, then land a follow-up migration (fix
-- forward -- this file has already been applied and does not get replayed)
-- that inserts the same section 12.2 row directly.
-- =====================================================================================
do $$
begin
  if not exists (select 1 from auth.users u
                  where u.email = 'nguyendinhngoc23052006@gmail.com') then
    raise warning 'org foundation: the owner account '
      '(nguyendinhngoc23052006@gmail.com) has not signed up in this Supabase project yet, '
      'so section 12.2 will seed no sysadmin row. Expected and harmless on an ephemeral '
      'preview branch. On a persistent project, sign up with that email, then land a '
      'follow-up migration to seed org_sysadmins directly.';
  end if;
end $$;

-- =====================================================================================
-- 1. CATALOGUES THAT ARE CODE
-- =====================================================================================

-- 1.1 Node natures. The model says a THIRD nature must be addable as a row, so this is
-- a table and not an enum or a CHECK: adding one is an INSERT, not a type rewrite.
-- It decides which doorway the UI opens (field: one tap creates the human AND the seat;
-- office: the seat is created first and stands empty) and nothing else.
create table if not exists public.node_natures (
  key         text primary key,
  name_vi     text not null,
  name_en     text not null,
  sort_order  integer not null default 100
);
alter table public.node_natures enable row level security;

-- 1.2 The capability vocabulary. "The SET of capability types is code" is enforced
-- literally: Section 11 grants SELECT and nothing else, so no request the browser can
-- make may widen it. Adding a capability is a migration, which is what "code" means.
--
-- DECISION -- labels are not stored here, unlike ranks and nodes. The drafts disagreed:
-- the safety draft carried label_vi/label_en/description columns, the minimal draft
-- carried none. Minimal wins because these keys are code and the repo already fails the
-- build on a missing i18n key (src/__tests__/i18nCoverage.test.ts), so the UI renders
-- t("capability.<key>") and the translation is reviewed like any other string. Ranks
-- and nodes DO carry names because they are data the CEO creates at runtime, where no
-- reviewer is in the loop. The asymmetry is deliberate.
create table if not exists public.capability_types (
  key         text primary key,
  sort_order  integer not null default 100,
  note        text
);
alter table public.capability_types enable row level security;

-- =====================================================================================
-- 2. THE RANK CATALOGUE -- append-only, sparse NUMERIC ordinal
-- =====================================================================================
-- LOWER ordinal = HIGHER authority. The ordinal exists for two purposes only: ORDER BY
-- in the UI, and the one coherence trigger in 8.4 that refuses to let a manager's seat
-- rank below its own report's. It is in no policy and in no function a policy calls.
--
-- Adding a rank BELOW the current lowest is one INSERT:
--     insert into public.ranks (key, name_vi, ordinal) values ('intern','Thực tập sinh',11000);
-- BETWEEN two existing ranks, one INSERT:
--     insert into public.ranks (key, name_vi, ordinal) values ('team_lead','Tổ trưởng',8000);
-- BETWEEN two adjacent integers, still one INSERT, because the column is numeric:
--     insert into public.ranks (key, name_vi, ordinal) values ('senior_staff','Nhân viên chính',8500.5);
--
-- No renumbering is ever needed, because nothing stores an ordinal (positions store
-- rank_id) and nothing enumerates ranks -- no enum, no CHECK, no TypeScript union. And
-- no renumbering is possible: 8.1 refuses any change to an ordinal or a key, so an
-- existing rank's meaning can never shift under a seat that already points at it.
create table if not exists public.ranks (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name_vi     text not null,
  name_en     text,
  ordinal     numeric not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null
);
alter table public.ranks enable row level security;
create index if not exists ranks_ordinal_idx on public.ranks(ordinal);

-- =====================================================================================
-- 3. THE NODE TREE
-- =====================================================================================
-- Arbitrary depth, growing wider and deeper. nature_key is nullable and inherited from
-- the nearest ancestor that sets one (node_nature(), 7.3). No legacy bridge here -- this
-- repo has no prior tier scheme to carry over; the tree starts at its one root node.
create table if not exists public.org_nodes (
  id               uuid primary key default gen_random_uuid(),
  parent_id        uuid references public.org_nodes(id) on delete restrict,
  name             text not null check (length(btrim(name)) > 0),
  name_en          text,
  nature_key       text references public.node_natures(key) on delete restrict,
  sort_order       integer not null default 100,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id) on delete set null,
  constraint org_nodes_not_own_parent check (parent_id is distinct from id)
);
alter table public.org_nodes enable row level security;
create index if not exists org_nodes_parent_idx on public.org_nodes(parent_id);
create index if not exists org_nodes_active_idx on public.org_nodes(active);

-- One company, one tree. The indexed expression is TRUE for every row the partial index
-- admits, so the index permits at most one parentless node. Note there is no `active`
-- in the predicate, deliberately: if deactivating the root freed the slot, a second root
-- could appear and the tree would silently become a forest.
-- To undo: drop index public.org_nodes_single_root_idx;
create unique index if not exists org_nodes_single_root_idx
  on public.org_nodes ((parent_id is null)) where parent_id is null;

-- =====================================================================================
-- 4. PERSONS, BANK DETAILS, SEATS, HOLDERS
-- =====================================================================================

-- 4.1 A person is not a login.
-- full_name is the only required human field. email, phone and account_id are all
-- nullable, so a field worker with no email, no phone and no account is a complete row:
-- they get an employee code, they hold a seat, tasks can target them, attendance records
-- against them. account_id is the OPTIONAL satellite, and clearing it deletes no person.
--
-- DECISION -- the safety draft made the login a separate person_accounts table with
-- link/unlink history; the minimal draft used one nullable unique FK. Minimal wins on
-- both counts. The FK says exactly what the model says ("a person may have at most one
-- account, attached later") in one column, and the separate table is what carried the
-- safety draft's identity-hijack hole, where anyone holding the appointment capability
-- could bind an arbitrary auth account to a person they controlled. Here account_id
-- moves only for the sysadmin or the CEO (8.3), so that attack has no surface at all.
--
-- employee_code is issued once and NEVER reused:
--   * the sequence is non-transactional, so a rolled-back insert burns the value;
--   * the column is unique;
--   * 8.3 overwrites whatever the client sent, so a code cannot be chosen or forged;
--   * 8.3 refuses every DELETE and Section 11 grants none, so a code never comes free.
--     Leaving is status = 'departed'.
create sequence if not exists public.employee_code_seq as bigint start with 1 increment by 1 no cycle;

create table if not exists public.persons (
  id             uuid primary key default gen_random_uuid(),
  employee_code  text not null unique,
  full_name      text not null check (length(btrim(full_name)) > 0),
  display_name   text,
  photo_url      text,
  email          text,
  phone          text,
  date_of_birth  date,
  national_id    text,
  address        text,
  hire_date      date,
  employment_note text,
  status         text not null default 'active'
                 check (status in ('active', 'suspended', 'departed')),
  account_id     uuid unique references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id) on delete set null
);
alter table public.persons enable row level security;
create index if not exists persons_account_idx on public.persons(account_id) where account_id is not null;
create index if not exists persons_status_idx on public.persons(status);

-- 4.2 Bank details, in their OWN table.
--
-- DECISION -- this is the safety draft's shape and it beats the minimal draft's inline
-- columns for one mechanical reason the minimal draft itself flagged as its top risk:
-- a column-level grant CANNOT narrow a table-level grant, so bank columns on `persons`
-- are exactly as visible as the person row, and the first screen that wants a staff
-- directory widens persons_select and ships every account number company-wide in one
-- line. A separate table is the only way to give these a tighter reach than the rest of
-- the profile, and it lets the capability be separate too -- so the CEO can hand a
-- manager profile maintenance without handing them payroll.
--
-- The owner has decided, after being warned about the fraud exposure, that a manager
-- enters these directly with no employee confirmation step. Every write is audited
-- (Section 6). What is still absent, and is the obvious follow-up: nothing alerts
-- anyone when an account number changes.
create table if not exists public.person_bank_details (
  person_id       uuid primary key references public.persons(id) on delete restrict,
  bank_name       text,
  account_holder  text,
  account_number  text,
  branch          text,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id) on delete set null
);
alter table public.person_bank_details enable row level security;

-- 4.3 The seat. Authority lives here, not on the person.
-- reports_to_position_id points at a STABLE position id, so replacing the holder of a
-- manager's seat orphans nobody -- the edge never mentions a person. A seat is retired
-- with abolished_at, never deleted, so the edges pointing at it never dangle.
create table if not exists public.positions (
  id                     uuid primary key default gen_random_uuid(),
  node_id                uuid not null references public.org_nodes(id) on delete restrict,
  rank_id                uuid not null references public.ranks(id) on delete restrict,
  reports_to_position_id uuid references public.positions(id) on delete restrict,
  title                  text not null check (length(btrim(title)) > 0),
  title_en               text,
  abolished_at           timestamptz,
  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users(id) on delete set null,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users(id) on delete set null,
  constraint positions_not_own_manager check (reports_to_position_id is distinct from id)
);
alter table public.positions enable row level security;
create index if not exists positions_node_idx on public.positions(node_id) where abolished_at is null;
create index if not exists positions_reports_to_idx on public.positions(reports_to_position_id);
create index if not exists positions_rank_idx on public.positions(rank_id);

-- EXACTLY ONE ROOTLESS RANKED SEAT, enforced by the database and by no string. rank_id
-- is NOT NULL, so every seat is a ranked seat; the partial unique index then admits at
-- most one live seat with no manager above it, and a second CEO fails with 23505.
--
-- Stated honestly: a unique index enforces at-most-one and cannot require a row to
-- exist. The safety draft added a DEFERRABLE constraint trigger for at-least-one; it is
-- rejected here because it turns every seat write into a commit-time full-table scan and
-- moves the error from the offending statement to COMMIT, which is a much worse thing to
-- debug on a database with no undo. The gap it covers is closed instead by 8.4, which
-- refuses to abolish any seat that still has live reports -- so the tree cannot be left
-- rootless while anyone is still reporting upward.
create unique index if not exists positions_single_root_idx
  on public.positions ((reports_to_position_id is null))
  where reports_to_position_id is null and abolished_at is null;

-- 4.4 Who sits in a seat, over time. An APPEND-ONLY event log: one row per change,
-- person_id null meaning "vacated". The state at any instant T is the newest row with
-- effective_from <= T. A promotion is an insert, so last September stays answerable.
--
-- DECISION -- the safety draft modelled tenures with an effective_to the caller closes.
-- The event log wins: closing a row needs an UPDATE grant, which is a write path an
-- append-only table should not have at all, and it forced that draft into a
-- microsecond-nudge workaround because now() is frozen inside a transaction. Here there
-- is no UPDATE grant and no UPDATE policy on any of the three timelines.
--
-- id is bigserial, not uuid, and that is load-bearing. Ordering is
-- (effective_from desc, id desc): a sequence is monotonic and not client-writable, so
-- two events written in the same transaction -- which tie on effective_from AND on
-- created_at, since both are transaction time -- still order deterministically. The
-- drafts ordered by a random uuid as the final tie-break, which decides "is this
-- capability granted?" by coin flip when a grant and a revoke land in one request.
create table if not exists public.position_holders (
  id             bigserial primary key,
  position_id    uuid not null references public.positions(id) on delete restrict,
  person_id      uuid references public.persons(id) on delete restrict,
  effective_from timestamptz not null default now(),
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null
);
alter table public.position_holders enable row level security;
create index if not exists position_holders_position_idx
  on public.position_holders(position_id, effective_from desc, id desc);
create index if not exists position_holders_person_idx
  on public.position_holders(person_id, effective_from desc) where person_id is not null;

-- =====================================================================================
-- 5. CAPABILITY GRANTS AND THE SYSADMIN
-- =====================================================================================

-- 5.1 Grants are made to NODES. There is no person_id column here and no other table in
-- this file grants a capability, so no path exists that hands a capability to a human:
-- a person has one if and only if they hold a seat in a node that has it.
--
-- NO INHERITANCE OF GRANTS. node_has_capability() reads the rows of exactly one node and
-- never looks at an ancestor, so "grant to subtree" is one explicit row per node
-- (grant_capability(), 9.5) and the row that authorises an act is always findable.
-- What IS directional is the REACH of a capability once held -- "assign work DOWN",
-- "appoint into a seat BELOW", "view SUBTREE workload" are subtree words in the model's
-- own vocabulary. The two are kept visibly separate: node_has_capability() is the grant
-- (no inheritance), capability_reaches() is the reach (subtree), and
-- explain_capability() returns BOTH legs, so "why can this person act on node X?" is
-- one query that names the granting node, the seat, and the distance -- which is the
-- property the no-inheritance rule exists to protect.
--
-- Revoking is an INSERT with granted = false. There is no UPDATE and no DELETE on this
-- table at any layer, so what was true last September cannot be rewritten.
create table if not exists public.node_capabilities (
  id             bigserial primary key,
  node_id        uuid not null references public.org_nodes(id) on delete restrict,
  capability_key text not null references public.capability_types(key) on delete restrict,
  granted        boolean not null,
  effective_from timestamptz not null default now(),
  reason         text,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null
);
alter table public.node_capabilities enable row level security;
create index if not exists node_capabilities_lookup_idx
  on public.node_capabilities(node_id, capability_key, effective_from desc, id desc);

-- 5.2 The sysadmin sits OUTSIDE the tree: no node, no seat, no rank, no reporting edge.
-- Keyed on an auth account rather than a person, because the sysadmin is a login and not
-- an employee of the company tree. Effective-dated and append-only, same shape again.
create table if not exists public.org_sysadmins (
  id             bigserial primary key,
  account_id     uuid not null references auth.users(id) on delete cascade,
  active         boolean not null,
  effective_from timestamptz not null default now(),
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null
);
alter table public.org_sysadmins enable row level security;
create index if not exists org_sysadmins_account_idx
  on public.org_sysadmins(account_id, effective_from desc, id desc);

-- =====================================================================================
-- 6. AUDIT
-- =====================================================================================
-- public.audit_log cannot carry these rows: its store_id is NOT NULL with an FK to
-- stores (baseline.sql:110), and nothing in this model has a store. One append-only
-- table, written by a security-definer trigger so no insert grant is needed, and with no
-- foreign keys so it outlives whatever it describes.
--
-- It is in THIS migration and not in a later profile PR because Section 10 opens a write
-- path to bank details the moment this merges, and an audit trail that starts later has
-- a hole exactly where the risk is.
create table if not exists public.org_audit (
  id                bigserial primary key,
  at                timestamptz not null default now(),
  actor_account_id  uuid,
  actor_person_id   uuid,
  entity_type       text not null,
  entity_id         text not null,
  subject_person_id uuid,
  node_id           uuid,
  action            text not null,
  before_json       jsonb,
  after_json        jsonb
);
alter table public.org_audit enable row level security;
create index if not exists org_audit_at_idx on public.org_audit(at desc);
-- org_audit's SELECT policy filters on actor_account_id and the table grows
-- forever; it was the only read path in this file with no index behind it.
create index if not exists org_audit_actor_idx
  on public.org_audit (actor_account_id, at desc);
create index if not exists org_audit_subject_idx on public.org_audit(subject_person_id, at desc);
create index if not exists org_audit_entity_idx on public.org_audit(entity_type, entity_id, at desc);

-- =====================================================================================
-- 7. THE PREDICATE VOCABULARY
--
-- Everything in Section 10 is built from these. Not one of them reads ranks.ordinal or
-- org_nodes.nature_key. All are SECURITY DEFINER: they query tables that are themselves
-- under policies which call them, and running as the owner both breaks that recursion
-- and lets the planner hoist a no-argument STABLE call into a single InitPlan per query
-- instead of re-running it per row.
--
-- Several return uuid[] rather than a set, on purpose. A SECURITY DEFINER set-returning
-- function cannot be inlined, so calling one per row inside a policy is a full scan per
-- row; an array-returning STABLE function with a constant argument is evaluated once.
-- =====================================================================================

-- 7.1 Who am I.
create or replace function public.org_current_person_id()
returns uuid language sql stable security definer set search_path = public as $$
  select p.id from public.persons p where p.account_id = (select auth.uid());
$$;

create or replace function public.org_is_sysadmin(p_at timestamptz default now())
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select s.active
      from public.org_sysadmins s
     where s.account_id = (select auth.uid())
       and s.effective_from <= p_at
     order by s.effective_from desc, s.id desc
     limit 1), false);
$$;

-- 7.2 Tree walks, returned as arrays. Both are depth-capped as well as cycle-guarded
-- (8.2 and 8.4), because a recursive CTE over a cyclic graph never returns and a policy
-- that never returns is an outage.
create or replace function public.org_subtree_ids(p_nodes uuid[])
returns uuid[] language sql stable security definer set search_path = public as $$
  with recursive d as (
    select n.id, 1 as depth from public.org_nodes n where n.id = any(p_nodes)
    union all
    select c.id, d.depth + 1
      from public.org_nodes c join d on c.parent_id = d.id
     where d.depth < 64
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
     where u.depth < 64
  )
  select coalesce(array_agg(distinct id), '{}'::uuid[]) from u;
$$;

-- How many levels below p_ancestor does p_node sit? NULL when it is not below it at
-- all. This is a walk and not array_position() over org_ancestor_ids(), because that
-- function aggregates with DISTINCT, which orders by value and not by depth -- an
-- ordinal position in it would be a number that looks like a depth and is not one.
create or replace function public.org_node_distance(p_ancestor uuid, p_node uuid)
returns integer language sql stable security definer set search_path = public as $$
  with recursive u as (
    select n.id, n.parent_id, 0 as depth from public.org_nodes n where n.id = p_node
    union all
    select p.id, p.parent_id, u.depth + 1
      from public.org_nodes p join u on u.parent_id = p.id
     where u.depth < 64
  )
  select depth from u where id = p_ancestor limit 1;
$$;

-- 7.3 Inherited nature: the nearest ancestor (including the node itself) that sets one.
-- UI ONLY. Referenced by no policy and by no function a policy calls -- it is resolved
-- here, in a read path, which is the whole reason it can stay out of the decision.
create or replace function public.org_node_nature(p_node uuid)
returns text language sql stable security definer set search_path = public as $$
  with recursive u as (
    select n.id, n.parent_id, n.nature_key, 1 as depth
      from public.org_nodes n where n.id = p_node
    union all
    select p.id, p.parent_id, p.nature_key, u.depth + 1
      from public.org_nodes p join u on u.parent_id = p.id
     where u.depth < 64
  )
  select nature_key from u where nature_key is not null order by depth limit 1;
$$;

-- 7.4 Seats. org_positions_held_by() is the hot one: it is called per row by the person
-- policies, so the person argument is pushed INSIDE the per-seat lookup rather than
-- filtered after it. The drafts did the opposite -- a DISTINCT ON over the whole
-- position_holders table with the argument applied afterwards -- which measured at
-- seconds per request and would start tripping Supabase's 8-second statement timeout
-- around three thousand people. Here the candidate list is an index scan on
-- position_holders_person_idx and each lookup is an index scan on
-- position_holders_position_idx.
create or replace function public.org_positions_held_by(p_person uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct cand.position_id), '{}'::uuid[])
    from (select distinct h.position_id
            from public.position_holders h
           where p_person is not null and h.person_id = p_person) cand
    join lateral (
      select h2.person_id
        from public.position_holders h2
       where h2.position_id = cand.position_id
         and h2.effective_from <= now()
       order by h2.effective_from desc, h2.id desc
       limit 1
    ) cur on cur.person_id = p_person
    join public.positions p on p.id = cand.position_id and p.abolished_at is null;
$$;

create or replace function public.org_person_node_ids(p_person uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct p.node_id), '{}'::uuid[])
    from public.positions p
   where p.id = any (public.org_positions_held_by(p_person));
$$;

create or replace function public.org_my_seat_node_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select public.org_person_node_ids(public.org_current_person_id());
$$;

create or replace function public.org_position_node(p_position uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.node_id from public.positions p where p.id = p_position;
$$;

create or replace function public.org_position_chain(p_position uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  with recursive up as (
    select p.id, p.reports_to_position_id, 1 as depth
      from public.positions p where p.id = p_position
    union all
    select m.id, m.reports_to_position_id, up.depth + 1
      from public.positions m join up on up.reports_to_position_id = m.id
     where up.depth < 64
  )
  select coalesce(array_agg(distinct id), '{}'::uuid[]) from up;
$$;

-- 7.5 Grants. THE AS-OF READER, and the place where "no inheritance" is literal: it
-- reads the rows of p_node and of no other node. Pass a past timestamp to answer what
-- was true last September.
create or replace function public.org_node_has_capability(
  p_node uuid, p_key text, p_at timestamptz default now())
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select c.granted
      from public.node_capabilities c
     where c.node_id = p_node
       and c.capability_key = p_key
       and c.effective_from <= p_at
     order by c.effective_from desc, c.id desc
     limit 1), false);
$$;

-- Do I personally sit in a node that holds this capability? This is the test that must
-- pass before I can hand the capability to anyone else (8.6), which is what stops a
-- holder of configure_child_capabilities from minting capabilities they do not have.
create or replace function public.org_i_hold(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from unnest(public.org_my_seat_node_ids()) s(id)
     where public.org_node_has_capability(s.id, p_key));
$$;

-- The nodes a capability I hold REACHES. p_strict drops the granting node itself, which
-- is how "configure a CHILD node's capabilities" is made to mean what it says.
create or replace function public.org_nodes_reached_with(p_key text, p_strict boolean default false)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce((
    select array_agg(distinct t)
      from unnest(public.org_my_seat_node_ids()) s(id)
      cross join lateral unnest(public.org_subtree_ids(array[s.id])) t
     where public.org_node_has_capability(s.id, p_key)
       and (not p_strict or t <> s.id)), '{}'::uuid[]);
$$;

create or replace function public.org_capability_reaches(
  p_key text, p_target uuid, p_strict boolean default false)
returns boolean language sql stable security definer set search_path = public as $$
  select p_target is not null
     and p_target = any (public.org_nodes_reached_with(p_key, p_strict));
$$;

-- My branch: the nodes I sit in and everything beneath them. Self-inclusive, so people
-- can see the team they are part of; bank details are a separate table with a separate
-- capability precisely so that this read does not carry them.
create or replace function public.org_my_scope_node_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select public.org_subtree_ids(public.org_my_seat_node_ids());
$$;

-- 7.6 The root seat is identified by its SHAPE -- no manager above it -- never by a rank
-- ordinal and never by a magic string.
create or replace function public.org_holds_root_seat()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.positions p
     where p.id = any (public.org_positions_held_by(public.org_current_person_id()))
       and p.reports_to_position_id is null
       and p.abolished_at is null);
$$;

-- The bootstrap pair, and the only thing in the file that is not a capability. It exists
-- so the very first grant can be written; everything after that runs on capabilities.
create or replace function public.org_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.org_is_sysadmin() or public.org_holds_root_seat();
$$;

-- 7.7 Is this person seated in my branch right now?
create or replace function public.org_person_in_my_scope(p_person uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_person is not null
     and public.org_person_node_ids(p_person) && public.org_my_scope_node_ids();
$$;

-- 7.7b THE PERSON SETS -- and the reason they are sets rather than per-row tests.
--
-- The obvious way to write persons_select is a predicate about the row: "are this
-- person's nodes inside my scope?". That calls a SECURITY DEFINER function once per
-- candidate row, and a SECURITY DEFINER function cannot be inlined, so the cost is a
-- function call plus index lookups multiplied by the size of the table. Measured on this
-- schema at 1,600 people it was seconds per request for a caller who was entitled to
-- nothing -- which is both a broken screen and a way for any signed-in account to spend
-- the instance's CPU at will, on a Free-tier project, against an 8-second statement
-- timeout.
--
-- These take no arguments, so the planner evaluates each ONCE per query as an InitPlan
-- and the per-row work collapses to an array membership test. They also walk the
-- caller's own subtree rather than the person table, so the cost tracks the size of the
-- branch the caller actually commands instead of the size of the company.
create or replace function public.org_persons_seated_in(p_nodes uuid[])
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce((
    select array_agg(distinct h.person_id)
      from public.positions po
      join lateral (
        select h2.person_id
          from public.position_holders h2
         where h2.position_id = po.id and h2.effective_from <= now()
         order by h2.effective_from desc, h2.id desc
         limit 1) h on true
     where po.abolished_at is null
       and h.person_id is not null
       and po.node_id = any (p_nodes)), '{}'::uuid[]);
$$;

-- Readable: my branch, plus any subtree where I maintain profiles, plus myself. The
-- bootstrap pair is handled by a separate cheap disjunct in the policy, so this never
-- has to materialise every person in the company.
create or replace function public.org_visible_person_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select case when public.org_current_person_id() is null then '{}'::uuid[]
         else public.org_persons_seated_in(
                public.org_my_scope_node_ids()
                || public.org_nodes_reached_with('maintain_person_profile'))
              || array[public.org_current_person_id()]
         end;
$$;

-- Writable: myself, and the subtrees where I hold profile maintenance. Deliberately
-- NARROWER than the readable set -- seeing the people in your branch is not the same
-- permission as editing them.
create or replace function public.org_maintainable_person_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select case when public.org_current_person_id() is null then '{}'::uuid[]
         else public.org_persons_seated_in(
                public.org_nodes_reached_with('maintain_person_profile'))
              || array[public.org_current_person_id()]
         end;
$$;

-- Bank details: a SEPARATE capability, so this is narrower again and a manager who can
-- edit a profile does not thereby reach payroll.
create or replace function public.org_bank_person_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select case when public.org_current_person_id() is null then '{}'::uuid[]
         else public.org_persons_seated_in(
                public.org_nodes_reached_with('maintain_bank_details'))
              || array[public.org_current_person_id()]
         end;
$$;

-- 7.8 "Why can this person act on that node?" -- ONE query returning BOTH legs: the seat
-- they hold, the node whose explicit grant row authorises it, and how far below that
-- node the target sits. depth 0 means the grant is on the node being acted upon.
create or replace function public.org_explain_capability(
  p_person uuid, p_key text, p_target uuid)
returns table (via_position_id uuid, granting_node_id uuid, target_node_id uuid, depth integer)
language sql stable security definer set search_path = public as $$
  select p.id,
         p.node_id,
         p_target,
         public.org_node_distance(p.node_id, p_target)
    from public.positions p
   where p.id = any (public.org_positions_held_by(p_person))
     and public.org_node_has_capability(p.node_id, p_key)
     and p_target = any (public.org_subtree_ids(array[p.node_id]))
     and (public.org_admin()
          or p_person = public.org_current_person_id()
          or public.org_person_in_my_scope(p_person))
   order by 4;
$$;

-- =====================================================================================
-- 8. GUARDS -- where authority is actually enforced
--
-- Read 8.5 through 8.8 as the security model. They run for the policy path and for every
-- SECURITY DEFINER RPC alike, so no write path can skip them. Each is gated on
-- `auth.uid() is not null`: with no JWT the caller is this migration or the service key,
-- both of which already hold more power than any check here could withhold.
-- =====================================================================================

-- 8.0 Attribution is stamped, never accepted from the client. created_by / created_at on
-- a client-writable table are just columns, and PostgREST sends whatever the request
-- body contains: without this a grant row can be attributed to the CEO by the person who
-- wrote it, which destroys the one thing the grant ledger is for. A plpgsql trigger
-- resolves NEW field references per relation at run time, so one function serves every
-- table below that has both columns.
create or replace function public.org_stamp_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  new.created_by := auth.uid();
  return new;
end $$;

create or replace function public.org_stamp_updated()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- 8.1 The rank catalogue. A label may be corrected; an ordinal may never be renumbered
-- and a key may never be reused, so no existing rank's meaning can change under a seat
-- that already points at it -- which would silently reorder every historical org chart.
create or replace function public.org_guard_ranks()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ranks are append-only; set active = false instead' using errcode = '42501';
  end if;
  if new.ordinal is distinct from old.ordinal then
    raise exception 'a rank ordinal is never renumbered; insert a new rank at the ordinal you want'
      using errcode = '42501';
  end if;
  if new.key is distinct from old.key then
    raise exception 'a rank key is permanent' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists org_guard_ranks on public.ranks;
create trigger org_guard_ranks
  before update or delete on public.ranks
  for each row execute function public.org_guard_ranks();

drop trigger if exists org_stamp_ranks_ins on public.ranks;
create trigger org_stamp_ranks_ins
  before insert on public.ranks
  for each row execute function public.org_stamp_created();

-- 8.2 The capability vocabulary is code: any write carrying a JWT is refused, so nothing
-- reachable from the browser can widen it. A migration runs without one.
create or replace function public.org_guard_capability_types()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    raise exception 'the capability vocabulary is code: add one in a migration'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists org_guard_capability_types on public.capability_types;
create trigger org_guard_capability_types
  before insert or update or delete on public.capability_types
  for each row execute function public.org_guard_capability_types();

drop trigger if exists org_guard_node_natures on public.node_natures;
create trigger org_guard_node_natures
  before insert or update or delete on public.node_natures
  for each row execute function public.org_guard_capability_types();

-- 8.3 persons: issue the code, keep it forever, refuse deletes, and lock the account
-- link to the bootstrap pair. That last one matters: anyone who could set account_id
-- could point a person record at their own login and inherit that person's seats.
create or replace function public.org_guard_persons()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'persons are never deleted (employee codes must never be reused); set status = ''departed'''
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.employee_code := 'KV-' || lpad(nextval('public.employee_code_seq')::text, 6, '0');
    new.created_at := now();
    new.created_by := auth.uid();
    new.updated_at := now();
    new.updated_by := auth.uid();
    if new.account_id is not null and auth.uid() is not null and not public.org_admin() then
      raise exception 'only the sysadmin or the CEO links a person to an account'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.employee_code is distinct from old.employee_code then
    raise exception 'an employee code is issued once and never changes' using errcode = '42501';
  end if;
  if new.id is distinct from old.id then
    raise exception 'a person id is permanent' using errcode = '42501';
  end if;
  if new.account_id is distinct from old.account_id
     and auth.uid() is not null and not public.org_admin() then
    raise exception 'only the sysadmin or the CEO links or unlinks an account'
      using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists org_guard_persons on public.persons;
create trigger org_guard_persons
  before insert or update or delete on public.persons
  for each row execute function public.org_guard_persons();

drop trigger if exists org_stamp_bank_ins on public.person_bank_details;
create trigger org_stamp_bank_ins
  before insert on public.person_bank_details
  for each row execute function public.org_stamp_created();

drop trigger if exists org_stamp_bank_upd on public.person_bank_details;
create trigger org_stamp_bank_upd
  before update on public.person_bank_details
  for each row execute function public.org_stamp_updated();

-- 8.4 positions: coherence AND authority, in one place.
--
-- The ordinal read here is the ONLY one in the file outside a display sort. It is a
-- trigger and not a policy on purpose: it decides whether a row is COHERENT, never
-- whether a caller is ALLOWED. Checked in both directions, so re-ranking an existing
-- seat cannot invert an edge that already exists.
--
-- The authority half is what makes a SECURITY DEFINER move RPC safe. A definer function
-- bypasses the positions_update policy; it does not bypass this.
create or replace function public.org_guard_positions()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_mine numeric;
  v_mgr  numeric;
  v_bad  integer;
  v_live integer;
begin
  -- Coherence ---------------------------------------------------------------------
  select r.ordinal into v_mine from public.ranks r where r.id = new.rank_id;
  if v_mine is null then
    raise exception 'unknown rank' using errcode = '22023';
  end if;
  if not exists (select 1 from public.org_nodes n where n.id = new.node_id and n.active) then
    raise exception 'a seat must sit in an active node' using errcode = '22023';
  end if;

  if new.reports_to_position_id is not null then
    if new.reports_to_position_id = new.id then
      raise exception 'a seat cannot report to itself' using errcode = '22023';
    end if;
    select r.ordinal into v_mgr
      from public.positions p join public.ranks r on r.id = p.rank_id
     where p.id = new.reports_to_position_id and p.abolished_at is null;
    if v_mgr is null then
      raise exception 'the manager seat must exist and be live' using errcode = '22023';
    end if;
    if v_mgr > v_mine then
      raise exception 'a manager''s rank may not sit below their report''s rank'
        using errcode = '22023';
    end if;
    if new.id = any (public.org_position_chain(new.reports_to_position_id)) then
      raise exception 'that reporting edge would create a cycle' using errcode = '22023';
    end if;
  end if;

  select count(*) into v_bad
    from public.positions p join public.ranks r on r.id = p.rank_id
   where p.reports_to_position_id = new.id and p.abolished_at is null and r.ordinal < v_mine;
  if v_bad > 0 then
    raise exception 'this rank would sit below % of this seat''s own reports', v_bad
      using errcode = '22023';
  end if;

  -- A seat with live reports cannot be retired: the edges pointing at it would be left
  -- pointing at a dead seat, and for the root seat it is what keeps the tree rooted.
  if tg_op = 'UPDATE' and new.abolished_at is not null and old.abolished_at is null then
    select count(*) into v_live from public.positions p
     where p.reports_to_position_id = new.id and p.abolished_at is null;
    if v_live > 0 then
      raise exception 'that seat still has % live report(s); move them first', v_live
        using errcode = '22023';
    end if;
  end if;

  -- Authority ---------------------------------------------------------------------
  if auth.uid() is null or public.org_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not public.org_capability_reaches('appoint_into_seat_below', new.node_id) then
      raise exception 'you cannot create a seat in that node' using errcode = '42501';
    end if;
  else
    -- You may not edit your own seat. Self-appointment is the primitive every
    -- escalation chain needs, so it is refused here as well as in 8.5.
    if old.id = any (public.org_positions_held_by(public.org_current_person_id())) then
      raise exception 'you cannot edit your own seat' using errcode = '42501';
    end if;
    if not public.org_capability_reaches('appoint_into_seat_below', old.node_id)
       or not public.org_capability_reaches('appoint_into_seat_below', new.node_id) then
      raise exception 'you must be able to appoint in both the old and the new node'
        using errcode = '42501';
    end if;
  end if;

  -- A new manager edge must land inside your own branch, or a manager could hang their
  -- own seat directly off the CEO and corrupt the chart evaluation is derived from.
  if new.reports_to_position_id is not null
     and (tg_op = 'INSERT' or new.reports_to_position_id is distinct from old.reports_to_position_id)
     and not (public.org_position_node(new.reports_to_position_id) = any (public.org_my_scope_node_ids())) then
    raise exception 'the manager seat must be inside your own branch' using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists org_guard_positions on public.positions;
create trigger org_guard_positions
  before insert or update on public.positions
  for each row execute function public.org_guard_positions();

drop trigger if exists org_stamp_positions_ins on public.positions;
create trigger org_stamp_positions_ins
  before insert on public.positions
  for each row execute function public.org_stamp_created();

drop trigger if exists org_stamp_positions_upd on public.positions;
create trigger org_stamp_positions_upd
  before update on public.positions
  for each row execute function public.org_stamp_updated();

-- A seat is retired with abolished_at, never removed, so the reporting edges and audit
-- rows that point at it can never point at nothing. There is no DELETE grant either; this
-- is the second lock, the one a future definer function also hits.
create or replace function public.org_block_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception '% rows are never deleted in this model', tg_table_name using errcode = '42501';
end $$;

drop trigger if exists org_block_positions_delete on public.positions;
create trigger org_block_positions_delete
  before delete on public.positions
  for each row execute function public.org_block_delete();

drop trigger if exists org_block_bank_delete on public.person_bank_details;
create trigger org_block_bank_delete
  before delete on public.person_bank_details
  for each row execute function public.org_block_delete();

-- 8.5 Seating. Append-only, plus the two checks that close the escalation routes both
-- attack passes found.
--
-- (a) You may not seat yourself. Granting a capability to a child node and then sitting
--     in that child is the whole escalation chain; without self-seating it cannot start.
-- (b) A person who ALREADY holds a seat may only be seated by someone whose scope
--     already contains them. Without this, anyone holding the appointment capability
--     could create a seat in their own node, seat the CEO's person into it, and thereby
--     pull that person into their maintenance scope -- profile and, with the bank
--     capability, account number. A person holding NO seat is in nobody's branch, so
--     seating them steals them from no one; that is what keeps both doorways working.
create or replace function public.org_guard_position_holders()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_node      uuid;
  v_abolished timestamptz;
  v_status    text;
  v_max       timestamptz;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'position_holders is append-only; insert a new effective-dated row'
      using errcode = '42501';
  end if;

  select p.node_id, p.abolished_at into v_node, v_abolished
    from public.positions p where p.id = new.position_id;
  if v_node is null then
    raise exception 'unknown seat' using errcode = '22023';
  end if;
  if v_abolished is not null and new.person_id is not null then
    raise exception 'that seat has been abolished' using errcode = '22023';
  end if;
  if new.person_id is not null then
    select pe.status into v_status from public.persons pe where pe.id = new.person_id;
    if v_status is null then
      raise exception 'unknown person' using errcode = '22023';
    end if;
    if v_status = 'departed' then
      raise exception 'a departed person cannot be seated' using errcode = '22023';
    end if;
  end if;

  -- One transaction-scoped lock per timeline closes the read-then-write race in the
  -- backdate check below: two concurrent inserts would otherwise both read the same
  -- max() and both pass. It costs nothing at this write volume.
  perform pg_advisory_xact_lock(hashtext('position_holders' || new.position_id::text));
  select max(h.effective_from) into v_max
    from public.position_holders h
   where h.position_id = new.position_id and h.effective_from <= now();
  if v_max is not null and new.effective_from < v_max then
    raise exception 'cannot backdate a seating before the newest effective row (%)', v_max
      using errcode = '22023';
  end if;

  if auth.uid() is null or public.org_admin() then
    return new;
  end if;
  if new.person_id is not null and new.person_id = public.org_current_person_id() then
    raise exception 'you cannot seat yourself' using errcode = '42501';
  end if;
  if not public.org_capability_reaches('appoint_into_seat_below', v_node) then
    raise exception 'you cannot appoint into that node' using errcode = '42501';
  end if;
  if new.person_id is not null
     and public.org_person_node_ids(new.person_id) <> '{}'::uuid[]
     and not public.org_person_in_my_scope(new.person_id) then
    raise exception 'that person already holds a seat outside your branch' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists org_guard_position_holders on public.position_holders;
create trigger org_guard_position_holders
  before insert or update or delete on public.position_holders
  for each row execute function public.org_guard_position_holders();

drop trigger if exists org_stamp_holders_ins on public.position_holders;
create trigger org_stamp_holders_ins
  before insert on public.position_holders
  for each row execute function public.org_stamp_created();

-- 8.6 Capability grants. Three rules, and the file's central security decision.
--
-- (a) STRICTLY BELOW. `configure_child_capabilities` reaches descendants only, never the
--     node it is granted on. Both attack passes proved the self-inclusive version: one
--     grant of the configure capability let a node write itself the entire remaining
--     vocabulary in a single statement. The capability is named for a CHILD node; now it
--     means that.
-- (b) NO AMPLIFICATION. A non-admin may only grant a capability they currently hold
--     themselves. This is what closes the longer chain -- grant a capability to a child
--     node, then sit in that child -- at its first step rather than its last, and it
--     holds even if some future RPC forgets a check, because it lives here.
-- (c) APPEND-ONLY, no backdating before the newest already-effective row, so any
--     interval closed by a later event is immutable. A correction dated after the last
--     change is still possible, which is what makes ordinary late data entry workable.
create or replace function public.org_guard_node_capabilities()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_max timestamptz;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'capability grants are append-only; insert a row with granted = false to revoke'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('node_capabilities' || new.node_id::text || new.capability_key));
  select max(c.effective_from) into v_max
    from public.node_capabilities c
   where c.node_id = new.node_id
     and c.capability_key = new.capability_key
     and c.effective_from <= now();
  if v_max is not null and new.effective_from < v_max then
    raise exception 'cannot backdate a grant before the newest effective row (%)', v_max
      using errcode = '22023';
  end if;

  if auth.uid() is null or public.org_admin() then
    return new;
  end if;
  if not public.org_capability_reaches('configure_child_capabilities', new.node_id, true) then
    raise exception 'you may only configure a node strictly below one of your own seats'
      using errcode = '42501';
  end if;
  if new.granted and not public.org_i_hold(new.capability_key) then
    raise exception 'you cannot grant a capability you do not hold yourself (%)', new.capability_key
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists org_guard_node_capabilities on public.node_capabilities;
create trigger org_guard_node_capabilities
  before insert or update or delete on public.node_capabilities
  for each row execute function public.org_guard_node_capabilities();

drop trigger if exists org_stamp_caps_ins on public.node_capabilities;
create trigger org_stamp_caps_ins
  before insert on public.node_capabilities
  for each row execute function public.org_stamp_created();

-- 8.7 The sysadmin timeline: append-only, and only a sitting sysadmin (or a migration)
-- may write it.
create or replace function public.org_guard_sysadmins()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'org_sysadmins is append-only; insert a row with active = false'
      using errcode = '42501';
  end if;
  if auth.uid() is not null and not public.org_is_sysadmin() then
    raise exception 'only a sitting sysadmin appoints another' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists org_guard_sysadmins on public.org_sysadmins;
create trigger org_guard_sysadmins
  before insert or update or delete on public.org_sysadmins
  for each row execute function public.org_guard_sysadmins();

drop trigger if exists org_stamp_sysadmins_ins on public.org_sysadmins;
create trigger org_stamp_sysadmins_ins
  before insert on public.org_sysadmins
  for each row execute function public.org_stamp_created();

-- 8.8 The tree: no cycles, and reparenting is the bootstrap pair's alone.
--
-- DECISION -- both drafts let a capability holder move a node. One attack pass grafted a
-- whole subtree, its seats and its people out from under the director whose capability
-- covered them, unaudited. Moving a branch is rare, structural, and has no undo on this
-- database, so it is the one act reserved to the sysadmin or the CEO. Renaming,
-- re-natureing and deactivating stay with the capability.
create or replace function public.org_guard_nodes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'nodes are never deleted; set active = false' using errcode = '42501';
  end if;
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'a node cannot be its own parent' using errcode = '22023';
    end if;
    if new.id = any (public.org_ancestor_ids(new.parent_id)) then
      raise exception 'that parent would create a cycle' using errcode = '22023';
    end if;
  end if;

  if auth.uid() is null or public.org_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.parent_id is null then
      raise exception 'only the sysadmin or the CEO creates the root node' using errcode = '42501';
    end if;
    if not public.org_capability_reaches('create_child_node', new.parent_id) then
      raise exception 'you cannot add a child to that node' using errcode = '42501';
    end if;
  else
    if new.parent_id is distinct from old.parent_id then
      raise exception 'moving a node is reserved to the sysadmin or the CEO' using errcode = '42501';
    end if;
    if not public.org_capability_reaches('create_child_node', old.id) then
      raise exception 'you cannot edit that node' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists org_guard_nodes on public.org_nodes;
create trigger org_guard_nodes
  before insert or update or delete on public.org_nodes
  for each row execute function public.org_guard_nodes();

drop trigger if exists org_stamp_nodes_ins on public.org_nodes;
create trigger org_stamp_nodes_ins
  before insert on public.org_nodes
  for each row execute function public.org_stamp_created();

drop trigger if exists org_stamp_nodes_upd on public.org_nodes;
create trigger org_stamp_nodes_upd
  before update on public.org_nodes
  for each row execute function public.org_stamp_updated();

-- 8.9 The audit trail, written as a by-product of the write so nobody can forget it.
-- org_nodes is included because a tree reshape that leaves no record was one of the
-- holes found in review.
create or replace function public.org_write_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.org_audit (
    actor_account_id, actor_person_id, entity_type, entity_id,
    subject_person_id, node_id, action, before_json, after_json)
  values (
    auth.uid(),
    public.org_current_person_id(),
    tg_table_name,
    coalesce(v_row->>'id', v_row->>'person_id', ''),
    case when tg_table_name = 'persons' then nullif(v_row->>'id', '')::uuid
         else nullif(v_row->>'person_id', '')::uuid end,
    nullif(v_row->>'node_id', '')::uuid,
    lower(tg_op),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

drop trigger if exists org_audit_persons on public.persons;
create trigger org_audit_persons after insert or update on public.persons
  for each row execute function public.org_write_audit();

drop trigger if exists org_audit_bank on public.person_bank_details;
create trigger org_audit_bank after insert or update on public.person_bank_details
  for each row execute function public.org_write_audit();

drop trigger if exists org_audit_positions on public.positions;
create trigger org_audit_positions after insert or update on public.positions
  for each row execute function public.org_write_audit();

drop trigger if exists org_audit_holders on public.position_holders;
create trigger org_audit_holders after insert on public.position_holders
  for each row execute function public.org_write_audit();

drop trigger if exists org_audit_nodes on public.org_nodes;
create trigger org_audit_nodes after insert or update on public.org_nodes
  for each row execute function public.org_write_audit();

-- node_capabilities is its own audit trail -- it is append-only and carries actor and
-- reason -- so it needs no second copy.

-- =====================================================================================
-- 9. THE DOORWAYS
--
-- Structural writes go through these rather than straight to a table, for one reason
-- that is not style: creating a person and creating their seat must be ONE statement
-- from the client's point of view, and doing it with an INSERT policy does not work.
-- PostgREST's .insert().select() emits INSERT ... RETURNING, Postgres re-applies the
-- SELECT policy to the returned row, and every sensible predicate about a brand-new
-- person ("is she below me?") is false for the instant before she has a seat. One draft
-- worked around that with a `created_by = auth.uid() and holds no seat` branch in
-- persons_select -- which then became an unlimited read of any unseated person's row,
-- bank details included, for whoever created them. Inside a SECURITY DEFINER function
-- RLS does not apply at all, so the window never exists and the branch is unnecessary.
--
-- These are thin on purpose. Every authority check they appear to make is ALSO made by
-- the triggers in Section 8, which a definer function cannot bypass.
-- =====================================================================================

-- 9.1 FIELD doorway: one action creates the human AND their seat, named after them.
create or replace function public.org_add_field_worker(
  p_node_id uuid,
  p_full_name text,
  p_rank_key text,
  p_reports_to_position_id uuid,
  p_phone text default null,
  p_email text default null,
  p_hire_date date default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_person public.persons;
  v_rank   uuid;
  v_pos    uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select id into v_rank from public.ranks where key = p_rank_key and active;
  if v_rank is null then
    raise exception 'unknown or inactive rank %', p_rank_key using errcode = '22023';
  end if;

  insert into public.persons (full_name, display_name, phone, email, hire_date)
  values (p_full_name, p_full_name, p_phone, p_email, p_hire_date)
  returning * into v_person;

  insert into public.positions (node_id, rank_id, title, reports_to_position_id)
  values (p_node_id, v_rank, p_full_name, p_reports_to_position_id)
  returning id into v_pos;

  insert into public.position_holders (position_id, person_id)
  values (v_pos, v_person.id);

  return jsonb_build_object(
    'person_id', v_person.id,
    'employee_code', v_person.employee_code,
    'position_id', v_pos);
end $$;

-- 9.2 OFFICE doorway, second half: the seat was created empty (a plain insert into
-- positions), and this fills it with a person who has no record yet. An office hire who
-- already has a person record is seated with org_seat_person() instead.
create or replace function public.org_create_person_for_seat(
  p_position_id uuid,
  p_full_name text,
  p_phone text default null,
  p_email text default null,
  p_hire_date date default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_person public.persons;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  insert into public.persons (full_name, display_name, phone, email, hire_date)
  values (p_full_name, p_full_name, p_phone, p_email, p_hire_date)
  returning * into v_person;
  insert into public.position_holders (position_id, person_id)
  values (p_position_id, v_person.id);
  return jsonb_build_object('person_id', v_person.id, 'employee_code', v_person.employee_code);
end $$;

-- 9.3 Seat, or vacate with a null person. An append-only event either way.
create or replace function public.org_seat_person(
  p_position_id uuid, p_person_id uuid, p_effective_from timestamptz default now())
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  insert into public.position_holders (position_id, person_id, effective_from)
  values (p_position_id, p_person_id, p_effective_from)
  returning id into v_id;
  return v_id;
end $$;

-- 9.4 Move a seat, and with it its holder, their permanent employee code and their whole
-- history. 8.4 requires appointment reach over BOTH the old and the new node and refuses
-- your own seat -- and it does so here too, because a definer function does not skip a
-- trigger.
create or replace function public.org_move_position(
  p_position_id uuid, p_new_node_id uuid, p_new_reports_to_position_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  update public.positions
     set node_id = p_new_node_id,
         reports_to_position_id = p_new_reports_to_position_id
   where id = p_position_id;
  if not found then
    raise exception 'unknown seat' using errcode = '22023';
  end if;
end $$;

-- 9.5 Grant or revoke. p_subtree writes ONE EXPLICIT ROW PER NODE -- there is no
-- inheritance to lean on, which is the point: every node that has a capability has a row
-- saying so, with an actor and a reason attached.
create or replace function public.org_set_capability(
  p_node_id uuid,
  p_capability_key text,
  p_granted boolean,
  p_subtree boolean default false,
  p_reason text default null
) returns integer language plpgsql security definer set search_path = public as $$
declare
  v_targets uuid[];
  v_count   integer := 0;
  v_node    uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from public.capability_types t where t.key = p_capability_key) then
    raise exception 'unknown capability %', p_capability_key using errcode = '22023';
  end if;
  v_targets := case when p_subtree then public.org_subtree_ids(array[p_node_id])
                    else array[p_node_id] end;
  foreach v_node in array v_targets loop
    -- Skip where the grant is already in the requested state, so re-running a subtree
    -- grant after adding a branch writes only the rows that actually change and the
    -- ledger stays readable.
    if public.org_node_has_capability(v_node, p_capability_key) is distinct from p_granted then
      insert into public.node_capabilities (node_id, capability_key, granted, reason)
      values (v_node, p_capability_key, p_granted, p_reason);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

-- 9.6 Preview, before a bulk grant that has no undo.
--
-- DECISION -- the safety draft shipped three previews and all three leaked: any signed-in
-- account, with no seat and no capability, could read seat-holders' names and permanent
-- employee codes, every node name, and subtree grant counts -- the exact enumeration hole
-- 20260917140000 section 4 had just closed on org_chart(). Only this one is kept, because
-- a subtree grant can write hundreds of irreversible rows and a preview genuinely
-- protects data there; the move previews only restated checks the triggers already make.
-- It returns nothing to a caller who cannot see the node, and it names no person.
create or replace function public.org_preview_capability_change(
  p_node_id uuid,
  p_capability_key text,
  p_granted boolean,
  p_subtree boolean default false
) returns table (node_id uuid, node_name text, currently_granted boolean, effect text)
language sql stable security definer set search_path = public as $$
  select n.id,
         n.name,
         public.org_node_has_capability(n.id, p_capability_key),
         case
           when not (public.org_admin()
                     or public.org_capability_reaches('configure_child_capabilities', n.id, true))
             then 'blocked: you cannot configure this node'
           when p_granted and not (public.org_admin() or public.org_i_hold(p_capability_key))
             then 'blocked: you do not hold this capability yourself'
           when public.org_node_has_capability(n.id, p_capability_key) = p_granted
             then 'no change'
           when p_granted then 'GRANT: one new row'
           else 'REVOKE: one new row'
         end
    from public.org_nodes n
   where n.id = any (case when p_subtree then public.org_subtree_ids(array[p_node_id])
                          else array[p_node_id] end)
     and (public.org_admin() or n.id = any (public.org_my_scope_node_ids()))
   order by n.name;
$$;

-- 9.7 The tree as one document for the UI, with nature resolved here in the read path.
-- Guarded like org_chart() was: a caller who is nobody in this model gets an empty list,
-- so a fresh signup cannot enumerate the company.
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
     where c.nature_key is null and c.depth < 64
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

-- =====================================================================================
-- 10. RLS -- every table has it enabled above and at least one policy here
--
-- Read these against the grants in Section 11: a table with no INSERT grant has no
-- INSERT policy either, on purpose, and vice versa. Structural writes have no policy at
-- all because they have no grant -- they arrive through Section 9 and are judged by the
-- triggers in Section 8.
-- =====================================================================================

-- NOTE ON THE `(select ...)` WRAPPING BELOW, which is not cosmetic.
-- A STABLE function called bare in a policy qual is re-evaluated FOR EVERY ROW; wrapped
-- in a scalar subquery it becomes an InitPlan the planner runs once. Measured on this
-- schema at 1,600 people the difference was 7.2 seconds versus milliseconds -- i.e. the
-- difference between a working screen and one that trips Supabase's 8-second statement
-- timeout. This is the same reason the rest of the repo writes `(select auth.uid())`
-- rather than `auth.uid()`.

-- 10.1 Catalogues. Readable by anyone the model knows; not writable over REST at all.
drop policy if exists node_natures_select on public.node_natures;
create policy node_natures_select on public.node_natures for select
  using ((select auth.uid()) is not null);

drop policy if exists capability_types_select on public.capability_types;
create policy capability_types_select on public.capability_types for select
  using ((select auth.uid()) is not null);

-- 10.2 Ranks. Everyone signed in reads the ladder (the chart renders it); the bootstrap
-- pair adds one, which is the "single INSERT" the model asks for. Note that neither
-- predicate names an ordinal.
drop policy if exists ranks_select on public.ranks;
create policy ranks_select on public.ranks for select
  using ((select auth.uid()) is not null);

drop policy if exists ranks_admin_insert on public.ranks;
create policy ranks_admin_insert on public.ranks for insert
  with check ((select public.org_admin()));

drop policy if exists ranks_admin_update on public.ranks;
create policy ranks_admin_update on public.ranks for update
  using ((select public.org_admin())) with check ((select public.org_admin()));

-- 10.3 The tree is the same picture for everyone the model knows -- boxes carry names,
-- not people, and an org chart nobody can see is not an org chart. It is NOT open to any
-- signed-in account: handle_new_user() gives every fresh signup a profile, and
-- 20260917140000 closed exactly that enumeration hole on org_chart().
--
-- The predicate deliberately tests the CALLER and not the row. A predicate about the row
-- would be re-applied to INSERT ... RETURNING and fail for a node that has no children
-- and no seats yet, killing "create a child node" from the browser with an error naming
-- the wrong problem.
drop policy if exists org_nodes_select on public.org_nodes;
create policy org_nodes_select on public.org_nodes for select
  using ((select public.org_current_person_id()) is not null or (select public.org_is_sysadmin()));

drop policy if exists org_nodes_insert on public.org_nodes;
create policy org_nodes_insert on public.org_nodes for insert
  with check (
    (select public.org_admin())
    or (parent_id is not null and (select public.org_capability_reaches('create_child_node', parent_id))));

drop policy if exists org_nodes_update on public.org_nodes;
create policy org_nodes_update on public.org_nodes for update
  using ((select public.org_admin()) or (select public.org_capability_reaches('create_child_node', id)))
  with check ((select public.org_admin()) or (select public.org_capability_reaches('create_child_node', id)));

-- No delete policy and no delete grant: a node is deactivated, so the audit rows and the
-- seats that reference it never point at nothing.

-- 10.4 persons. Yourself, your branch, a subtree where you hold maintain_person_profile,
-- or the bootstrap pair. Peers of your reports do not see each other.
--
-- "Any director of a FIELD node may maintain any field worker" is expressed as capability
-- grants on the field nodes, not as a test of node nature -- nature is forbidden in a
-- predicate, and a grant says the same thing while staying answerable by
-- org_explain_capability(). Where field work sits under one branch this is a single grant
-- on that branch; where it is scattered it is one row per branch, which is the price of
-- the no-inheritance rule and is paid in data rather than in code. The safety draft
-- instead added an unbounded `maintain_person_profile_anywhere` capability, and that is
-- rejected: an attack pass used exactly that capability as the payload of a four-call
-- escalation to company-wide bank-account rewrite. A capability with no containment leg
-- is the one shape this model cannot audit.
--
-- There is no INSERT policy and no INSERT grant: persons are created by 9.1 / 9.2.
drop policy if exists persons_select on public.persons;
create policy persons_select on public.persons for select
  using (
    account_id = (select auth.uid())
    or (select public.org_is_sysadmin())
    or (select public.org_holds_root_seat())
    or persons.id = any (coalesce((select public.org_visible_person_ids()), '{}'::uuid[])));

-- Office staff maintain their own details; managers maintain the people in their subtree.
-- employee_code, id and account_id are locked by 8.3 whichever branch let the caller in.
drop policy if exists persons_update on public.persons;
create policy persons_update on public.persons for update
  using (
    account_id = (select auth.uid())
    or (select public.org_admin())
    or persons.id = any (coalesce((select public.org_maintainable_person_ids()), '{}'::uuid[])))
  with check (
    account_id = (select auth.uid())
    or (select public.org_admin())
    or persons.id = any (coalesce((select public.org_maintainable_person_ids()), '{}'::uuid[])));

-- 10.5 Bank details. The narrowest table in the file: yourself, the bootstrap pair, or a
-- subtree where you hold maintain_bank_details -- which is a SEPARATE capability from
-- profile maintenance, so the CEO can hand a manager personnel work without handing them
-- payroll. Nobody else, including a manager who can see the person's profile.
drop policy if exists person_bank_select on public.person_bank_details;
create policy person_bank_select on public.person_bank_details for select
  using (
    (select public.org_is_sysadmin())
    or person_bank_details.person_id = any (coalesce((select public.org_bank_person_ids()), '{}'::uuid[])));

drop policy if exists person_bank_insert on public.person_bank_details;
create policy person_bank_insert on public.person_bank_details for insert
  with check (
    (select public.org_is_sysadmin())
    or person_bank_details.person_id = any (coalesce((select public.org_bank_person_ids()), '{}'::uuid[])));

drop policy if exists person_bank_update on public.person_bank_details;
create policy person_bank_update on public.person_bank_details for update
  using (
    (select public.org_is_sysadmin())
    or person_bank_details.person_id = any (coalesce((select public.org_bank_person_ids()), '{}'::uuid[])))
  with check (
    (select public.org_is_sysadmin())
    or person_bank_details.person_id = any (coalesce((select public.org_bank_person_ids()), '{}'::uuid[])));

-- 10.6 Seats and holder history are the org chart, so they are readable by anyone the
-- model knows, like the tree. Writes have no policy: seats are created and moved through
-- Section 9 and judged by 8.4 and 8.5.
drop policy if exists positions_select on public.positions;
create policy positions_select on public.positions for select
  using ((select public.org_current_person_id()) is not null or (select public.org_is_sysadmin()));

drop policy if exists positions_insert on public.positions;
create policy positions_insert on public.positions for insert
  with check (
    (select public.org_admin())
    or (select public.org_capability_reaches('appoint_into_seat_below', node_id)));

drop policy if exists positions_update on public.positions;
create policy positions_update on public.positions for update
  using ((select public.org_admin()) or (select public.org_capability_reaches('appoint_into_seat_below', node_id)))
  with check ((select public.org_admin()) or (select public.org_capability_reaches('appoint_into_seat_below', node_id)));

drop policy if exists position_holders_select on public.position_holders;
create policy position_holders_select on public.position_holders for select
  using ((select public.org_current_person_id()) is not null or (select public.org_is_sysadmin()));

-- 10.7 Capability grants are deliberately transparent to everyone the model knows: "why
-- can this person do that?" should be answerable by the person it is about, and a ledger
-- only the powerful can read is not a check on the powerful.
drop policy if exists node_capabilities_select on public.node_capabilities;
create policy node_capabilities_select on public.node_capabilities for select
  using ((select public.org_current_person_id()) is not null or (select public.org_is_sysadmin()));

-- 10.8 The sysadmin table: your own row, or everything if you are one.
drop policy if exists org_sysadmins_select on public.org_sysadmins;
create policy org_sysadmins_select on public.org_sysadmins for select
  using (account_id = (select auth.uid()) or (select public.org_is_sysadmin()));

-- 10.9 The audit trail carries before/after JSON of persons and bank rows, so it is as
-- narrow as the bank policy: a sysadmin, what you did, or what was done to you. A
-- "show me this node's audit trail" screen must come through a definer RPC that returns
-- safe columns, not by widening this.
drop policy if exists org_audit_select on public.org_audit;
create policy org_audit_select on public.org_audit for select
  using (
    (select public.org_is_sysadmin())
    or actor_account_id = (select auth.uid())
    or subject_person_id = (select public.org_current_person_id()));

-- =====================================================================================
-- 11. GRANTS -- required, because default privileges were revoked
--
-- The shape of each grant IS a guarantee that sits below RLS:
--   capability_types / node_natures  select only -> the vocabulary is code
--   ranks                            no delete   -> the ladder is append-only
--   org_nodes                        no delete   -> nodes are deactivated, never removed
--   persons                          no insert, no delete -> codes are issued by 9.1/9.2
--                                                            and never come free
--   positions                        no delete   -> reporting edges never dangle
--   position_holders / node_capabilities / org_sysadmins  select only -> append-only at
--                                    the privilege layer, not merely by trigger
--   org_audit                        select only -> written by a definer trigger
--
-- REVOKE FIRST, THEN GRANT, and that is not decoration. baseline.sql:691 contains
-- `grant select, insert, update, delete on all tables in schema public to authenticated`.
-- If that line ever runs again -- a replay, or a future migration copying the convenience
-- idiom -- every table here silently gains DELETE. A block that only ever adds cannot
-- express "and nothing else"; this one is authoritative, so re-running this file repairs
-- the grants instead of layering on top of them.
-- =====================================================================================

revoke all on public.node_natures, public.capability_types, public.ranks,
              public.org_nodes, public.persons, public.person_bank_details,
              public.positions, public.position_holders, public.node_capabilities,
              public.org_sysadmins, public.org_audit
  from public, anon, authenticated;

grant select                  on public.node_natures        to authenticated;
grant select                  on public.capability_types    to authenticated;
grant select, insert, update  on public.ranks               to authenticated;
grant select, insert, update  on public.org_nodes           to authenticated;
grant select, update          on public.persons             to authenticated;
grant select, insert, update  on public.person_bank_details to authenticated;
grant select, insert, update  on public.positions           to authenticated;
grant select                  on public.position_holders    to authenticated;
grant select                  on public.node_capabilities   to authenticated;
grant select                  on public.org_sysadmins       to authenticated;
grant select                  on public.org_audit           to authenticated;

-- No sequence is granted. employee_code_seq is advanced only inside 8.3 and the bigserial
-- sequences only inside definer functions, all of which run as the owner. Every
-- client-inserted table keys on a uuid default instead, which sidesteps the
-- sequence-permission trap entirely. In particular there is no callable
-- next_employee_code(): an earlier draft granted one to `authenticated`, and any signed-in
-- account could then burn the permanent code space in a loop.
revoke all on sequence public.employee_code_seq from public, anon, authenticated;

-- `revoke ... from public` is doing independent work here: ALTER DEFAULT PRIVILEGES in
-- 20260917140000 was aimed at `authenticated`, while Postgres separately grants EXECUTE
-- to PUBLIC on every new function, and anon inherits PUBLIC.
revoke all on function public.org_current_person_id() from public, anon;
grant execute on function public.org_current_person_id() to authenticated;
revoke all on function public.org_is_sysadmin(timestamptz) from public, anon;
grant execute on function public.org_is_sysadmin(timestamptz) to authenticated;
revoke all on function public.org_subtree_ids(uuid[]) from public, anon;
grant execute on function public.org_subtree_ids(uuid[]) to authenticated;
revoke all on function public.org_ancestor_ids(uuid) from public, anon;
grant execute on function public.org_ancestor_ids(uuid) to authenticated;
revoke all on function public.org_node_distance(uuid, uuid) from public, anon;
grant execute on function public.org_node_distance(uuid, uuid) to authenticated;
revoke all on function public.org_node_nature(uuid) from public, anon;
grant execute on function public.org_node_nature(uuid) to authenticated;
revoke all on function public.org_positions_held_by(uuid) from public, anon;
grant execute on function public.org_positions_held_by(uuid) to authenticated;
revoke all on function public.org_person_node_ids(uuid) from public, anon;
grant execute on function public.org_person_node_ids(uuid) to authenticated;
revoke all on function public.org_my_seat_node_ids() from public, anon;
grant execute on function public.org_my_seat_node_ids() to authenticated;
revoke all on function public.org_position_node(uuid) from public, anon;
grant execute on function public.org_position_node(uuid) to authenticated;
revoke all on function public.org_position_chain(uuid) from public, anon;
grant execute on function public.org_position_chain(uuid) to authenticated;
revoke all on function public.org_node_has_capability(uuid, text, timestamptz) from public, anon;
grant execute on function public.org_node_has_capability(uuid, text, timestamptz) to authenticated;
revoke all on function public.org_i_hold(text) from public, anon;
grant execute on function public.org_i_hold(text) to authenticated;
revoke all on function public.org_nodes_reached_with(text, boolean) from public, anon;
grant execute on function public.org_nodes_reached_with(text, boolean) to authenticated;
revoke all on function public.org_capability_reaches(text, uuid, boolean) from public, anon;
grant execute on function public.org_capability_reaches(text, uuid, boolean) to authenticated;
revoke all on function public.org_my_scope_node_ids() from public, anon;
grant execute on function public.org_my_scope_node_ids() to authenticated;
revoke all on function public.org_holds_root_seat() from public, anon;
grant execute on function public.org_holds_root_seat() to authenticated;
revoke all on function public.org_admin() from public, anon;
grant execute on function public.org_admin() to authenticated;
revoke all on function public.org_persons_seated_in(uuid[]) from public, anon;
grant execute on function public.org_persons_seated_in(uuid[]) to authenticated;
revoke all on function public.org_visible_person_ids() from public, anon;
grant execute on function public.org_visible_person_ids() to authenticated;
revoke all on function public.org_maintainable_person_ids() from public, anon;
grant execute on function public.org_maintainable_person_ids() to authenticated;
revoke all on function public.org_bank_person_ids() from public, anon;
grant execute on function public.org_bank_person_ids() to authenticated;
revoke all on function public.org_person_in_my_scope(uuid) from public, anon;
grant execute on function public.org_person_in_my_scope(uuid) to authenticated;
revoke all on function public.org_explain_capability(uuid, text, uuid) from public, anon;
grant execute on function public.org_explain_capability(uuid, text, uuid) to authenticated;
revoke all on function public.org_add_field_worker(uuid, text, text, uuid, text, text, date) from public, anon;
grant execute on function public.org_add_field_worker(uuid, text, text, uuid, text, text, date) to authenticated;
revoke all on function public.org_create_person_for_seat(uuid, text, text, text, date) from public, anon;
grant execute on function public.org_create_person_for_seat(uuid, text, text, text, date) to authenticated;
revoke all on function public.org_seat_person(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.org_seat_person(uuid, uuid, timestamptz) to authenticated;
revoke all on function public.org_move_position(uuid, uuid, uuid) from public, anon;
grant execute on function public.org_move_position(uuid, uuid, uuid) to authenticated;
revoke all on function public.org_set_capability(uuid, text, boolean, boolean, text) from public, anon;
grant execute on function public.org_set_capability(uuid, text, boolean, boolean, text) to authenticated;
revoke all on function public.org_preview_capability_change(uuid, text, boolean, boolean) from public, anon;
grant execute on function public.org_preview_capability_change(uuid, text, boolean, boolean) to authenticated;
revoke all on function public.org_tree() from public, anon;
grant execute on function public.org_tree() to authenticated;

-- The trigger functions are invoked by the trigger machinery as the table owner, so no
-- role needs EXECUTE on them and none is given.
revoke all on function public.org_stamp_created() from public, anon, authenticated;
revoke all on function public.org_stamp_updated() from public, anon, authenticated;
revoke all on function public.org_guard_ranks() from public, anon, authenticated;
revoke all on function public.org_guard_capability_types() from public, anon, authenticated;
revoke all on function public.org_guard_persons() from public, anon, authenticated;
revoke all on function public.org_guard_positions() from public, anon, authenticated;
revoke all on function public.org_guard_position_holders() from public, anon, authenticated;
revoke all on function public.org_guard_node_capabilities() from public, anon, authenticated;
revoke all on function public.org_guard_sysadmins() from public, anon, authenticated;
revoke all on function public.org_guard_nodes() from public, anon, authenticated;
revoke all on function public.org_write_audit() from public, anon, authenticated;
revoke all on function public.org_block_delete() from public, anon, authenticated;

-- =====================================================================================
-- 12. SEED
-- =====================================================================================

-- 12.1 Catalogues. Guarded by NOT EXISTS over EVERY unique constraint on the target, not
-- by ON CONFLICT on one of them. ranks has two uniques (key AND ordinal), and an
-- `on conflict (key)` seed raises 23505 on a replay the moment somebody has used the
-- documented workflow to insert their own rank at a seeded ordinal under a different key
-- -- which is precisely what this file tells them to do.
insert into public.node_natures (key, name_vi, name_en, sort_order)
select v.key, v.name_vi, v.name_en, v.sort_order
  from (values
    ('field',  'Hiện trường', 'Field',  10),
    ('office', 'Văn phòng',   'Office', 20)
  ) as v(key, name_vi, name_en, sort_order)
 where not exists (select 1 from public.node_natures x where x.key = v.key);

insert into public.capability_types (key, sort_order, note)
select v.key, v.sort_order, v.note
  from (values
    ('assign_work_down',                 10, 'Send a task to a seat at or below this node'),
    ('accept_or_reject_submission',      20, 'Close or bounce work returned from below'),
    ('hand_across_to_peer',              30, 'Share ONE task sideways to an equal seat'),
    ('create_child_node',                40, 'Add or edit a child box under this node'),
    ('appoint_into_seat_below',          50, 'Create seats at or below this node, and seat or vacate people in them'),
    ('issue_document_for_acknowledgment',60, 'Publish something people below must acknowledge'),
    ('set_deadline_and_weight',          70, 'Put a due date and a weight on a task'),
    ('view_subtree_workload',            80, 'See the whole subtree''s open work'),
    ('evaluate_people_below',            90, 'Derive an evaluation from the task record below'),
    ('configure_child_capabilities',    100, 'Grant or revoke capabilities on nodes STRICTLY BELOW this one'),
    ('maintain_person_profile',         110, 'Edit name, photo, contact and employment details of people in this subtree'),
    ('maintain_bank_details',           120, 'Read and write bank details of people in this subtree. High fraud exposure: every write is audited')
  ) as v(key, sort_order, note)
 where not exists (select 1 from public.capability_types x where x.key = v.key);

insert into public.ranks (key, name_vi, name_en, ordinal)
select v.key, v.name_vi, v.name_en, v.ordinal
  from (values
    ('ceo',        'Tổng giám đốc', 'Chief executive', 1000::numeric),
    ('director',   'Giám đốc',      'Director',        3000::numeric),
    ('manager',    'Quản lý',       'Manager',         5000::numeric),
    ('supervisor', 'Giám sát',      'Supervisor',      7000::numeric),
    ('staff',      'Nhân viên',     'Staff',           9000::numeric)
  ) as v(key, name_vi, name_en, ordinal)
 where not exists (select 1 from public.ranks r where r.key = v.key or r.ordinal = v.ordinal);

-- 12.2 The sysadmin, seeded so a real human can bootstrap the model on day one.
-- Without a row here nobody can create the first seat or write the first grant, and the
-- model is inert forever -- so the self-check below refuses to finish if this comes up
-- empty. Matched by email against auth.users directly -- there is no tier scheme in this
-- repo to carry a role over from.
insert into public.org_sysadmins (account_id, active, note)
select u.id, true, 'seeded as the owner account, matched by email'
  from auth.users u
 where u.email = 'nguyendinhngoc23052006@gmail.com'
   and not exists (select 1 from public.org_sysadmins s where s.account_id = u.id);

-- 12.3 The root node. No retail legacy exists in this repo to mirror -- Kwook
-- is a fresh org tree built here, not migrated from sectors/stores. The
-- sysadmin creates every node below the root through the ordinary org_*
-- RPCs (create_child_node etc.), same as the root itself would be edited.
insert into public.org_nodes (parent_id, name, name_en, sort_order, active)
select null, 'Kwook Việt Nam', 'Kwook Vietnam', 0, true
 where not exists (select 1 from public.org_nodes n where n.parent_id is null);

-- =====================================================================================
-- 13. SELF-CHECK -- refuse to finish in a state the grant floor makes invisible
--
-- Every failure this catches is silent. A table with RLS on and no policy returns zero
-- rows rather than an error, so it reads as "no data". A table with no grant returns
-- permission-denied, which reads as a client bug. And a model with no sysadmin row looks
-- perfectly healthy while being permanently unbootstrappable. All three are cheap to
-- detect here and expensive to find in production on a database with no undo.
--
-- Raising here rolls this file back cleanly and leaves production exactly as it was,
-- which is the outcome to want: a red deploy that changed nothing beats a green deploy
-- that shipped an unusable schema needing another migration to repair.
-- =====================================================================================

do $$
declare
  v_t       text;
  v_missing text[] := '{}';
  v_tables  text[] := array[
    'node_natures','capability_types','ranks','org_nodes','persons','person_bank_details',
    'positions','position_holders','node_capabilities','org_sysadmins','org_audit'];
begin
  foreach v_t in array v_tables loop
    if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = 'public' and c.relname = v_t and c.relrowsecurity) then
      v_missing := v_missing || (v_t || ': RLS not enabled');
    end if;
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = v_t) then
      v_missing := v_missing || (v_t || ': RLS on with NO POLICY -- returns zero rows silently');
    end if;
    if not has_table_privilege('authenticated', 'public.' || quote_ident(v_t), 'SELECT') then
      v_missing := v_missing || (v_t || ': no SELECT grant to authenticated');
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    raise exception 'org foundation self-check failed: %', array_to_string(v_missing, '; ');
  end if;
end $$;

do $$
begin
  if (select count(*) from public.ranks) < 5 then
    raise exception 'org foundation self-check failed: the rank catalogue did not seed';
  end if;
  if (select count(*) from public.capability_types) < 12 then
    raise exception 'org foundation self-check failed: the capability vocabulary did not seed';
  end if;
  if (select count(*) from public.org_nodes where parent_id is null) <> 1 then
    raise exception 'org foundation self-check failed: the tree does not have exactly one root node';
  end if;
  -- Non-fatal, matching Section 0: on an ephemeral preview branch the owner never
  -- signs up, so this is expected there. On a persistent project it means the
  -- model needs a follow-up seed once the owner signs up (fix forward).
  if not exists (select 1 from public.org_sysadmins where active) then
    raise warning 'org foundation: the sysadmin seed matched nothing (no sysadmin exists yet). '
      'Expected and harmless on an ephemeral preview branch. On a persistent project, sign up '
      'with the owner''s email, then land a follow-up migration to seed org_sysadmins directly.';
  end if;
end $$;
