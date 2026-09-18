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
