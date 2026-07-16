# Phase 18 Research — Existing State and Implementation Notes

## Confirmed implementation facts

- `organizations.outreachEnabled` exists and system routes mutate it, but neither `processOutreachSequences`, `processFollowUps`, nor `/api/outreach/send-message` reads it.
- `processOutreachSequences` loads at most 200 due `campaign_leads` without `orderBy`. It then skips blocked accounts/windows in memory, leaving the same rows due for the next tick.
- The processor calls `sendOutreachEmail` for `currentStep` without checking `sequenceSteps.type`. `subject || ''` and nullable bodies allow a `delay` or `condition` row to become a blank provider dispatch.
- The unique `(campaign_lead_id, sequence_step_id)` index prevents a second insert, but a failed or stale `queued` row can never be claimed again. There are no lease, attempt, backoff, or dispatch-ambiguity columns.
- The existing advisory lock prevents concurrent processor ticks but does not solve container death between claim, provider call, and success update.
- `markCompletedCampaigns` exists but is not called by the scheduler. Its `status NOT IN (...)` predicate considers a normally contacted lead incomplete even when `completed_at` is set.
- `/api/outreach/send-message` is native-only and deliberately bypasses daily/warm-up state. `processFollowUps` checks suppression/window but bypasses organization enablement, daily allowance, warm-up, spacing, and durable send history.
- `package.json` has no `test` script or test runner.

## Recommended state model

The logical send remains one `outreach_emails` row. Add:

- `origin` text/enum-like check
- `idempotency_key` text, unique with `organization_id`
- `to_address` text (backfilled from the campaign lead for existing rows)
- `attempt_count` integer, default 0
- `max_attempts` integer, default 3
- `next_attempt_at` timestamp
- `lease_token` uuid/text
- `lease_expires_at` timestamp
- `dispatch_started_at` timestamp
- `last_attempt_at` timestamp
- `last_error_code` text

Reuse existing message statuses:

- `queued`: eligible/leased work not yet known to have been accepted
- `sent`: provider accepted and message metadata persisted
- `failed`: known retryable or terminal failure; `next_attempt_at` distinguishes retryable
- `held`: ambiguous post-dispatch state requiring reconciliation/manual release

Strict exactly-once delivery cannot be guaranteed by ordinary SMTP after a worker dies following remote acceptance. The safe invariant is therefore: never automatically retry a stale row once `dispatch_started_at` is set. This prevents duplicate sends at the cost of surfacing an ambiguous held record.

To make this the common ledger, migration 038 also makes campaign/lead/step and tracking-token fields nullable for non-campaign origins, guarded by a check requiring all campaign fields for `origin='campaign'`. `agentic` requires campaign and campaign-lead but no sequence step; `manual`/`unified_inbox` use `to_address` plus the organization-scoped idempotency key. Existing campaign rows remain fully linked.

## Fair selection strategy

Use a DB query that selects eligible campaign-lead IDs ordered by `next_scheduled_at, id`, limits the number selected per `assigned_email_account_id`, and filters active campaigns, verified accounts, and enabled organizations before the application hydration query. For temporary blocks, persist a specific future `next_scheduled_at` (window reopening, spacing deadline, or next UTC daily reset). This keeps a permanently blocked account from filling the first 200 rows.

## Test strategy

- Vitest projects cover server `.ts` tests in Node, frontend `.tsx` tests in jsdom with Testing Library React/jest-dom, and PostgreSQL integration tests in Node.
- `npm run test -- <arquivo>` is the canonical targeted command for all projects; `npm run test` runs the complete suite.
- Pure unit tests cover step transition, retry classification/backoff, and policy denial codes.
- Repository/provider interfaces are injected into the dispatcher so most crash/recovery paths need neither PostgreSQL nor SMTP.
- Database integration tests use `@testcontainers/postgresql` to create and destroy a dedicated `xmail_test_*` database. The harness accepts only its generated URL (or an explicitly supplied local URL whose database name contains `test`), rejects equality with the pre-existing `DATABASE_URL`, rejects non-loopback hosts for overrides, sets a per-run guard marker, applies migrations only to that guarded URL, and tears the container down in `globalTeardown` even after test failure. There is no fallback to application `DATABASE_URL`.
- A migration integration test applies migration 038 twice to the disposable database and runs schema assertions without reading application `DATABASE_URL`.
- Build and lint remain mandatory phase-level gates.

## Migration discipline

Create `supabase/migrations/038_outreach_dispatch_state_machine.sql` manually and mirror columns/indexes/checks in `src/db/schema.ts`. The executable production apply command is:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/038_outreach_dispatch_state_machine.sql
```

Do not use `drizzle-kit generate`, `npm run db:generate`, or `db:push`.
