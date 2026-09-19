# MEMORY.md — whole-scene facts (prune to stay under ~200 lines)

## Testing the database without a Supabase project

- A stock Postgres replays every migration if two stubs go first: `auth`
  (roles `anon`/`authenticated`/`service_role`, `auth.users` with `email`,
  `raw_user_meta_data`, `raw_app_meta_data`, and `auth.uid()` reading
  `current_setting('request.jwt.claims', true)::json->>'sub'`) and `storage`
  (`buckets`, `objects` with RLS on, `foldername`/`filename`/`extension`).
  Replay in filename order with `ON_ERROR_STOP`; then test as the real role:
  `set role authenticated; set request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}'`.
- Never insert into `position_holders`/`node_capabilities` as `authenticated`
  in a test — only the RPCs (`org_seat_person`, `org_set_capability`) are
  granted. Seed fixtures as `postgres`, act as the role.
- PL/pgSQL resolves `new.<field>` at plan time even inside a short-circuited
  `or`; a trigger shared by several tables must branch on `tg_table_name` into
  table-specific variables first.
- **Three-valued logic bypasses gates.** For a caller with no `persons` row
  (a door device, a fresh signup) `org_current_person_id()` is NULL, so
  `not (false or NULL)` is NULL and `if not (...) then raise` never raises.
  Every gate is `coalesce(<predicate>, false)`.
- A `lateral fn(constants)` in a test is evaluated **once** and cross-joined
  (an uncorrelated function scan); to call an RPC N times make an argument
  depend on the series (`now() - g * interval '1 second'`).
- `reset request.jwt.claims` leaves `''`, which `::json` rejects inside the
  guards; switch claims to the admin's sub instead when seeding as `postgres`.

## Org model gotchas

- A capability reaches the **subtree of the node it is granted on**, and only
  a holder seated **in that node** carries it — a grant on the parent gives a
  child seat's holder nothing. Test fixtures grant on the seat's own node.
- Privilege flows only from a seat in an **effectively active** unit
  (`org_positions_held_by`); the raw holder list is
  `org_positions_currently_held_by`. Archiving a unit drops its holders to
  `pending`; reactivating restores them. Root cannot be archived.
- Node nature (`field`/`office`) is UI-only and never appears in a policy.

## Cameras

- Two device stacks exist: legacy `devices`/`/pair` (counting only) and the
  org stack `camera_devices` (created by the `create-camera-device` Edge
  Function, signed in with email+password). `org_camera_create_device` flips
  the auth user's profile to `kind = 'device'` — before 20260924030000 it did
  not, so org cameras sat on the "waiting for approval" screen.
- `App.tsx` routes a device whose `camera_devices.role` is `check_in`/`check_out`
  to `/attendance`; everything else falls to the legacy `/capture`.

## Attendance (20260924030000)

- Faces are matched **inside** `camera_attendance_capture`; the phone sends a
  128-number embedding plus `FACE_MODEL_VERSION` and reads nothing back but
  the verdict. `person_face_embeddings` has no client grant at all.
- Cooldown is a **symmetric** window per (person, door kind) — two doors of
  the same kind do not double-log; with cooldown 0 only the deterministic id
  (device, person, minute) dedupes. A door matches only people seated at or
  below its own unit, trusts the phone clock to two minutes, never returns
  the match distance, and refuses more than 20 captures a minute.
- Self-enrolment is the `enroll_own_face` capability (granted per unit);
  a manager enrols people below via `maintain_person_profile`. Without the
  capability, any worker could enrol a colleague's face as their own.
- The report scopes people by seats held **at any point in the range**
  (`org_persons_seated_in_during`), pairs across the range edges (events
  16 h either side take part), and reports an open check-in younger than
  16 h as `on_site`, not as a missing punch.
- face-api's `detectSingleFace` returns the highest-*score* face, not the
  largest; the door describes all faces and picks the largest one inside
  the zone.
- Matching is a plain `real[]` unnest: 45 ms per capture at 2,000 enrolled
  people, linear. Past ~20k people the seam is `vector(128)` + an HNSW index
  in one migration; the RPC signature does not change.
- The hours report pairs a check-in with the next check-out **within 16 h**;
  anything longer is a missing punch, not hours. Days are `Asia/Ho_Chi_Minh`.
- `@vladmandic/face-api`'s `esm-nobundle` build imports
  `@tensorflow/tfjs-backend-wasm` unconditionally: it must be installed even
  though only the WebGL/CPU backends run. Models ship from `public/models`.
- The TensorFlow chunk is ~1.6 MB (360 KB gzip): import `src/attendance/faceEngine.ts`
  only from the lazy door page or via `await import()`.

## Screenshot harness

- Playwright's accessible name is the `aria-label`, not the visible text:
  `MoveNodeDialog`'s trigger is "Báo cáo cho". Generic regexes collide
  ("Thu hồi" vs "đã thu hồi", "Ngừng hoạt động" vs "đã ngừng hoạt động") —
  anchor them.

## CSS and the component layer

- `src/styles.css` (the floor/device design system) is imported by
  `src/index.css` into a **`legacy` cascade layer**, never as a second
  un-layered stylesheet. Un-layered CSS beats ALL layered CSS regardless of
  order or specificity, which is why its bare `button { }` used to defeat
  every Tailwind utility in the hub. Layer order is
  `theme, base, legacy, components, utilities` — verify it in the BUILT css
  (`@layer` blocks appear in that order), not in the source.
- `--radius-sm`/`--radius-md` are declared in index.css's **un-layered**
  `:root` because styles.css also declares them and the legacy layer would
  otherwise win. Anything that must beat the legacy layer goes there.
- shadcn's token names (`--color-primary`, `--color-accent`, …) are bound by
  reference to the `--kw-*` values in `@theme inline`. `accent` carries
  shadcn's meaning — the hover tint — so the brand hue is `primary`;
  `primary-strong/-subtle/-text` replaced the old `accent-*` utilities.
- The UI primitives in `src/components/ui/` are shadcn implementations under
  this repo's PascalCase filenames (CLAUDE.md's naming rule wins over
  shadcn's lowercase convention). There is ONE of each — `org/TouchSelect`
  was a second hand-rolled select and is gone.

## Staging state after the wipe

- staging is a **Supabase branch** (`ggdswhusjogumfkplrkm`), not the main
  project (`tlnqzqadqipuwwjopqbu`, whose public schema is empty). Query the
  branch ref, or you will conclude the tables do not exist.
- After the wipe: 1 node, 1 sysadmin, 16 capability types, 5 ranks, and
  **0 persons, 0 positions, 0 holders, 0 capability grants**. Every hub
  screen is legitimately empty — an empty screen here is not a bug, and
  "the log does not render" was this, not a defect.
- `org_capability_history()` is verified working end-to-end as
  `role authenticated` with the real jwt sub: grant + revoke both logged,
  and the definer RPC and a direct `node_capabilities` select agree.
- The history names **"system"** as the actor for every sysadmin action:
  the join is `persons p on p.account_id = nc.created_by` and a sysadmin
  has no `persons` row.
- Writing and reading in ONE statement (a CTE calling `org_set_capability`
  then counting) sees 0 — same-statement snapshot. Use two statements.

## The lifecycle audit (2026-09-19)

- The shape of almost every gap: **the database allowed the edit and nothing
  above it ever called it.** Fourteen exported service functions had zero UI
  callers. Before claiming a feature is missing, check the policy and the
  grant first — the write path usually already exists.
- `grep -rl "\bfnName\b" src --include='*.tsx' | wc -l` is the check. Run it
  after shipping a service function, not before: twice this session I shipped
  one with no caller (updatePosition/abolishPosition, createRank/updateRank).
- Deliberate immutability is NOT a gap, and the guards say so in their own
  error messages. `org_guard_tasks` freezes title/detail/weight/due_at
  ("fixed at assignment"); `handed_across` is insertable only by the seat
  currently holding the work; terminal task and application states are
  terminal. Read the guard before "fixing" one.
- The org camera stack is half-built: `camera_count_minutes`,
  `camera_count_events`, `camera_compliance_events` and `camera_operators`
  have tables, policies and grants and **zero** references in `src/` or the
  Edge Functions. The floor writes the legacy `count_minutes`/`devices`/
  `stations`/`lines` stack instead. Do not build UI onto the org counting
  tables without deciding which stack survives.

## Verifying against the database — traps hit this session

- `reset request.jwt.claims` leaves `''`, which `::json` rejects inside every
  guard. Hit twice. Symptom: the statement raises, the transaction continues,
  and a LATER select reports the OLD value as though the write succeeded.
  Always read the row back before trusting a before/after measurement.
- A `begin;` in a psql `-f` script with no `commit;` is rolled back at EOF, so
  a fixture built that way vanishes and every later assertion silently tests
  an empty database.
- `x = any ((select arr from cte))` is parsed as the SUBQUERY form of ANY and
  compares `uuid = uuid[]`. Hold the array in a plpgsql variable, or inline
  the function call.
- Writing and reading in ONE statement (a CTE that calls a writing function,
  then counts) sees the pre-write snapshot. Use two statements.
- A test that refuses for the WRONG reason proves nothing: capacity 0 hit an
  "at least one" check before ever reaching the booked-count branch it was
  written to exercise. Read the error text, not just the refusal.
- When grepping a function definition across all migrations, the FIRST match
  is usually the oldest. `org_attendance_rows` was rebuilt from the
  pre-hardening copy that way and nearly reverted the 16-hour edge window and
  the `on_site` column. Find every file defining it first.


## Retiring the legacy camera stack (2026-09-19)

- The legacy stack was NOT a thin test-bed. `camera_*` was a column-for-column
  twin of it, but the floor had accumulated seven guarantees after that twin
  was written — line identity, the capture session, one-open-per-STATION,
  clamped `last_evidence_at`, `skew_seconds`, the reaper, and an ending that
  cannot be rewritten. Each exists to stop a SILENT wrong number. Check what a
  twin is missing before calling a migration a rename.
- A multi-transaction migration that FAILS partway commits its earlier
  sections, and the next push replays the whole file against that half-applied
  state. Any statement that reads something the same file later drops has to be
  guarded, or the retry fails somewhere new and looks like a fresh bug.
- Do not re-install or re-grant what an earlier migration owns. Repeating
  `grant ... on all tables in schema cron` against an already-granted schema
  fails 2BP01. Guard on `pg_extension` (installed), not
  `pg_available_extensions` (available).
- pgmq and pg_cron do not exist on a plain Postgres, so the local replay
  harness cannot check the reaper at all. That half is verifiable only on a
  Supabase preview branch — check it there rather than claiming it passed.
- A stubbed counter filing `count: 0` is worse than no counter: on the wall it
  is indistinguishable from a belt that genuinely ran empty. No rows is absence
  of measurement; a zero is a measurement. Keep the session (it asserts the
  camera is RUNNING, not a tally) and file nothing.
- `python3 re.sub` over `config.toml` ate the block after the one it targeted,
  because `(?:(?!\n\[).*\n)*` slid past a blank line. Deleting a named block
  from a config file: match the exact literal text, then assert it was there.
