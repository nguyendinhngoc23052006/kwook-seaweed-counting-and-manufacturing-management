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

-- The ::uuid casts are required: INSERT ... SELECT does not coerce a string
-- literal to the target column's type the way a plain VALUES insert does.
insert into devices (id, tenant_id, name, camera_function, station_id)
select '22222222-2222-2222-2222-222222222222'::uuid, s.tenant_id, 'cam-01', 'counting', s.id
  from stations s where s.name = 'Belt 1'
union all
select '33333333-3333-3333-3333-333333333333'::uuid, s.tenant_id, 'cam-02', 'compliance', s.id
  from stations s where s.name = 'Main door';
