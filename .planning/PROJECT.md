# SkaleClub Mail — Outreach System

## What This Is

SkaleClub Mail is a multi-tenant email server management platform. The outreach module provides cold email campaign tooling: leads management, email sequence building, campaign orchestration, reply/bounce detection, and analytics. After hardening DB layer in v1.1, focus shifts to security, correctness, and tooling hygiene revealed by the 2026-05-16 system-wide audit.

## Current State

**Latest shipped:** v1.2 — Security & Tech Debt Remediation (2026-05-16). All 27 requirements satisfied across 5 phases (21 plans). See [`MILESTONES.md`](MILESTONES.md) and [`v1.2-MILESTONE-AUDIT.md`](v1.2-MILESTONE-AUDIT.md).

**Current milestone:** None — run `/gsd:new-milestone` to start v1.3.

## Next Milestone Goals (v1.3 candidates)

- Error log sink (Sentry / Datadog / structured stdout) — deferred from v1.2 CI-04.
- Per-user rate limiting (replace per-IP limiter).
- Persistent webhook dead-letter queue.
- Drizzle migration regeneration / full schema sync.
- Testing framework setup (Vitest + Supertest).
- Email warm-up automation (sending logic).

## Core Value

A user can create a campaign, build a sequence, add leads, and have emails actually sent and tracked — with replies and bounces correctly detected and handled.

## Requirements

### Validated

- ✓ Email account (inbox) CRUD with SMTP/IMAP connection verification — v1.0
- ✓ Campaign CRUD (create, edit, pause, activate, archive) — v1.0
- ✓ Sequence and step CRUD at the API level — v1.0
- ✓ Lead and lead list CRUD with bulk import — v1.0
- ✓ Outreach dashboard with live stats (open rate, click rate, reply rate) — v1.0
- ✓ Send window enforcement (time-of-day and weekday-only) — v1.0
- ✓ Daily send limit per email account — v1.0
- ✓ Suppression list (unsubscribes honored before sending) — v1.0
- ✓ Open/click tracking injection (pixel + URL rewriting) — v1.0
- ✓ A/B testing schema fields on sequence steps — v1.0
- ✓ Unsubscribe endpoint and flow — v1.0
- ✓ Campaign completion detection (mark complete when all leads finish) — v1.0
- ✓ Outlook OAuth sending via `sendMessageWithOutlook` — v1.0
- ✓ NewSequencePage connected to API with correct field names — v1.0
- ✓ processOutreachSequences uses outreach-sender.ts (no duplication) — v1.0
- ✓ A/B variant selection in sequence processor — v1.0
- ✓ processReplies.ts migrated to imapflow — v1.0
- ✓ Consistent api-client.ts usage across outreach pages — v1.0
- ✓ TypeScript errors resolved — v1.0
- ✓ Cron concurrency guard — v1.0
- ✓ RLS policies fixed — org-scoped with is_org_member, no server references — v1.1 Phase 05
- ✓ Safe index migration workflow (CREATE INDEX CONCURRENTLY) — v1.1 Phase 05
- ✓ Index health verification script — v1.1 Phase 05
- ✓ All FK columns indexed (48 indexes across 28 tables) — v1.1 Phase 06
- ✓ Composite performance indexes (org+status, campaign+status, token, nextScheduledAt) — v1.1 Phase 06
- ✓ Shared pagination utility + all list endpoints paginated — v1.1 Phase 07
- ✓ PaginationControls component on all outreach list pages — v1.1 Phase 07
- ✓ processQueue.ts batch-loads messages/orgs (3N→3 queries) — v1.1 Phase 08
- ✓ List endpoints exclude htmlBody/plainBody from SELECT — v1.1 Phase 08
- ✓ Outreach sequences batch-load suppressions/idempotency — v1.1 Phase 08
- ✓ CHECK constraints on sequenceSteps (delayHours >= 0, stepOrder >= 1) — v1.1 Phase 09
- ✓ Old migration file deprecated with comment header — v1.1 Phase 09
- ✓ Cascade delete transactional + cross-org user preservation — v1.2 Phase 10 (CRIT-01)
- ✓ `/health/ready` returns 503 on DB failure — v1.2 Phase 10 (CRIT-02)
- ✓ `/test-connection` auth + SSRF + rate-limit — v1.2 Phase 10 (CRIT-03)
- ✓ RLS doc honesty + `access.ts` consolidation — v1.2 Phase 10 (CRIT-04)
- ✓ Centralized SSRF guard (`network-guard.ts`) — v1.2 Phase 11 (SEC-01)
- ✓ IMAP TLS hardening + per-mailbox `skipTlsVerify` — v1.2 Phase 11 (SEC-02)
- ✓ JWT auth cache (60s LRU+TTL) — v1.2 Phase 11 (SEC-03)
- ✓ Cron jobs use Postgres advisory locks — v1.2 Phase 11 (SEC-04)
- ✓ Webhook timeout + retry/backoff + attempts counter — v1.2 Phase 12 (COR-01, COR-02)
- ✓ Click tracking replay dedup (60s window) — v1.2 Phase 12 (COR-03)
- ✓ Outreach global-toggle Zod + audit response — v1.2 Phase 12 (COR-04)
- ✓ `/move` folder ownership validation — v1.2 Phase 12 (COR-05)
- ✓ Suppression integration in `POST /messages` — v1.2 Phase 12 (COR-06)
- ✓ ESLint config + zero-warning baseline — v1.2 Phase 12 (COR-07)
- ✓ `tsc --noEmit` zero errors (both configs) — v1.2 Phase 13 (QUA-01)
- ✓ Migration 013 archived + schema workflow doc — v1.2 Phase 13 (QUA-02)
- ✓ RLS consolidation migration 020 — v1.2 Phase 13 (QUA-03)
- ✓ Domain name lowercase normalize + backfill — v1.2 Phase 13 (QUA-04)
- ✓ CSP hardened (frame-ancestors, object-src, base-uri) — v1.2 Phase 13 (QUA-05)
- ✓ PII logs gated behind `if (!isProd)` — v1.2 Phase 13 (QUA-06)
- ✓ authLimiter recalibrated to 10/15min — v1.2 Phase 13 (QUA-07)
- ✓ Schema fields camelCase (ownerId, outreachEnabled) — v1.2 Phase 13 (QUA-08)
- ✓ mail-diag testEmail from query param — v1.2 Phase 14 (CLN-01)
- ✓ Repo cleanup (nul + scripts/_) — v1.2 Phase 14 (CLN-02)
- ✓ Vite build warning suppressed — v1.2 Phase 14 (CLN-03)
- ✓ `MAX_WEBHOOK_RESPONSE_BODY` constant extracted — v1.2 Phase 14 (CLN-04)
- ✓ CI lint + tsc gates active — v1.2 Phase 14 (CI-01, CI-02)
- ✓ `/health/ready` runbook (`docs/runbook.md`) — v1.2 Phase 14 (CI-03)
- ✓ Error log sink decision recorded (deferred to v1.3) — v1.2 Phase 14 (CI-04)

### Active

v1.2 complete. Next milestone requirements TBD via `/gsd:new-milestone`.

### Out of Scope

- Email warm-up automation — schema fields exist but warm-up sending logic is not built; deferred
- New outreach features (templates library, AI copywriting, multi-channel) — improvements only, not net-new features
- Testing framework setup — no tests currently exist across the whole app; deferred to separate initiative
- MailLayout `openCompose` prop error — belongs to mail module, not outreach; tracked separately

## Context

- The outreach system is large (~7600 lines across 20+ files) and was partially built — backend routes are solid, jobs have logic but with duplication and gaps (v1.0 resolved)
- Two API client utilities coexisted: `src/lib/api.ts` and `src/lib/api-client.ts` — v1.0 consolidated to `api-client.ts`
- `outreach-sender.ts` was created as a shared sending module; v1.0 eliminated duplication in `processOutreachSequences.ts`
- All IMAP code now uses `imapflow` after v1.0 migration of `processReplies.ts`
- Codebase uses Supabase (PostgreSQL) with Drizzle ORM — no indexes beyond PKs, frequent N+1 query patterns, pages load all rows without pagination

## Constraints

- **Tech stack**: Express 5 beta, React 18, Drizzle ORM, Supabase — no changes to stack
- **Auth**: All outreach API routes go through `isPlatformAdmin` middleware; this pattern must be preserved
- **DB**: Schema changes require `npm run db:generate` + `npm run db:push`
- **Scale**: Personal project with small dataset — focus is on fundamentals (indexes, query patterns), not horizontal scaling

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Consolidate job to use outreach-sender.ts | Eliminates ~100 lines of duplicated logic; ensures Outlook support is automatic | ✓ v1.0 |
| Migrate processReplies.ts to imapflow | Matches all other IMAP code; single library to maintain | ✓ v1.0 |
| Sequence creation tied to campaign | Data model requires it; UI flow must reflect this constraint | ✓ v1.0 |
| Use lib/api-client.ts across all outreach pages | Consistent error handling and retry logic vs lib/api.ts | ✓ v1.0 |
| Module-level isSequenceProcessing flag | Prevents cron overlap without DB locks; .finally() resets unconditionally | ✓ v1.0 |
| Consolidate is_outreach_org_member into is_org_member | Identical function body; reduces maintenance surface | ✓ v1.1 Phase 05 |
| RLS is defense-in-depth, JS-side is source of truth | App connection uses `DATABASE_URL` role that bypasses RLS; every route must call `checkAccess` | v1.2 Phase 10 (C4) |
| Centralize SSRF guard in `network-guard.ts` | Webhooks, click tracking, IMAP/SMTP test connection all need it — DRY | v1.2 Phase 11 |
| Postgres advisory locks for cron jobs | Multi-instance safe without external infra (Redis); leverages existing DB | v1.2 Phase 11 |
| Defer Drizzle migration regeneration | Schema drift is too large; team-of-one writes manual SQL in `supabase/migrations/`. Document the pattern; deprecate `db:generate` workflow rather than producing a massive auto-diff | v1.2 Phase 13 |
| Defer error log sink (Sentry/Datadog) to v1.3 | Requires budget + ops infra decision (vendor selection, retention policy, PII handling). `/health/ready` (CRIT-02) plus CI lint + `tsc --noEmit` gates (CI-01, CI-02) provide the v1.2 first-line defense. Avoid premature commitment to a vendor before observability requirements are scoped. | v1.2 Phase 14 — CI-04 deferred; tracked in `Future Requirements` for v1.3 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-16 — v1.2 Security & Tech Debt Remediation shipped & archived*
