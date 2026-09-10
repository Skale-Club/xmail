# drizzle/archive — historical genesis DDL, never to be applied

This directory holds the original `drizzle-kit generate` output from before this project
hand-rolled its migrations in `supabase/migrations/`:

- `0000_dear_wolverine.sql` — the very first schema Drizzle ever generated for this
  project. It predates the multi-tenant `organization_id` model entirely: tables are
  scoped by a `server_id` (a standalone mail server) rather than by organization. The
  application has moved on from that shape many migrations ago (`organization_id` landed,
  the `servers` table itself was later dropped — see `supabase/migrations/008_*.sql`).
- `meta/0000_snapshot.json`, `meta/_journal.json` — drizzle-kit's own bookkeeping for that
  single generated migration. Never tracked by git before this move (`drizzle/meta` was
  gitignored); kept here on disk purely as a companion to the SQL file above, for anyone
  who opens this folder expecting the full drizzle-kit output shape.

**Why it's kept:** it is the only surviving record of production's *original* structure —
useful for archaeology (e.g. understanding why a column or unique index exists that no
later migration ever explicitly created) but actively misleading if run against any
database that has since applied `supabase/migrations/`.

**Why it must never be applied:**

- It targets the pre-`organization_id`, server-scoped schema. Running it against the
  current schema will conflict with tables and columns that have since been renamed,
  dropped, or restructured.
- `CLAUDE.md`'s Schema & Migration Workflow is explicit that `supabase/migrations/NNN_*.sql`
  is the source of truth for the running database, applied in numeric order. This file
  has no place in that sequence — it was never given a supabase-migrations number and
  never will be.
- Some of what it creates (e.g. the `email_provider` enum, the `lead_org_email_unique`
  and `campaign_lead_unique` unique indexes) was never re-created by any numbered
  migration — production has always carried them because it was bootstrapped from this
  exact file. `supabase/migrations/066_reconcile_unique_indexes_and_enums.sql` closes that
  gap idempotently for any database that was NOT bootstrapped this way, so a fresh
  database built purely from `supabase/migrations/*.sql` ends up structurally equivalent
  without ever touching this archive.

**If you're setting up a new environment:** run `supabase/migrations/*.sql` in order via
`scripts/apply-pending-migrations.mjs` (see `CLAUDE.md`). Do not run anything in this
directory.
