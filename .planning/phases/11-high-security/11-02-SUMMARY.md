---
phase: 11-high-security
plan: 02
subsystem: mail-sync
tags: [security, tls, imap, mitm, mailboxes, drizzle, migrations]

# Dependency graph
requires: []
provides:
  - "mailboxes.skip_tls_verify column (SQL + Drizzle field)"
  - "Strict-by-default IMAP TLS verification in mail-sync.ts (createImapConnection + testMailboxConnection)"
  - "Per-mailbox opt-in for self-signed IMAP servers via skipTlsVerify boolean"
affects:
  - 12-high-correctness
  - 13-medium-consolidation

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "rejectUnauthorized: !mailbox.skipTlsVerify (data-driven, not NODE_ENV-driven)"
    - "Hand-written SQL migrations under supabase/migrations/ remain canonical; Drizzle schema mirrors them by hand"

key-files:
  created:
    - supabase/migrations/018_add_mailbox_skip_tls_verify.sql
  modified:
    - src/db/schema.ts
    - src/server/lib/mail-sync.ts

key-decisions:
  - "Migration renumbered from 017 -> 018 because 017 is reserved by Phase 13 (QUA-03) for RLS consolidation"
  - "Drop NODE_ENV branching for TLS; staging != production, and 'lax in dev' is itself the MITM hole audit H5 flagged"
  - "Second IMAP construction (testMailboxConnection) gets a default-false skipTlsVerify parameter rather than reading a mailbox row, because the function takes loose primitives from /test-connection"
  - "No UI for the toggle in this milestone; operators flip skipTlsVerify via direct SQL UPDATE"

patterns-established:
  - "All IMAP construction in mail-sync.ts derives rejectUnauthorized from a per-mailbox or per-call boolean, default strict"

requirements-completed:
  - SEC-02

# Metrics
duration: 4min
completed: 2026-05-16
---

# Phase 11 Plan 02: IMAP TLS Hardening (SEC-02) Summary

**Strict IMAP TLS verification by default in `mail-sync.ts`; per-mailbox opt-in via the new `skipTlsVerify` flag. Closes audit finding H5 (MITM on IMAP sync).**

## Performance

- **Duration:** ~4 min (resume + final tasks)
- **Tasks:** 4 (3 file-modifying, 1 verification)
- **Files created:** 1 (migration 018)
- **Files modified:** 2 (`src/db/schema.ts`, `src/server/lib/mail-sync.ts`)

## Accomplishments

- **SQL migration `supabase/migrations/018_add_mailbox_skip_tls_verify.sql`** adds `skip_tls_verify boolean NOT NULL DEFAULT false` to `public.mailboxes`. Idempotent via `ADD COLUMN IF NOT EXISTS`. Includes `COMMENT ON COLUMN` documenting the security semantics.
- **Drizzle schema field** `skipTlsVerify: boolean('skip_tls_verify').default(false).notNull()` added to the `mailboxes` table in `src/db/schema.ts`, mapped to the new SQL column.
- **`createImapConnection` (mail-sync.ts:63)** — dropped the `process.env.NODE_ENV === 'production'` branch; now derives `rejectUnauthorized: !mailbox.skipTlsVerify`. `undefined` (older rows pre-migration) resolves to strict.
- **`testMailboxConnection` (mail-sync.ts:499)** — added optional `skipTlsVerify: boolean = false` parameter; replaced hard-coded `rejectUnauthorized: false` (the audit H5 hot-spot at the original line 541) with `rejectUnauthorized: !skipTlsVerify`.
- **Zero `rejectUnauthorized: false` literals remain** in `src/server/lib/mail-sync.ts`. Both occurrences are now data-driven.

## Task Commits

1. **Task 1: SQL migration 018** — `7742f86` (feat)
2. **Task 2: Drizzle schema field** — `4a73fae` (feat)
3. **Task 3: mail-sync.ts TLS hardening (both call sites)** — `81a36ee` (feat)
4. **Task 4: Manual smoke / code-review probes** — no file changes (verification only, results below)

Plan metadata commit follows (this SUMMARY.md + STATE.md + ROADMAP.md).

## Files Created/Modified

- **Created:** `supabase/migrations/018_add_mailbox_skip_tls_verify.sql` — 19 lines. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS skip_tls_verify boolean NOT NULL DEFAULT false` + `COMMENT ON COLUMN`.
- **Modified:** `src/db/schema.ts` — +2 lines in the `mailboxes` block (1 comment, 1 field).
- **Modified:** `src/server/lib/mail-sync.ts` — `createImapConnection` TLS block rewritten; `testMailboxConnection` signature extended with `skipTlsVerify`; both `tlsOptions` blocks now derive from the flag.

## Verification

### tsc

`npx tsc --noEmit -p tsconfig.server.json` produces only pre-existing errors in `src/server/lib/cron-lock.ts` (untracked file owned by plan 11-04 / cron concurrency work, already logged in `.planning/phases/11-high-security/deferred-items.md`). **Zero new errors in `mail-sync.ts` or `schema.ts`** introduced by this plan — confirmed via:

```
npx tsc --noEmit -p tsconfig.server.json 2>&1 | grep -E "mail-sync|schema\.ts"
# (no output)
```

### grep proofs (Task 4 Probe C — code review)

| Pattern                                                  | Required | Actual                                               |
| -------------------------------------------------------- | -------- | ---------------------------------------------------- |
| `rejectUnauthorized: false` literal in `mail-sync.ts`    | 0        | 0                                                    |
| `rejectUnauthorized: !` (skipTlsVerify-driven)           | 2        | 2 (line 73 `mailbox.skipTlsVerify`, line 551 `skipTlsVerify`) |
| `NODE_ENV` references in `mail-sync.ts` TLS code         | 0        | 0                                                    |
| `skip_tls_verify` in migration 018                       | ≥ 1      | 2 (ADD COLUMN + COMMENT)                             |
| `skipTlsVerify` in `src/db/schema.ts`                    | ≥ 1      | 1 (mailboxes block, after `imapSecure`)              |

### Smoke probes (Task 4)

- **Probe A (self-signed IMAP fails by default):** NOT RUN. No self-signed IMAP test target available in dev. Mitigation: relying on code review of `mail-sync.ts` changes — `rejectUnauthorized: !undefined` (older rows) and `rejectUnauthorized: !false` (default for new rows) both resolve to `true`, which is the strict path. The IMAP library passes `tlsOptions` directly to Node TLS, which is well-trodden behavior; flipping the boolean was a one-line change with no other code paths.
- **Probe B (opt-in succeeds):** NOT RUN — same reason. Trivially follows from `!true === false`.
- **Probe C (code review):** PASSED. Both occurrences confirmed, zero literals remain.

## Operator notes

### Applying the migration

```bash
psql "$DATABASE_URL" -f supabase/migrations/018_add_mailbox_skip_tls_verify.sql
```

The migration is idempotent (`IF NOT EXISTS`), safe to re-run.

### Opting a mailbox into skip-verify (self-signed corporate IMAP)

```sql
UPDATE public.mailboxes
SET skip_tls_verify = true
WHERE id = '<mailbox-uuid>';
```

The UI does not yet expose this toggle (deferred to v1.3). Operators with shell + DB access are the audience until then.

### Behavior change for existing mailboxes

Before this plan, `mail-sync.ts` accepted any TLS cert in non-production environments (the `NODE_ENV === 'production'` branch). After this plan, dev and staging environments now also verify certs by default. Any mailbox previously syncing against a self-signed IMAP server in dev/staging will start failing until the operator flips `skip_tls_verify = true` for that specific row. This is the intended security improvement.

## Decisions Made

- **Migration renumbering 017 -> 018.** Phase 13 (QUA-03) already reserved 017 for `consolidate_rls.sql`. Documented inline in the migration file header. No code references the migration number, so the rename is cosmetic.
- **Drop NODE_ENV-based TLS gating.** The audit explicitly calls out "staging is not 'production' but should still verify TLS" — coupling a security boundary to a deployment-environment string is the wrong axis. Per-mailbox is the right axis.
- **`testMailboxConnection` takes a default-false parameter, not a mailbox row.** Its callers (the `/test-connection` route) work with loose primitives from the request body, not stored mailbox rows. Adding a 11th parameter with a safe default keeps the existing caller passing tests trivially while allowing future opt-in.
- **`mailbox.skipTlsVerify` defended against `undefined`.** `createImapConnection`'s parameter is `any`-typed, so older code paths (or future partial-object callers) may pass an object without the field. `!undefined === true` is the strict path — accidentally safe.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Migration filename collision with Phase 13**

- **Found during:** Plan setup (before resume)
- **Issue:** Plan body specified filename `017_add_mailbox_skip_tls_verify.sql`, but Phase 13 had already reserved 017 for the RLS consolidation migration. Two migrations with the same number would either collide on disk or run in undefined order.
- **Fix:** Renumbered this plan's migration to `018_add_mailbox_skip_tls_verify.sql`. Header comment documents the renumber and the reason.
- **Files modified:** `supabase/migrations/018_add_mailbox_skip_tls_verify.sql` (created with 018 name).
- **Committed in:** `7742f86`

---

**Total deviations:** 1 (migration filename — renumber for Phase 13 coexistence).
**Impact on plan:** None on functionality. Plan body's references to 017 are historical; SUMMARY.md and the migration header both note the 018 filename.

## Issues Encountered

- Pre-existing tsc errors in `src/server/lib/cron-lock.ts` (untracked, owned by Phase 11 plan 11-04). Already logged in `.planning/phases/11-high-security/deferred-items.md`. NOT caused by this plan and explicitly out of scope per the executor's scope-boundary rule.

## User Setup Required

- Operator must apply migration 018: `psql "$DATABASE_URL" -f supabase/migrations/018_add_mailbox_skip_tls_verify.sql` (one command, idempotent).
- Any dev/staging mailbox that currently syncs against a self-signed IMAP server will start failing after deploy until the operator flips `skip_tls_verify = true` for that row (intentional — see "Behavior change" above).

## Notes for Downstream Phases

- **Phase 13 (QUA-03) keeps `017_consolidate_rls.sql`** as originally planned — this plan's migration takes 018 instead, so 017 is still available.
- **Phase 12 / future UX work:** Surface `skipTlsVerify` toggle in the mailbox edit form. Add a warning banner ("TLS verification disabled — use only with trusted self-signed corporate servers").
- **Out-of-scope IMAP sites carried forward:** `src/server/routes/mail/messages.ts:130` still uses `NODE_ENV` gating. Audit explicitly left it out of SEC-02. Future cleanup candidate.

## Known Stubs

None — no UI surface added in this plan; backend wiring is complete end to end (column -> schema field -> both IMAP construction sites).

## Self-Check

**Files verified to exist on disk:**

- FOUND: `c:/Users/Vanildo/Dev/skaleclub-mail/supabase/migrations/018_add_mailbox_skip_tls_verify.sql`
- FOUND: `c:/Users/Vanildo/Dev/skaleclub-mail/src/db/schema.ts` (skipTlsVerify field present at the mailboxes block)
- FOUND: `c:/Users/Vanildo/Dev/skaleclub-mail/src/server/lib/mail-sync.ts` (both TLS blocks updated)
- FOUND: `c:/Users/Vanildo/Dev/skaleclub-mail/.planning/phases/11-high-security/11-02-SUMMARY.md` (this file)

**Commits verified in `git log`:**

- FOUND: `7742f86` feat(11-02): add migration 018 adding mailboxes.skip_tls_verify column
- FOUND: `4a73fae` feat(11-02): add mailboxes.skipTlsVerify column to schema
- FOUND: `81a36ee` feat(11-02): enforce strict IMAP TLS by default, opt-in skipTlsVerify

## Self-Check: PASSED

---
*Phase: 11-high-security*
*Completed: 2026-05-16*
