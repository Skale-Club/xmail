# Milestones

## v1.2 — Security & Tech Debt Remediation (Shipped: 2026-05-16)

**Phases completed:** 5 phases (10–14), 21 plans, 27 requirements (CRIT-01..04, SEC-01..04, COR-01..07, QUA-01..08, CLN-01..04, CI-01..04)
**Stats:** 81 commits, 125 files changed, 13,450 insertions, 464 deletions
**Audit:** PASSED 27/27 ([.planning/v1.2-MILESTONE-AUDIT.md](v1.2-MILESTONE-AUDIT.md))

**Key accomplishments:**

- **Cascade delete safety** — `deleteOrganizationCascade` rewritten transactional, covers 25+ tables, preserves cross-org users' mailbox + passwordHash; verified with `scripts/test-cascade-delete.ts` (31/31 assertions pass on live DB).
- **Centralized SSRF guard** — `src/server/lib/network-guard.ts` covers IPv4 RFC1918 + 169.254/16 + IPv6 ULA/link-local + metadata hosts; sync + DNS-rebinding-safe async variants. Used by webhooks (POST/PATCH), click tracking, and IMAP/SMTP test-connection.
- **Cron multi-instance safety** — `src/server/lib/cron-lock.ts` wraps all 7 cron callbacks (`processQueue`, `processHeldMessages`, `cleanupOldMessages`, `processOutreachSequences`, `resetDailyLimits`, `processReplies`, `processBounces`) with Postgres `pg_try_advisory_lock` on stable SHA-256 keys.
- **JWT cache** — 60s LRU+TTL cache in `auth-cache.ts` keyed by SHA-256(token), wired into `/api` middleware. Eliminates per-request Supabase auth roundtrip.
- **Webhook retry + replay protection** — `fireWebhooks` retries 3x (1s/3s/9s) on 5xx/timeout, logs each attempt with `attempts` counter; click tracking deduplicates via atomic `clicked_at` UPDATE with 60s window.
- **Suppression integration** — `POST /api/messages` batch-checks `suppressions` table before insert (Phase 08 pattern); returns 400 with suppressed list.
- **RLS consolidation** — `020_consolidate_rls.sql` (1243 lines, 124 policies, 8 helpers) replaces 8 historical RLS migrations; idempotent via `DROP POLICY IF EXISTS`; `verify-rls-policies.ts` PASSES.
- **Doc honesty (CRIT-04)** — `CLAUDE.md` rewritten to document that the app's `DATABASE_URL` role bypasses RLS, JS-side `checkXAccess` helpers are the source of truth; `src/server/lib/access.ts` provides canonical import surface for 9 access helpers.
- **CI gates live** — `.github/workflows/ci.yml` runs `npm run lint` (zero-warnings), `tsc --noEmit` for both tsconfigs, and `npm run build` on every push/PR. ESLint 8 flat config landed (`.eslintrc.cjs`), 116 problems → 0.
- **CSP hardened** — `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'` added to helmet.
- **Runbook** — `docs/runbook.md` documents `/health/ready` 200/503 contract with K8s probe config + triage playbooks.

**Deferred to v1.3:**

- Error log sink (Sentry/Datadog) — needs budget + ops decision.
- Per-user rate limiting (currently per-IP).
- Persistent webhook dead-letter queue.
- Drizzle migration regeneration / full schema sync.

---

## v1.1 (Shipped: 2026-04-01)

**Phases completed:** 5 phases, 11 plans, 22 tasks

**Key accomplishments:**

- Migration 016 drops 11 dead server-scoped RLS policies and rewrites all policies to use organizationId with is_org_member/is_org_admin helpers, plus a static analysis verification script
- One-liner:
- One-liner:
- Shared paginate() utility with Zod-validated query params applied to 4 list endpoints — campaigns, sequences, lead lists, email accounts — returning consistent `{ <resource>: [...], pagination: { page, limit, total, totalPages } }` responses.
- Commit:
- Commit:
- Commit:
- Batch N+1 query fixes in cascade.ts, messages.ts POST, and processHeld.ts using inArray and bulk inserts

---

## v1.0 — Outreach System Completion

**Status:** Complete
**Date:** 2026-03-30 → 2026-03-31
**Goal:** Fill implementation gaps and fix errors so the outreach system works end-to-end.

**Phases:**

1. sending-correctness — Outlook support, A/B variant, idempotency, daily limits
2. sequence-builder-ui — NewSequencePage API connection, field names, campaign selection
3. code-quality — Duplicate consolidation, imapflow migration, TypeScript errors
4. code-quality — Cron concurrency guard

**Shipped:** Campaign CRUD, sequence/step management, lead import, send window enforcement, open/click tracking, reply/bounce detection, suppression list, Outlook OAuth sending, A/B testing support.

---

## v1.1 — Database Health

**Status:** Defining requirements
**Date:** 2026-03-31 →
**Goal:** Make every page load fast and make the database layer robust enough that changes don't break things.

**Phases:**

5. RLS & Migration Safety — Fix broken RLS policies, establish safe index migration workflow
6. Index Foundation — Add all FK and composite indexes to schema.ts
7. Pagination — Paginated responses on all list endpoints
8. Query Optimization — N+1 fixes, column filtering, scoped queries
9. Schema Hardening — CHECK constraints, deprecate old migration file

---
