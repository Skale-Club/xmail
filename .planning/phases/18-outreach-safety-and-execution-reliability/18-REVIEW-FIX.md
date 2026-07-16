---
status: all_fixed
phase: 18
iteration: 1
fix_scope: critical_warning
findings_in_scope: 7
fixed: 7
skipped: 0
critical_fixed: 3
warning_fixed: 4
---

# Phase 18 Code Review Fix Report

## Result

All three critical and four warning findings from `18-REVIEW.md` were fixed without implementing the Phase 19 Graph/MIME parity work. No production database, migration target, provider, or deployment was touched.

## Fixed Findings

### CR-01 — Account- and tenant-safe reply/bounce matching

- Reply Message-ID and References lookup now requires the active `emailAccountId`, verifies account/outreach organization equality, and uses exact normalized Message-ID equality.
- Bounce matching now requires both account and organization, removes the global substring `LIKE`, and scopes webhook fallback to the caller-bound account/organization.
- Reply/bounce mutations guard account, organization, and campaign linkage before changing tenant data.
- Disposable PostgreSQL coverage creates two tenants with the same Message-ID and proves each matcher can return only the current account's row.

### CR-02 — Terminal-state preservation after provider completion

- Provider finalization now requires the ledger row to remain queued with dispatch started and the owning lease.
- Campaign-lead progress uses compare-and-set on the expected sequence step and a nonterminal status.
- Lead promotion uses compare-and-set from `new`, so a concurrent reply/bounce/unsubscribe cannot regress to `contacted`.
- A lost progress race is logged and leaves terminal scheduling untouched.

### CR-03 — Atomic shared account capacity

- Migration 038 and its Drizzle mirror now record capacity reservation/release timestamps.
- Daily/warm-up capacity and spacing are conditionally reserved in the same PostgreSQL statement that starts dispatch.
- Explicit rejected failures release capacity idempotently; accepted and ambiguous outcomes retain their reservation.
- Accepted finalization increments `total_sent` from the ledger transition, removing per-entrypoint counter races.
- PostgreSQL contention tests prove only one distinct idempotency key can reserve the last daily slot or a shared spacing window.

### WR-01 — Unknown timeout phase is ambiguous

- `ETIMEDOUT`, `ECONNRESET`, and `ESOCKET` require a positive pre-DATA SMTP command before retry.
- Missing command/phase evidence is held as ambiguous and has a regression test.

### WR-02 — Retry payload and tracking token are frozen

- Claims return the persisted recipient, subject, bodies, tracking token, threading headers, and A/B variant.
- Retries send that stored payload rather than newly generated/edited campaign content.
- The campaign provider consumes the ledger-frozen payload and tracking token.
- A fail/retry unit scenario proves edited input cannot replace the original durable payload.

### WR-03 — Conditional campaign completion

- Completion is a single conditional `UPDATE ... WHERE EXISTS ... AND NOT EXISTS ... RETURNING` statement using the shared exhaustive terminal-status contract.
- The previous select-then-update race no longer exists.

### WR-04 — Durable reply context for agentic follow-up

- Native and IMAP reply paths persist a normalized inbound Message-ID and bounded reply body.
- Reply status, terminal scheduling, reply context, and opt-in follow-up scheduling are written in the same campaign-lead mutation.
- Agentic scheduling is no longer created without the context required by `processFollowUps`.

## Commits

- `41bf478` — `fix(18): scope inbound outreach events to their account`
- `bc3f416` — `fix(18): make outreach finalization and capacity atomic`
- `43d88c4` — `test(18): prove inbound matching tenant isolation`
- `f0d2b38` — `test(18): cover concurrent account spacing reservation`
- `412d273` — `chore(18): remove obsolete completion import`

## Verification Evidence

- Targeted unit suites: **PASS**, 4 files / 49 tests.
- Dispatch migration and capacity PostgreSQL suite: **PASS**, 5/5.
- Cross-tenant inbound matching PostgreSQL suite: **PASS**, 2/2.
- Full `npm run test`: **PASS**, 11 files / 91 tests.
- `npm run build`: **PASS**, Vite client and TypeScript server.
- `npm run lint`: **PASS**, zero warnings.
- `git diff --check`: **PASS**.

## Operational Boundary

Migration 038 was applied only to disposable Testcontainers PostgreSQL databases. Production application of `038_outreach_dispatch_state_machine.sql` remains an explicit operator/deployment action. Outlook Graph ingestion and MIME/header parity remain deferred to Phase 19.
