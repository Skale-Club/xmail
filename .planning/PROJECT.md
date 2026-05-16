# SkaleClub Mail — Outreach System

## What This Is

SkaleClub Mail is a multi-tenant email server management platform. The outreach module provides cold email campaign tooling: leads management, email sequence building, campaign orchestration, reply/bounce detection, and analytics. After hardening DB layer in v1.1, focus shifts to security, correctness, and tooling hygiene revealed by the 2026-05-16 system-wide audit.

## Current Milestone: v1.2 Security & Tech Debt Remediation

**Goal:** Eliminate the 4 CRITICAL + 12 HIGH + 13 MEDIUM + 5 LOW issues from the 2026-05-16 audit so the system is secure, correct, and CI-enforceable.

**Target outcomes:**
- Cascade delete is transactional and complete (no orphans, no cross-org password lockouts)
- Health check correctly reports DB failures
- All externally-controlled URLs validated through a centralized SSRF guard
- Cron jobs are multi-instance safe (Postgres advisory locks)
- JWT validation cached (perf + cost)
- Suppression list integrated into POST /messages
- `npm run lint` and `npx tsc --noEmit` pass with zero warnings; both enforced in CI
- RLS posture documented honestly; CSP hardened

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

### Active

See `.planning/REQUIREMENTS.md` for v1.2 requirements (CRIT-01..04, SEC-01..04, COR-01..07, QUA-01..08, CLN-01..04, CI-01..04).

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
*Last updated: 2026-05-16 — starting v1.2 Security & Tech Debt Remediation (post-audit)*
