---
phase: 10-critical-fixes
plan: 02
plan_id: 10-02
subsystem: server/health + server/mail
tags: [security, ssrf, rate-limit, health-check, critical]
status: complete
completed: 2026-05-16
requirements:
  - CRIT-02
  - CRIT-03
dependency_graph:
  requires: []
  provides:
    - "/health/ready returns truthful HTTP status (200 healthy / 503 unhealthy)"
    - "/api/mail/mailboxes/test-connection: auth-gated, SSRF-blocked, per-user rate-limited"
  affects:
    - src/server/lib/health.ts
    - src/server/routes/mail/mailboxes.ts
    - src/server/index.ts
tech_stack:
  added: []
  patterns:
    - "per-user rate limiter via express-rate-limit keyGenerator on x-user-id"
    - "inline isPrivateHost (TODO Phase 11 SEC-01 will centralize)"
key_files:
  created: []
  modified:
    - src/server/lib/health.ts
    - src/server/routes/mail/mailboxes.ts
    - src/server/index.ts
decisions:
  - "isPrivateHost duplicated (not extracted) per plan; Phase 11 SEC-01 will centralize"
  - "testConnectionLimiter mounted as app.use on exact path before mail router so it intercepts before route handler"
  - "Auth middleware (which sets x-user-id) runs at app.use('/api', ...) before the route-scoped limiter, so keyGenerator can read the user id"
metrics:
  duration: "~6 min"
  tasks: 2
  files_modified: 3
  commits: 2
---

# Phase 10 Plan 02: /health/ready honesty + /test-connection hardening — Summary

Closes two CRITICAL audit findings: `/health/ready` now reports HTTP 503 when `checkDatabaseHealth().ok === false` (was silently returning 200/ok=true), and `POST /api/mail/mailboxes/test-connection` now requires authentication, rejects private/loopback hosts, and is rate-limited 5 req/min per user.

## Tasks Completed

### Task 1 — Truth-telling /health/ready (commit `d77a624`)

**File:** `src/server/lib/health.ts`

Before, the database branch only checked `dbResult.status === 'fulfilled'`. Since `Promise.allSettled` fulfills even when the awaited function resolves with `{ ok: false, error: ... }`, a successful-but-unhealthy DB probe produced `database: { ok: true, latencyMs: undefined }` and propagated `readiness.ok = true` → HTTP 200. Monitoring stayed silent during outages.

**Fix (lines 11–28):**
- Database branch now checks `dbResult.status === 'fulfilled' && dbResult.value.ok`.
- Unhealthy branch propagates `dbResult.value.error` when fulfilled-but-unhealthy, falls through to rejection reason otherwise.
- Auth branch mirrored to `authResult.status === 'fulfilled' && authResult.value.ok` (`checkSupabaseAuthHealth` either resolves `{ ok: true }` or throws; defensive check is still cheap).

HTTP status code logic in `src/server/index.ts:131-134` was already `res.status(readiness.ok ? 200 : 503)`, so once `readiness.ok` reflects truth, the status code follows automatically. No `index.ts` change needed for Task 1.

### Task 2 — Auth + SSRF + rate-limit on /test-connection (commit `967cdee`)

**Files:** `src/server/routes/mail/mailboxes.ts`, `src/server/index.ts`

**`mailboxes.ts`:**
- Added local `isPrivateHost` helper (lines 12–29) — verbatim copy of `src/server/routes/track.ts:15–28`. Marked with `// TODO: Phase 11 SEC-01 — move to src/server/lib/network-guard.ts` so the duplication is grep-able for the upcoming refactor.
- `BLOCKED_HOSTS` set includes `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `169.254.169.254`; IPv4 RFC1918 ranges (10/8, 172.16/12, 192.168/16) covered.
- Inside `/test-connection` handler (line 358 → now ~376):
  - Auth gate added BEFORE Zod parse: `if (!userId || typeof userId !== 'string') return res.status(401).json({ error: 'Authentication required' })`. Pattern consistent with sibling handlers (e.g. line 40).
  - After Zod parse, `smtpHost`/`imapHost` are `.trim()`-normalized and passed to `isPrivateHost`. Either match → `400 { error: 'Connection to private/loopback hosts is not allowed' }`.
  - The normalized values are then threaded into `nodemailer.createTransport({ host: smtpHost, ... })` and `new Imap({ host: imapHost, ... })` so we cannot accidentally test a different host than we just validated.
- TLS settings (`rejectUnauthorized: false`) intentionally left untouched — that is Phase 11 SEC-02.

**`index.ts`:**
- Defined `testConnectionLimiter` (lines 77–89) near the other `express-rate-limit` instances: `windowMs: 60_000`, `max: 5`, `keyGenerator` keys by `req.headers['x-user-id']` (falls back to `ip:${req.ip}` defensively, though auth middleware makes that unreachable for the protected route).
- Mounted with `app.use('/api/mail/mailboxes/test-connection', testConnectionLimiter)` (line 220) IMMEDIATELY BEFORE `app.use('/api/mail', mailRoutes)` (line 221) — and crucially AFTER the auth middleware at `app.use('/api', ...)` (line 158) so the limiter can read `x-user-id`.

## Verification

```
$ grep -nE "value\.ok|database\.ok" src/server/lib/health.ts
11:    const database = dbResult.status === 'fulfilled' && dbResult.value.ok
21:    const auth = authResult.status === 'fulfilled' && authResult.value.ok
31:        ok: database.ok && auth.ok,

$ grep -nE "x-user-id|isPrivateHost" src/server/routes/mail/mailboxes.ts | head -10
17:function isPrivateHost(hostname: string): boolean {
...
377:        const userId = req.headers['x-user-id']
399:        if (isPrivateHost(smtpHost) || isPrivateHost(imapHost)) {

$ grep -n "testConnectionLimiter" src/server/index.ts
78:const testConnectionLimiter = rateLimit({
220:app.use('/api/mail/mailboxes/test-connection', testConnectionLimiter)

$ npx tsc --noEmit -p tsconfig.server.json
# zero output / zero errors

$ npm run build
# ✓ built in 12.00s (client) ; tsc server build succeeded ; PWA service-worker regenerated
```

Curl probes were not executed (server not booted; no DATABASE_URL in this env). Plan-level smoke tests remain in the PLAN.md for manual run post-deploy.

## Deviations from Plan

**None substantive.** The plan suggested using `parsed.smtpHost?.trim()` (optional chaining) but the Zod schema makes both `smtpHost` and `imapHost` required strings, so the `?.` is unnecessary — used straight `.trim()` instead. Functionally identical.

The plan suggested possibly applying the same fix to a "Supabase auth probe" in health.ts. Inspection showed `checkSupabaseAuthHealth` only returns `{ ok: true }` or throws (never returns `{ ok: false }`), so the fix is a defensive no-op mirroring of the same shape — applied for consistency, documented in the inline comment.

## Files Touched

- `src/server/lib/health.ts` — fulfilled-but-unhealthy now treated as unhealthy; shape unchanged.
- `src/server/routes/mail/mailboxes.ts` — added `isPrivateHost`, auth gate, SSRF guard; threaded trimmed hosts into transports.
- `src/server/index.ts` — added `testConnectionLimiter` definition + route mount.

## Known Stubs / Followups

- `isPrivateHost` is duplicated in `src/server/routes/track.ts` and `src/server/routes/mail/mailboxes.ts`. Phase 11 SEC-01 will extract to `src/server/lib/network-guard.ts` and add IPv6 ULA + DNS rebinding coverage. Both copies carry a `// TODO: Phase 11 SEC-01` comment for traceability.
- IMAP TLS `rejectUnauthorized: false` on the test probe is deliberately untouched — Phase 11 SEC-02 / audit H6.
- Per-IP fallback in `testConnectionLimiter.keyGenerator` is dead code given the auth gate, but kept defensively in case a future change relaxes auth.

## Self-Check: PASSED

- src/server/lib/health.ts: FOUND, modified with `value.ok` check (line 11) — confirmed by grep.
- src/server/routes/mail/mailboxes.ts: FOUND, contains `isPrivateHost` definition (line 17) + auth gate (line 377) + SSRF check (line 399).
- src/server/index.ts: FOUND, contains `testConnectionLimiter` definition (line 78) + mount (line 220).
- Commit d77a624 (Task 1): FOUND in git log.
- Commit 967cdee (Task 2): FOUND in git log.
- `npx tsc --noEmit -p tsconfig.server.json`: zero errors.
- `npm run build`: succeeded (12.00s client build, server tsc clean).
