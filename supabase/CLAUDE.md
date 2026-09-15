Migrations are append-only and UTC-named. Never edit an applied migration; add a
new one. Every table needs RLS enabled in the same migration that creates it.
