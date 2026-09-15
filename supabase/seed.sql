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
--   admin  demo-admin@kwook.test   demo-kwook-2026   → /wall, /admin
--   cam-01 cam-01@kwook.test       demo-kwook-2026   → /capture, counting, Belt 1
--   cam-02 cam-02@kwook.test       demo-kwook-2026   → /capture, compliance, Main door
--
-- Order matters: the admin is inserted first because on_auth_user_created makes
-- the first account in the tenant the admin and every later one a viewer.

create or replace function seed_user(uid uuid, addr text, display text)
  returns void language plpgsql as $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    addr, crypt('demo-kwook-2026', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('display_name', display),
    '', '', '', ''
  );

  -- Without an identities row the account exists but email sign-in fails.
  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), uid, uid::text,
    jsonb_build_object('sub', uid::text, 'email', addr),
    'email', now(), now(), now()
  );
end $$;

select seed_user('11111111-1111-1111-1111-111111111111', 'demo-admin@kwook.test', 'Demo Admin');
select seed_user('22222222-2222-2222-2222-222222222222', 'cam-01@kwook.test', 'cam-01');
select seed_user('33333333-3333-3333-3333-333333333333', 'cam-02@kwook.test', 'cam-02');

drop function seed_user(uuid, text, text);

-- The two camera accounts become devices. This mirrors exactly what an admin
-- does in /admin: flip the profile to kind='device', then insert the devices
-- row that gives it a role and a station.
update profiles
   set kind = 'device', role = 'viewer'
 where id in ('22222222-2222-2222-2222-222222222222'::uuid,
              '33333333-3333-3333-3333-333333333333'::uuid);

-- The ::uuid casts are required: INSERT ... SELECT does not coerce a string
-- literal to the target column's type the way a plain VALUES insert does.
insert into devices (id, tenant_id, name, role, station_id)
select '22222222-2222-2222-2222-222222222222'::uuid, s.tenant_id, 'cam-01', 'counting', s.id
  from stations s where s.name = 'Belt 1'
union all
select '33333333-3333-3333-3333-333333333333'::uuid, s.tenant_id, 'cam-02', 'compliance', s.id
  from stations s where s.name = 'Main door';
