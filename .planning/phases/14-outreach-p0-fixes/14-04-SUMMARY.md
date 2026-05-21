---
phase: 14-outreach-p0-fixes
plan: 04
subsystem: outreach/campaigns-route
tags: [outreach, drizzle, scheduling, transaction, cascade-delete, p0-fix]
requirements_satisfied:
  - P0-01
  - P0-09
  - P0-10
dependency_graph:
  requires:
    - "14-03 (cascade FKs in migration 020 + Drizzle schema mirror)"
  provides:
    - "addLeadsToCampaign that actually schedules the first email (nextScheduledAt is non-NULL)"
    - "addLeadsToCampaign that correctly resolves the first sequence step (no broken Drizzle subquery)"
    - "deleteCampaign wrapped in a transaction so future non-cascading relations can be torn down atomically by adding a single tx.delete() line"
  affects:
    - "src/server/jobs/processOutreachSequences.ts — pendingLeads query will now match newly-added leads on the next 5-minute tick"
tech_stack:
  added: []
  patterns:
    - "Two sequential .findFirst() calls in place of an inline db.select() subquery (Drizzle pattern: scalar values must be resolved outside the where clause)"
    - "Wrap multi-step or cascade-relying deletes in db.transaction(async (tx) => ...) for defense-in-depth even when schema FKs cascade"
    - "Set nextScheduledAt = new Date() on insert so SQL lte(col, now) doesn't filter the row out via NULL semantics"
key_files:
  created: []
  modified:
    - src/server/routes/outreach/campaigns.ts
decisions:
  - "firstSequence ordering uses asc(sequences.createdAt) → oldest sequence wins deterministically when a campaign somehow has multiple (matches audit fix sugerido)."
  - "nextScheduledAt = new Date() (immediate now), not now + 1min. The processor runs every 5min; the immediate value matches the audit's preferred fix ('agendar imediato') and the next tick picks it up regardless."
  - "Dropped the dead `|| 0` fallback on currentStepOrder: the schema CHECK requires stepOrder >= 1 AND we now guard with `if (!firstStep) return 400` above, so the fallback was unreachable."
  - "Transaction body in deleteCampaign is intentionally THIN — only the campaigns delete. Adding manual tx.delete() for sequences/steps/leads/outreach_emails would fire the cascade twice (no-op at best, error at worst). The comment block is the contract: future non-cascading relations get added BEFORE the campaigns line."
  - "Added top-level `asc` to drizzle-orm import. Previously only present via callback-style ordering (`orderBy: (steps, { asc }) => [asc(...)]`); we now use array-form `orderBy: [asc(...)]` which needs the top-level symbol."
metrics:
  duration_seconds: 180
  duration_human: "~3 minutes"
  tasks_completed: 2
  files_touched: 1
  commits: 2
  completed_at: "2026-05-17T04:30:00Z"
---

# Phase 14 Plan 04: addLeadsToCampaign + deleteCampaign P0 fixes — Summary

Three P0s closed inside a single file (`src/server/routes/outreach/campaigns.ts`): the lead-add flow now actually schedules emails (P0-01), resolves the first sequence step via a valid two-query pattern (P0-09), and campaign deletion runs inside a transaction (P0-10 code half) on top of the schema-level cascade landed in Plan 14-03.

## What was built

### Edit 1 — Drizzle import (line 5)

Added `asc` to the named imports so the new two-query refactor can use array-form `orderBy: [asc(...)]` instead of the callback-style `orderBy: (t, { asc }) => [asc(...)]` (callback form still works inside `findFirst`, but the top-level import is cleaner and consistent with the rest of the file's `desc` usage).

```diff
-import { eq, and, sql, inArray, desc } from 'drizzle-orm'
+import { eq, and, sql, inArray, desc, asc } from 'drizzle-orm'
```

### Edit 2 — addLeadsToCampaign (lines 956-994 region)

**Before** (the bug, ~18 lines):

```ts
const firstStep = await db.query.sequenceSteps.findFirst({
    where: eq(sequenceSteps.sequenceId,
        db.select({ id: sequences.id }).from(sequences).where(eq(sequences.campaignId, campaignId)).limit(1)
    ),
    orderBy: (steps, { asc }) => [asc(steps.stepOrder)],
})

const insertedCampaignLeads = await db.insert(campaignLeads).values(
    newLeadIds.map(leadId => ({
        campaignId,
        leadId,
        assignedEmailAccountId: validatedData.emailAccountId,
        currentStepId: firstStep?.id,           // ← undefined in practice
        currentStepOrder: firstStep?.stepOrder || 0,
        // ← MISSING: nextScheduledAt → NULL → processor skips forever
    }))
).returning()
```

**After** (the fix, ~38 lines):

- `firstSequence = await db.query.sequences.findFirst(...)` first
- Return **400** if no sequence: `"Campaign has no sequence — create a sequence with at least one step before adding leads"`
- `firstStep = await db.query.sequenceSteps.findFirst(... eq(sequenceSteps.sequenceId, firstSequence.id))` second
- Return **400** if no step: `"Campaign sequence has no steps — add at least one step before adding leads"`
- Insert with `currentStepId: firstStep.id` (non-optional now), `currentStepOrder: firstStep.stepOrder` (no `|| 0` dead code), and **`nextScheduledAt: now`** (the P0-01 fix)
- `const now = new Date()` declared once and reused for every row in the insert

The two-query pattern is documented in-line with a 3-line comment citing audit P0-09. The `nextScheduledAt` set is documented with a 2-line comment citing audit P0-01 and explaining the NULL-semantics gotcha.

### Edit 3 — deleteCampaign (lines 549-555 region)

**Before:**

```ts
await db.delete(campaigns).where(eq(campaigns.id, campaignId))
```

**After:**

```ts
// Wrap in transaction for defense-in-depth. The schema-level ON DELETE CASCADE
// (migration 020) handles sequences, sequence_steps, campaign_leads, outreach_emails
// automatically. If a future relation is added without cascade, add explicit
// tx.delete(...) calls here BEFORE the campaigns delete. See audit P0-10.
await db.transaction(async (tx) => {
    await tx.delete(campaigns).where(eq(campaigns.id, campaignId))
})
```

The transaction body is intentionally **thin**: a single delete that leans on the migration 020 cascade chain (sequences → sequence_steps → campaign_leads → outreach_emails). The comment above the transaction is the contract for future contributors — any new outreach table that does NOT cascade gets its `tx.delete(...)` added BEFORE the campaigns line so the campaigns row stays around long enough to anchor the cascade plan.

Manual `tx.delete()` calls for already-cascading tables were deliberately **not** added because they would either no-op (rows already gone) or cause a race with the cascade. Defense-in-depth here means atomicity + a documented extension point, not redundant deletes.

## Deviations from Plan

None — plan executed exactly as written. The plan's verbatim code blocks were applied for both edits; the import update was done as Step 1 of Task 1.

## Commits

| # | Hash | Message |
|---|---|---|
| 1 | `1ab6703` | fix(14-04): repair addLeadsToCampaign (P0-01 + P0-09) |
| 2 | `29f7705` | fix(14-04): wrap deleteCampaign in transaction (P0-10 code half) |

## Verification

- `grep -n "asc" src/server/routes/outreach/campaigns.ts | head -1` → asc present in drizzle-orm import on line 5 — **PASS**
- `grep -n "db.select({ id: sequences.id })"` → 0 matches (broken subquery gone) — **PASS**
- `grep -n "Campaign sequence has no steps"` → 1 match (400 guard in place) — **PASS**
- `grep -n "nextScheduledAt: now"` → 1 match (P0-01 fix in place) — **PASS**
- `grep -c "firstSequence"` → 3 matches (declare + null-check + use) — **PASS**
- `grep -n "db.transaction(async (tx)"` → 1 match (transaction wrap in place) — **PASS**
- `grep -n "tx.delete(campaigns)"` → 1 match inside transaction — **PASS**
- `grep -n "await db.delete(campaigns).where(eq(campaigns.id, campaignId))"` → 0 matches (bare delete gone) — **PASS**
- `npm run build` — **EXIT 0** (Vite client + tsc server, no diagnostics)

## Test plan (post-deploy UAT)

After Wave 2 ships and migration 020 is applied to prod Supabase:

1. **P0-01 + P0-09 smoke test:**
   - Create a campaign with a sequence containing ≥ 1 step.
   - POST `/api/outreach/campaigns/{id}/leads` with a lead ID payload.
   - Within ≤ 5 minutes (one processor tick), confirm an outreach email lands in the lead's inbox and `outreach_emails` row exists.
   - SQL spot check: `SELECT id, next_scheduled_at, current_step_id FROM campaign_leads WHERE campaign_id = '<id>';` — both columns should be **non-NULL** for newly-added rows.

2. **P0-09 guard test:**
   - Create a campaign with **no** sequence (or a sequence with no steps).
   - POST to the same endpoint.
   - Expect HTTP 400 with the appropriate error message (no silent insert of broken rows).

3. **P0-10 cascade test:**
   - Create a campaign, add leads, let at least one email send (so `outreach_emails` rows exist).
   - DELETE `/api/outreach/campaigns/{id}`.
   - Expect HTTP 200, no FK error in the server log, and `SELECT COUNT(*) FROM outreach_emails WHERE campaign_id = '<id>'` returns 0.

## Contracts published for later plans

This plan is the final touch for the `addLeadsToCampaign` and `deleteCampaign` handlers in Phase 14. No downstream plan needs further changes here. Plan 14-05 (P0-02 HMAC tokens) and 14-06 (P0-03/P0-05/P0-06/P0-07/P0-08) operate on different files and do not interact with these handlers.

## Known Stubs

None introduced by this plan. (The pre-existing `trackingToken` placeholder in `outreach-sender.ts` from Plan 14-03 remains, and is resolved by Plan 14-05 per Wave 2 plan ownership — out of scope here.)

## Self-Check: PASSED

Files verified to exist (modified):
- FOUND: src/server/routes/outreach/campaigns.ts (line 5 has `asc` in import; lines 959-993 have two-query pattern + nextScheduledAt; lines 554-556 have transaction wrap)

Commits verified in git log:
- FOUND: 1ab6703
- FOUND: 29f7705
