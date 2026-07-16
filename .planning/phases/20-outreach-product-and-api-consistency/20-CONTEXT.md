# Phase 20 — Outreach Product and API Consistency

## Outcome

Make the public outreach product describe and operate one coherent model: one canonical sequence per campaign, settings that actually become defaults, bounded list contracts, honest metrics, organization-member UI access, and machine authentication whose identity is chosen by the server.

## Scope

This phase owns requirements `CONS-01` through `CONS-07`. It follows the queue/provider safety work in Phases 18–19 and must reuse their shared delivery-policy gate and test harness rather than inventing parallel mechanisms.

## Locked decisions

### Canonical sequence

- A campaign has exactly one canonical sequence. Existing campaigns keep the oldest sequence (`created_at`, then `id`) and migrate all non-conflicting steps into it before surplus sequences are removed.
- The database enforces one row per campaign with a unique constraint/index on `sequences.campaign_id`.
- Campaign creation and its canonical sequence creation are one database transaction.
- The public write contract replaces the entire ordered step set transactionally. It is idempotent for the same payload and cannot leave a partially edited sequence.
- Step order is one-based. `delay_hours >= 0`; email steps require a subject and at least one body; non-email steps cannot carry sendable content. Any condition payload must be explicitly validated rather than stored as an undocumented shape.
- Existing single-step CRUD may remain only as an internal compatibility path if it delegates to the same validator; the UI uses the replace endpoint.

### Settings

- Persisted organization settings are the source of defaults for new campaigns and new email accounts when a request omits a value.
- Explicit request fields always win over defaults.
- Notification toggles are not allowed to remain decorative: Phase 20 either connects them to the existing reply/bounce/unsubscribe events or removes unsupported controls from both API and UI. The preferred implementation is event-policy consumption.
- Existing rows are not retroactively overwritten when defaults change.

### Lists and metrics

- Lead/campaign list queries use validated, bounded pagination; `limit` never exceeds 100.
- Lead search is server-side, case-insensitive, trimmed, escaped, and searches email, first/last name, company, and title within the selected organization.
- Stable ordering always includes a unique tie-breaker (`created_at DESC, id DESC`).
- Campaign metrics publish named denominators (`eligibleLeads`, `contactedLeads`, `sentEmails`) rather than one overloaded total. Rates use the denominator documented in the response contract and exclude leads suppressed/unsubscribed before any send.

### Access and machine identity

- Platform administration remains behind `AdminCheck`; outreach uses a dedicated authenticated organization-access guard.
- Organization viewers may read; organization admins/members may write, matching backend rules.
- The backend remains authoritative. The frontend guard improves navigation but does not replace route checks.
- `x-service-key` authenticates a server-configured principal and organization scope. Caller-supplied `x-user-id` and caller-selected organization scope are overwritten/rejected.
- Prefer `XMAIL_SERVICE_USER_ID` plus `XMAIL_SERVICE_ORGANIZATION_ID` environment bindings for the existing single orchestrator. Do not create a general API-key product in this phase.

### Database workflow

- Phase 20 reserves migration `040_outreach_product_consistency.sql` after Phase 18/19 reservations; the executor must inspect `supabase/migrations/` immediately before implementation and renumber if another phase landed first.
- SQL migrations are hand-written and are the database source of truth; mirror constraints/indexes in `src/db/schema.ts`.
- Never run `drizzle-kit generate`, `npm run db:generate`, or `db:push`.
- Automated migration verification must run only through the Phase 18 protected PostgreSQL harness, passing its guarded test URL explicitly; tests must never read or fall back to application `DATABASE_URL`. Manual production rollout uses PowerShell: `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/NNN_outreach_product_consistency.sql`.

## Test boundary

- Use the automated test harness established by Phase 18.
- Include route-level tests for cross-tenant denial, role behavior, service-principal binding, sequence replacement rollback/idempotency, bounded search, and metric cohorts.
- Build, lint, schema-drift audit, and a disposable-database migration smoke test are mandatory before completion.

## Out of scope

- Unified Inbox persistence and APIs (Phase 21).
- Unified Inbox interaction UI (Phase 22).
- AI automation controls (Phase 23).
- A multi-key API credential management product.
