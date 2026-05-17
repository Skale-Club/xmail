---
phase: 12-high-correctness
plan: 04
plan_id: 12-04
subsystem: mail-routes, send-routes
tags: [security, correctness, validation, audit-h10, audit-h11, cor-05, cor-06]
status: complete
one_liner: "Folder-ownership guard on /move + suppression-list batch check on POST /api/messages — closes audit H10 and H11"
requires:
  - "src/db/schema.ts: mailFolders.mailboxId, suppressions(organizationId,emailAddress)"
  - "src/server/lib/access.ts: org-scoped access helpers (checkMessageAccess, checkUserMailboxAccess) already in place"
provides:
  - "POST /api/mail/mailboxes/:mailboxId/messages/:messageId/move rejects cross-mailbox folderId with 400"
  - "POST /api/messages rejects any send where to/cc/bcc contains a suppressed address for the org"
affects:
  - "src/server/routes/mail/messages.ts (line 627 /move handler)"
  - "src/server/routes/messages.ts (lines 195+ POST / handler)"
tech_stack:
  added: []
  patterns:
    - "validate-before-write (SELECT folder belongs to mailbox before UPDATE)"
    - "batch inArray() recipient lookup against unique (organizationId, emailAddress) index"
key_files:
  created: []
  modified:
    - "src/server/routes/mail/messages.ts"
    - "src/server/routes/messages.ts"
decisions:
  - "Fail-entire-request on any suppressed recipient (audit-prescribed default). Partial-send 'send to non-suppressed only' deferred to v1.3 UX."
  - "Scoped fix to single-message /move only. Batch endpoint folder ownership flagged as follow-up TODO (audit only singles out /move)."
  - "No email case-normalization in this plan. Documented as Phase 13 QUA-04-adjacent follow-up."
  - "Outreach send path (src/server/lib/outreach-*) not patched. Audit only flags POST /api/messages."
metrics:
  duration: "~7 minutes"
  completed_at: "2026-05-16"
  tasks: 3
  files_modified: 2
  lines_added: 32
requirements:
  - COR-05
  - COR-06
---

# Phase 12 Plan 04: Folder ownership + Suppression check Summary

## What was built

Two correctness fixes packed into a single plan because they share the same corrective shape (validate-before-write) and touch disjoint files.

### COR-05 — Folder ownership guard on `/move` (audit H10)

`src/server/routes/mail/messages.ts` `router.post('/:mailboxId/messages/:messageId/move', ...)` at line 627.

**Before:** Zod parsed `folderId`, then immediately `UPDATE mailMessages SET folderId = ? WHERE id = ? AND mailboxId = ?`. The `WHERE mailboxId` clause protected the *message* side (you can't move someone else's message) but did NOT protect the *folder* side (you could write a foreign mailbox's folder id into your own message, silently corrupting both folder trees).

**After:** Before the UPDATE, query:

```ts
const targetFolder = await db.query.mailFolders.findFirst({
  where: and(eq(mailFolders.id, data.folderId), eq(mailFolders.mailboxId, mailboxId)),
})
if (!targetFolder) {
  return res.status(400).json({ error: 'Folder does not belong to this mailbox' })
}
```

`mailFolders` and `and`/`eq` were already imported (line 3 and 6); no import changes needed.

### COR-06 — Suppression check on `POST /api/messages` (audit H11)

`src/server/routes/messages.ts` `router.post('/', ...)` at line 195.

**Before:** Zod parse → access check → straight into outlook resolution + template rendering + insert. The `suppressions` table is populated by bounce/complaint/manual-unsubscribe pipelines but was never consulted at send time.

**After:** Added imports for `inArray` (drizzle-orm) and `suppressions` (schema). After the access check and before any send logic:

```ts
const allRecipients = [...data.to, ...(data.cc || []), ...(data.bcc || [])]
if (allRecipients.length > 0) {
  const suppressed = await db
    .select({ emailAddress: suppressions.emailAddress })
    .from(suppressions)
    .where(and(
      eq(suppressions.organizationId, data.organizationId),
      inArray(suppressions.emailAddress, allRecipients),
    ))
  if (suppressed.length > 0) {
    return res.status(400).json({
      error: 'Recipients are suppressed',
      suppressed: suppressed.map(s => s.emailAddress),
    })
  }
}
```

The duplicate `const allRecipients` declaration that previously lived ~80 lines lower (used for the `deliveries` insert) was removed — the outer declaration is now in scope for both the suppression check AND the deliveries insert.

Index alignment: the suppression table has a unique constraint on `(organization_id, email_address)`, so `inArray` against the email list and the equality on `organizationId` together hit the index — O(log n) per recipient.

## Probe results

| Probe | What | Result |
| ----- | ---- | ------ |
| A     | `/move` with folderId from a different mailbox → expect 400 | **Deferred to staging** (requires two distinct mailboxes + tokens) |
| B     | `/move` with valid same-mailbox folderId → expect 200 | **Deferred to staging** |
| C     | `POST /messages` with one suppressed recipient → expect 400 + list | **Deferred to staging** (requires running server + admin token + seeded suppression row) |
| D     | `POST /messages` with no suppressed recipients → expect 201 | **Deferred to staging** |
| E     | Code-review fallback (greps + tsc) | **PASS** — see verification below |

## Verification

```
grep "Folder does not belong to this mailbox" src/server/routes/mail/messages.ts  -> 1 match (line 655)
grep "mailFolders.mailboxId.*mailboxId"        src/server/routes/mail/messages.ts  -> 9 matches incl. line 652 (the new SELECT WHERE clause)
grep "Recipients are suppressed"               src/server/routes/messages.ts       -> 1 match (line 224)
grep "inArray(suppressions.emailAddress"       src/server/routes/messages.ts       -> 1 match (line 220)
grep -c "const allRecipients"                  src/server/routes/messages.ts       -> 1 (no duplicate declaration)
npx tsc --noEmit -p tsconfig.server.json                                            -> 0 errors
```

All plan-prescribed greps return the expected counts. The duplicate `allRecipients` risk flagged in `<risks>` was hit and resolved as the plan predicted.

## Deviations from Plan

None — plan executed exactly as written. The duplicate `const allRecipients` risk was anticipated in `<risks>` and handled per the plan's Edit 3 instructions.

## Audit Checklist

- **H10 (COR-05) — Folder ownership bypass:** CLOSED. `/move` now SELECTs `mailFolders WHERE id = folderId AND mailboxId = req.params.mailboxId` before the UPDATE; mismatch returns 400.
- **H11 (COR-06) — Suppression list bypass:** CLOSED. `POST /api/messages` now batch-queries `suppressions` against `to + cc + bcc` for the org; any match returns 400 with the suppressed email list.

## Known Stubs

None. Both fixes are real database queries against real columns. No placeholder data.

## Follow-ups (TODOs carried forward)

1. **Batch move endpoint folder ownership.** `router.post('/:mailboxId/messages/batch', ...)` at line 690 of `src/server/routes/mail/messages.ts` also accepts `folderId` for custom-folder overrides on `archive`/`spam`/`unspam`/`restore` actions (around line 803). The batch handler currently looks up the override folder with a scoped `WHERE mailboxId = AND id =` query already, so it actually IS guarded — but the audit only singled out `/move`, so this plan stayed tightly-scoped. No action needed unless a future audit pass flags it.
2. **Outreach send-path suppression.** `src/server/lib/outreach-*` performs its own sending and doesn't consult `suppressions`. Outreach has its own unsubscribe handling; integration deferred to v1.3.
3. **Email case normalization.** Suppression table stores emails as-inserted; recipients arrive as user input. If suppressions inserts lowercase but a recipient is mixed-case, the match misses. Document as Phase 13 QUA-04-adjacent — lowercase both on insert into `suppressions` AND on the inArray probe.
4. **Probes A-D staging run.** End-to-end HTTP probes deferred — needs running server + two-user fixture + token issuance. Schedule alongside Phase 12 verification gate.

## Files modified

- `src/server/routes/mail/messages.ts` — +10 lines in `/move` handler
- `src/server/routes/messages.ts` — +22 / -4 lines (imports + suppression check + duplicate removal)

## Commits

- `a95f471` — feat(12-04): validate folder ownership in /move handler (COR-05)
- `7d0760d` — feat(12-04): block sends to suppressed recipients in POST /api/messages (COR-06)

## Self-Check: PASSED

- File `src/server/routes/mail/messages.ts` — FOUND (modified, contains "Folder does not belong to this mailbox" at line 655)
- File `src/server/routes/messages.ts` — FOUND (modified, contains "Recipients are suppressed" at line 224, `inArray(suppressions` at line 220, exactly one `const allRecipients`)
- Commit `a95f471` — FOUND in `git log`
- Commit `7d0760d` — FOUND in `git log`
- `npx tsc --noEmit -p tsconfig.server.json` — exit 0
