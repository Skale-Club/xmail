---
phase: 22-unified-inbox-operator-experience
plan: 01
subsystem: api
tags: [postgres, drizzle, migration, unified-inbox, outreach, operator-workflows, leases, idempotency, supabase-storage, tdd]

# Dependency graph
requires:
  - phase: 21-unified-inbox-foundation
    provides: "Migration 041 conversation tables + read API (unified-inbox.ts, queries.ts, cursor.ts); provider-neutral contracts"
  - phase: 20-outreach-product-and-api-consistency
    provides: "Canonical outreach access helper (requireOutreachRead/requireOutreachWrite)"
  - phase: 18-outreach-safety-and-execution-reliability
    provides: "Durable dispatcher (dispatchOutreachMessage) + shared delivery policy + lease/idempotency conventions"
  - phase: 19-provider-parity-and-deliverability
    provides: "Threaded-reply provider (createThreadedDispatchProvider) + normalized failure classification"
provides:
  - "Migration 042: operator-workflow tables — inbox_labels, inbox_conversation_labels, inbox_reminders, inbox_snippets, inbox_send_commands, inbox_attachments + additive archive columns on outreach_conversations + one private Supabase Storage bucket"
  - "src/server/lib/inbox-operator.ts — tenant-scoped label/archive/reminder/snippet services, bounded transactional bulk, durable send-command create/cancel"
  - "src/server/lib/inbox-command-dispatch.ts — executeInboxSendCommand, the single lease-aware executor and only inbox caller of dispatchOutreachMessage"
  - "src/server/jobs/processInboxCommands.ts — advisory-locked claimer for due send commands + transactional reminder notifier, wired at 1-min cadence"
  - "Extended unified-inbox.ts router with operator endpoints; extended listConversations/cursor with label/reminder-state/archived filters"
affects: [22-02-unified-inbox-ux, 22-03, 22-04-reply-composer, 23-guarded-ai]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Operator state is durable, organization-scoped rows — never browser state (labels/archive/reminders/snippets/send-commands)"
    - "Composite (id, organization_id) FKs bind every operator row to its tenant; PG15+ column-list ON DELETE SET NULL nulls only the reference column, never the NOT NULL organization_id"
    - "Bounded bulk = transaction that resolves the org-matched id set first, keys every mutation on that set, and reports matched/updated/skipped — an empty/partial filter can never widen to the org"
    - "Durable send command claimed under a lease (token/expiry/bounded attempts); the executor is the ONE lease-aware entrypoint to dispatchOutreachMessage; a stable idempotency key makes a post-crash re-execution return 'duplicate' → at-most-once"
    - "Reminders idempotent via a single transaction: FOR UPDATE SKIP LOCKED + scheduled->notified status guard + user_notification insert; a duplicate tick / restart notifies exactly once"

key-files:
  created:
    - supabase/migrations/042_unified_inbox_operator_workflows.sql
    - src/server/lib/inbox-operator.ts
    - src/server/lib/inbox-command-dispatch.ts
    - src/server/jobs/processInboxCommands.ts
    - src/server/routes/outreach/__tests__/inbox-operator-migration.db.test.ts
    - src/server/routes/outreach/__tests__/inbox-operator.db.test.ts
  modified:
    - src/db/schema.ts
    - src/server/routes/outreach/unified-inbox.ts
    - src/server/lib/unified-inbox/queries.ts
    - src/server/lib/unified-inbox/cursor.ts
    - src/server/jobs/index.ts
    - src/server/routes/outreach/__tests__/unified-inbox.db.test.ts

key-decisions:
  - "Archive is ORTHOGONAL to the Phase 21 open/closed status: additive archived_at/archived_by_user_id columns on outreach_conversations, leaving the status CHECK (and the read API's status filter) untouched."
  - "Composite send-command SET NULL FKs use PG15+ column-list syntax (ON DELETE SET NULL (col)) so deleting a message/email nulls only its link and never the NOT NULL organization_id — an audit record survives."
  - "Attempt accounting: the claim increments attempts (bounds crash/poison loops); a policy defer refunds the attempt (waiting for a send window is free) while a real send failure keeps it and terminates at max_attempts."
  - "executeInboxSendCommand dispatches the frozen command snapshot's primary recipient/body through createThreadedDispatchProvider; full cc/bcc fan-out + quoting + attachment streaming are Plan 22-04."
  - "Reminder metadata uses sql.json() not JSON.stringify() — the latter double-encodes into a jsonb string scalar under postgres-js, making metadata->>'reminderId' return NULL (a real production bug, fixed)."

patterns-established:
  - "Any .db suite that exercises listConversations must apply migration 042 (it now projects/filters 042 columns/tables); Phase 21's unified-inbox.db.test was updated accordingly."
  - "InboxOperatorError(status, code) carries HTTP status + stable code; the route maps it, services never write the response."

requirements-completed: [UIX-04, UIX-05]

# Metrics
duration: 42min
completed: 2026-07-16
---

# Phase 22 Plan 01: Unified Inbox Operator Workflows Summary

**Migration 042 plus a tenant-scoped operator service, an extended (never parallel) inbox router, and an advisory-locked lease claimer turn labels, archive, reminders, snippets, bounded bulk actions, and scheduled replies into durable, organization-owned, restart-safe records — 567/567 tests green.**

## Performance

- **Duration:** ~42 min
- **Started:** 2026-07-16T16:36:28Z
- **Completed:** 2026-07-16T17:18:42Z
- **Tasks:** 3 (Task 1 migration, Tasks 2–3 TDD)
- **Files:** 12 (6 created, 6 modified)

## Operator tables / columns created (migration 042)

042 was confirmed as the next free integer at execution start (041 was the last). All tables carry `organization_id` and composite `(id, organization_id)` tenant binding.

- **`inbox_labels`** — `id, organization_id, name, color?, created_by_user_id?, created_at, updated_at`. Case-insensitive unique `(organization_id, lower(name))`; name-length CHECK; composite `(id, organization_id)` unique for the join FK.
- **`inbox_conversation_labels`** (join) — `(organization_id, conversation_id, label_id, created_by_user_id?)`, unique per `(org, conversation, label)`. Label FK cascades the JOIN row (never the conversation).
- **`inbox_reminders`** — `id, organization_id, conversation_id, user_id, remind_at, note?, status(scheduled|notified|cancelled|done), notified_at?, timestamps`. Partial due-claim index `WHERE status='scheduled'`; `notified` requires `notified_at`.
- **`inbox_snippets`** — `id, organization_id, created_by_user_id?, name, body, shortcut?, timestamps`. Case-insensitive unique name.
- **`inbox_send_commands`** — actor/org/conversation/source-message/account, `mode(reply|reply_all|forward)`, explicit `to/cc/bcc_recipients` jsonb snapshots, `subject/body_text/body_html`, `in_reply_to/message_references`, `attachment_ids`, `status(draft|scheduled|queued|sending|sent|failed|cancelled|held)`, `scheduled_at?/due_at`, `lease_token?/lease_expires_at?`, `attempts/max_attempts`, `last_error?/last_policy_code?`, stable `idempotency_key`, `resulting_conversation_message_id?/resulting_outreach_email_id?`, timestamps. Unique `(organization_id, idempotency_key)`; partial due index `WHERE status IN (scheduled,queued,sending)`; `(organization_id, conversation_id, status)` index; lease + bounded-attempts CHECKs.
- **`inbox_attachments`** — `id, organization_id, send_command_id?, created_by_user_id?, storage_bucket, storage_path, filename, mime_type, size_bytes, checksum?, status(pending|ready|failed|deleted)`. Unique `(storage_bucket, storage_path)`; per-file size CHECK (≤ 25 MiB); NO `bytea`/blob column.
- **`outreach_conversations`** additive columns — `archived_at`, `archived_by_user_id` + partial archived index (status vocab untouched).
- **Private Storage bucket** — one `inbox-attachments` bucket upserted `public=false`, guarded on `storage` schema existence so it is a safe no-op where storage is absent (the disposable test container).

## How the command/reminder claimer stays lease-safe + restart-recoverable

- **Send commands:** `processInboxCommands` runs under a named advisory lock (`runWithLock`, lazily imported so the module loads without `DATABASE_URL`). Each tick first parks poison rows (`status='sending'`, expired lease, `attempts >= max`), then claims the oldest due row (`due_at <= now()` or a `sending` row whose lease expired) via `FOR UPDATE SKIP LOCKED`, flips it to `sending`, sets a fresh lease token/expiry, and increments `attempts`. The claimed lease is handed to `executeInboxSendCommand` — the ONLY inbox module that calls `dispatchOutreachMessage`. Every finalize UPDATE is guarded by `WHERE id = … AND lease_token = …`, so an expired or cancelled command is never overwritten. **Restart recovery:** a crash after a successful send but before finalize leaves the command `sending`; the lease expires, the next tick reclaims it, and the dispatcher's `(organization_id, idempotency_key)` uniqueness returns `duplicate` → the command finalizes `sent` without resending. A policy defer reschedules to `retryAt` and refunds the claim's attempt; a terminal provider failure keeps the attempt and terminates at `max_attempts`; an ambiguous provider outcome is `held` for manual review and never blindly resent.
- **Reminders:** the same tick (a separate advisory-locked function in the file) claims each due `scheduled` reminder with `FOR UPDATE SKIP LOCKED` and, in ONE transaction, inserts a deduplicated `user_notification` (targeting the reminder owner, org-scoped metadata) and flips the reminder `scheduled -> notified`. Because the side effect is a DB insert, the transaction IS the idempotency guard: a duplicate tick or a restart notifies exactly once and never sends email.

## How bulk operations are bounded + tenant-scoped

`bulkUpdateConversations` rejects an empty list, > 100 ids, and duplicate ids up front. Inside one transaction it first resolves the **matched** set (`organization_id = org AND id = ANY(ids)`) and keys every mutation (read/unread/status/archive/unarchive/add_label/remove_label) on that matched set only — a cross-tenant id simply does not match and is counted as `skipped`, never mutated. It returns `{ matched, updated, skipped }`, so an empty/partial filter can never widen to the whole organization. `add_label` additionally verifies the label belongs to the org before inserting join rows. A DB test proves an org-B conversation id passed under org-A scope is reported skipped while org B's row is byte-identical afterward.

## How attachments avoid binary-in-Postgres

`inbox_attachments` stores only object **metadata** (filename, mime type, size, checksum, status) plus a `(storage_bucket, storage_path)` reference to one object in a **private** Supabase Storage bucket; there is no `bytea`/blob column (asserted by the migration test). Migration 042 idempotently configures exactly one `inbox-attachments` bucket with `public = false` (guarded on `storage` schema existence). The lifecycle service (signed intent / finalize / download / orphan cleanup) is a later plan; this plan lands the durable metadata model, the private bucket, and the per-file size/MIME bound at the database.

## API contract added (all under `/api/outreach/unified-inbox`, extending the Phase 21 router)

Reads use `requireOutreachRead`; mutations use `requireOutreachWrite` (viewers read-only); every underlying query carries the verified `organizationId`.

| Area | Endpoints |
| --- | --- |
| Labels | `GET/POST /labels`, `PATCH/DELETE /labels/:id`, `POST /conversations/:id/labels`, `DELETE /conversations/:id/labels/:labelId` |
| Status/archive | `PATCH /conversations/:id/status`, `PATCH /conversations/:id/archive` |
| Bulk | `POST /conversations/bulk` (≤ 100 ids) |
| Reminders | `GET /reminders` (due summary), `GET/POST /conversations/:id/reminders`, `PATCH/DELETE /reminders/:id` |
| Snippets | `GET/POST /snippets`, `PATCH/DELETE /snippets/:id` |
| Send commands | `POST /conversations/:id/send-commands`, `GET /send-commands/:id`, `POST /send-commands/:id/cancel` |
| List filters | `GET /conversations` gains `labelId`, `reminderState(active|due)`, `archived(true|false)`; each conversation item now carries a `labels[]` array; the opaque cursor fingerprint binds the new filters |

## Phase 21 name reconciliation

No Phase 21 tables were renamed or duplicated. This plan **extended** the Phase 21 model: additive archive columns on `outreach_conversations`, and new `inbox_*` tables that reference the Phase 21 `(id, organization_id)` composite uniques. The Phase 21 read router (`unified-inbox.ts`), query module (`queries.ts`), and cursor codec (`cursor.ts`) were extended in place (never a parallel `inbox.ts`).

## Final gate counts

- `npm run test`: **567 passed / 567** (47 files), run to completion. +40 over the Phase 21 baseline of 527 (14 `inbox-operator-migration.db` + 26 `inbox-operator.db`).
- `npm run build`: PASS (client + server).
- `npm run lint`: PASS (0 warnings).
- `tsc -p tsconfig.server.json --noEmit`: PASS. `tsc -p tsconfig.json --noEmit` (client): PASS.
- Migration 042 applied TWICE in its DB test (idempotent). No production DB touched.
- Static check: only `executeInboxSendCommand` reaches `dispatchOutreachMessage` from the inbox surface; the operator route/job import no provider adapter.

## Task Commits

1. **Task 1 — migration 042 + schema mirror + migration DB test** - `44c5db8` (feat)
2. **Task 2 — tenant-safe operator APIs (labels/archive/reminders/snippets/bulk) + router + two-org test** - `8b79db0` (feat)
3. **Task 3 — lease-aware executor + advisory-locked claimer + reminder notifier + scheduler wiring** - `29979ff` (feat)

## Deviations from Plan

### Auto-fixed / within-latitude adjustments

**1. [Rule 3 - Blocking] Task 2/3 tests are `.db.test.ts`, not `.test.ts`**
- **Found during:** Tasks 2–3.
- **Issue:** The plan named the operator test `inbox-operator.test.ts`, but two-org tenant isolation, bulk transactions, and lease/claim concurrency require the guarded Testcontainers Postgres harness (the `server` project excludes `.db.test.ts` and has no DB).
- **Fix:** Named it `inbox-operator.db.test.ts`, matching the Phase 21 convention (`unified-inbox.db.test.ts`). Filter with `npm run test -- inbox-operator.db`.

**2. [Rule 3 - Blocking] Composite `ON DELETE SET NULL` violated NOT NULL organization_id**
- **Found during:** Task 1 (migration DB test).
- **Issue:** A multi-column `ON DELETE SET NULL` nulls ALL referencing columns, including the NOT NULL `organization_id`, so deleting a source message failed.
- **Fix:** Used PG15+ column-list syntax `ON DELETE SET NULL (col)` for the three composite send-command SET NULL FKs (Postgres 16 in the harness; Supabase is PG15+).

**3. [Rule 1 - Bug] Reminder metadata was double-encoded into a jsonb string scalar**
- **Found during:** Task 3 (reminder dedup test).
- **Issue:** `${JSON.stringify(obj)}::jsonb` under postgres-js re-serializes the already-stringified value, storing a jsonb string scalar so `metadata->>'reminderId'` is NULL — a real production bug in the notification path.
- **Fix:** Used the postgres-js `sql.json()` helper (serializes once into a jsonb object). Committed in `29979ff`.

**4. [Rule 1 - Bug] Bulk `read`/`add_label` raw `ANY(array::uuid[])` binding failed (22P02)**
- **Found during:** Task 2 (bulk read/unread test).
- **Issue:** Passing a JS array parameter to `ANY(${arr}::uuid[])` via a raw `sql.execute` produced a malformed array literal.
- **Fix:** Rewrote both paths with the drizzle query builder (`inArray` / values-from-matched-ids), no raw array casting. Committed in `8b79db0`.

**5. [Rule 3 - Blocking] `queries.ts` now references 042 columns/tables**
- **Found during:** Task 2.
- **Issue:** Extending `listConversations` with label/archive/reminder filters + a `labels[]` projection couples it to 042. The Phase 21 `unified-inbox.db.test` applies only up to 041.
- **Fix:** Added migration 042 to that suite's `beforeAll` (additive + idempotent, no regression — 20/20 still green). New cursor fields are optional so `cursor.test.ts` and existing callers still compile.

---

**Total deviations:** 5 (2 blocking test/harness, 2 real bugs auto-fixed, 1 within-latitude naming). **Impact:** All necessary for correctness or to run on the deterministic harness. Two are genuine production bugs (double-encoded jsonb, composite SET NULL) that the DB tests surfaced. No scope creep.

## Known Stubs

None that block the plan's goal. The attachment **lifecycle** service (signed upload intent / finalize / download / orphan cleanup) is intentionally deferred to a later plan — this plan delivers the durable `inbox_attachments` metadata model + private bucket + DB-level size/MIME bound that the lifecycle will build on. `executeInboxSendCommand` dispatches the primary recipient/body from the frozen snapshot; full cc/bcc fan-out, quoting, and attachment streaming are Plan 22-04 (documented in code). No hardcoded empty UI values.

## Issues Encountered

- **jsonb-as-string under `prepare:false`.** postgres-js returns jsonb from a data-modifying CTE's `RETURNING` (and on plain reads) as a raw string rather than a parsed value under the pooler-safe `prepare:false` config. Handled in production code (`parseRecipients` in the claimer) and in test assertions (parse metadata before reading). Not a defect — a documented postgres-js behavior.

## User Setup Required

None for automated verification. **Production rollout note:** migration 042 is written and tested against the disposable Postgres harness but is NOT applied to production. Manual apply, after 038→039→040→041, in order:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/042_unified_inbox_operator_workflows.sql
```

The private `inbox-attachments` Storage bucket is created by the migration only where a `storage` schema exists (production Supabase); no separate dashboard step is required for the bucket row, though Storage RLS/policies for signed uploads are a later attachment-lifecycle plan.

## Next Phase Readiness

- **22-02+ (Unified Inbox UX)** has a stable, typed server contract: label/archive/reminder/snippet endpoints, bounded bulk, list filters (`labelId`/`reminderState`/`archived`) + `labels[]` projection, and durable send-command create/cancel/status.
- **22-04 (reply composer)** builds on `createInboxSendCommand` + `executeInboxSendCommand`: it resolves recipients/thread headers/attachments from the thread and creates commands; the executor already dispatches them at-most-once through the policy gate.
- No production migration is applied yet; keep 038→039→040→041→042 as an ordered manual deploy step.

## Self-Check: PASSED

- Files verified present: `042_unified_inbox_operator_workflows.sql`, `inbox-operator.ts`, `inbox-command-dispatch.ts`, `processInboxCommands.ts`, `inbox-operator-migration.db.test.ts`, `inbox-operator.db.test.ts`, `22-01-SUMMARY.md` (all FOUND).
- Commits verified present: `44c5db8` (Task 1), `8b79db0` (Task 2), `29979ff` (Task 3).
- Gates: client `tsc` PASS, server `tsc` PASS, `npm run lint` PASS (0 warnings), `npm run build` PASS, `npm run test` 567/567.

---
*Phase: 22-unified-inbox-operator-experience*
*Completed: 2026-07-16*
