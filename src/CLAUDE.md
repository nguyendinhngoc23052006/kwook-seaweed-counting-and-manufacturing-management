Components render, `lib/` validates and talks to Supabase, `vision/` is pure
functions only — no DOM, no network — so it stays testable without a camera.
