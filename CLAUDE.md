# CLAUDE.md — the rules this project obeys

Seaweed leaf counting, PPE compliance and station supervision for Kwook.
Phones analyse their own camera on-device and send results; a Cloudflare Worker
serves the app and ingests them; Supabase stores them; GitHub gates every deploy.

## Scope (generated — do not hand-edit)

- Framework: **Vite + React + TypeScript** · env prefix `VITE_` · build dir `dist`
  · config `vite.config.ts` · Supabase client `src/lib/supabaseClient.ts`
- Team: **solo** · Environments: **staging + main** · PRs target **`staging`**
- Repo is **public**; rulesets hard-enforce. Required approvals stay at 1 with the
  maintainer on each ruleset's bypass list — never lower the rule instead.

## The nine rules that cannot be broken

1. **Device accounts are write-only.** No `SELECT` policy on event tables, ever.
   A device credential lives on an unattended phone on a factory floor.
2. **Role comes from the server.** `devices.role`, never a URL parameter.
3. **`algorithm_version` on every count row.** The counter will be tuned; a month
   must be comparable or provably not.
4. **Client-generated UUID per event**, written with upsert. A retry after a
   dropped connection must never double-count.
5. **The stream never degrades analytics.** Cap sender bitrate. SFU down does not
   mean counting down.
6. **No audio, ever. No stored live video.**
7. **Report snapshots are immutable.** A disputed month still says what it said.
8. **Cron → Queue, never Cron alone.** Cron Triggers do not retry.
9. **`tenant_id` on every table.**

## How you work

1. **Think first.** Restate the goal, read callers before editing, state
   assumptions in the PR. Ask ONE question when the task touches more than 5
   files, adds the first use of a dependency or external service, or writes a
   migration touching more than one table.
2. **Simplicity.** Minimum code, nothing speculative. No abstraction until the
   second real use. No comments except where the *why* is non-obvious.
3. **Surgical.** Touch only what the task needs. Note unrelated problems; do not
   fix them.
4. **Goal-driven.** Turn the task into a failing test, then pass it. The vision
   core is pure functions precisely so it can be tested without a camera.

## Migrations

Migrations are the single source of truth. Every schema change is a new file in
`supabase/migrations/`, UTC-named, append-only. Never hand-edit the database and
never edit a migration that has been applied.

## Security

- **Never put a Claude Code session link in a commit message, PR body, or PR
  comment.** No attribution URLs in anything pushed to this repository.
- **Public sign-up is off** (`supabase/config.toml`, `[auth] enable_signup`).
  Accounts are created by an admin, never self-served: with signup on, anyone who
  found the URL got a profile from the `on_auth_user_created` trigger and could
  read the tenant's counts and compliance events - and the FIRST account to sign
  up becomes admin. `config.toml` does not reach production, so production signup
  is off in the Supabase dashboard instead.
- **Demo credentials live only in `supabase/seed.sql`**, which Supabase never
  applies to production and does not apply to persistent branches without an
  explicit `[remotes.<name>.db.seed]` block. Never seed a real environment.

- Publishable key in the browser, secret key server-only, RLS on every table.
- The device screen shows only its own station's figures — never totals, never
  other stations, never per-operator numbers. A stolen device credential must be
  worth nothing, and workers must not be able to watch their own live score.
- Every export writes an `access_log` row.

## Measurement honesty

- Report **rates**, not names. Compliance is an audit instrument, not an
  accusation engine.
- Every report carries a data-quality section: per-station uptime, % flagged,
  minutes lost to mode transitions. Without it a station that was offline 30% of
  the month ranks last on merit it never had.
- No count feeds a performance decision until a parallel manual-count validation
  has produced stated error bars.

## Quality gate — before every PR

- [ ] `npm run lint`, `npm run typecheck`, `npm test` all pass
- [ ] Any new table has RLS enabled and a policy for every role that touches it
- [ ] No device-readable path was added to an event table
- [ ] Migration is additive and UTC-named
- [ ] PR body says what changed and how to undo it
