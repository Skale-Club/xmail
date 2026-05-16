---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: milestone
status: executing
stopped_at: Completed 12-03-PLAN.md (COR-04 closed)
last_updated: "2026-05-16T22:53:33.607Z"
last_activity: 2026-05-16
progress:
  total_phases: 5
  completed_phases: 2
  total_plans: 12
  completed_plans: 11
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-16)

**Core value:** A user can create a campaign, build a sequence, add leads, and have emails actually sent and tracked — with replies and bounces correctly detected and handled.
**Current focus:** Phase 12 — high-correctness

## Current Position

Phase: 12 (high-correctness) — EXECUTING
Plan: 3 of 5
Status: Ready to execute
Last activity: 2026-05-16

Progress: [░░░░░░░░░░] 0%

### Phase List

- [ ] **Phase 10:** CRITICAL Fixes (CRIT-01, CRIT-02, CRIT-03, CRIT-04)
- [ ] **Phase 11:** HIGH Security Posture (SEC-01, SEC-02, SEC-03, SEC-04)
- [ ] **Phase 12:** HIGH Correctness & Validation (COR-01..07)
- [ ] **Phase 13:** MEDIUM Consolidation (QUA-01..08)
- [ ] **Phase 14:** LOW Cleanup + CI/Observability (CLN-01..04, CI-01..04)

## Performance Metrics

**Velocity:**

- Total plans completed v1.0+v1.1: 17
- Average duration: -
- Total execution time: -

**v1.2 Progress:**

| Phase | Plans | Status |
|-------|-------|--------|
| 10-critical-fixes | 3 | Pending |
| 11-high-security | 4 | Pending |
| 12-high-correctness | 5 | Pending |
| 13-medium-consolidation | 6 | Pending |
| 14-low-and-ci | 3 | Pending |
| Phase 10-critical-fixes P02 | 6 min | 2 tasks | 3 files |
| Phase 10-critical-fixes P03 | 8 min | 2 tasks | 9 files |
| Phase 10-critical-fixes P01 | 6 min | 2 tasks | 2 files |
| Phase 11-high-security P02  | 4 min | 4 tasks | 3 files |
| Phase 11-high-security P01  | 10 min | 4 tasks | 4 files |
| Phase 11-high-security P04  | 8 min | 3 tasks | 2 files |
| Phase 11-high-security P03  | 5 min | 2 tasks | 1 file (wire-up; helper landed earlier in ebae465) |
| Phase 12-high-correctness P01 | 3 min | 3 tasks | 2 files |
| Phase 12 P02 | ~3min | 4 tasks | 3 files |
| Phase 12 P03 | 4 min | 3 tasks | 1 files |

## Accumulated Context

### Decisions

Carried over from v1.1 + new for v1.2:

- **RLS is defense-in-depth, JS-side is source of truth** — App connection uses `DATABASE_URL` role that bypasses RLS; every API route must call a `checkAccess` helper (v1.2 Phase 10 CRIT-04).
- **Centralize SSRF guard** in `src/server/lib/network-guard.ts` (v1.2 Phase 11 SEC-01).
- **Postgres advisory locks for cron** — Multi-instance safe without external infra (v1.2 Phase 11 SEC-04).
- **Defer Drizzle migration regen** — Schema drift too large; document `supabase/migrations/*.sql` as canonical (v1.2 Phase 13 QUA-02).
- [Phase 10-critical-fixes]: isPrivateHost duplicated in mailboxes.ts pending Phase 11 SEC-01 centralization
- [Phase 10-critical-fixes]: Phase 10 Plan 03: Re-export pattern (no impl move) gives canonical src/server/lib/access.ts without touching 40+ call sites; Phase 11+ will migrate imports and normalize the 7 identical org-scoped signatures into checkOrgAccess.
- [Phase 10-critical-fixes]: Phase 10 Plan 01: mailboxes are user-scoped (not org-scoped) — cascade cleanup gated on user having zero remaining orgs preserves shared-user mailbox + passwordHash
- [Phase 11-high-security P02]: IMAP TLS hardening uses data-driven `rejectUnauthorized: !mailbox.skipTlsVerify` (not NODE_ENV). Migration renumbered 017 -> 018 so Phase 13 QUA-03 keeps 017 for RLS consolidation. Operator must `psql -f supabase/migrations/018_add_mailbox_skip_tls_verify.sql` to deploy.
- [Phase 11-high-security P01]: SSRF guard split sync/async by call-site characteristics — sync (`isPrivateHost`) for click-handler hot path and admin-driven test-connection, async DNS-resolving (`isPrivateHostWithDns`) for webhook write paths. Webhook URL validated at write time only; `fireWebhooks` does NOT re-check at delivery time to avoid per-event DNS load. Fail-closed on DNS failure and 2s timeout. Closes audit H1/H3/H6.
- [Phase 11-high-security P04]: Option A (reserved-connection + `pg_try_advisory_lock`) chosen over Option B (`pg_try_advisory_xact_lock` + db.transaction) because `queryClient.reserve()` is exposed by postgres-js and Option B would hold a transaction open for the entire job duration (VACUUM / replication pressure). Lock key passed as string + `::bigint` cast (postgres-js tagged-template params reject native bigint at the TS layer). `isSequenceProcessing` flag REMOVED — advisory lock is strictly stronger. Closes audit H8.
- [Phase 11-high-security P03]: Auth-cache uses hand-rolled Map+TTL (no lru-cache npm dep). 60s TTL bounds token-revocation latency; 5000-entry cap. Cache successes only — 401s always re-hit Supabase. In-flight Promise dedup collapses concurrent identical-token bursts to one Supabase call. Compact-user shape stored (id/email/firstName/lastName/emailVerified) preserves x-user-* header contract for downstream consumers. Closes audit H7.
- [Phase 12-high-correctness]: Webhook retry backoff: BACKOFF_MS=[0,3000,9000] — attempts at T=0s, ~3s, ~12s; 4xx and 2xx exit immediately, only 5xx + network/timeout retry (COR-01/COR-02)
- [Phase 12]: 60s sliding-window dedup for click-tracking via atomic UPDATE on messages.clicked_at — multi-instance safe, replaces SELECT-then-act race
- [Phase 12]: [Phase 12-high-correctness P03]: Outreach toggle hardened — PUT /api/system/outreach/global-toggle (Zod + audit-log + affectedRows/previousState response) replaces old PUT /api/system/outreach which now returns 410 Gone unconditionally with newPath breadcrumb. Audit log to stdout (`[audit] outreach-toggle user=... from=N/N to=bool affected=N at=iso`) until QUA-06 introduces structured logger. No frontend callers found in src/pages or src/components — frontend migration not required for COR-04. Closes audit H9 + M7.

### Pending Todos

- Execute Phase 10 Plan 01: `deleteOrganizationCascade` rewrite (CRIT-01)
- Execute Phase 10 Plan 02: `/health/ready` + `/test-connection` (CRIT-02, CRIT-03)
- Execute Phase 10 Plan 03: Access helpers + CLAUDE.md (CRIT-04)
- Execute Phase 11 Plans 01–04 (SEC-01..04)
- Execute Phase 12 Plans 01–05 (COR-01..07)
- Execute Phase 13 Plans 01–06 (QUA-01..08)
- Execute Phase 14 Plans 01–03 (CLN-01..04, CI-01..04)

### Blockers/Concerns

- Phase 10 cascade rewrite is the most error-prone single task — recommend running it on a DB snapshot first.
- Phase 13 schema field rename (QUA-08) touches many call sites; landing it after the lint/tsc gates exist makes the sweep cheap.
- CI-04 (error log sink) may end up deferred to v1.3 if budget/infra isn't ready.

## Session Continuity

Last session: 2026-05-16T22:53:33.563Z
Stopped at: Completed 12-03-PLAN.md (COR-04 closed)
Resume file: None
Next action: Phase 11 fully complete (SEC-01..04). Run phase verification; advance to Phase 12 (COR-01..07).
