# Requirements — Milestone v1.2: Security & Tech Debt Remediation

**Created:** 2026-05-16
**Source:** `.planning/debug/system-wide-audit-2026-05-16.md` (4 CRITICAL + 12 HIGH + 13 MEDIUM + 5 LOW)
**Total requirements:** 27

---

## v1.2 Requirements

### CRITICAL — Security & Data Integrity (Phase 10)

- [x] **CRIT-01**: `deleteOrganizationCascade` runs in a single transaction and deletes every row that references the org (outreach tables, outlook_mailboxes, mail tables, suppressions, etc.) AND preserves user mailboxes/passwordHash for users who are members of other orgs. (audit C2)
- [x] **CRIT-02**: `/health/ready` returns HTTP 503 with `database.ok=false` when the database is unreachable or returning errors. (audit C3)
- [x] **CRIT-03**: `POST /api/mail/mailboxes/test-connection` requires authenticated user (`userId` from Supabase token), rejects private/loopback hosts, and is covered by a per-user rate limit. (audit C1)
- [x] **CRIT-04**: `CLAUDE.md` (and any onboarding text) accurately describes the auth posture: RLS is defense-in-depth, the app role bypasses RLS, every API route is required to call a `checkAccess` helper. A consolidated `src/server/lib/access.ts` exposes all access helpers. (audit C4)

### HIGH — Security Posture (Phase 11)

- [x] **SEC-01**: A centralized `src/server/lib/network-guard.ts` exposes `isPrivateHost(host)` covering IPv4 RFC1918, loopback, link-local `169.254.0.0/16`, IPv6 ULA `fc00::/7`, link-local `fe80::/10`, `::1`, and cloud metadata hostnames. Used by `webhooks.POST/PATCH`, `track.ts` click handler, and `mailboxes /test-connection`. (audit H1, H3, H6)
- [x] **SEC-02**: `src/server/lib/mail-sync.ts` uses `rejectUnauthorized: true` by default. A per-mailbox opt-in `skipTlsVerify` flag is required to relax TLS verification. (audit H5)
- [x] **SEC-03**: JWT validation in the API middleware is backed by an LRU cache keyed by `sha256(token)` with a 60s TTL, reducing Supabase API calls. Cache-hit-rate logged in dev. (audit H7)
- [x] **SEC-04**: All cron jobs in `src/server/jobs/index.ts` (processQueue, processBounces, processReplies, cleanupOldMessages, plus existing outreach) wrap their work in a `pg_try_advisory_lock(BIGINT)` so overlapping ticks or multi-instance deploys are safe. (audit H8)

### HIGH — Correctness & Validation (Phase 12)

- [x] **COR-01**: `POST /webhooks/:id/test` uses `AbortSignal.timeout(10_000)`. (audit H2)
- [x] **COR-02**: `fireWebhooks` retries failed deliveries with exponential backoff (1s/3s/9s, max 3 attempts) and persists each attempt to `webhook_requests` with an `attempts` counter. (audit M6, H2)
- [x] **COR-03**: Click tracking deduplicates within a 60s window per `(messageId, token)` so refresh/preview bots don't multiply stats. (audit H4)
- [x] **COR-04**: The outreach global toggle endpoint is renamed `PUT /api/system/outreach/global-toggle`, validates body with Zod, returns `{ affectedRows, previousState }`, and emits an audit log line including `userId`. (audit H9, M7)
- [x] **COR-05**: `POST /api/mail/mailboxes/:mailboxId/messages/:messageId/move` validates that the supplied `folderId` belongs to the same `mailboxId` before updating. (audit H10)
- [x] **COR-06**: `POST /api/messages` checks the `suppressions` table for each recipient and returns 400 with the list when any are suppressed. (audit H11)
- [x] **COR-07**: `.eslintrc.cjs` (or flat `eslint.config.js`) exists, `npm run lint` runs successfully, and the codebase passes with zero warnings (whitelisted exceptions documented). (audit H12)

### MEDIUM — Consolidation & Hygiene (Phase 13)

- [ ] **QUA-01**: `npx tsc --noEmit` passes with zero errors across both `tsconfig.json` and `tsconfig.server.json` (fix `AppLogo.tsx:12` unused var and `tracking.ts:266` `event as any` cast). (audit M1, M12)
- [x] **QUA-02**: `supabase/migrations/013_add_performance_indexes.sql` is deleted (moved to `supabase/migrations/archive/`). `package.json` scripts and a README section document that schema lives in `src/db/schema.ts` + hand-written `supabase/migrations/*.sql`, and that `npm run db:generate` is not used for new migrations. Scripts that still rely on it use the current Drizzle-kit syntax. (audit M2, M3, M4)
- [x] **QUA-03**: `supabase/migrations/020_consolidate_rls.sql` exists, is idempotent, and reflects the current end-state of RLS policies. Older RLS migrations are annotated as superseded. (Renumbered from 017 — migrations 018 and 019 were taken by Phase 11 SEC-02 and Phase 12 COR-03.) (audit M5)
- [ ] **QUA-04**: `POST /api/domains` lowercases and trims `name` before insert. A one-shot data migration lowercases existing `domains.name`. (audit M9)
- [x] **QUA-05**: Helmet CSP adds `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`. Verified via response headers in a smoke test. (audit M10)
- [x] **QUA-06**: `console.log` calls in `src/server/**/*.ts` that emit PII (emails, tokens) are gated behind `if (!isProd)` or removed; startup messages remain. (audit M11)
- [x] **QUA-07**: `authLimiter` (`/login`, `/reset-password`) is recalibrated to 10 attempts / 15min (or equivalent), reducing false lockouts. (audit M8)
- [x] **QUA-08**: TypeScript schema property names use camelCase consistently: `organizations.ownerId`, `organizations.outreachEnabled` (SQL columns remain snake_case). (audit M13)

### LOW — Cosmetic & Dead Code (Phase 14)

- [ ] **CLN-01**: `/api/system/mail-diag` accepts an optional `?testEmail=` query parameter; default behavior runs no diagnostic test (no hardcoded personal email). (audit L1)
- [ ] **CLN-02**: Repo root has no `nul` file. `scripts/_check-db.ts` and `scripts/_setup-user.ts` are renamed (drop `_` prefix) or deleted with rationale in commit message. (audit L2, L3)
- [ ] **CLN-03**: `index.html` script tag for `/app-config.js` no longer produces a Vite build warning. (audit L4)
- [ ] **CLN-04**: `MAX_WEBHOOK_RESPONSE_BODY = 5000` extracted to a named constant in `tracking.ts`. (audit L5)

### Observability — CI & Monitoring (Phase 14)

- [ ] **CI-01**: CI pipeline runs `npm run lint` and fails on warnings. (depends COR-07)
- [ ] **CI-02**: CI pipeline runs `npx tsc --noEmit` and fails on errors. (depends QUA-01)
- [ ] **CI-03**: A runbook entry documents `/health/ready` as the readiness probe and the expected 503 behavior when DB is down. (depends CRIT-02)
- [ ] **CI-04**: Error log capture strategy is decided (Sentry / Datadog / structured stdout) — either implemented or formally deferred to v1.3 with rationale.

---

## Future Requirements (deferred to v1.3+)

- Replay/replication of webhook_dead_letter queue
- Per-user (not just per-IP) rate limiting
- Drizzle migration regeneration / full schema sync
- Email warm-up sending logic
- Testing framework setup (Vitest + Supertest)

---

## Out of Scope (explicit exclusions for v1.2)

- **Rewriting auth to enforce RLS at DB layer** — would require swapping the connection role, holding `auth.uid()` per-request, and re-architecting jobs. Documented as defense-in-depth instead (CRIT-04).
- **Webhook dead-letter queue** — covered by COR-02 retries only; persistent DLQ deferred.
- **Schema drift remediation via `db:generate`** — too large to land safely in this milestone; documented in QUA-02.
- **End-to-end test suite** — separate initiative.

---

## Traceability — Requirements to Phases

| REQ-ID | Phase |
|--------|-------|
| CRIT-01..04 | Phase 10 |
| SEC-01..04 | Phase 11 |
| COR-01..07 | Phase 12 |
| QUA-01..08 | Phase 13 |
| CLN-01..04, CI-01..04 | Phase 14 |
