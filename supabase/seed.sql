-- DEMO SEED — preview branches only.
--
-- These credentials are in a public repository on purpose: they only ever exist
-- on ephemeral preview databases, which hold no real data and are deleted when
-- the PR closes.
--
-- They cannot reach production. Supabase's deploy-to-production applies
-- migrations, Edge Functions and storage buckets only — "all other
-- configurations, including API, Auth, and seed files, are ignored by default",
-- and "data changes in your seed files are not merged to production"
-- (supabase.com/docs/guides/deployment/branching/github-integration, read
-- 2026-09-15). Seeding a persistent branch additionally requires an explicit
-- [remotes.<name>.db.seed] block, which this project does not define — so
-- staging is not seeded either.
--
--   owner  demo-admin@kwook.test   demo-kwook-2026   → /wall, /admin
--   cam-01 cam-01@kwook.test       demo-kwook-2026   → /capture, counting, Belt 1
--   cam-02 cam-02@kwook.test       demo-kwook-2026   → /capture, compliance, Main door
--
-- Roles are set explicitly below; the on_auth_user_created trigger gives every
-- new account role 'pending' and nothing else.

-- One DO block, not a helper function: Supabase's seed runner PREPARES a batch
-- of statements before executing it, so a `select seed_user(...)` in the same
-- file fails with "function seed_user(...) does not exist" - the CREATE has not
-- run at prepare time. A single anonymous block has nothing to resolve ahead of
-- execution.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      (1, '11111111-1111-1111-1111-111111111111'::uuid, 'demo-admin@kwook.test', 'Demo Admin'),
      (2, '22222222-2222-2222-2222-222222222222'::uuid, 'cam-01@kwook.test',     'cam-01'),
      (3, '33333333-3333-3333-3333-333333333333'::uuid, 'cam-02@kwook.test',     'cam-02')
    ) as t(ord, uid, addr, display)
    order by ord
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000', r.uid, 'authenticated', 'authenticated',
      r.addr, crypt('demo-kwook-2026', gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('display_name', r.display),
      '', '', '', ''
    );

    -- Without an identities row the account exists but email sign-in fails.
    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), r.uid, r.uid::text,
      jsonb_build_object('sub', r.uid::text, 'email', r.addr),
      'email', now(), now(), now()
    );
  end loop;
end $$;

-- Set the intended roles explicitly rather than relying on the order the trigger
-- saw the inserts in. on_auth_user_created makes the first account an admin, but
-- the seed should not depend on that to be correct.
update profiles set kind = 'human', role = 'owner'
 where id = '11111111-1111-1111-1111-111111111111'::uuid;

update profiles
   set kind = 'device', role = 'viewer'
 where id in ('22222222-2222-2222-2222-222222222222'::uuid,
              '33333333-3333-3333-3333-333333333333'::uuid);

-- The demo floor. This used to live in migration 20260915080000, which meant
-- production would have been born with it; 20260917100000 removed it there and
-- it lives here instead, because a seed reaches preview branches only.
--
-- On the org camera stack now. Everything below hangs off the root org node,
-- so it seeds nothing at all on a database that has no organisation yet --
-- which is right: a floor with no company above it is not a demo, it is
-- orphaned rows.
--
-- One thing did NOT survive the move as-is. Legacy `stations.kind` had lost
-- its CHECK and become free text for the physical thing ('Belt', 'Tray table',
-- 'Doorway'); `camera_stations.kind` is the camera's FUNCTION, from a
-- four-value catalogue. Same column name, different question, so each station
-- is mapped to the function a camera standing there would actually run.
insert into camera_lines (org_node_id, name)
select n.id, f.name
  from org_nodes n
  cross join (values ('Line A'), ('Plant')) as f(name)
 where n.parent_id is null
on conflict do nothing;

-- camera_stations carries no unique constraint on name, so `on conflict` has
-- nothing to key on and a second seed run would duplicate the floor.
insert into camera_stations (org_node_id, line_id, name, kind)
select l.org_node_id, l.id, f.name, f.kind
  from (values ('Line A', 'Belt 1', 'counting'),
               ('Line A', 'Portioning 1', 'provisioning'),
               ('Plant',  'Main door', 'compliance')) as f(line, name, kind)
  join camera_lines l on l.name = f.line
 where not exists (
   select 1 from camera_stations s where s.name = f.name
 );

-- The ::uuid casts are required: INSERT ... SELECT does not coerce a string
-- literal to the target column's type the way a plain VALUES insert does.
--
-- camera_devices calls a camera's job `role` where devices called it
-- camera_function, and the row carries its own org_node_id rather than
-- inheriting one from its station.
insert into camera_devices (id, org_node_id, name, role, station_id)
select '22222222-2222-2222-2222-222222222222'::uuid, s.org_node_id, 'cam-01', 'counting', s.id
  from camera_stations s where s.name = 'Belt 1'
union all
select '33333333-3333-3333-3333-333333333333'::uuid, s.org_node_id, 'cam-02', 'compliance', s.id
  from camera_stations s where s.name = 'Main door'
on conflict (id) do nothing;
