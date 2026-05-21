# Roadmap: SkaleClub Mail — Database Health (v1.1)

**Milestone:** v1.1 — Database Health
**Created:** 2026-03-31
**Granularity:** coarse
**Requirements:** 19 v1 requirements
**Phases:** 5 (continuing from v1.0 phase 04)

---

## Phases

- [x] **Phase 05: RLS & Migration Safety** — Fix broken RLS policies and establish safe index migration workflow (completed 2026-03-31)
- [x] **Phase 06: Index Foundation** — Add all FK and composite indexes to schema.ts, apply via CONCURRENTLY (completed 2026-04-01)
- [x] **Phase 07: Pagination** — Add paginated responses to all list endpoints (completed 2026-04-01)
- [x] **Phase 08: Query Optimization** — Fix N+1 patterns, add column filtering, scope unbounded queries (completed 2026-04-01)
- [x] **Phase 09: Schema Hardening** — Add CHECK constraints, deprecate old migration file (completed 2026-04-01)

---

## Phase Details

### Phase 05: RLS & Migration Safety
**Goal:** Data isolation between organizations is verified and index migrations can be applied safely without blocking writes
**Depends on:** Nothing (prerequisite for all other phases)
**Requirements:** DBS-01, DBS-02, DBS-03
**Success Criteria** (what must be TRUE):
  1. RLS policies no longer reference the removed `servers` table — verified by inspecting the migration SQL
  2. A user in one organization cannot read or modify another organization's data — verified by testing with two org accounts
  3. `npm run db:indexes` script executes `sql/indexes.sql` containing `CREATE INDEX CONCURRENTLY` statements
  4. Invalid indexes (where `indisvalid = false`) are automatically detected, dropped, and retried by the verification script
**Plans:** 2/2 plans complete

Plans:
- [x] 05-01-PLAN.md — Fix RLS policies (migration 016 + verification script) — DBS-01
- [x] 05-02-PLAN.md — Safe index migration workflow (sql/indexes.sql + verify script) — DBS-02, DBS-03

### Phase 06: Index Foundation
**Goal:** All foreign key and composite query columns are indexed so that no query performs a full sequential scan
**Depends on:** Phase 05
**Requirements:** IDX-01, IDX-02, IDX-03, IDX-04, IDX-05, IDX-06
**Success Criteria** (what must be TRUE):
  1. Every FK column (`organizationId`, `campaignId`, `serverId`, `domainId`, `credentialId`, `routeId`, `webhookId`, `leadListId`) has an index across all org-scoped tables
  2. Dashboard stats query (`messages WHERE organizationId = ? AND status = ?`) returns in under 100ms with EXPLAIN ANALYZE showing index usage
  3. Campaign lead status counts (`campaignLeads WHERE campaignId = ? AND status = ?`) return in under 100ms
  4. Send pipeline cron query filters on `nextScheduledAt` without scanning all leads — verified with EXPLAIN ANALYZE
  5. Open/click tracking lookup by `messages.token` returns in under 10ms
  6. All index definitions exist in `src/db/schema.ts` using Drizzle `index()` API — `013_add_performance_indexes.sql` is superseded
**Plans:** 2/2 plans complete

### Phase 07: Pagination
**Goal:** All list endpoints return paginated results so that page loads don't degrade as data grows
**Depends on:** Phase 06
**Requirements:** PAGE-01, PAGE-02, PAGE-03, PAGE-04, PAGE-05
**Success Criteria** (what must be TRUE):
  1. `GET /api/outreach/campaigns` returns `{ items, pagination: { page, pageSize, total } }` instead of all rows
  2. `GET /api/outreach/leads` returns paginated results
  3. `GET /api/outreach/lead-lists` returns paginated results
  4. `GET /api/email-accounts` returns paginated results
  5. `GET /api/outreach/sequences` returns paginated results
  6. List endpoints accept `?page=1&pageSize=25` query parameters and return correct `total` count
**Plans:** 2/2 plans complete

Plans:
- [x] 07-01-PLAN.md — Shared pagination utility + server-side pagination (campaigns, lead-lists, email-accounts, sequences) — PAGE-01, PAGE-03, PAGE-04, PAGE-05
- [x] 07-02-PLAN.md — Frontend pagination controls (all outreach list pages) — PAGE-01, PAGE-02, PAGE-03, PAGE-04, PAGE-05

### Phase 08: Query Optimization
**Goal:** Background jobs and list endpoints load data efficiently with no N+1 patterns and no oversized payloads
**Depends on:** Phase 06, Phase 07
**Requirements:** QRY-01, QRY-02, QRY-03
**Success Criteria** (what must be TRUE):
  1. `processQueue.ts` batch-loads all needed messages and organizations before the delivery loop — 2 queries instead of 3*N (verified by logging query count)
  2. List endpoints exclude `htmlBody`, `plainBody`, and other large text columns from SELECT — response payload sizes reduced (verified by comparing before/after)
  3. `processOutreachSequences` lead query includes `WHERE nextScheduledAt <= now()` and uses the index from Phase 06 — no full table scan (verified with EXPLAIN ANALYZE)
  4. Suppression and idempotency checks batch-loaded before lead loop (2 queries instead of 2*N)
  5. Cascade.ts, messages.ts POST, and processHeld.ts use batch queries instead of per-item loops
**Plans:** 4/4 plans complete

Plans:
- [x] 08-01-PLAN.md — processQueue.ts N+1 fix (batch-load messages + orgs) — QRY-01
- [ ] 08-02-PLAN.md — Column filtering on list endpoints (exclude large text columns) — QRY-02
- [ ] 08-03-PLAN.md — Outreach sequences N+1 fixes (suppression, idempotency, limit, markCompleted) — QRY-03
- [ ] 08-04-PLAN.md — Other N+1 fixes (cascade, delivery inserts, held updates) — QRY-01, QRY-03

### Phase 09: Schema Hardening
**Goal:** Database constraints prevent invalid data and the old migration file is properly deprecated
**Depends on:** Nothing (independent, last to avoid schema.ts merge conflicts)
**Requirements:** SCH-01, SCH-02
**Success Criteria** (what must be TRUE):
  1. `sequenceSteps.delayHours` rejects negative values — insert of -1 fails with constraint violation (verified by testing)
  2. `sequenceSteps.stepOrder` rejects values less than 1 — insert of 0 fails with constraint violation (verified by testing)
  3. `supabase/migrations/013_add_performance_indexes.sql` has a deprecation comment header explaining that indexes are now managed via Drizzle schema.ts
**Plans:** 1/1 plans complete

Plans:
- [ ] 09-01-PLAN.md — CHECK constraints on sequenceSteps + deprecate old migration — SCH-01, SCH-02

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 05. RLS & Migration Safety | 2/2 | Complete    | 2026-03-31 |
| 06. Index Foundation | 1/2 | Complete    | 2026-04-01 |
| 07. Pagination | 2/2 | Complete    | 2026-04-01 |
| 08. Query Optimization | 1/4 | Complete    | 2026-04-01 |
| 09. Schema Hardening | 0/1 | Complete    | 2026-04-01 |

---

## Coverage

| Requirement | Phase | Status |
|-------------|-------|--------|
| DBS-01 | Phase 05 | Pending |
| DBS-02 | Phase 05 | Pending |
| DBS-03 | Phase 05 | Pending |
| IDX-01 | Phase 06 | Pending |
| IDX-02 | Phase 06 | Pending |
| IDX-03 | Phase 06 | Pending |
| IDX-04 | Phase 06 | Pending |
| IDX-05 | Phase 06 | Pending |
| IDX-06 | Phase 06 | Pending |
| PAGE-01 | Phase 07 | Pending |
| PAGE-02 | Phase 07 | Pending |
| PAGE-03 | Phase 07 | Pending |
| PAGE-04 | Phase 07 | Pending |
| PAGE-05 | Phase 07 | Pending |
| QRY-01 | Phase 08 | Pending |
| QRY-02 | Phase 08 | Pending |
| QRY-03 | Phase 08 | Pending |
| SCH-01 | Phase 09 | Pending |
| SCH-02 | Phase 09 | Pending |

**Coverage: 19/19 requirements mapped ✓**

### Phase 14: Outreach P0 fixes (milestone v1.3 — Outreach Hardening)

**Goal:** Make the outreach module functional end-to-end and compliant with bulk-sender requirements (Gmail/Yahoo, CAN-SPAM, GDPR). Close the 11 P0 findings from `.planning/debug/outreach-system-deep-audit.md` (2026-05-16, including the user-reported P0-11 "tela preta" bug appended on the same day).
**Requirements:** P0-01, P0-02, P0-03, P0-04, P0-05, P0-06, P0-07, P0-08, P0-09, P0-10, P0-11 (treated as requirement IDs since REQUIREMENTS.md predates this phase)
**Depends on:** Phases 10-13 (v1.2 mail server stack — merged in `3bcc241`)
**Plans:** 6/6 plans complete

Plans:
- [x] 14-01-PLAN.md — Fix middleware 403 (P0-04) — unblocks every other plan
- [x] 14-02-PLAN.md — NewCampaignPage + route (P0-11)
- [x] 14-03-PLAN.md — Migration 020 + schema cascade FKs + new columns (P0-10 schema, P0-02 prereq, P0-07 prereq)
- [x] 14-04-PLAN.md — addLeadsToCampaign fixes + deleteCampaign tx wrap (P0-01, P0-09, P0-10 code)
- [x] 14-05-PLAN.md — HMAC tokens, unsubscribe mount, List-Unsubscribe headers, tracking fork (P0-02, P0-03)
- [x] 14-06-PLAN.md — Processor idempotency + advisory lock + bounce SQL fix + suppression writes (P0-05, P0-06, P0-07, P0-08)

> **Note:** Numbered 14 to follow v1.2's phases 10-13 (mail server hardening, code-merged 2026-04-15). ROADMAP.md here is the residual v1.1 doc — v1.2/v1.3 phase scaffolding lives under `.planning/phases/` while the formal roadmap rewrite is pending. See STATE.md for current milestone status.

### Phase 15: Campaign detail page (frontend)

**Goal:** Build the missing `/outreach/campaigns/:id` detail page so the funnel from create → manage → activate is end-to-end functional. CampaignsPage links and OutreachDashboard links currently lead to a route that doesn't exist in `src/main.tsx`. Backend endpoints already exist (campaigns/:id, /leads, /sequences, /stats) — this is a frontend completion. Multi-tab UI (Overview / Leads / Sequence / Stats) with optimistic updates. CONTEXT.md is pre-authored.
**Requirements:** UI-COMPLETION (detail page) + UX-NEXT (post-create redirect updated)
**Depends on:** Phase 14
**Plans:** 3/3 plans complete

Plans:
- [x] 15-01-PLAN.md — Route + page skeleton + Overview tab + NewCampaignPage redirect — UI-COMPLETION, UX-NEXT
- [x] 15-02-PLAN.md — Leads tab (paginated table + Add Leads modal) — UI-COMPLETION
- [x] 15-03-PLAN.md — Sequence tab + Stats tab (read-only views, no charts) — UI-COMPLETION

### Phase 16: Reply detection v2 + per-inbox throttle

**Goal:** Two related fixes to the outreach job loop. (A) Reply detection v2: 3-tier matching (In-Reply-To → References → from-address heuristic) + auto-reply filter (Auto-Submitted, Precedence, OOO subject) so auto-replies don't stop sequences and lead replies from related aliases are correctly matched. (B) Per-inbox throttle: respect `email_accounts.minMinutesBetweenEmails`/`maxMinutesBetweenEmails` (currently unused → burst sends → spam folder); add `last_sent_at` column via migration 021; apply jitter on scheduling. Single biggest deliverability risk in the system today.
**Requirements:** REPLY-DETECT-V2 + INBOX-THROTTLE + AUTO-REPLY-FILTER
**Depends on:** Phase 15 (no code dependency, just sequencing)
**Plans:** 4/4 plans complete

Plans:
- [x] 16-01-PLAN.md — Migration 021 (email_accounts.last_sent_at) + applySendJitter helper + extend canSendFromAccount — INBOX-THROTTLE
- [x] 16-02-PLAN.md — Wire per-inbox throttle + jitter + structured skip logs in processOutreachSequences.ts — INBOX-THROTTLE
- [x] 16-03-PLAN.md — Rewrite processReplies.ts: 3-tier matcher + auto-reply filter + IMAP SINCE cap + structured logs — REPLY-DETECT-V2, AUTO-REPLY-FILTER
- [x] 16-04-PLAN.md — Explicit timezone: 'UTC' on resetDailyLimits cron in jobs/index.ts — INBOX-THROTTLE

### Phase 17: Observability foundation

**Goal:** Make the outreach system OPERATIONALLY LEGIBLE. Adopt `pino` for structured JSON logging across all outreach paths (sender, processor, replies, bounces, unsubscribe, track); standardize log shape `{action: "outreach.<area>.<event>", ...context}`; build `/api/admin/outreach/health` endpoint with per-org and per-campaign rolling-window metrics (sent/open/click/bounce/reply rates, processor p50/p95); add daily 09:00 UTC digest cron logging top campaigns + alerts. NO email/slack notifications, NO Prometheus — keep it free and grep-able for now. CONTEXT.md is pre-authored.
**Requirements:** STRUCTURED-LOGS + HEALTH-ENDPOINT + DAILY-DIGEST
**Depends on:** Phase 16
**Plans:** 4/4 plans complete

Plans:
- [x] 17-01-PLAN.md — Create logger.ts (pino + thresholds) and add pino + pino-pretty deps — STRUCTURED-LOGS
- [x] 17-02-PLAN.md — Swap all console.* in outreach paths for pino + add tick timing — STRUCTURED-LOGS
- [x] 17-03-PLAN.md — Build GET /api/admin/outreach/health endpoint + outreach-metrics.ts helper + sent_at/status index — HEALTH-ENDPOINT
- [x] 17-04-PLAN.md — dailyOutreachDigest cron at 09:00 UTC (log-only) — DAILY-DIGEST

---

## Dependency Chain

```
Phase 05 (RLS & Migration Safety)
    ↓
Phase 06 (Index Foundation)
    ↓
Phase 07 (Pagination) ──→ Phase 08 (Query Optimization)
                               ↑
Phase 09 (Schema Hardening) ───┘  (independent)
```

Phase 09 is independent — it can run in parallel with any other phase but is ordered last to avoid merge conflicts in schema.ts.
