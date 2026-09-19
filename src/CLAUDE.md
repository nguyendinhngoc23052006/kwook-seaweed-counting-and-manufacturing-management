Components render, `lib/` validates and talks to Supabase.

`vision/` is gone: the hand-rolled Otsu/morphology/connected-components counter
was retired with the move to the org camera stack (20261005000000), and its
replacement is being built on OpenCV, MediaPipe and ONNX Runtime Web. Until one
exists, `Capture.tsx` runs the camera and holds a session but files no counts —
absence of measurement, never a measured zero.

`lib/outbox.ts` and `lib/minuteRowId.ts` have no caller for the same reason.
They are kept deliberately: `minuteRowId` is rule 4's deterministic
`(device, minute)` id and `outbox` is the offline durability around it, both of
which any counter must use. Whatever replaces the vision core writes through
them rather than around them.
