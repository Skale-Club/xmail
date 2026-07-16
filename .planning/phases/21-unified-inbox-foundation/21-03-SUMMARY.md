---
phase: 21-unified-inbox-foundation
plan: 03
subsystem: api
tags: [outreach, unified-inbox, providers, parity, outbound, backfill, idempotency, tdd, postgres]

# Dependency graph
requires:
  - phase: 21-unified-inbox-foundation (plan 01)
    provides: "Migration 041 — conversation tables + provider-event materialization lifecycle; provider-neutral contracts"
  - phase: 21-unified-inbox-foundation (plan 02)
    provides: "materializeProviderEvent (idempotent leased event->message materializer), attributeConversation, normalize.ts, materializeUnifiedInbox job"
  - phase: 19-provider-parity-and-deliverability
    provides: "outreach_provider_events/cursors staging + native/IMAP/Graph inbound readers, cursor contract, Outlook read scopes + capability gate"
  - phase: 18-outreach-safety-and-execution-reliability
    provides: "dispatchOutreachMessage durable sent-state finalize contract"
provides:
  - "unified-inbox/providers/{native,imap,outlook}.ts — pure provider->NormalizedInboundMessage adapters with equivalent full fields (the sole field-mapping boundary; outreach-inbound-sources.ts delegates to them)"
  - "IMAP field parity: full safe-header allow-list extracted from raw MIME (was a fixed 6-header subset)"
  - "materializeOutboundEmail — idempotent outreach_email -> ONE outbound conversation message (source_key outreach-email:<id>), never sends/mutates the email"
  - "The sole best-effort outbound hook in outreach-dispatch.ts, after durable sent-state commit"
  - "backfillUnifiedInbox — bounded, restart-safe NOT EXISTS anti-join backfill (outbound before inbound)"
affects: [21-04-read-api, 22-unified-inbox-ux, 23-guarded-ai]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One provider->normalized field-mapping boundary shared by ingestion AND the parity suite: native mail row / raw MIME ParsedMail / Graph delta message all funnel through unified-inbox/providers/*"
    - "IMAP retains the full SAFE_HEADER_ALLOW_LIST from raw header lines so a materialized IMAP message carries the same safe headers native/Graph carry (sanitizeHeaders narrows both at materialization)"
    - "Outbound idempotency = FOR UPDATE on outreach_emails (read-lock only, never mutated) + unique (org,account,source_key) message key; outbound threads by its own Message-ID root so an inbound reply's In-Reply-To/References converge on the same rfc:<root> key"
    - "Best-effort post-dispatch hook: invoked only after finalizeSent commits, wrapped so any failure (incl. a mocked/absent DB client) is swallowed and never resends"
    - "Restart-safe backfill without a checkpoint table: anti-join drops materialized rows + deterministic (sent_at,id)/(received_at,id) keyset advances past errored rows within a run"

key-files:
  created:
    - src/server/lib/unified-inbox/providers/shared.ts
    - src/server/lib/unified-inbox/providers/native.ts
    - src/server/lib/unified-inbox/providers/imap.ts
    - src/server/lib/unified-inbox/providers/outlook.ts
    - src/server/lib/unified-inbox/outbound.ts
    - src/server/jobs/backfillUnifiedInbox.ts
    - src/server/lib/unified-inbox/__tests__/providers.db.test.ts
    - src/server/lib/unified-inbox/__tests__/outbound.db.test.ts
    - src/server/jobs/__tests__/backfillUnifiedInbox.db.test.ts
  modified:
    - src/server/lib/unified-inbox/normalize.ts
    - src/server/lib/outreach-inbound-sources.ts
    - src/server/lib/outreach-dispatch.ts
    - src/server/lib/__tests__/outreach-dispatch.test.ts
    - src/server/lib/__tests__/outlook-inbound.test.ts

key-decisions:
  - "The provider field-mapping boundary is unified-inbox/providers/*, not processReplies/processBounces (which only consume already-normalized events). outreach-inbound-sources.ts delegates to and re-exports the adapters (normalizeGraphMessage kept for existing importers)."
  - "IMAP parity fix: extract the FULL safe-header allow-list from parsed.headerLines rather than a fixed 6-header subset; SAFE_HEADER_ALLOW_LIST is exported from normalize.ts as the single source of truth."
  - "Outbound provider column = the sending email_account's provider; outbound match_strategy = 'outbound' (allowed by 041 CHECK), classification = 'other'."
  - "Outbound lead attribution: campaign_lead's lead when present, else the org lead at the recipient address (manual/campaign-less sends); campaign/campaign_lead come straight from the send."
  - "Backfill is operator-invoked (backfillUnifiedInbox + advisory-locked runBackfillUnifiedInboxWithLock); NOT scheduled, to honour the no-downtime/bounded rollout requirement."

patterns-established:
  - "Every new .db suite applies 038/039/041 in beforeAll and cleans up its own rows in afterAll (events before conversations, so the composite event->message ON DELETE SET NULL never nulls organization_id)."

requirements-completed: [UIF-02, UIF-03, UIF-05]

# Metrics
duration: 30min
completed: 2026-07-16
---

# Phase 21 Plan 03: Provider Parity, Outbound Materialization, and Backfill Summary

**Native, IMAP, and Outlook now stage EQUIVALENT full normalized fields through one shared adapter boundary; every durably sent outreach email becomes exactly one outbound conversation message via a best-effort post-dispatch hook, and a bounded restart-safe anti-join backfill closes any crash window without resending — with an inbound reply proven to thread onto its outbound root.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-16T12:55:24Z
- **Completed:** 2026-07-16T13:22:00Z
- **Tasks:** 3 (TDD)
- **Files:** 14 (9 created, 5 modified)

## How the three providers achieve field parity

The provider→normalized field mapping was extracted out of `outreach-inbound-sources.ts` into three pure adapters under `src/server/lib/unified-inbox/providers/`, each producing the same Phase 19 `NormalizedInboundMessage` shape; `outreach-inbound-sources.ts` now delegates to them (and re-exports `normalizeGraphMessage`). Because ingestion AND the parity test both go through this one boundary, the mapping cannot drift.

| Field | native (`native.ts`) | IMAP/`smtp` (`imap.ts`) | Outlook (`outlook.ts`) |
| --- | --- | --- | --- |
| direction | inbound (set at materialization) | inbound | inbound |
| provider id / source_key | `native:<mail_message_uuid>` | `smtp:mid:<msgid>` / `smtp:uid:<v>:<uid>` | `outlook:mid:<msgid>` / `outlook:graph:<id>` |
| RFC threading (internet_message_id / in_reply_to / references) | from row | from ParsedMail | from `internetMessageHeaders` |
| addresses (from/to/cc) | row fields | ParsedMail address objects | Graph recipient objects |
| text + html bodies | both, truncated | both, truncated | one (Graph exposes one body) |
| safe headers | full `row.headers` | **FULL allow-list from `headerLines`** (was a 6-header subset) | full bounded `internetMessageHeaders` |
| attachment metadata | id/name/mime/size/inline/contentId | checksum/name/mime/size/inline/cid | id/name/mime/size/inline/contentId |

The one real gap this plan closed is the **IMAP header subset**: Phase 19 kept only 6 headers, so a materialized IMAP message was missing Subject/Date/Message-ID/From/To/... that native and Graph carried. `imap.ts` now extracts the FULL `SAFE_HEADER_ALLOW_LIST` (exported from `normalize.ts`) from the raw header lines. The parity DB test stages the SAME logical reply via all three adapters and asserts equal `internet_message_id`/`in_reply_to`/`message_references`/`subject`/`from_address`, that all three converge into ONE conversation (identical reference root), and that all three carry the shared safe-header key set. Bodies are the sole legitimate divergence: Graph returns exactly one body, so parity there is field-presence (each provider fills whichever bodies it has), which the existing text/html fallbacks already handle.

## How attachment metadata stays binary-free

Every adapter maps a provider attachment onto the fixed `OutreachProviderAttachment` descriptor — `providerId`, `name`, `mimeType`, `size`, `inline`, `contentId` — and nothing else. No adapter reads `content`/`contentBytes`/`data`; the Graph reader (Phase 19) already fetches attachment metadata via `$select=id,name,contentType,size,isInline,contentId` and never downloads bytes, and IMAP derives descriptors from the parsed MIME parts (mailparser recomputes the real decoded `size`, which is why the parity test asserts `size > 0` rather than a cross-provider-identical byte count). The DB test proves it: after materialization, every stored attachment's key set is a subset of the descriptor keys, and the fixture's base64 blob bytes appear nowhere in the persisted attachments JSON.

## How the outbound hook stays best-effort and the backfill stays restart-safe

**The hook** (`src/server/lib/outreach-dispatch.ts`) is the SOLE live outbound materialization call. It fires ONLY after `repository.finalizeSent(...)` returns true — i.e. after `outreach_emails.status='sent'`/`sent_at`/`message_id` have committed durably — and is wrapped in a `try/catch` that swallows any error (logging `outreach.dispatch.outbound_materialize_failed`). Because the send is already durable before the hook runs, a materialization failure can neither fail nor delay the send, and `materializeOutboundEmail` never calls the provider, so it can never resend. `dispatchOutreachMessage` returns `sent` regardless. (The full-suite run even exercised the swallow in the wild: an existing dispatch test reached the sent path with a mock query client, the default hook's `sql.begin is not a function` was swallowed, and the test still passed.) Entrypoints (campaign/manual/agentic/route/jobs) are unchanged and delegate only to the dispatcher — verified by the existing `outreach-entrypoints.test.ts`.

**The backfill** (`src/server/jobs/backfillUnifiedInbox.ts`) reuses the LIVE idempotent materializers over rows an anti-join proves are unmaterialized: successful `outreach_emails` missing an `outreach-email:<id>` message, and staged events missing a `<provider>:<id>` message. Restart-safety needs no checkpoint table because a materialized row disappears from the anti-join, and a deterministic `(sent_at,id)`/`(received_at,id)` keyset advances past any errored row within a run — so interruption and restart converge to the same counts as one uninterrupted run (proven by the "interrupted twice then unbounded" test landing on the same 4 messages). Outbound batches run BEFORE inbound so a historical reply's References attach to its outbound root. It writes only the Unified Inbox tables — no campaign/lead/account counters — and the "never resends or mutates" test asserts the `outreach_emails` row count and statuses are byte-identical before and after.

## Proof an inbound reply joins the outbound conversation

`materializeOutboundEmail` stores the outbound message's own `internet_message_id` and roots the conversation `thread_key` at `rfc:<outbound-message-id>`. An inbound reply carrying `In-Reply-To: <outbound-message-id>` then resolves through Plan 21-02's attribution tier 1 (an existing conversation message with that `internet_message_id`) OR, failing that, converges via the identical `rfc:<root>` thread key. Two tests pin this:

- `outbound.db.test.ts` "threads a later inbound reply onto the same outbound conversation": materialize the sent email, then materialize an inbound event with `in_reply_to = <outbound-root>` → `inbound.conversationId === outbound.conversationId`, lead/campaign inherited, conversation carries both `last_inbound_at` and `last_outbound_at`, 2 messages in 1 conversation.
- `backfillUnifiedInbox.db.test.ts` "runs outbound before inbound…": a sent outbound + a staged reply event referenced only by Message-ID, backfilled in one pass, land in one conversation holding exactly one `inbound` + one `outbound` message.

## OAuth read scopes / degraded state

No change needed here — Phase 19 already ships the Outlook read surface: `OUTLOOK_SCOPES` includes `Mail.Read`, and `evaluateOutlookOutreachCapability` fails an account with `outlook_missing_scopes` (reconnect guidance) rather than reporting success when read scope is absent. This plan consumes that contract; it neither weakens nor re-implements it.

## Backfill runbook (operator-invoked)

The backfill is intentionally NOT scheduled (no downtime; bounded rollout). To populate recent history in production, an operator invokes it once (e.g. via a one-off `tsx` script or REPL) after migrations 038→039→040→041 are applied:

```ts
import { runBackfillUnifiedInboxWithLock } from './src/server/jobs/backfillUnifiedInbox'
// Bounded: default lookback 30 days, batchSize 200, maxBatches 1000. Advisory-locked so it
// cannot overlap the 5-min materializer. Reports scanned/inserted/duplicates/errors per section.
const result = await runBackfillUnifiedInboxWithLock({ lookbackDays: 30 })
```

It is safe to re-run (converges), can be scoped with `organizationId`, and mutates no counters. The regular `materializeUnifiedInbox` cron (Plan 21-02) already drives new inbound events; the backfill is only for the recent history that predates the materializer/hook or fell into a crash window.

## Final gate counts

- `npm run test`: **494 passed / 494** (42 files), run TWICE deterministically. +20 over the 21-02 baseline of 474 (5 providers.db + 7 outbound.db + 5 backfill.db + 3 dispatch).
- `npm run build`: PASS (client + server).
- `npm run lint`: PASS (0 warnings).
- `tsc -p tsconfig.server.json --noEmit`: PASS. `tsc -p tsconfig.json --noEmit` (client): PASS.
- No new migration (schema is from 041). No production DB touched.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking] Pre-existing Outlook test time-bomb blocked the mandatory `npm run test` gate**
- **Found during:** Task 2 gate (running refactor-affected suites).
- **Issue:** `outlook-inbound.test.ts` pinned the fixture `tokenExpiresAt` to the simulated `NOW+1h` (`2026-07-16T13:00Z`), but `getValidOutlookAccessToken` checks expiry against the REAL `Date.now()`. Once the real wall clock passed 13:00Z on 2026-07-16, all 23 `fetchOutlookInboxDelta` tests spuriously took the refresh path and failed with "Failed to obtain Outlook token". Confirmed pre-existing by reproducing on clean HEAD with my changes stashed (unrelated to the adapter refactor — the failing tests don't touch the adapters).
- **Fix:** Anchored the fixture's token validity to real time (`Date.now() + 60 * 60_000`) so the pre-flight check always sees a live token. No test intent changed (refresh-path tests trigger via 401, not expiry).
- **Files modified:** `src/server/lib/__tests__/outlook-inbound.test.ts`. **Commit:** `ebadf06` (`fix(21)`).

### Design resolutions within plan latitude

- **Provider mapping lives in `unified-inbox/providers/*`, not `processReplies.ts`/`processBounces.ts`.** The plan's Task 2 `files_modified` listed those two jobs and `outlook.ts`, but they only *consume* already-normalized events — the real provider→normalized boundary is `outreach-inbound-sources.ts`, which I refactored to delegate to the new adapters. `processReplies.ts`, `processBounces.ts`, and `outlook.ts` needed no change (Outlook read scopes + degraded gate already shipped in Phase 19). The listed files reflect the pre-21-02 plan draft; the substantive change landed where the mapping actually is.
- **`src/server/jobs/index.ts` unchanged.** The plan listed it under Task 3, but the `materializeUnifiedInbox` cron was already wired by Plan 21-02, and the backfill is operator-invoked by design (no-downtime requirement), so no scheduler change is warranted.
- **`outreach-inbound-sources.ts` was modified** (not in the plan's file list) to delegate to the adapters and re-export `normalizeGraphMessage` — necessary so the new adapters are the live staging path rather than dead code.

## Known Stubs

None. Every module is wired and exercised end-to-end: the adapters drive the live `ingestOutreachInbound` staging path and the parity DB suite; `materializeOutboundEmail` is called by the live dispatch hook and the backfill and is covered by `outbound.db.test.ts`; `backfillUnifiedInbox` is covered by its own DB suite. The backfill is intentionally operator-invoked (not scheduled) per the plan's bounded-rollout requirement.

## Deferred Issues

- **DEF-21-A** (pre-existing Phase 19 concurrent-claim db flake under full postgres load) — did NOT manifest in either full run this plan (494/494 twice). Still tracked in `deferred-items.md` for a future Phase 19 test-hardening task.

## Self-Check: PASSED

- Files verified present: all 9 created + 5 modified (see key-files).
- Commits verified present: `7a8cd43` (test/RED), `ebadf06` (fix/time-bomb), `69533d0` (feat/adapters), `d74ed2b` (feat/outbound+hook+backfill).
- Gates: client `tsc` PASS, server `tsc` PASS, `npm run lint` PASS (0 warnings), `npm run build` PASS, `npm run test` 494/494 (twice).

---
*Phase: 21-unified-inbox-foundation*
*Completed: 2026-07-16*
