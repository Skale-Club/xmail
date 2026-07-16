---
phase: 23
phase_name: ai-inbox-automation-and-guardrails
fixed_at: "2026-07-16T20:10:00Z"
review: 23-REVIEW.md
status: fixes_complete
addressed: [C-1, G-1, M-1, M-2, M-4]
deferred: [M-3]
gates: { test: "907 passed (56 files), 3x identical", build: pass, server_tsc: 0, client_tsc: 0, lint: 0 }
---

# Phase 23 Code Review — Fix Report

All blocking findings (C-1, G-1) fixed; three hardenings folded in (M-1, M-2, M-4). M-3 deferred
(optional, non-cross-tenant). The single-delivery-path invariant and every clean category from the
review are preserved — the C-1 fix introduces no new send path and the model still cannot influence
the ceiling count.

## C-1 (CRITICAL) — autonomous follow-up ceiling was inoperative → FIXED

**Root cause (confirmed):** `resolveAutonomousRun` set `autonomousFollowUpsSent: campaignLead.followUpCount`,
but `campaign_leads.follow_up_count` is never incremented on the durable-command send path (the 23-03
refactor deleted the legacy `set({ followUpCount: +1 })` and never re-homed it). Grep confirmed only
the schema def + those two reads. So the check was always `0 >= N` → false for any positive N: an
operator's "max 2 follow-ups" was silently unlimited.

**Fix (count-over-`outreach_ai_runs`, no schema change):**
`src/server/lib/inbox-ai-automation-runtime.ts`
- New `countAutonomousSends(organizationId, campaignLeadId)`: counts `outreach_ai_runs` where
  `organization_id = … AND campaign_lead_id = … AND run_kind = 'autonomous' AND status = 'completed'
  AND action = 'draft' AND send_command_id IS NOT NULL`. That predicate matches ONLY a run that
  genuinely dispatched a reply (a completed run's `action` is set to `'draft'` exclusively in the
  `sent`/`duplicate` executor branch, and the run is linked to a durable command). Drafts, held,
  failed, no-action, and `paused_before_dispatch` (`action = 'none'`) runs are excluded.
- `resolveAutonomousRun` now derives `autonomousFollowUpsSent` from this count and no longer reads the
  dead `follow_up_count` column (removed from the `campaign_leads` select).
- **Tenant-scoped:** the count filters on `(organization_id, campaign_lead_id)`.
- **Crash/replay-safe:** a run is terminal once `completed`, so it is counted at most once; the
  command/run idempotency already collapses dispatch replays onto that single run, so the count
  advances exactly once per successful autonomous send. The run being processed is still `running`
  during resolution, so it is naturally excluded (this counts PRIOR sends only).
- `max = 0` still blocks (`0 >= 0`), so "disable" continues to work.

**RED test (exercises the REAL counting path, not an injected value):**
`src/server/lib/__tests__/inbox-ai-automation-ceiling.db.test.ts` (new, 3 tests). Self-contained: it
applies migration 043 (idempotent) so the `outreach_ai_runs` FKs are present deterministically, and
seeds a real chain (org, campaign, lead, campaign_lead, account, conversation, one durable command).
- **countAutonomousSends test:** drives N=3 GENUINE successful autonomous sends by running the real
  `processAutonomousAiRun` end-to-end against the real `createDrizzleAiRunStore` (claim → link durable
  command → complete `action='draft'`), and asserts the real count advances 0→1→2→3, once per send.
  It then asserts `campaign_leads.follow_up_count` is STILL 0 after N real sends (the frozen column the
  old code trusted — the direct RED proof that the old path would never trip the ceiling). It also
  proves specificity: held/failed/no-action/`none`/draft-kind/other-lead rows do NOT count, and the
  count is per-lead and per-org scoped.
- **ceiling-engages test:** drives N=2 genuine sends (ceiling = N), then processes the (N+1)th run
  whose `resolveRun` reads the REAL `countAutonomousSends` → count reports N → `N >= N` fires →
  `no_action` with `output_outcome = 'max_follow_ups'`, and `createCommand`/`dispatchCommand` are
  never called. Under the old code the (N+1)th resolution read `follow_up_count = 0`, so `0 >= 2` was
  false and it would have sent — this test is that RED.
- **max=0 test:** a fresh lead with `max = 0` → `no_action`, no dispatch.

Source lock: `src/server/lib/__tests__/outreach-review-regressions.test.ts` asserts the runtime uses
`countAutonomousSends` and no longer reads `campaignLead.followUpCount` as the ceiling source.

## G-1 (GAP) — full test suite was non-deterministic → FIXED

**Root cause (confirmed):** `campaign-sequences.db.test.ts` applied only migration 040 in `beforeAll`
and depended on a SIBLING suite (notification-policy) having applied 024 (`outreach_settings`) to the
one shared disposable DB. Vitest reorders files by cached timing across re-runs, so it intermittently
failed with `relation "outreach_settings" does not exist` (500 ≠ 201). Reproduced on the pre-fix
baseline: cold run 888/898 with all 10 failures in that suite.

**Fix (root-cause, class-eliminating):** `src/test/postgres-harness.ts` — added
`024_outreach_settings.sql` to `OUTREACH_TEST_BASELINE_MIGRATIONS`, so `outreach_settings` exists for
EVERY suite. 024 is a small idempotent `CREATE TABLE IF NOT EXISTS` + `ENABLE ROW LEVEL SECURITY`; it
applies cleanly on top of the baseline order (it only needs `organizations`, created by the bootstrap
before the baseline loop) and the notification-policy suite's own explicit 024 apply becomes a
harmless idempotent no-op.

**Determinism proof:** `npm run test` run **3×** back-to-back → **907 passed (56 files)** every time,
identical. Runs 2 and 3 reorder files by cached timing (the exact condition that previously exposed
the flake) and are green — which also serves as the audit for any other hidden cross-suite
table-dependency of this class (there were none; all three reordered runs are clean).

## M-1 (hardening) — dead attribution guard on the suggestion path → FIXED

`src/server/routes/outreach/unified-inbox.ts` (`loadInboxAiContextInput`) now selects
`organization_id`/`conversation_id` from `outreach_conversation_messages` and stamps each projected
context message from the ROW (`m.organizationId`/`m.conversationId`) instead of the function args —
mirroring the autonomous runtime resolver. `buildInboxAiContext`'s `attribution_mismatch` guard is now
a live second line of defense: if the org-scoped query ever returned a foreign row, the build fails
closed instead of trusting the caller's scope. (The org-scoped `WHERE` remains the real protection, so
there was and is no isolation gap.)

**Test:** because the org-scoped query pins both columns, a runtime mismatch cannot be produced through
the real query (row-stamp vs arg-stamp are behaviorally identical on a correct query) — so this is
strictly defense-in-depth and is locked with a source-level regression in
`outreach-review-regressions.test.ts` (asserts the select fetches the row's scope columns and the
projection stamps from `m.organizationId`/`m.conversationId`). The existing `buildInboxAiContext`
attribution suite already proves the guard fires on a foreign row.

## M-2 (hardening) — reloadAutonomy default returned stale autonomy → FIXED

`src/server/lib/inbox-ai-automation.ts` — `reloadAutonomy` is now a REQUIRED dep on
`ProcessAutonomousAiRunDeps` (removed the `?`), and the pre-dispatch recheck calls
`deps.reloadAutonomy(claimed)` directly (the stale `?? (async () => resolution!.autonomy)` fallback is
gone). A caller can no longer silently skip the pause recheck by omitting the dep. All existing call
sites already supply a fresh reader (production `createProcessDeps`, and both the automation + evals
test `processDeps` helpers), so no behavior changed for correct callers. Locked with a source-level
regression assertion.

## M-4 (hardening) — source-guard coverage + stale comment → FIXED

`src/server/lib/__tests__/outreach-entrypoints.test.ts` — extended the source-guard regression (the
one asserting `processFollowUps.ts` imports no send primitive) to ALSO assert
`src/server/lib/inbox-ai-automation.ts` and `inbox-ai-automation-runtime.ts` import no
`dispatchOutreachMessage` / `sendThreadedReply` / `createThreadedDispatchProvider` /
`outreach-dispatch-provider` / `outreach-sender` / `outreach-provider`, plus a positive assertion that
the runtime reaches the wire only via `executeInboxSendCommand` (the allowed durable executor). This
locks the single-delivery-path invariant from the entrypoint-guard file too (it was already covered by
the structural guard in `inbox-ai-automation.test.ts`).

`src/server/lib/inbox-ai-automation.ts:17-24` — corrected the stale comment to state that the source
-level regression tests live in `inbox-ai-automation.test.ts` (structural guard) and
`__tests__/outreach-entrypoints.test.ts` (entrypoint guard), covering THIS module and the runtime.

## M-3 (optional) — DEFERRED

Not fixed (per the review's "optional, low priority; skip unless trivial"). It is a within-org,
self-inflicted replay (a caller reusing one client-chosen idempotency key across two of its OWN
conversations replays the first conversation's draft) — never cross-tenant. Adding `conversationId` to
the suggestion idempotency identity changes the documented key contract and the endpoint's idempotency
semantics, so it is not trivial enough to fold in blind without product intent; deferred as a
key-per-conversation contract note for a follow-up.

## Files changed

- `src/server/lib/inbox-ai-automation-runtime.ts` — C-1: `countAutonomousSends` + wire into resolution.
- `src/server/lib/__tests__/inbox-ai-automation-ceiling.db.test.ts` — C-1 RED (new, 3 tests).
- `src/test/postgres-harness.ts` — G-1: 024 in the baseline.
- `src/server/routes/outreach/unified-inbox.ts` — M-1: stamp attribution from the DB row.
- `src/server/lib/inbox-ai-automation.ts` — M-2: required `reloadAutonomy`; M-4: comment fix.
- `src/server/lib/__tests__/outreach-entrypoints.test.ts` — M-4: source-guard coverage.
- `src/server/lib/__tests__/outreach-review-regressions.test.ts` — C-1/M-1/M-2 source locks (3 tests).

## Gate counts (final)

| Gate | Result |
| --- | --- |
| `npm run test` (run 1) | 907 passed (56 files) |
| `npm run test` (run 2) | 907 passed (56 files) — identical |
| `npm run test` (run 3) | 907 passed (56 files) — identical |
| `npm run build` | success |
| `npx tsc --noEmit -p tsconfig.server.json` | 0 errors |
| `npx tsc --noEmit -p tsconfig.json` (client) | 0 errors |
| `npm run lint` | 0 warnings |

Pre-fix baseline for reference: 898 total, non-deterministic (cold 898/898, re-runs 888/898). Post-fix:
907 total (+9: 3 ceiling db + 3 entrypoint guard + 3 review-regression locks), deterministic.

## Deviations

- None beyond the review scope. M-1 is locked with a source-level regression rather than a behavioral
  test because the org-scoped query makes a row/arg attribution difference unobservable at runtime
  (documented above) — it is genuine defense-in-depth, not a behavior change.
- C-1's RED drives genuine sends through the real store + real count query; the durable-command
  boundary (`createCommand`/`dispatchCommand`) is faked at a real seeded command id, keeping the test
  a focused ceiling test rather than standing up the entire Phase 18/22 dispatch stack. The count it
  asserts against is the real production query over real audit rows.
