---
phase: 19-provider-parity-and-deliverability
plan: 01
subsystem: api
tags: [smtp, tls, starttls, nodemailer, outreach, deliverability]

# Dependency graph
requires:
  - phase: 18-outreach-safety-and-execution-reliability
    provides: Vitest multi-project harness (server/client/postgres) used for the resolver tests
provides:
  - Single SMTP transport-option resolver shared by verification, delivery, presets, and CSV import
  - Port-derived TLS semantics (465 implicit TLS, 587 required STARTTLS, 25 opportunistic STARTTLS)
  - Write-time 422 validation (`smtp_tls_mode_mismatch`) for contradictory port/TLS input
  - Backwards-compatible normalization of legacy `smtp_secure=true` + port 587 rows
affects: [19-02, 19-03, 19-04, outreach sending, inbox onboarding]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Port/flag pairs resolve through one pure function rather than being re-derived per call site"
    - "Legacy data normalizes on read; only new writes are validated — a fix cannot strand working inboxes"
    - "Dependency-free server module shared with browser code so UI presets cannot drift from server truth"

key-files:
  created:
    - src/server/lib/smtp-security.ts
    - src/server/lib/__tests__/smtp-security.test.ts
    - src/pages/outreach/inboxes/__tests__/parse-mailbox-csv.test.ts
  modified:
    - src/server/lib/outreach-sender.ts
    - src/server/routes/outreach/email-accounts.ts
    - src/pages/outreach/inboxes/NewInboxPage.tsx
    - src/pages/outreach/inboxes/parse-mailbox-csv.ts

key-decisions:
  - "Port 465 = implicit TLS; 587 = STARTTLS required; 25 = STARTTLS opportunistic; nonstandard ports honour an explicit secure=true, else require STARTTLS"
  - "Legacy rows whose smtp_secure contradicts their port are normalized with a warning, not rejected, so existing inboxes keep sending"
  - "smtpSecure has no schema default; it is derived from the port when omitted, which is what stops new 587 inboxes persisting implicit TLS"
  - "Contradictory port/TLS input is a 422 only when the caller explicitly stated the flag"
  - "smtp-security.ts is kept dependency-free and imported by browser code so presets/CSV share the exact server rule instead of a duplicated `port === 465` guess"
  - "The UI's 'Use TLS/SSL' checkbox is replaced by a derived read-only label on standard ports; the choice is only offered on nonstandard ports"

patterns-established:
  - "One resolver, two consumers: buildSmtpTransportOptions is the only way to construct an outreach SMTP transport"
  - "Normalization warnings carry the account id and mode only — never host credentials or decrypted passwords"

requirements-completed: [PROV-01]

# Metrics
duration: 12min
completed: 2026-07-16
---

# Phase 19 Plan 01: SMTP TLS Parity Summary

**Port 587 outreach inboxes now verify and send over STARTTLS instead of claiming implicit TLS, with one shared resolver (`smtp-security.ts`) driving presets, CSV import, API validation, verification, and delivery.**

## What Changed

### The bug

`email_accounts.smtp_port` defaults to `587` while `email_accounts.smtp_secure` defaults to `true`. Both `createSmtpTransporter` (send) and the account-verification route passed that boolean straight to Nodemailer, where `secure: true` means "TLS from the first byte" — port 465's contract. On 587 the server answers in cleartext and expects STARTTLS, so the standard-provider configuration was wrong by default. The two call sites also duplicated the config, so they could drift apart independently.

### Task 1 — `src/server/lib/smtp-security.ts` (TDD)

A pure resolver, `resolveSmtpSecurity({ port, secure })`, returning Nodemailer `secure`, `requireTLS`, a `tls.minVersion` floor of TLSv1.2, plus `normalized`/`warning` fields:

| Port | Mode | `secure` | `requireTLS` |
|---|---|---|---|
| 465 | implicit TLS | `true` | `false` |
| 587 | STARTTLS required | `false` | `true` |
| 25 | STARTTLS opportunistic | `false` | `false` |
| other | flag is the only signal: `true` → implicit TLS, else STARTTLS required | — | — |

An explicit flag that contradicts a standard port is overridden and reported via `warning` (`normalized: true`); an unset flag has nothing to contradict. `buildSmtpTransportOptions` composes host/auth/timeouts on top, and is the only permitted way to build an outreach SMTP transport.

Supporting exports `isStandardSmtpPort` and `describeSmtpSecurityMode` exist so the UI does not re-list the standard ports.

### Task 2 — one resolver everywhere

- **Send** (`outreach-sender.ts`) and **verify** (`email-accounts.ts`) both call `buildSmtpTransportOptions`. The only difference permitted between them is the verify path's connect/greeting timeouts — locked by a test asserting the two produce identical transport options for the same account.
- **Write-time validation**: `smtpSecure` lost its `.default(true)` on both `createEmailAccountSchema` and `importMailboxSchema`. Omitted → derived from the port. Explicitly contradictory → `422 { code: 'smtp_tls_mode_mismatch' }` on create, bulk-import (all-or-nothing, matching the existing host-check pattern), and update.
- **Update path** resolves port and flag together against the row's post-update state, so editing 465 → 587 re-derives the flag instead of silently keeping implicit TLS.
- **Presets** (`NewInboxPage.tsx`): the outlook/gmail/yahoo presets all specified port 587 **and** `smtpSecure: true` — the exact broken combination. They now carry no flag at all; `withCanonicalSmtpSecurity` derives it. `defaultForm` derives its flag too.
- **CSV** (`parse-mailbox-csv.ts`): replaced the hardcoded `smtpPort === 465` with the shared resolver. The rule was already correct here, but duplicated — which is how it drifts.
- **Legacy rows** normalize on read with a warning logged as `{ emailAccountId, mode }` only — no host credentials, no decrypted password.

### UI honesty change

The "Use TLS/SSL" checkbox was the control that produced the invalid 587+implicit combination and would now earn a 422. On standard ports the mode is implied, so the form reports it read-only ("Encryption: STARTTLS (required) — determined by port 587"). The checkbox only appears on nonstandard ports, where the choice is genuinely real.

## Verification Results

| Gate | Result |
|---|---|
| `npm run test` | **131 passed** (14 files) — server + client + postgres/Testcontainers |
| `npx tsc --noEmit -p tsconfig.json` (client) | pass |
| `npx tsc --noEmit -p tsconfig.server.json` (server) | pass |
| `npm run build` | pass (client + server) |
| `npm run lint` | pass, 0 warnings |

New tests: 24 in `smtp-security.test.ts` (RED-committed first at `a0c9cc3`, GREEN at `1733875`), 5 in `parse-mailbox-csv.test.ts`.

## Success Criteria

1. **Standard 587 providers verify and send through STARTTLS** — resolver maps 587 → `secure:false, requireTLS:true`; both transporters go through it.
2. **Port 465 remains implicit TLS** — resolver maps 465 → `secure:true`; preserved for nonstandard explicit implicit-TLS config too.
3. **Presets, bulk imports, API validation, verification, and send share one documented meaning** — all five call `resolveSmtpSecurity`/`buildSmtpTransportOptions` from `smtp-security.ts`.

## Deviations from Plan

### Additions (Rule 2 — missing critical functionality)

**1. Extra test file for `parse-mailbox-csv.ts`**
- **Found during:** Task 2
- **Issue:** The plan's must-have truth "UI/CSV presets no longer persist secure=true for standard port 587" had no test lock on the CSV half, and the parser had no test coverage at all.
- **Fix:** Added `src/pages/outreach/inboxes/__tests__/parse-mailbox-csv.test.ts` (5 tests).
- **Commit:** `c4576c3`

**2. UI control replaced rather than re-defaulted**
- **Found during:** Task 2
- **Issue:** The plan said to update presets/form defaults. But leaving the free "Use TLS/SSL" checkbox on a standard port means the user can still hand-build the 587+implicit combination — which, after this plan, is a 422 instead of a silent bad row. Fixing the default without fixing the control would trade a silent bug for a confusing error.
- **Fix:** Derived read-only label on standard ports; checkbox retained only for nonstandard ports.
- **Commit:** `c4576c3`

**3. `isStandardSmtpPort` / `describeSmtpSecurityMode` exports**
- **Found during:** Task 2
- **Issue:** The UI needed to know which ports are standard. Hardcoding `[465, 587, 25]` in the component would re-create the duplication this plan exists to remove.
- **Fix:** Exported both from the resolver, with tests.
- **Commit:** `c4576c3`

### Architectural note (no Rule 4 stop needed)

`src/pages/outreach/inboxes/*` now imports `src/server/lib/smtp-security.ts`, crossing the boundary drawn by `tsconfig.json`'s `exclude: ["src/server/**/*"]`. This was deliberate and is the reason the module is documented as dependency-free (no db, no nodemailer runtime import, no env access): success criterion 3 requires presets, imports, validation, verification, and send to share **one** meaning, and any client-side copy of the rule is drift waiting to happen. Verified clean through the client typecheck, `vite build`, and lint. If a future phase wants a formal `src/shared/` tier, this module is the natural first tenant — noted for the phase-19 verifier rather than actioned here.

### Not needed

The plan anticipated changing `parse-mailbox-csv.ts` to fix a wrong rule; it already derived `smtpSecure: smtpPort === 465` correctly. The change there was de-duplication (route through the shared resolver), not a behavior fix. The real preset drift was entirely in `NewInboxPage.tsx`.

## Notes for Later Plans

- `email_accounts.smtp_secure` still has `.default(true)` at the **database** level (`src/db/schema.ts:669`). This is now harmless — every write path canonicalizes before insert, and reads normalize — but a future migration could drop the default or backfill legacy rows. Not done here: it needs a migration number, and CLAUDE.md forbids touching the production DB from this workflow. Backfill candidates are rows with `smtp_port = 587 AND smtp_secure = true`.
- `src/server/lib/mail-sync.ts`, `mail.ts`, `routes/mail/*` (the native/webmail mailbox path, a different table: `mail_mailboxes`) still pass `secure` straight through. Out of scope for PROV-01, which is outreach-only, and untouched deliberately. If a mailbox there is configured on 587 with `smtp_secure=true`, it has the same latent bug — worth a look in a later plan.

## Known Stubs

None.

## Self-Check: PASSED

- All 7 claimed created/modified files exist on disk.
- All 3 claimed commits (`a0c9cc3`, `1733875`, `c4576c3`) exist in git history.
- Cited line `src/db/schema.ts:669` verified as `smtpSecure: boolean('smtp_secure').default(true),`.
