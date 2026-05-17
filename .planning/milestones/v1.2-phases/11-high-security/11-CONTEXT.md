# Phase 11: HIGH Security Posture - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss — autonomous mode, audit is the spec)

<domain>
## Phase Boundary

Close SSRF, MITM, and concurrency gaps. After this phase, every externally-controllable URL goes through one guard, IMAP TLS is verified by default, the auth middleware is cached, and cron jobs are multi-instance safe.

**In scope (from ROADMAP success criteria):**
1. `src/server/lib/network-guard.ts` exists and is used by webhooks (POST/PATCH), `track.ts` click handler, and mailboxes `/test-connection`. Covers IPv4 RFC1918 + loopback + 169.254/16, IPv6 ULA fc00::/7, link-local fe80::/10, ::1, cloud metadata hostnames. Includes optional DNS-resolve helper for rebinding protection.
2. `mail-sync.ts` IMAP uses `rejectUnauthorized: true` by default; per-mailbox opt-in `skipTlsVerify` flag.
3. JWT validation in API middleware backed by LRU cache (sha256(token) key, 60s TTL).
4. All cron jobs in `src/server/jobs/index.ts` wrap work in `pg_try_advisory_lock(BIGINT)`.

**Out of scope:** webhook retries (Phase 12), folder validation (Phase 12), suppression integration (Phase 12), ESLint (Phase 12).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
Audit (`.planning/debug/system-wide-audit-2026-05-16.md` — Fase 2 Blocos 2.1, 2.4, 2.5, 2.6) is the spec.

### network-guard.ts (SEC-01)
- Exports `isPrivateHost(host: string): boolean` (sync; covers RFC1918 + loopback + 169.254/16 + IPv6 ULA/link-local + ::1 + metadata hosts).
- Exports `isPrivateHostWithDns(host: string): Promise<boolean>` for rebinding protection (uses `dns.promises.resolve4/6` and rejects if any resolved IP is private).
- Migrate existing `isPrivateHost` from `track.ts` (will be replaced with import) and from `mailboxes.ts` (Phase 10 copy-paste — replace with import).

### IMAP TLS (SEC-02)
- Default `rejectUnauthorized: true` in `mail-sync.ts`.
- Per-mailbox column `skipTlsVerify` (add to `mailboxes` table if not present; if schema lacks it, add a Drizzle migration adding `skip_tls_verify boolean NOT NULL DEFAULT false`).
- If schema rename adds risk, scope minimal: use a fallback constant set via env var `MAIL_SKIP_TLS_VERIFY=` (comma-separated mailbox ids) until proper column added. Prefer schema column — only fallback if migration would block phase.

### JWT cache (SEC-03)
- New `src/server/lib/auth-cache.ts` using `lru-cache` (add to package.json if missing) or simple Map+TTL.
- Key: `sha256(token).hexDigest()`. Value: user object from `supabaseAnonClient.auth.getUser`. TTL: 60s.
- Wrap middleware in `src/server/index.ts`: try cache → fallback Supabase. In dev only, log cache-hit-rate every N requests.

### Cron advisory locks (SEC-04)
- New `src/server/lib/cron-lock.ts` exposing `runWithLock(jobName: string, fn: () => Promise<void>): Promise<void>`.
- Use stable BIGINT key: `BigInt(djb2(jobName)) % BigInt(2^63)` or similar deterministic hash.
- `pg_try_advisory_lock`/`pg_advisory_unlock`. If lock not acquired → skip silently and log.
- Wrap each cron callback in `src/server/jobs/index.ts`. Replace the existing in-memory `isSequenceProcessing` flag (still safe to keep as belt-and-suspenders).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/server/routes/track.ts` — has existing `isPrivateHost` (will be replaced with import).
- `src/server/routes/mail/mailboxes.ts` (Phase 10) — has copy of `isPrivateHost` (will be replaced).
- `src/server/index.ts` — auth middleware around line 170-184 (target for cache).
- `src/server/jobs/index.ts` — cron registrations and the existing `isSequenceProcessing` flag.
- `src/server/lib/mail-sync.ts` — IMAP `tlsOptions: { rejectUnauthorized: false }` at line ~541.
- `src/db/schema.ts` — `mailboxes` table definition.

### Established Patterns
- `db.execute(sql\`...\`)` for raw SQL via Drizzle.
- `node-cron` for scheduling.
- `supabase-js` `auth.getUser(token)` for JWT validation.

### Integration Points
- All four changes are isolated to specific files; no cross-cutting refactor.
- Tests are observability via grep + smoke probes.

</code_context>

<specifics>
## Specific Ideas

Audit "Fase 2" blocks 2.1, 2.4, 2.5, 2.6. Each block → one plan.

</specifics>

<deferred>
## Deferred Ideas

- IPv6 DNS resolve in `track.ts` click handler — covered by `isPrivateHostWithDns` (use optional based on perf cost).
- LRU cache size tuning — start at 5000, revisit if memory issue.
- Per-instance vs per-process advisory lock semantics — Postgres advisory locks are session-scoped, which is correct.

</deferred>
