---
phase: 22-unified-inbox-operator-experience
plan: 03
subsystem: frontend
tags: [react, tanstack-query, optimistic-ui, rollback, unified-inbox, outreach, suppression, accessibility, bulk, tdd]

# Dependency graph
requires:
  - phase: 22-unified-inbox-operator-experience (plan 01)
    provides: "Operator endpoints (labels/archive/reminders/bulk) + inbox-operator services + BULK_CONVERSATION_LIMIT"
  - phase: 22-unified-inbox-operator-experience (plan 02)
    provides: "Prop-driven ConversationList/ConversationThread/InboxFilterRail + org-scoped inboxKeys + useUnifiedInbox read hooks + validated URL state"
  - phase: 20-outreach-product-and-api-consistency
    provides: "requireOutreachWrite org-scoped mutation guard"
  - phase: 18-outreach-safety-and-execution-reliability
    provides: "evaluateOutreachDeliveryPolicy suppression check (now also matches the @domain sentinel)"
provides:
  - "src/hooks/useUnifiedInbox.ts operator mutations: optimistic single (read/archive/status/label) + bounded bulk, each snapshotting both the org list + detail caches and rolling back byte-for-byte on 4xx/5xx, reconciling from the server response, invalidating unread + list on settle"
  - "src/lib/unified-inbox-api.ts typed operator mutation fetchers + DTOs + isInboxListQueryKey predicate + INBOX_BULK_LIMIT"
  - "src/components/outreach/inbox/ConversationActions.tsx — accessible single-conversation actions + BulkActionsBar + server-authoritative suppression flow gated by ConfirmDialog"
  - "src/server/lib/inbox-suppression.ts — org-scoped previewSuppression/applySuppression (idempotent; refuses public/free-mail domain blocks) + @domain sentinel model"
  - "src/server/lib/public-email-domains.ts — conservative public/free-mail domain classifier"
  - "unified-inbox router POST /suppressions/preview + POST /suppressions (requireOutreachWrite)"
  - "Delivery policy enforces the @domain suppression sentinel org-wide"
affects: [22-04-reply-composer, 22-05, 23-guarded-ai]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optimistic UI ONLY with rollback (locked #4): a shared engine snapshots every affected org list query + the detail before patching, restores the exact snapshot on error, then reconciles deterministic fields from the server's returned conversation/version"
    - "onSettled invalidation of the org list is what makes an archived/read row leave a view — the server re-filters membership; the optimistic patch only updates in-place fields for instant feedback"
    - "Bulk is bounded at the SOURCE: selection is capped at INBOX_BULK_LIMIT as rows are checked, the request body carries exactly the chosen loaded ids, and the copy says the real count — never a filter-wide 'select all N matching'"
    - "Suppression is server-authoritative (locked #8): the client always previews server-side, always confirms, needs a SECOND confirm for domain scope, and a public/free-mail domain block is refused by the server (400) — the UI only surfaces the server's classification"
    - "Domain blocks are an @domain sentinel row that the delivery policy matches alongside the exact address, so a domain block denies every current + future recipient at that domain"

key-files:
  created:
    - src/components/outreach/inbox/ConversationActions.tsx
    - src/server/lib/inbox-suppression.ts
    - src/server/lib/public-email-domains.ts
  modified:
    - src/lib/unified-inbox-api.ts
    - src/hooks/useUnifiedInbox.ts
    - src/components/outreach/inbox/ConversationList.tsx
    - src/components/outreach/inbox/ConversationThread.tsx
    - src/components/outreach/inbox/InboxFilterRail.tsx
    - src/pages/outreach/UnifiedInboxPage.tsx
    - src/server/routes/outreach/unified-inbox.ts
    - src/server/lib/outreach-delivery-policy.ts
    - src/server/routes/outreach/__tests__/inbox-operator.db.test.ts
    - src/pages/outreach/__tests__/UnifiedInboxPage.test.tsx

key-decisions:
  - "Optimistic patch touches ONLY deterministic fields (unread/archived/status/labels); ordering + view membership are reconciled by an onSettled list invalidation so the server stays authoritative and an archived row disappears only when the current filter requires it."
  - "Suppression preview/apply endpoints were NOT delivered by 22-01 (the plan anticipated 'if implemented'); added server-side as a Rule 2/3 auto-fix — the locked-#8 contract requires server-side execution. Reuses the existing suppressions table (no migration)."
  - "Domain suppression is stored as a lowercased `@domain` sentinel and the delivery policy's suppression check was widened to match it (Rule 2) so a domain block is genuinely enforced for every current + future address — not a cosmetic row."
  - "Public/free-mail domain rejection is SERVER-authoritative (400 suppression_public_domain); the UI refuses the domain confirm and offers only the safe sender scope based on the preview's isPublicDomain flag."
  - "ConversationActions is prop-driven (matching 22-02): the page owns the optimistic hooks and passes handlers + a suppression controller, so the component is unit-testable without a QueryClient and the rollback engine is tested in isolation via renderHook."

patterns-established:
  - "Client hook tests import the REAL hooks past the module mock via vi.importActual('@/hooks/useUnifiedInbox') while api-client is vi.mocked, so the same file can mock the hooks for page/wiring tests AND exercise the real optimistic engine against a fake network."
  - "A DB suite whose baseline predates a production table shape reconciles it in beforeAll (suppressions gained organization_id in prod; the disposable 0000 snapshot still had server_id) — mirrors the harness's own auth/RLS stubs."

requirements-completed: [UIX-04, UIX-05]

# Metrics
duration: 28min
completed: 2026-07-16
---

# Phase 22 Plan 03: Unified Inbox Operator Actions Summary

**Every non-send operator action — read/unread, archive/restore, close/reopen, labels, durable reminders, bounded bulk, and a server-authoritative sender/domain block — now runs on the read workspace with optimistic UI that snapshots BOTH the list and thread caches and rolls back byte-for-byte on any 4xx/5xx, a bulk mode that is bounded to the loaded set and honest about its count, and a destructive suppression flow that the server (not the client) gates — 634/634 tests green (+28).**

## Actions built (matrix)

| Action | Surface | Optimistic patch | Reconcile / invalidate |
| --- | --- | --- | --- |
| Mark read / unread | thread header, bulk | `unread` on item + detail | server `unread`; unread aggregate + list |
| Archive / restore | thread header, bulk | `archived` on item + detail | server `{archived,status}`; list (row leaves an unarchived view on the server re-filter) |
| Close / reopen | thread header | `status` on item + detail | server `{status,archived}`; list |
| Attach / detach label | thread header (checkbox menu), bulk add | `labels[]` add/remove | list (labels[] projection) |
| Create label | filter rail inline form | — | labels query |
| Reminder create | thread header form | — | conversation reminders + list |
| Bulk read/unread/archive/label | BulkActionsBar | all selected loaded ids | matched/updated/skipped; unread + list |
| Block sender / domain | thread header block menu | — (destructive; server-executed) | list + unread on success |

## How optimistic updates roll back on failure

A single engine (`useOptimisticConversationMutation`) wraps every single-conversation mutation. `onMutate` cancels the org's in-flight list + detail queries, snapshots **every** matching list query (`getQueriesData` over the `['outreach-inbox', orgId, 'list', *]` predicate) plus the detail, then patches only the target conversation's deterministic fields in both caches. `onError` restores the exact snapshots (`setQueryData` per captured `[key, data]` pair for the lists, and the detail's prior value). `onSuccess` reconciles from the server's returned conversation/version (e.g. the true `unread` flag). `onSettled` invalidates the unread aggregate and the list so the server has the final word on ordering and view membership. The bulk hook uses the same snapshot/restore shape over the selected id set.

**The test that proves it:** `operator mutations: optimistic + rollback › restores the EXACT prior list + thread state when the request fails with %s` (parametrized over 403/409/500). It seeds an unread conversation into both the list and detail caches, mocks `apiFetch` to reject, runs the real hook via `vi.importActual` against the fake network, and asserts BOTH caches are back to `unread: true` after the rejection settles. A companion test proves org isolation (an ORG_A rollback never touches ORG_B's seeded cache), and a bulk variant proves every affected row is restored.

## How suppression confirmation gates the destructive action + rejects free-mail domains

Suppression is executed **server-side** (locked #8). The new `inbox-suppression` service exposes `previewSuppression` (classifies the exact address/domain, whether the domain is public/free-mail, whether it is already suppressed, and human warnings — never mutates) and `applySuppression` (idempotent insert; **refuses** a public/free-mail domain block with `400 suppression_public_domain`). Routes `POST /suppressions/preview` and `POST /suppressions` sit under `requireOutreachWrite` with the verified `organizationId`.

The client `SuppressionFlow` (inside `ConversationActions`, reusing `ConfirmDialog`) **always** previews before confirming, requires a **second** explicit confirm for a domain block, and — when the preview reports `isPublicDomain` for a domain scope — shows a "Domain block not allowed" dialog that offers only the safe sender scope. A public-domain `apply('...','domain')` is therefore never issued; a rejected apply keeps the dialog open with the reason and the selection intact. Six client tests cover cancel/no-call, email scope, two-confirm safe domain, refused public domain (asserts no domain apply), 403 tenant denial (dialog stays, Retry remains), and duplicate-block idempotency. A domain block stores a lowercased `@domain` sentinel, and `evaluateOutreachDeliveryPolicy` was widened to match it — a DB test proves a *different* fresh address at the blocked domain is denied `recipient_suppressed`.

## How bulk stays bounded + honest about selection count

Bulk selection is capped at `INBOX_BULK_LIMIT` (100, mirroring the server ceiling) at the moment a row is checked — the page's `toggleSelect` refuses to grow the set past the limit, and `selectAllLoaded` only ever selects the currently loaded rows (`conversations.slice(0, LIMIT)`). `BulkActionsBar` renders the real `selectedCount` ("N selected"), never a filter-wide "select all N matching" claim, disables actions at 0 or over-limit, and shows an `alert` above the ceiling. The bulk request body carries exactly the chosen ids (asserted in a hook test) and the server independently rejects >100 / empty / duplicate ids and reports matched/updated/skipped.

## Final gate counts

- `npm run test`: **634 passed / 634** (48 files), run to completion. +28 over the 22-02 baseline of 606: +7 optimistic/rollback hook tests, +10 single-action + bulk + page-wiring component tests, +6 client suppression-gating tests, +4 suppression DB tests, +1 net.
- `npm run build`: PASS (client + server).
- `npm run lint`: PASS (0 warnings, full project).
- `tsc -p tsconfig.json --noEmit` (client): PASS. `tsc -p tsconfig.server.json --noEmit` (server): PASS.
- No new migration (suppressions table reused; 042 remains the latest). No production DB touched. `vitest.config.ts` unchanged.

## Task Commits

1. **Task 1 — optimistic mutation hooks + typed fetchers + rollback tests (TDD)** - `c0be39a` (feat)
2. **Task 2 — accessible single actions, labels, reminders, bounded bulk** - `beff6a4` (feat)
3. **Task 3 — server-authoritative sender/domain suppression + gated UI (TDD)** - `2940663` (feat)

## Deviations from Plan

### Auto-added missing functionality (Rule 2/3)

**1. [Rule 2/3 - Missing server endpoint] Suppression preview/confirm was never built by 22-01**
- **Found during:** Task 3.
- **Issue:** The plan's Task 3 read-first pointed at a "suppression preview/confirm route if implemented" — 22-01 did not build one, yet locked #8 requires suppression to be "executed server-side with organization authorization."
- **Fix:** Added `src/server/lib/inbox-suppression.ts` (+ `public-email-domains.ts`) and two `requireOutreachWrite` routes on the existing unified-inbox router, reusing the existing `suppressions` table (no migration). Covered by 4 DB tests.
- **Files:** inbox-suppression.ts, public-email-domains.ts, unified-inbox.ts.

**2. [Rule 2 - Correctness] Delivery policy now enforces the @domain suppression sentinel**
- **Found during:** Task 3.
- **Issue:** A domain block that stored a sentinel row but was not matched by the send path would be a cosmetic stub — the delivery policy only matched exact addresses.
- **Fix:** Widened the policy's suppression query (`or(exact, '@'+domain)`). The unit test mocks `loadSnapshot`, so it is unaffected; a DB test proves end-to-end enforcement for a fresh address at the blocked domain.
- **Files:** outreach-delivery-policy.ts.

### Test-harness reconciliation

**3. [Rule 3 - Blocking] Disposable-DB `suppressions` predated the org-scoped shape**
- **Found during:** Task 3 (DB test).
- **Issue:** The harness bootstraps `suppressions` from the pre-outreach Drizzle 0000 snapshot (`server_id`-scoped, `server_id NOT NULL`), but production long ago moved it to `organization_id` (RLS policies in 016; the (organization_id, email_address) unique in 037). The suppression service queries `organization_id`.
- **Fix:** The `inbox-operator.db.test` `beforeAll` reconciles the disposable table to the production shape (add `organization_id`, drop `server_id` NOT NULL, add the org unique index) — mirroring the harness's own auth/RLS stubs. No production migration; production already has this shape.
- **Files:** inbox-operator.db.test.ts.

**4. [Within latitude] ConversationActions is prop-driven; the page owns the hooks**
- Matches the 22-02 presentational-component convention: the rollback engine lives in `useUnifiedInbox` and is tested via `renderHook`, while `ConversationActions`/`BulkActionsBar` are tested with mocked handlers. The block flow's suppression controller is injected from the page's `useInboxSuppression`.

**Total deviations:** 4 (1 missing server endpoint auto-added, 1 correctness enforcement, 1 blocking test-harness reconciliation, 1 within-latitude structure). No scope creep; all serve the locked #4/#8 contracts.

## Known Stubs

None that block the plan's goal. Reply/forward composition, scheduled-reply UI, snippet insertion UI, and attachment upload/download remain 22-04/22-05 (this plan delivers UIX-04 in full and the durable reminder/label portions of UIX-05). Attachment download stays the disabled affordance shipped by 22-02. No hardcoded empty values flow to rendering as fake data.

## Self-Check: PASSED

- Files verified present: `ConversationActions.tsx`, `inbox-suppression.ts`, `public-email-domains.ts`, `22-03-SUMMARY.md` (all FOUND).
- Commits verified present: `c0be39a` (Task 1), `beff6a4` (Task 2), `2940663` (Task 3).
- Gates: client `tsc` PASS, server `tsc` PASS, `npm run lint` PASS (0 warnings), `npm run build` PASS, `npm run test` 634/634.

---
*Phase: 22-unified-inbox-operator-experience*
*Completed: 2026-07-16*
