---
phase: 22
phase_name: unified-inbox-operator-experience
status: passed
score: "6/6 requirements; 19/19 declared must-haves"
verified_at: "2026-07-16T20:35:00Z"
verifier: gsd-verifier
---

# Phase 22 Verification — Unified Inbox Operator Experience

## Verdict

**Passed.** The implementation satisfies the Phase 22 goal and `UIX-01` through `UIX-06`. This
verdict rests on direct source inspection and fresh gate runs, not on the plan summaries (which
were themselves under test).

The operator can work every outreach reply from one organization-scoped `/outreach/unified-inbox`
route inside `OutreachLayout` (not a skin over `/mail/inbox`): a server-paginated conversation list
and full normalized thread across accounts; URL-validated filters/search that round-trip to the
Phase 21 server (no in-memory org-mailbox filtering, no cross-tenant cache reuse); reply/reply-all/
forward whose recipients and RFC threading headers are resolved SERVER-SIDE from persisted messages
and dispatched only through the single lease-aware `executeInboxSendCommand` behind the Phase-18
policy gate; bounded/tenant-scoped operator actions with a server-authoritative, public-domain-
refusing suppression flow; durable DB-backed scheduled replies and reminders claimed under an
advisory lock with lease + idempotency (no browser timers); and one bearer-authenticated
`fetch`+`ReadableStream`+`AbortController` SSE aggregate stream carrying only ids/counts, degrading
to bounded list/unread polling with a visible stale state and never clobbering an active composer.

The safety-critical claim — **durable, restart-safe, policy-gated send** — is true in code:
the route persists a command with no dispatch capability; the claimer reclaims expired leases; the
executor is the only inbox caller of `dispatchOutreachMessage`; a crash-replay collapses onto the
same `outreach_emails` row via the stable idempotency key (`duplicate` → finalize `sent`, no resend).

Provider-gated send/attachment-byte delivery and the deployment migration/bucket apply are correctly
deferred to runtime (BLOCKED/MANUAL in the UAT), not claimed as verified — the same discipline as
Phase 18. One minor housekeeping observation is recorded below (orphan-cleanup helper not scheduled);
it does not affect any observable requirement truth.

## Fresh verification evidence

| Check | Result |
|---|---|
| Full suite (run 1) | `npm run test` — **50 files, 692/692 passed**, exit 0 (55.1s) |
| Full suite (run 2, determinism) | `npm run test` — **50 files, 692/692 passed**, exit 0 (55.9s) — byte-identical file/test counts; Phase 21+ determinism holds |
| Production build | `npm run build` — **exit 0**; Vite client + PWA precache + `tsc -p tsconfig.server.json` server build |
| Lint | `npm run lint` — **exit 0**, zero warnings (`--max-warnings 0`) |
| Client typecheck | `tsc --noEmit -p tsconfig.json` — **exit 0** (matters here; the build does NOT typecheck the client) |
| Server typecheck | `tsc --noEmit -p tsconfig.server.json` — **exit 0** |
| Migration provenance | `042_unified_inbox_operator_workflows.sql` is the highest hand-written migration (041 precedes it); no generated/drizzle-kit artifact in the phase diff |
| Migration harness | `inbox-operator-migration.db.test.ts` applies 042 **twice** to the guarded disposable Postgres (`assertSafeTestDatabaseUrl` rejects the app URL / non-loopback / non-`test` db); asserts no `bytea` column and a **private** bucket (`public = false`) |
| Single-dispatch scan | `dispatchOutreachMessage` production callers = sequences, follow-ups, manual send, and `inbox-command-dispatch.ts` only; `processInboxCommands.ts` never calls it directly |
| `EventSource` scan | Zero uses in `src/` (only negative-assertion comments/tests); client stream uses `fetchWithAuth` |

Determinism note: both runs printed identical `50 passed (50)` / `692 passed (692)`. A benign
`sql.begin is not a function` WARN appears in both runs from the **pre-existing** best-effort outbound
materialization (test fake lacks `.begin`); the diff to `outreach-dispatch.ts` is additive-only
(optional `cc`/`bcc`/`attachments`), the path is caught ("backfill will repair"), and production
`queryClient` implements `.begin`. Not a Phase 22 regression.

## Requirement matrix

| Requirement | Status | Evidence |
|---|---|---|
| `UIX-01` — centralized list + full thread across accounts | PASS | Distinct workspace route `/outreach/unified-inbox` lazy-loaded under the org-member gate at `src/main.tsx:520-523` (`OutreachCheck`, not `AdminCheck`), rendered inside `OutreachLayout` with an `Inbox` nav item + unread badge at `src/components/outreach/OutreachLayout.tsx:43,195`; `/mail/inbox` untouched. Server-cursor list + full normalized thread via `useInboxConversations`/`useInboxConversation` against the Phase 21 router mounted at `src/server/routes/outreach/index.ts:35`. 83 client tests in `UnifiedInboxPage.test.tsx` green. |
| `UIX-02` — URL filters + bounded search, shareable, tenant-safe | PASS | `src/lib/unified-inbox-url.ts` Zod parse/serialize (defaults omitted, invalid enums/UUIDs/blank search scrubbed, cursor reset on filter change); `toListQueryString` maps to the exact Phase 21 `GET /conversations` query (archived hidden by default) — client never filters an org mailbox in memory; query keys begin `['outreach-inbox', organizationId, …]` so an org change yields fresh keys (`unified-inbox-api.ts`). URL round-trip + validation + cache-separation tests green (UAT 4.1–4.4). |
| `UIX-03` — reply/reply-all/forward, server threading, policy gate, bounded attachments | PASS | `resolveSendCommand` (`inbox-command-dispatch.ts:467-524`) derives To/Cc/In-Reply-To/References from persisted `outreach_conversation_messages`; the route schema (`unified-inbox.ts:405-418`) has **no** reply-mode recipient/header field, so spoofing is structurally impossible. `createResolvedSendCommand` deps carry **no** `dispatch` seam (`inbox-command-dispatch.ts:573-628`); `executeInboxSendCommand` (`:190`) is the sole inbox caller of `dispatchOutreachMessage` via the Phase-18 gate. Attachments bounded/owned/private/non-base64 (`inbox-attachments.ts:91-118,259-280`); RAW upload capped by `express.raw` 26 MiB at `unified-inbox.ts:740-744`. Server unit + DB resolution + composer tests green; live-provider smoke correctly BLOCKED. |
| `UIX-04` — read/unread, labels, archive, bulk, suppression | PASS | Durable org-scoped rows (migration 042; `inbox-operator.ts`); every mutation via `requireOutreachWrite` and `ctx.organizationId` (`unified-inbox.ts`); bulk hard-capped at `BULK_CONVERSATION_LIMIT` (100) at both the Zod schema (`:373`) and the transactional service, reporting matched/updated/skipped. Suppression is server-authoritative: `applySuppression` refuses public/free-mail domains (`inbox-suppression.ts:127`), stores an `@domain` sentinel, and the client requires a second confirm; two-org DB tests + 6 client gating tests green. |
| `UIX-05` — durable scheduled replies/reminders/snippets/attachments, restart-safe | PASS | `inbox_send_commands`/`inbox_reminders` are DB rows; `processInboxCommands.ts` claims due rows under advisory lock (`:302-307`) via `FOR UPDATE SKIP LOCKED` + fresh lease + bounded attempts (`:164-188`), and hands each to the executor; restart replay is at-most-once through the idempotency key (`inbox-command-dispatch.ts:290-293`); a policy defer reschedules and refunds the attempt, body untouched (`:294-300`). Reminders notify exactly once in one transaction and never send email (`processInboxCommands.ts:254-291`). Registered at 1-min cadence (`jobs/index.ts:153`). NO browser timers (composer only POSTs a command). Claimer/reminder DB tests green. |
| `UIX-06` — near-real-time without per-thread polling; safe degrade | PASS | ONE org-scoped SSE endpoint behind `requireOutreachRead` (`unified-inbox.ts:244`); the bus rebuilds every event from a fixed whitelist so bodies/subjects/addresses cannot ride the wire (`inbox-events.ts:86-96`); subscribers keyed by org id (structural tenant isolation). Client uses `fetchWithAuth`+`ReadableStream`+`AbortController`, never `EventSource` (`useUnifiedInboxEvents.ts:141-176`); disconnect → capped backoff + bounded unread/list poll only (`invalidateAggregates` never enumerates threads, `:55-60`) with visible `isStale`; the hook only invalidates queries (never focus/composer). `inbox-events.test.ts` + SSE hook tests + composer-preservation test green. |

## Declared must-have verification

### Plan 22-01 — durable operator workflow layer

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Labels/archive/reminders/snippets/send-commands are durable org-scoped records | PASS | Migration 042 tables all carry `organization_id` + composite `(id, organization_id)` keys; services in `inbox-operator.ts`. |
| Truth | Bulk has a hard server limit and can't cross tenants | PASS | `bulkSchema` `.max(BULK_CONVERSATION_LIMIT)` (`unified-inbox.ts:373`) + transactional matched-set service reporting matched/updated/skipped. |
| Truth | Scheduled commands/reminders use leases/idempotency, recover after restart | PASS | `processInboxCommands.ts:154-211` (park poison → claim → lease → executor) + idempotency replay at `inbox-command-dispatch.ts:290-293`; reminder single-txn dedup `:254-291`. |
| Truth | Migration numbering revalidated; no Drizzle generate/push | PASS | 042 is the next free integer (041 precedes); migration test only touches the guarded disposable URL; no generated artifact in the diff. |
| Artifact | `supabase/migrations/042_…sql` (contains `inbox_send_commands`) | PASS | Present; full DDL incl. lease/attempts/idempotency uniques + private bucket. |
| Artifact | `src/server/lib/inbox-operator.ts` exports bulk/reminder/send-command services | PASS | Present (871 lines); `InboxOperatorError` status/code mapping. |
| Artifact | `src/server/lib/inbox-attachments.ts` lifecycle service | PASS | Present; validate/upload/assert-owned/load/download/delete/cleanup + private bucket + no bytea. |
| Artifact | `src/server/jobs/processInboxCommands.ts` advisory-locked processor | PASS | Present; `runInboxCommandsWithLock` + `processDueReminders`. |
| Key link | router → `requireOutreachRead/Write` + org predicate | PASS | Every handler routes through `authorizeOrganization`/`authorizeWrite` (`unified-inbox.ts:126-167`). |
| Key link | due commands only via `executeInboxSendCommand` | PASS | `processInboxCommands.ts:196`; no direct `dispatchOutreachMessage`. |

### Plan 22-02 — read workspace + URL state

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | One org-scoped route, server-paginated list + full thread | PASS | `main.tsx:520`; `useInfiniteQuery` over the opaque cursor; thread via `useInboxConversation`. |
| Truth | Validated URL state round-trips; org change can't reuse another tenant's cache | PASS | `unified-inbox-url.ts` + org-leading query keys; org-switch clears selection/cursor. |
| Truth | Desktop/tablet/mobile follow the spec, not a shrunk grid | PASS | CSS breakpoints (`hidden xl:flex` rail, overlay sheet, single mobile stage); AUTO stage-swap test (UAT 2.8); MANUAL responsive rows pending deploy. |
| Truth | List/thread states independently recoverable | PASS | Separate queries + prop-driven components; independent loading/empty/error/retry tests (UAT 3.1–3.9). |
| Artifact | `UnifiedInboxPage.tsx` / `useUnifiedInbox.ts` / `unified-inbox-url.ts` | PASS | All present and wired to the live Phase 21 API (no mock fallback). |
| Key link | `ConversationList` → `GET /conversations` via validated filters | PASS | `useInboxConversations` + `toListQueryString`. |
| Key link | `ConversationThread` → `EmailHtmlViewer` isolation | PASS | Bodies render through the sandboxed (no `allow-scripts`) iframe; malformed-HTML isolation test green. |

### Plan 22-03 — operator actions + suppression

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Single + bulk mutations patch list & thread caches and roll back on failure | PASS | `useOptimisticConversationMutation` snapshots both caches; the 403/409/500 rollback test restores byte-for-byte (UAT 6.2); org-isolation rollback test green. |
| Truth | Suppression requires explicit scope confirmation, executed server-side | PASS | `previewSuppression`/`applySuppression` under `requireOutreachWrite`; two-confirm domain flow; public-domain refusal (`inbox-suppression.ts:127`). |
| Truth | Bulk bounded; copy never implies filter-wide selection | PASS | Selection capped at `INBOX_BULK_LIMIT`; body carries exactly the chosen ids; BulkActionsBar shows the real count. |
| Artifact | `ConversationActions.tsx` accessible single/bulk + destructive confirm | PASS | Present (590 lines); `ConfirmDialog`-gated block flow. |
| Artifact | `useUnifiedInbox.ts` optimistic mutations + rollback | PASS | Present. |
| Key link | `ConversationActions` → 22-01 APIs via typed mutations + `ConfirmDialog` | PASS | Wired through the page-owned hooks/controller. |
| Extra (Rule-2 correctness) | Delivery policy enforces the `@domain` sentinel | PASS | `outreach-delivery-policy.ts:324-339` — org-scoped `or(exact, '@'+domain)`; DB test proves a fresh address at a blocked domain is denied `recipient_suppressed`. |

### Plan 22-04 — reply composer + attachments

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Recipients + RFC headers resolved/validated server-side from persisted messages | PASS | `resolveSendCommand` (`:467-524`); route schema has no reply-mode recipients (`:405-418`). |
| Truth | Every immediate/scheduled send is a durable command via the single executor; routes never dispatch | PASS | `createResolvedSendCommand` (no dispatch dep) → `inbox_send_commands` row → claimer → `executeInboxSendCommand`. |
| Truth | Attachments bounded, org-owned, never base64 JSON | PASS | `inbox-attachments.ts` validation + ownership + private bucket + no bytea; RAW upload (not multipart) preserves every locked-#7 property. |
| Truth | Policy denial preserves the draft with a safe retry/defer | PASS | Executor reschedules on `deferred` with body untouched + `last_policy_code` (`:294-300`); composer renders the recoverable reason and keeps the body (`ConversationComposer.tsx:214-216,371-381`). |
| Artifact | `inbox-command-dispatch.ts` validation/dispatch adapter | PASS | Present (764 lines). |
| Artifact | `ConversationComposer.tsx` reply/reply-all/forward + snippets/attachments/schedule | PASS | Present (412 lines). |
| Key link | executor owns policy + the sole low-level dispatch | PASS | `inbox-command-dispatch.ts:103-119,190`. |

### Plan 22-05 — near-real-time + UAT

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | One lightweight org-scoped stream invalidates aggregates; bodies never broadcast | PASS | Whitelist redaction (`inbox-events.ts:86-96`); endpoint under `requireOutreachRead` (`:244`). |
| Truth | Disconnect → bounded polling, visible stale, threads stay readable | PASS | `useUnifiedInboxEvents.ts:88-100,132-139`; `isStale`; `InboxSyncStatus` "Updates delayed". |
| Truth | Badge/list/open-thread converge without stealing focus or clobbering the composer | PASS | Hook only invalidates queries; detail-namespace invalidation; composer keyed by conversation id; focus/body-preservation test green (UAT 9.6). |
| Truth | Responsive/a11y UAT covers every async + destructive/send flow | PASS | `22-UAT.md` maps every AUTO row to a passing case; MANUAL/BLOCKED rows recorded honestly. |
| Artifact | `useUnifiedInboxEvents.ts` fetch/ReadableStream SSE + fallback | PASS | Present; `InboxRealtimeProvider` hosts one stream at the shell (`OutreachLayout.tsx:266`). |
| Artifact | `22-UAT.md` executable script | PASS | Present (254 lines). |

## Special-scrutiny assessments

- **22-03 delivery-policy widening (highest-risk):** ACCEPTABLE. The change (`outreach-delivery-policy.ts:324-339`) is additive: the exact-address arm is preserved as the first `or()` branch, the second arm only matches a literal `@domain` sentinel row, and the whole predicate is `AND`-scoped to `organizationId`. It cannot over-suppress legitimate mail (a real address `user@d.com` never equals the sentinel `@d.com`) and cannot break existing sender suppression. Domain sentinels are only ever created for non-public domains (write-side refusal at `inbox-suppression.ts:127`). A DB test proves end-to-end enforcement; the pure unit test mocks `loadSnapshot` and is unaffected.
- **22-04 RAW-body attachment upload:** ACCEPTABLE. All locked-#7 properties hold — count (schema `.max` + `assertAttachmentsUsable`), per-file & aggregate size (`validateAttachmentDeclaration`/`validateAttachmentSet` measuring ACTUAL received bytes + `express.raw` 26 MiB ceiling + DB CHECK), MIME/extension allow-list rejecting active content, ownership (org-scoped + not-already-bound), private bucket (`public=false`), server-chosen path (`buildStoragePath`), and non-base64 (no bytea column, bytes stream to Storage). Only the wire encoding differs from multipart, justified by no multipart parser on Express 5 beta.
- **22-05 detail-namespace SSE invalidation:** ACCEPTABLE. Invalidating the detail namespace refetches only the currently-open thread (the sole active observer) — a bounded, correct refresh — while the hook never touches composer state or calls focus; the composer's local draft (keyed by conversation id) survives the event-driven re-render (proven test). It does not poll every thread.
- **UAT AUTO/MANUAL/BLOCKED split:** HONEST. All 10 spot-checked AUTO rows resolve to real passing tests in `UnifiedInboxPage.test.tsx` / `inbox-events.test.ts`. Live-provider send (§11.1–11.3) and real attachment byte delivery (§8.12) are marked BLOCKED/MANUAL (provider credentials + Supabase Storage absent here), not passed from unit tests.
- **Migrations 038–042 unapplied to production:** CORRECTLY FLAGGED. 042 is the highest hand-written migration; the migration test only touches the disposable harness; summaries + UAT record the ordered manual `psql` apply as a deployment prerequisite. No production DB/Storage was touched.

## Anti-patterns / observations

| Item | Severity | Impact |
|---|---|---|
| `cleanupExpiredAttachments` (`inbox-attachments.ts:373`) is defined but not registered in `jobs/index.ts` | ℹ️ Info | The RAW-upload flow inserts `ready` rows (not `pending`) and rolls back the object on insert failure, so it creates no orphan intents to prune; but abandoned `ready` uploads (composer discarded) have no automatic reaper. Storage hygiene only — no requirement-truth impact. Recommend scheduling the helper (and extending it to unbound `ready` rows past a TTL) in a follow-up. |
| `sql.begin is not a function` WARN during tests | ℹ️ Info | Pre-existing best-effort outbound materialization with a test fake lacking `.begin`; caught and backfilled, production `queryClient` has `.begin`. Not a Phase 22 change. |

No blocker or warning anti-patterns found. No stub/placeholder rendering, no hardcoded empty data
flowing to the UI, no direct-provider bypass, no `EventSource`, no browser-timer scheduling.

## Human verification required

These are deployment-runtime items explicitly outside the automated boundary (mirroring Phase 18's
deferred live-provider/migration concerns) — not unverified Phase 22 acceptance criteria:

### 1. Apply migration 042 + provision the private bucket
**Test:** `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/042_unified_inbox_operator_workflows.sql` after 038→041; confirm the private `inbox-attachments` bucket + signed-URL Storage policies exist.
**Expected:** Tables/indexes/bucket created; bucket `public = false`.
**Why human:** Production DB/Storage are not touched by tests.

### 2. Provider reply smoke (native / SMTP / Outlook)
**Test:** UAT §11.1–11.3 — send one reply per provider from a deployed account.
**Expected:** Sent with correct `In-Reply-To`/`References`; Outlook Bcc refusal is a documented Graph limitation.
**Why human:** No production provider credentials in this environment (BLOCKED, provider-gated).

### 3. Real attachment upload/download round-trip
**Test:** UAT §8.12 — upload a bounded file, dispatch, and download via the signed URL.
**Expected:** Byte-accurate delivery from the private bucket.
**Why human:** Requires the deployed Supabase Storage bucket.

### 4. Restart-recovery + responsive/a11y manual rows
**Test:** UAT §10.3–10.4 (restart before `due_at` → exactly one dispatch), §2/§5 responsive + keyboard/contrast, §9.8–9.10 two-browser convergence + degraded fallback.
**Expected:** As scripted; the automated claimer/lease/idempotency tests already cover the mechanism (§10.1–10.2).
**Why human:** Requires a running app + browser + a live second session.

## Gaps

None blocking. `UIX-01`–`UIX-06` are each satisfied by code + passing tests, not inference or
documentation. The one recorded observation (unscheduled orphan-cleanup helper) is Info-level storage
hygiene with no observable-truth impact and is safe to address in a follow-up.

---

_Verified: 2026-07-16T20:35:00Z_
_Verifier: Claude (gsd-verifier) — direct source inspection + fresh test/build/lint/tsc runs_
