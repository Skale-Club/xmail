---
phase: 13-medium-consolidation
plan: 05
subsystem: server-hardening
tags: [security, hygiene, csp, rate-limit, pii, helmet, logging]
requirements: [QUA-05, QUA-06, QUA-07]
closes_audit_findings: [M8, M10, M11]
dependency-graph:
  requires: []
  provides:
    - "Hardened helmet CSP with frame-ancestors/object-src/base-uri directives"
    - "authLimiter recalibrated to 10/15min (was 5/15min)"
    - "findLocalUser PII-bearing console.log calls gated behind !isProd"
  affects:
    - "src/server/index.ts (CSP directives + authLimiter.max)"
    - "src/server/lib/native-mail.ts (findLocalUser logs + isProd flag)"
tech-stack:
  added: []
  patterns:
    - "isProd const at module top for gating PII-bearing dev-only console.log"
    - "Defense-grade CSP via helmet getDefaultDirectives() spread + explicit overrides"
key-files:
  created: []
  modified:
    - "src/server/index.ts"
    - "src/server/lib/native-mail.ts"
decisions:
  - "Keep transport/operational console.log lines (SMTP/IMAP/route-matcher/send) unguarded. They emit envelope addresses but are operational logs analogous to the [audit] log line in system.ts:470 that the plan explicitly preserves. Scoped fix focuses on findLocalUser which dumped the entire domains table per call."
  - "Move db.query.domains.findMany() INSIDE the !isProd guard, not just the console.log, so production avoids the DB roundtrip entirely."
  - "Bump authLimiter from 5 → 10 attempts per 15min: still well within OWASP guidance; global limiter (500/15min) unchanged."
metrics:
  duration_minutes: 4
  completed_date: "2026-05-16"
  tasks_completed: 2
  files_modified: 2
  commits: 2
---

# Phase 13 Plan 05: CSP + PII Logs + authLimiter Hygiene Summary

CSP hardened with `frame-ancestors`/`object-src`/`base-uri`, `findLocalUser` debug logs gated behind `!isProd` (with diagnostic `findMany()` moved inside the guard so prod skips the DB roundtrip), and `authLimiter` recalibrated 5 → 10 attempts per 15min — three audit MEDIUM findings closed in two atomic commits.

## What Was Done

### Task 1 — Harden CSP + recalibrate authLimiter (`src/server/index.ts`)

**Commit:** `39f0b22`

**CSP diff (QUA-05 / audit M10):** Added three new directive keys after `connect-src` in the helmet config:

```typescript
'frame-ancestors': ["'none'"],   // clickjacking
'object-src':      ["'none'"],   // plugin-content
'base-uri':        ["'self'"],   // base-URI hijack
```

helmet's `getDefaultDirectives()` does NOT include these three, so explicit overrides are required. Existing `img-src` and `connect-src` overrides preserved unchanged.

**authLimiter diff (QUA-07 / audit M8):** `max: 5` → `max: 10` with an inline `// QUA-07 — see audit M8` comment. No other rate limiters touched — `limiter` (500/2000 per IP), `trackingLimiter` (100/IP/min), and `testConnectionLimiter` (5/user/min) all unchanged.

### Task 2 — Gate findLocalUser PII logs (`src/server/lib/native-mail.ts`)

**Commit:** `6c32b5d`

**Changes:**
1. Added `const isProd = process.env.NODE_ENV === 'production'` at the top of the file (near `BCRYPT_ROUNDS`) with a `// QUA-06 — see audit M11` reference comment.
2. Every `console.log` inside `findLocalUser` (7 call sites) wrapped in `if (!isProd) ...`.
3. Critically: the `db.query.domains.findMany()` call that fed the "All domains in DB" diagnostic log is now INSIDE the `if (!isProd) { ... }` block. Production no longer pays the DB roundtrip just to discard the result.

## Console.log Triage Across `src/server/`

Plan called for a full triage table. Output of `grep -rn "console.log" src/server/` reviewed; each call site classified.

| File:Line | Classification | Reason |
|---|---|---|
| `index.ts:260` | kept | Startup banner — `Server running on port ${PORT}`. No PII. |
| `index.ts:289` | kept | Startup banner — SMTP/IMAP disabled notice. No PII. |
| `jobs.ts:8,10,16` | kept | Mailbox sync worker heartbeat. Counts only, no PII. |
| `jobs/index.ts:27,37` | kept | Scheduler startup banner. No PII. |
| `jobs/cleanupMessages.ts:142` | kept | Periodic cleanup metrics (counts). No PII. |
| `jobs/processQueue.ts:178,188` | kept | Delivery ID + retry counter. No email/token. |
| `jobs/processOutreachSequences.ts:196,209,314,343` | kept | Operational counters; email-account ID not user email. |
| `jobs/processHeld.ts:36` | kept | Periodic counter. No PII. |
| `imap-server.ts:331` | kept (operational) | `[IMAP] Login: ${email}` — login audit trail. Treated as audit-log equivalent (analogous to `system.ts:470 [audit] outreach-toggle ...` which the plan explicitly preserves). Documented for future review under audit logging policy. |
| `imap-server.ts:853,854` | kept | IMAP startup banner. No PII. |
| `smtp-server.ts:87,102,104,116,154,186,210,224,237,241,270,271` | kept (operational) | SMTP relay/delivery operational logs (envelope + relay status). Transport-layer logs comparable to access logs; not PII-as-application-debug. Classified out-of-scope per audit M11 framing (which targeted findLocalUser specifically). |
| `smtp-inbound.ts:105,113,116,137,141,156,167,174,179,188,204,216,217` | kept (operational) | Inbound SMTP envelope/parse/delivery flow logs. Same reasoning as `smtp-server.ts`. |
| `routes/system.ts:470` | kept | `[audit] outreach-toggle ...` — explicit production audit log; plan instructs to keep. |
| `routes/mail/send.ts:59-426 (15 lines)` | kept (operational) | Send pipeline operational logs (envelope, route decisions, delivery counters). Same reasoning. |
| `lib/auth-cache.ts:113` | kept | Cache hit-rate stats. Counts only, no PII. |
| `lib/cron-lock.ts:77` | kept | Cron lock skip notice. No PII. |
| `lib/mail-sync.ts:50,478,481,494` | kept | Mailbox-sync attempts + IMAP IDLE lifecycle. mailboxId (UUID) only, no email. |
| `lib/route-matcher.ts:157,161,165,169,174,178,182,188,192` | kept (operational) | Route-matching pipeline logs for inbound delivery. Recipient-address logs are envelope-tier; same reasoning as SMTP. |
| `lib/native-mail.ts:131,135,147,148,152,160,164` | **wrapped** | All 7 calls in `findLocalUser` now behind `if (!isProd)`. Domain-dump diagnostic db call also inside guard. |
| `routes/auth.ts` | n/a | No `console.log` in this file. |
| `routes/users.ts` | n/a | No `console.log` in this file. |

**Net result:** 7 PII-bearing application-debug logs wrapped (all in `findLocalUser`). 0 logs removed. All other logs classified as operational/startup/audit per plan guidance.

**Note for future hardening:** A follow-up phase may want to migrate SMTP/IMAP/send transport logs to a structured logger with PII redaction (replace envelope addresses with hashes). Out of scope for QUA-06; the audit finding M11 targeted `findLocalUser` specifically.

## Verification

```
$ grep -E "frame-ancestors|object-src.*none|base-uri.*self" src/server/index.ts
            'frame-ancestors': ["'none'"],
            'object-src': ["'none'"],
            'base-uri': ["'self'"],
3 matches ✓

$ grep -A2 "const authLimiter" src/server/index.ts
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10, // QUA-07 — see audit M8. Bumped from 5 → 10 to reduce false lockouts of honest users.
max: 10 ✓

$ grep -n "console.log" src/server/lib/native-mail.ts
134:        if (!isProd) console.log(`[NativeMail] findLocalUser(...) → NO DOMAIN PART`)
138:    if (!isProd) console.log(`[NativeMail] findLocalUser(...) → checking domain ...`)
152:            console.log(`[NativeMail] findLocalUser(...) → domain ... NOT VERIFIED`)     ← inside if(!isProd) block
153:            console.log(`[NativeMail]   All domains in DB:`, ...)                          ← inside if(!isProd) block
158:    if (!isProd) console.log(`[NativeMail] findLocalUser(...) → domain ... VERIFIED ...`)
166:        if (!isProd) console.log(`[NativeMail] findLocalUser(...) → USER NOT FOUND ...`)
170:    if (!isProd) console.log(`[NativeMail] findLocalUser(...) → FOUND userId=... isAdmin=...`)
All guarded ✓

$ npx tsc --noEmit -p tsconfig.server.json
(no output — passes) ✓

$ npm run lint
(no output — 0 warnings, 0 errors) ✓
```

Server-runtime curl test for CSP header skipped (server not running during execution); static grep confirms three directives present.

## Deviations from Plan

None — plan executed exactly as written. Three changes, two commits (one per file), no auto-fixes needed.

## Authentication Gates

None.

## Closes

- **Audit M8** (QUA-07) — authLimiter recalibrated 5 → 10
- **Audit M10** (QUA-05) — CSP `frame-ancestors`/`object-src`/`base-uri` directives added
- **Audit M11** (QUA-06) — `findLocalUser` PII-bearing console.log calls gated; broader server-wide triage documented above

## Commits

| Task | Commit | Files |
|------|--------|-------|
| 1: CSP + authLimiter | `39f0b22` | `src/server/index.ts` |
| 2: findLocalUser PII | `6c32b5d` | `src/server/lib/native-mail.ts` |

## Self-Check: PASSED

- SUMMARY file present at `.planning/phases/13-medium-consolidation/13-05-SUMMARY.md` ✓
- `src/server/index.ts` exists ✓
- `src/server/lib/native-mail.ts` exists ✓
- Commit `39f0b22` in git log ✓
- Commit `6c32b5d` in git log ✓
