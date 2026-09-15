# Kwook Line Vision

Seaweed leaf counting, PPE compliance and station supervision.

Phones mounted at stations run this app in the browser, analyse their own camera
feed on-device, and send **results** — not video. A Cloudflare Worker serves the
app and ingests those results; Supabase stores them; GitHub gates every deploy.

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
