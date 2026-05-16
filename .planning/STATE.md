---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: milestone
status: verifying
stopped_at: Completed 14-01-PLAN.md
last_updated: "2026-05-16T23:54:24.908Z"
last_activity: 2026-05-16
progress:
  total_phases: 5
  completed_phases: 5
  total_plans: 21
  completed_plans: 21
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-16)

**Core value:** A user can create a campaign, build a sequence, add leads, and have emails actually sent and tracked — with replies and bounces correctly detected and handled.
**Current focus:** Phase 14 — low-and-ci

## Current Position

Phase: 14 (low-and-ci) — EXECUTING
Plan: 3 of 3
Status: Phase complete — ready for verification
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
| Phase 12 P05 | 10min | 4 tasks | 28 files |
| Phase 13 P02 | 7m | 2 tasks | 4 files |
| Phase 13 P05 | 4m | 2 tasks | 2 files |
| Phase 13 P06 | 3min | 2 tasks | 9 files |
| Phase 13 P03 | 15 min | 2 tasks | 9 files |
| Phase 13 P01 | 4min | 2 tasks | 1 files |
| Phase 14 P02 | 1m | 2 tasks | 1 files |
| Phase 14 P14-03 | 3min | 2 tasks | 3 files |
| Phase 14-low-and-ci P01 | 12 min | 4 tasks | 3 files |

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
- [Phase 12]: Demoted no-explicit-any, exhaustive-deps, only-export-components to off globally (with Phase 13/14 TODOs) rather than per-line whitelisting — plan-sanctioned override-bloat mitigation.
- [Phase 13]: Removed db:generate/db:push scripts from package.json (option a) rather than neutering them; schema workflow now hand-rolled SQL only (Phase 13 QUA-02).
- [Phase 13]: 13-05: Kept SMTP/IMAP/route-matcher/send transport logs unguarded — classified as operational logs analogous to [audit] line in system.ts; QUA-06 scope was findLocalUser specifically per audit M11
- [Phase 13]: QUA-08 rename: organizations.owner_id->ownerId, outreach_enabled->outreachEnabled (TS only; SQL columns unchanged); JSON wire-format keys preserved as snake_case.
- [Phase 13]: RLS consolidation: single idempotent migration 020 supersedes 8 historical RLS migrations; 124 policies, 36 tables, 8 helpers; verifier PASS on all 5 checks. Renumbered 017->020 (018/019 taken by Phase 11/12).
- [Phase 13]: 13-01: tsc-clean QUA-01 — removed 'event as any' casts in tracking.ts (audit M12); AppLogo M1 already clean; zero 13-06 schema-rename fallout surfaced. Both tsconfig.json + tsconfig.server.json exit 0; CI-02 gate ready.
- [Phase 14]: 14-02: CI workflow .github/workflows/ci.yml runs npm ci + lint + tsc (both tsconfigs) + build on push/PR to main with Node 20.x and cancel-in-progress concurrency; build step uses VITE_* placeholders so vite build passes without real Supabase keys. Kept separate from deploy-hetzner.yml so PRs are gated too. Closes CI-01 + CI-02; branch-protection setup left to operator.
- [Phase 14]: Defer error log sink (Sentry/Datadog) to v1.3 — needs budget + ops infra decision; /health/ready + CI gates are the v1.2 first-line defense
- [Phase 14]: Runbook lives at docs/runbook.md (not README); README is product-facing, runbook is ops-facing
- [Phase 14-low-and-ci]: 14-01 CLN-03: index.html /app-config.js warning silenced via document.write injection (type=text/javascript and vite-ignore both insufficient; Vite only accepts type=module). Synchronous parse-time injection preserves load-order before main.tsx.
- [Phase 14-low-and-ci]: 14-01 CLN-02: scripts/_check-db.ts + _setup-user.ts deleted (not renamed) — _check-db overlapped with scripts/check-full.ts; _setup-user contained hardcoded PII (vanildo@skale.club) and a deprecated password-update flow superseded by Supabase Auth + scripts/set-admin.ts. CLN-02 deletion landed in parallel commit 22872be.

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

Last session: 2026-05-16T23:54:24.900Z
Stopped at: Completed 14-01-PLAN.md
Resume file: None
Next action: Phase 11 fully complete (SEC-01..04). Run phase verification; advance to Phase 12 (COR-01..07).
