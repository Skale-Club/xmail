---
phase: 10-critical-fixes
plan: 01
subsystem: database
tags: [drizzle, postgres, transactions, cascade-delete, rls, multi-tenancy]

# Dependency graph
requires: []
provides:
  - "Transactional deleteOrganizationCascade that cleans every FK-dependent row"
  - "Cross-org user preservation contract (mailbox + passwordHash kept for shared users)"
  - "Manual verification script proving zero orphans + preserved state"
affects:
  - 11-high-security
  - 12-high-correctness
  - 13-medium-consolidation

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "db.transaction(async (tx) => ...) for any multi-table mutation"
    - "Leaf-first deletion order with parent-id collection for non-org-scoped child tables"
    - "Per-user cleanup gated on count of remaining org memberships"

key-files:
  created:
    - scripts/test-cascade-delete.ts
  modified:
    - src/server/lib/cascade.ts

key-decisions:
  - "mailboxes (and mail_folders/messages/filters/signatures, contacts, user_notifications) are user-scoped, NOT org-scoped — they are deleted in the per-user cleanup pass only when the deleted org was the user's last org"
  - "sequences/sequence_steps/campaign_leads have no organizationId column — they are deleted via inArray(campaignIds) collected from campaigns"
  - "The current branch check uses ne(organizationUsers.organizationId, deletedOrg) AFTER the org-side memberships have been deleted; the AND clause is defensive but matches identical to length-only check since we already deleted this org's rows"

patterns-established:
  - "Single db.transaction wraps all deletes in cascade.ts; tx is passed (not module-level db) to every call"
  - "Parent-id collection: select { id } from parent where org=X, then inArray on children"
  - "Verification scripts live in scripts/, use sentinel UUIDs, and run cleanup() in finally"

requirements-completed:
  - CRIT-01

# Metrics
duration: 6min
completed: 2026-05-16
---

# Phase 10 Plan 01: Cascade Delete Rewrite Summary

**Transactional `deleteOrganizationCascade` that cleans every FK-dependent row (25+ tables) and preserves mailbox + passwordHash for users who remain members of other orgs.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-16T21:48:03Z
- **Completed:** 2026-05-16T21:53:50Z
- **Tasks:** 2
- **Files modified:** 2 (1 rewritten, 1 created)

## Accomplishments

- `deleteOrganizationCascade` now wraps the entire operation in `db.transaction(async (tx) => ...)` — killing the connection mid-call leaves zero partial state (Postgres rolls back automatically).
- Cascade now covers the previously missing tables: `outreach_emails`, `outreach_analytics`, `campaign_leads`, `sequence_steps`, `sequences`, `campaigns`, `leads`, `lead_lists`, `email_accounts`, `outlook_mailboxes`, `mailboxes` (per-user), `mail_folders`, `mail_messages`, `mail_filters`, `signatures`, `contacts`, `user_notifications`. 33 `tx.delete(` calls across the function.
- Cross-org user preservation: for each former member, we count their memberships in OTHER orgs. If `> 0` → only the membership row is dropped, mailbox + `passwordHash` untouched. If `0` → mailbox tree + contacts + notifications wiped, `passwordHash` nulled.
- Verification script `scripts/test-cascade-delete.ts` seeds a 2-org / 2-user fixture and runs 31 assertions against the live dev DB — **all 31 passed** (see Verification section below).

## Task Commits

1. **Task 1: Rewrite cascade.ts as a single transaction** — `24ee983` (feat)
2. **Task 2: Verification script + live-DB run** — `c5b292d` (test)

Plan metadata commit follows (this SUMMARY.md + STATE.md + ROADMAP.md).

## Files Created/Modified

- `src/server/lib/cascade.ts` — full rewrite; 184 insertions / 54 deletions. Now a single `db.transaction` block.
- `scripts/test-cascade-delete.ts` — new manual verification runner (492 lines). Seeds fixtures, calls the cascade, runs 31 assertions, cleans up in `finally`.

## Tables enumerated and cleared by the cascade

| Group              | Tables                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outreach (direct)  | `outreach_emails`, `outreach_analytics`, `campaigns`, `leads`, `lead_lists`, `email_accounts`                                                                                          |
| Outreach (parent)  | `campaign_leads` (via campaignIds), `sequences` (via campaignIds), `sequence_steps` (via sequenceIds)                                                                                  |
| Outlook            | `outlook_mailboxes`                                                                                                                                                                    |
| Webhooks           | `webhooks`, `webhook_requests` (via webhookIds)                                                                                                                                        |
| Routing / messages | `deliveries`, `messages`, `routes`, `domains`, `credentials`, `smtp_endpoints`, `http_endpoints`, `address_endpoints`                                                                  |
| Templates/tracking | `templates`, `track_domains`, `suppressions`, `statistics`                                                                                                                             |
| Membership         | `organization_users`                                                                                                                                                                   |
| Per-user (gated)   | `mailboxes`, `mail_folders`, `mail_messages`, `mail_filters`, `signatures`, `contacts`, `user_notifications` — only when user has zero remaining orgs                                  |
| Org row            | `organizations`                                                                                                                                                                        |

**Tables intentionally NOT touched:** `users` (kept; only `passwordHash` nulled on last-org cleanup); `system_branding` (singleton).

## Verification

### tsc

`npx tsc --noEmit -p tsconfig.server.json` → exit 0 (no errors in `cascade.ts`, no regression elsewhere).
`npx tsc --noEmit scripts/test-cascade-delete.ts` (with CommonJS module flag) → exit 0.

### grep proofs (Task 1 verify block)

| Pattern                                  | Required | Actual |
| ---------------------------------------- | -------- | ------ |
| `db.transaction` in cascade.ts           | ≥ 1      | 1 (line 71) |
| `passwordHash` inside `length === 0`     | YES      | YES (line 182 inside `if (stillMember.length === 0) { ... }`) |
| `tx.delete(` calls                       | ≥ 20     | 33     |

### Live-DB execution

`NODE_ENV=production npx tsx scripts/test-cascade-delete.ts` → exit 0. All 31 assertions:

- 21x `orgDelete: zero rows in <table>` (domains, credentials, webhooks, outlook_mailboxes, leads, lead_lists, campaigns, email_accounts, outreach_emails, outreach_analytics, templates, track_domains, suppressions, statistics, deliveries, messages, routes, smtp_endpoints, http_endpoints, address_endpoints, organization_users) — all 0.
- `orgDelete row deleted from organizations` ✓
- `orgKeep row still exists` ✓
- `userMulti still member of orgKeep` ✓
- `userMulti row still exists` ✓
- **`userMulti.passwordHash PRESERVED (got "sentinel-hash-do-not-use")`** ✓ — the key cross-org bug fix.
- **`userMulti mailbox SURVIVED (cross-org user)`** ✓ — second key cross-org guarantee.
- `userSolo row still exists` ✓
- **`userSolo.passwordHash NULLED`** ✓
- `userSolo mailbox deleted` ✓
- `userSolo user_notifications deleted` ✓

### Atomicity smoke test

Not run (would require killing Postgres backend mid-call). Postgres transaction semantics guarantee atomicity by design; the `db.transaction` wrapper has been verified to span all deletes.

## Decisions Made

- **mailboxes are user-scoped (per schema), not org-scoped.** The audit's table list assumed `mailboxes.organizationId` but the actual schema has only `userId`. Resolved by moving mailbox cleanup into the per-user "no remaining orgs" branch — semantically correct and aligns with the cross-org preservation contract.
- **Per-user cleanup also covers `contacts` and `user_notifications`** (both user-scoped only). Same gating logic: removed only when the user has no remaining org memberships.
- **Parent-scoped table strategy** for `sequences`, `sequence_steps`, `campaign_leads`: collect `campaignIds` for the org, then `inArray` on each child. Keeps the cascade FK-safe and avoids touching rows belonging to other orgs.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan referenced `mailboxes.organizationId` but the column does not exist**

- **Found during:** Task 1 (cascade rewrite)
- **Issue:** Plan body suggested `tx.delete(mailboxes).where(eq(mailboxes.organizationId, organizationId))`, but `src/db/schema.ts` defines mailboxes with only `userId` — there is no `organizationId` column. Writing that delete would have been a tsc error and a misunderstanding of the data model.
- **Fix:** Moved all mailbox-tree cleanup (mailboxes, mail_folders, mail_messages, mail_filters, signatures) into the per-user cleanup pass, gated on `stillMember.length === 0`. Also moved `contacts` (user-scoped) to the same pass. This is in fact MORE correct than the audit suggested — it means a user shared across orgs keeps their inbox when one org is deleted, matching the CRIT-01 contract.
- **Files modified:** `src/server/lib/cascade.ts`
- **Verification:** Live-DB run shows userMulti's mailbox preserved AND userSolo's mailbox deleted — both branches verified.
- **Committed in:** `24ee983` (Task 1 commit)

**2. [Rule 1 - Bug] Plan referenced direct `organizationId` on `sequences`, `sequence_steps`, `campaign_leads` — column does not exist**

- **Found during:** Task 1
- **Issue:** Plan suggested `await tx.delete(sequenceSteps).where(eq(sequenceSteps.organizationId, organizationId))` etc. Schema shows these tables scope through their parent (`sequences.campaignId`, `sequence_steps.sequenceId`, `campaign_leads.campaignId`).
- **Fix:** Collect `campaignIds` via the org's campaigns, then collect `sequenceIds` via those campaigns, then `inArray` on the leaves.
- **Files modified:** `src/server/lib/cascade.ts`
- **Verification:** Live-DB seed inserted a campaign + sequence + sequence step; post-cascade assertion shows zero rows for campaigns in the deleted org (and FK constraints would have failed if children remained).
- **Committed in:** `24ee983`

---

**Total deviations:** 2 auto-fixed (2 schema-correctness bugs in the plan's pseudo-code).
**Impact on plan:** Plan intent fully preserved; only the SQL shapes had to adapt to the actual schema. All success criteria met.

## Issues Encountered

None — both tasks executed cleanly. The verification script ran on the live dev DB without polluting it (cleanup in `finally` removes all sentinel rows).

## User Setup Required

None — no external services involved.

## Next Phase Readiness

- CRIT-01 fully closed. Phase 10 plans 02 and 03 ran in parallel and are also committed (see `git log` — `d77a624`, `967cdee`, `e3c4ca5`).
- Ready for Phase 11 (HIGH Security Posture). No blockers from this plan.
- One follow-up for verifier: the live-DB verification script touches a shared dev DB. A future CI plan (Phase 14 CI-01/CI-02) should NOT run this script in CI without a dedicated ephemeral DB.

## Self-Check

**Files verified to exist on disk:**

- FOUND: `c:/Users/Vanildo/Dev/skaleclub-mail/src/server/lib/cascade.ts`
- FOUND: `c:/Users/Vanildo/Dev/skaleclub-mail/scripts/test-cascade-delete.ts`
- FOUND: `c:/Users/Vanildo/Dev/skaleclub-mail/.planning/phases/10-critical-fixes/10-01-SUMMARY.md` (this file)

**Commits verified in `git log`:**

- FOUND: `24ee983` (feat(10-01): transactional cascade delete with cross-org user preservation)
- FOUND: `c5b292d` (test(10-01): add cascade-delete verification script)

## Self-Check: PASSED

---
*Phase: 10-critical-fixes*
*Completed: 2026-05-16*
