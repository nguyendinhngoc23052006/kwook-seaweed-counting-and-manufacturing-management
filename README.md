# Kwook Line Vision

Seaweed leaf counting, PPE compliance and station supervision — plus the `/org`
management hub that runs the people who run those stations.

Phones mounted at stations run this app in the browser, analyse their own camera
feed on-device, and send **results** — not video. A Cloudflare Worker serves the
app and ingests those results; Supabase stores them; GitHub gates every deploy.

## `/org` — the management hub

| Section | What it's for |
|---|---|
| Org tree / chart | Seats, reporting lines, who holds what |
| Cameras | Capability-gated device/station admin (the older surface) |
| Hiring | Job postings, applications, interview slot scheduling |
| Work | Task assignment, with a comment thread per task |
| Notifications | In-app, fed by task events, comments, and capability changes |
| Profile | The signed-in person's own record |

Authority is seat-based (`persons`/`positions`/`position_holders`), and access
is capability-based (`node_capabilities`, reached via
`org_capability_reaches()`) — see `CLAUDE.md` for the full model. The public
careers site (`/jobs/:jobId`, `/jobs/:jobId/apply`) and the interview-booking
link sent to candidates are unauthenticated and live in a separate router
(`PublicJobsApp.tsx`).

## Stack

| Layer | Tool |
|---|---|
| Written by | Claude Code |
| Gated and deployed by | GitHub Actions |
| Data | Supabase (Postgres, Auth, RLS) |
| Served by | Cloudflare Workers |
| Video fan-out | Cloudflare Realtime (SFU + TURN) |

## Device roles

| Role | What it does |
|---|---|
| `counting` | Belt line-crossing counter — tracks blobs, counts forward crossings, aggregates per minute |
| `provisioning` | Tray snapshot counter — Otsu threshold, connected components, cluster splitting by median leaf area |
| `compliance` | Doorway PPE check on entry |
| `overview` | Continuous stream to the wall |

A device's role comes from its own database row, never from the URL.

## Local commands

```
npm install
npm run dev
npm test
npm run lint
npm run typecheck
npm run build
```

Copy `.env.example` to `.env` and fill both `VITE_` values from the Supabase
dashboard (Project Settings → API).
