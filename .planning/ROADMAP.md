# Roadmap: SkaleClub Mail — Security & Tech Debt Remediation (v1.2)

**Milestone:** v1.2 — Security & Tech Debt Remediation
**Created:** 2026-05-16
**Source:** `.planning/debug/system-wide-audit-2026-05-16.md`
**Granularity:** coarse
**Requirements:** 27 v1.2 requirements
**Phases:** 5 (continuing from v1.1 phase 09)

---

## Phases

- [x] **Phase 10: CRITICAL Fixes** — Stop the bleeding: cascade delete integrity, health check truth, /test-connection auth + SSRF, RLS doc honesty (completed 2026-05-16)
- [x] **Phase 11: HIGH Security Posture** — Centralized SSRF guard, IMAP TLS hardening, JWT cache, cron advisory locks (11-01 SEC-01 done, 11-02 SEC-02 done, 11-03 SEC-03 done, 11-04 SEC-04 done — all 4 plans complete 2026-05-16)
- [ ] **Phase 12: HIGH Correctness & Validation** — Webhook timeout/retry/replay, /move folder validation, suppression integration, outreach toggle hardening, ESLint config
- [ ] **Phase 13: MEDIUM Consolidation** — tsc errors, migration cleanup, RLS consolidation, domain normalization, CSP hardening, PII logs, field naming
- [ ] **Phase 14: LOW Cleanup + CI/Observability** — Dev artifacts removal, magic constants, CI lint/tsc gates, monitoring/runbook

---

## Phase Details

### Phase 10: CRITICAL Fixes
**Goal:** Eliminate the four CRITICAL audit findings (C1–C4) so cascade deletes are safe, health checks tell the truth, the test-connection proxy is closed, and the auth model is honestly documented.
**Depends on:** Nothing (prerequisite for everything else)
**Requirements:** CRIT-01, CRIT-02, CRIT-03, CRIT-04
**Success Criteria** (what must be TRUE):
  1. Deleting an org via `deleteOrganizationCascade` in a controlled test removes EVERY row in tables with `organizationId` FK and leaves zero orphans. The operation is transactional (kill DB mid-call → no partial state).
  2. A user who belongs to two orgs is not affected (mailbox preserved, passwordHash preserved) when one of their orgs is deleted.
  3. `GET /health/ready` returns HTTP 503 with `database.ok=false` when the DB is unreachable (verified by stopping Postgres locally).
  4. `POST /api/mail/mailboxes/test-connection` rejects requests without `x-user-id` (401) AND rejects requests with private/loopback hosts (400) AND is rate-limited (e.g. 5 req/min/user).
  5. `CLAUDE.md` describes the auth model accurately (RLS = defense-in-depth, JS-side `checkAccess` = source of truth), and `src/server/lib/access.ts` exposes consolidated helpers.

Plans:
- 10-01-PLAN.md — `deleteOrganizationCascade` rewrite (CRIT-01)
- 10-02-PLAN.md — `/health/ready` truth-telling + `/test-connection` auth & SSRF (CRIT-02, CRIT-03)
- 10-03-PLAN.md — Access helpers consolidation + CLAUDE.md update (CRIT-04)

---

### Phase 11: HIGH Security Posture
**Goal:** Close SSRF, MITM, and concurrency gaps. After this phase, every externally-controllable URL goes through one guard, IMAP TLS is verified by default, the auth middleware is cached, and cron jobs are multi-instance safe.
**Depends on:** Phase 10
**Requirements:** SEC-01, SEC-02, SEC-03, SEC-04
**Success Criteria** (what must be TRUE):
  1. Posting a webhook with `url=http://169.254.169.254/...` or `http://localhost/` is rejected with 400 by `webhooks.POST` and `webhooks.PATCH`.
  2. A click-tracking URL whose decoded redirect resolves to a private IP (including via DNS rebinding) is rejected with 400.
  3. `mail-sync.ts` IMAP connections fail by default against self-signed certs; only mailboxes with `skipTlsVerify=true` accept them.
  4. Two consecutive `/api/messages` requests with the same JWT result in a single Supabase auth call (cache-hit observed in dev logs).
  5. `processQueue` cron running with a 2-minute artificial delay does not overlap a second tick (advisory lock blocks the duplicate). Multi-instance smoke test: starting two server processes, only one runs each tick.

Plans:
- 11-01-PLAN.md — `network-guard.ts` library + wire into webhooks, track, mailboxes (SEC-01)
- 11-02-PLAN.md — IMAP TLS hardening + per-mailbox `skipTlsVerify` (SEC-02)
- 11-03-PLAN.md — JWT cache middleware (SEC-03)
- 11-04-PLAN.md — Cron advisory-lock wrapper (SEC-04)

---

### Phase 12: HIGH Correctness & Validation
**Goal:** Eliminate functional/data bugs and finally make lint enforceable. After this phase, webhooks recover from transient failures, click tracking ignores replays, suppression list actually blocks sends, /move can't corrupt folders, and `npm run lint` enforces zero warnings.
**Depends on:** Phase 11 (network-guard exists; SSRF check used in webhook validation)
**Requirements:** COR-01, COR-02, COR-03, COR-04, COR-05, COR-06, COR-07
**Success Criteria** (what must be TRUE):
  1. `POST /webhooks/:id/test` with a URL that hangs returns within 10 seconds (timeout enforced).
  2. A webhook URL returning 503 produces 3 attempts in `webhook_requests` with timestamps roughly 1s, 4s, 13s apart.
  3. Hitting a click-tracking URL 10 times in 30 seconds increments `linksClicked` exactly once.
  4. `PUT /api/system/outreach/global-toggle` exists, validates `{ enabled: boolean }` via Zod, returns `{ affectedRows, previousState }`, and the old endpoint is gone (or returns 410 with deprecation note).
  5. `POST /:mailboxId/messages/:messageId/move { folderId }` returns 400 when `folderId` belongs to a different mailbox.
  6. `POST /api/messages` with a recipient present in `suppressions` returns 400 listing the suppressed addresses.
  7. `npm run lint` runs (no "couldn't find config" error) and exits 0 with zero warnings; any whitelisted rules are documented inline.

Plans:
- 12-01-PLAN.md — Webhook timeout, retry/backoff, attempts counter (COR-01, COR-02)
- 12-02-PLAN.md — Click-tracking replay dedup (COR-03)
- 12-03-PLAN.md — Outreach global-toggle rename + Zod + audit response (COR-04)
- 12-04-PLAN.md — `/move` folder ownership validation + suppression integration in `POST /messages` (COR-05, COR-06)
- 12-05-PLAN.md — ESLint config + first clean lint pass (COR-07)

---

### Phase 13: MEDIUM Consolidation
**Goal:** Eliminate the long tail of inconsistencies that erode confidence: tsc errors, migration drift, RLS scattered across files, mixed casing, weak CSP, PII in logs.
**Depends on:** Phase 12 (lint gates the rest)
**Requirements:** QUA-01, QUA-02, QUA-03, QUA-04, QUA-05, QUA-06, QUA-07, QUA-08
**Success Criteria** (what must be TRUE):
  1. `npx tsc --noEmit` returns 0 errors against both tsconfig files.
  2. `supabase/migrations/013_add_performance_indexes.sql` is gone from the active migrations dir (archived under `supabase/migrations/archive/`); `README` / `CLAUDE.md` documents the schema-edit workflow.
  3. `supabase/migrations/017_consolidate_rls.sql` exists, is idempotent (running twice succeeds with no errors), and `verify-rls-policies.ts` reports a clean state from this single migration.
  4. Inserting domain `EXAMPLE.COM` then `example.com` returns 400 "duplicate" on the second insert; `SELECT name FROM domains WHERE name <> lower(name)` returns zero rows.
  5. Response headers from any HTML page include `Content-Security-Policy: ... frame-ancestors 'none'; object-src 'none'; base-uri 'self'`.
  6. `grep -r "console.log" src/server/` shows no logs that emit user email/token in production code paths (only startup messages or `if (!isProd)`-guarded debug).
  7. `organizations.ownerId` and `organizations.outreachEnabled` (camelCase) are used in TypeScript; SQL columns remain `owner_id` / `outreach_enabled`.

Plans:
- 13-01-PLAN.md — Type-check zero-error sweep (QUA-01, also catches schema-rename callers)
- 13-02-PLAN.md — Migration cleanup + Drizzle workflow doc (QUA-02)
- 13-03-PLAN.md — `017_consolidate_rls.sql` (QUA-03)
- 13-04-PLAN.md — Domain lowercase normalization + data backfill (QUA-04)
- 13-05-PLAN.md — CSP hardening + console.log audit + authLimiter calibration (QUA-05, QUA-06, QUA-07)
- 13-06-PLAN.md — Schema field rename (QUA-08)

---

### Phase 14: LOW Cleanup + CI / Observability
**Goal:** Final pass — kill cosmetic debt and turn on the gates so this whole milestone stays green.
**Depends on:** Phase 13
**Requirements:** CLN-01, CLN-02, CLN-03, CLN-04, CI-01, CI-02, CI-03, CI-04
**Success Criteria** (what must be TRUE):
  1. `/api/system/mail-diag` no longer references any personal email; it accepts `?testEmail=` and defaults to no test.
  2. `git ls-files | grep -E "^(nul|scripts/_)" ` returns no matches.
  3. `npm run build` produces no "can't be bundled without type=module" warning.
  4. `MAX_WEBHOOK_RESPONSE_BODY` is a named export from `tracking.ts`.
  5. CI workflow runs `npm run lint` and `npx tsc --noEmit` as required checks (failing the build on either).
  6. A `docs/runbook.md` (or section in README) documents `/health/ready` as the K8s readiness probe and expected behavior on DB outage.
  7. A decision is recorded for CI-04 (either implemented error sink OR documented deferral to v1.3 with rationale in PROJECT.md decisions table).

Plans:
- 14-01-PLAN.md — Cosmetic cleanup (CLN-01, CLN-02, CLN-03, CLN-04)
- 14-02-PLAN.md — CI gates: lint + tsc + db:audit (CI-01, CI-02)
- 14-03-PLAN.md — Runbook + error-sink decision (CI-03, CI-04)

---

## Estimated Effort

| Phase | Plans | Est. hours |
|-------|-------|-----------|
| 10 — CRITICAL | 3 | ~5h |
| 11 — HIGH Security | 4 | ~7h |
| 12 — HIGH Correctness | 5 | ~7h |
| 13 — MEDIUM Consolidation | 6 | ~8h |
| 14 — LOW + CI | 3 | ~3h |
| **Total** | **21** | **~30h** |

---

## Notes

- Phases must be executed in order — each builds on the previous.
- Phase 10 should land as a single hotfix-style sweep; CRITICAL findings are real production risks.
- ESLint config (COR-07) is intentionally in Phase 12 (not earlier) because writing new code in Phases 10–11 against a missing linter is fine; we lint everything together once the rules exist.
- Migration 017 (QUA-03) is intentionally in Phase 13, after RLS-touching code in Phases 10–12 has settled.
