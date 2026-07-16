---
phase: 20-outreach-product-and-api-consistency
plan: 01
subsystem: api
tags: [outreach, sequences, postgres, drizzle, zod, migration, transactional]

# Dependency graph
requires:
  - phase: 18-outreach-safety-and-execution-reliability
    provides: disposable Testcontainers postgres harness (serial, advisory-locked migration applies), TERMINAL_CAMPAIGN_LEAD_STATUSES / CAMPAIGN_LEAD_PROGRESS, shared delivery policy
  - phase: 19-outreach-provider-events
    provides: migration 039 baseline, provider event schema
provides:
  - One database-enforced canonical sequence per campaign (unique index on sequences.campaign_id)
  - Transactional GET/PUT /api/outreach/campaigns/:campaignId/sequence replace contract (idempotent, history-safe)
  - Shared canonical sequence service (getCanonicalSequence, replaceCanonicalSequence, sequencePayloadSchema)
  - Hand-written migration 040 that merges legacy multi-sequence campaigns non-destructively
  - Reconciled sequence_steps invariants across Zod, Drizzle, and PostgreSQL
affects: [outreach-settings, outreach-metrics, unified-inbox, campaign-enrollment, sequence-processor]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Discriminated-union Zod payload whose step order is derived from array position (one-based, contiguous) rather than trusted from the client"
    - "Transactional replace service that preserves row ids for unchanged positions and refuses to orphan referenced rows (history_conflict)"
    - "Non-destructive data migration: reparent child rows by id + delete only verified-empty parents; abort with a diagnostic on ambiguous conflict"
    - "Deliberately-failing migration tested on a private connection so the shared advisory lock is never held across an aborted transaction"

key-files:
  created:
    - src/server/lib/outreach-sequences.ts
    - supabase/migrations/040_outreach_product_consistency.sql
    - src/server/lib/__tests__/outreach-sequences.db.test.ts
    - src/server/lib/__tests__/outreach-sequences-migration.db.test.ts
    - src/server/routes/outreach/__tests__/campaign-sequences.db.test.ts
  modified:
    - src/server/routes/outreach/campaigns.ts
    - src/db/schema.ts
    - src/pages/outreach/SequencesPage.tsx
    - src/pages/outreach/sequences/NewSequencePage.tsx
    - src/pages/outreach/campaigns/tabs/SequenceTab.tsx
    - src/pages/outreach/campaigns/tabs/StatsTab.tsx

key-decisions:
  - "Step order is derived server-side from the payload array index (one-based, contiguous); the client never sends stepOrder, which removes an entire class of duplicate/zero-based bugs"
  - "History safety = never delete a referenced step: in-place updates preserve step ids (send snapshots already live on outreach_emails), and removing a referenced trailing step returns 409 history_conflict instead of orphaning it"
  - "Email content validity (subject + at least one body) and non-email content-emptiness are hard PostgreSQL CHECK constraints; the migration preflights and aborts with counts on legacy violations rather than fabricating or dropping content"
  - "Condition steps are accepted as an explicitly documented, content-free shape (not an undocumented payload); they remain quarantined by the processor until branching exists"
  - "Legacy single-step CRUD and the many-sequence create/list endpoints stay as compatibility adapters that cannot create a second row and carry Deprecation metadata; the UI uses the replace endpoint"

patterns-established:
  - "Canonical resolution: resolve the single sequence via getCanonicalSequence(campaignId, organizationId); never findFirst(sequences)/sequences[0]"
  - "One transaction for campaign + its canonical sequence creation"

requirements-completed: [CONS-01, CONS-07]

# Metrics
duration: 34min
completed: 2026-07-16
---

# Phase 20 Plan 01: Canonical Campaign Sequence Summary

**One database-enforced sequence per campaign with a transactional, idempotent, history-safe replace contract reconciled across Zod, Drizzle, and hand-written PostgreSQL migration 040.**

## Performance

- **Duration:** ~34 min
- **Started:** 2026-07-16T08:00:52Z
- **Completed:** 2026-07-16T08:35:00Z
- **Tasks:** 3
- **Files modified:** 11 (5 created, 6 modified)

## Accomplishments

- **Database-enforced canonical model.** Migration 040 adds `sequences_campaign_id_unique`, so a campaign can never have more than one sequence. `GROUP BY campaign_id HAVING count(*) > 1` is now structurally impossible.
- **Non-destructive legacy reconciliation.** 040 merges each campaign's surplus sequences into the oldest (`created_at`, then `id`) canonical row by **reparenting steps by id** (never deleting them), then removing only verified-empty surplus sequences. Historical `campaign_leads.current_step_id` and `outreach_emails.sequence_step_id` references survive because the step rows they point at are re-pointed, not dropped. When two sequences of one campaign share a step position, the migration **aborts with a diagnostic** instead of silently dropping content.
- **Transactional replace contract.** `PUT /api/outreach/campaigns/:campaignId/sequence` replaces the entire ordered step set in one transaction: idempotent for an identical payload (same step ids, no row growth), rejects edits to non-draft/paused campaigns (409), and refuses to remove a step that still has send history or an active lead pointer (409 `sequence_step_referenced`) rather than orphaning it.
- **Three-layer invariant reconciliation.** Step order ≥ 1, delay ≥ 0, A/B percentage bounds, and email-requires-subject+body / non-email-carries-no-content are enforced identically in the Zod payload, `src/db/schema.ts`, and PostgreSQL CHECK constraints.
- **Every consumer resolves the same resource.** Enrollment, activation validation, the processor (already id-based), and all UI screens use the canonical resolver; `rg "sequences\[0\]|findFirst\(.*sequences"` finds no production canonical-sequence selection.

## Task Commits

1. **Task 1: Failing db tests for the canonical contract** — `2aa267b` (test)
2. **Task 2: Migration 040 + Drizzle mirror + migration test** — `162c305` (feat)
3. **Task 3: Canonical service, API, and migrated UI callers** — `143d678` (feat)

**Plan metadata:** _(this commit)_ (docs: complete plan)

## Files Created/Modified

- `src/server/lib/outreach-sequences.ts` — `sequencePayloadSchema` (discriminated union), `getCanonicalSequence`, transactional `replaceCanonicalSequence`.
- `supabase/migrations/040_outreach_product_consistency.sql` — merge + normalize + unique index + step checks (hand-written, idempotent).
- `src/db/schema.ts` — mirrored `sequences_campaign_id_unique`, `sequence_steps_ab_test_percentage_bounds`, `sequence_steps_content_valid`.
- `src/server/routes/outreach/campaigns.ts` — new GET/PUT `/sequence`, transactional campaign creation, canonical enrollment/activation, deprecated compat adapters.
- `src/pages/outreach/{SequencesPage,sequences/NewSequencePage}.tsx` — load + save the singular resource via one replace mutation; removed append loops and the "reuse first sequence" workaround.
- `src/pages/outreach/campaigns/tabs/{SequenceTab,StatsTab}.tsx` — read the singular `/sequence`, render one-based `Step {stepOrder}`.
- 3 `.db.test.ts` files — service, route (real express handlers), and migration coverage against the guarded Testcontainers harness.

## Final API payload

Request — `PUT /api/outreach/campaigns/:campaignId/sequence`:

```jsonc
{
  "name": "Main Sequence",            // optional
  "description": "…",                 // optional, nullable
  "steps": [                           // 1..50, order derived from position
    { "type": "email", "delayHours": 0, "subject": "Hi", "htmlBody": "<p>…</p>",
      "plainBody": "…", "abTestEnabled": false, "abTestPercentage": 50 },
    { "type": "delay", "delayHours": 48 },
    { "type": "condition", "delayHours": 0 }
  ]
}
```

Responses: `200 { sequence: { id, campaignId, name, description, isActive, createdAt, updatedAt, steps:[…] } }`;
`400` Zod validation; `409 { code: "campaign_not_editable", status }`; `409 { code: "sequence_step_referenced", conflicts:[{ stepId, stepOrder }] }`; `403`/`404` for access/existence. GET returns `{ sequence: <canonical | null> }`.

## History-preservation policy

- **In-place edits are always safe.** Matching positions reuse the existing step id; sent-content history is snapshotted on `outreach_emails` (its own subject/body columns), so editing a step never rewrites the record of what was sent.
- **Deletions are gated.** A trailing step removed by a shorter payload is deleted only if no `campaign_leads.current_step_id` and no `outreach_emails.sequence_step_id` reference it; otherwise the edit is rejected (409) with the conflicting `stepId`/`stepOrder` and nothing is written.
- **Migration is non-destructive.** Step rows are re-pointed, never deleted; ambiguous position conflicts abort the whole migration; a content preflight aborts (with counts) rather than mutating legacy drafts.

## Legacy-row reconciliation counts

The migration was validated **only** against the guarded Testcontainers harness (which rejects non-test DBs), per plan discipline — it has **not** been applied to production. The harness starts from an empty schema, so seeded scenarios (not organic rows) exercised the merge:

- Merge happy path: 1 campaign, 2 sequences (1 empty canonical + 1 surplus with a referenced step) → merged to 1 sequence, step id preserved, lead + outreach_email references intact.
- Conflict path: 1 campaign, 2 sequences each with `step_order = 1` → migration aborted, both steps preserved.
- SQL boundary: `step_order = 0`, negative delay, body-less email, non-email carrying a subject, and duplicate positions each rejected by PostgreSQL.

Production counts will be reported when the runbook is executed:
`psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/040_outreach_product_consistency.sql`.
If it aborts, the diagnostic names the campaign/step positions (conflict) or the count of body-less email / content-bearing non-email steps to repair first.

## Decisions Made

See `key-decisions` frontmatter. Notable: step order is server-derived; history safety means in-place update or 409, never orphaning; content rules are hard SQL checks with a preflight that aborts (never fabricates) on legacy violations.

## Deviations from Plan

None that changed scope. Two implementation adjustments were required for correctness and are folded into the task commits:

**1. [Rule 3 - Blocking] Migration test harness lacks migration 038.**
- **Found during:** Task 2/1 (send-history fixtures)
- **Issue:** `OUTREACH_TEST_BASELINE_MIGRATIONS` does not include 038, so `outreach_emails.origin` is absent when a suite runs in isolation.
- **Fix:** The migration and service suites explicitly apply `038_outreach_dispatch_state_machine.sql` (idempotent, advisory-locked) in `beforeAll` before seeding outreach_emails — matching the existing lifecycle-suite pattern.
- **Verification:** Suites pass in isolation and in the full serial run.

**2. [Rule 1 - Bug] Normalization violated its own order check on re-apply.**
- **Found during:** Task 2 (idempotent second apply on seeded data)
- **Issue:** The one-based normalization stages step_order to negative values, which violated the already-present `sequence_steps_order_positive` CHECK on the second apply.
- **Fix:** The migration drops `sequence_steps_order_positive` before the negative-staging normalization and re-adds it in step 5 (all within the same transaction).
- **Verification:** Migration test applies 040 twice and asserts constraints; found via a temporary statement-splitting probe that was removed.

**3. [Rule 1 - Bug] Shared advisory-lock starvation from a deliberately-failing migration.**
- **Found during:** Task 3 (full multi-project `npm run test`, intermittent hook timeouts)
- **Issue:** The conflict-abort test routed an expected-to-fail migration through the shared advisory-lock harness; the RAISE left the migration transaction aborted, the harness's `finally` unlock failed, and the lock lingered across `sql.end`, intermittently starving sibling suites' `beforeAll` migration applies (cascading 10s hook timeouts).
- **Fix:** Run only that failing apply on a private connection (no shared advisory lock); the successful merge/cleanup applies still use the shared harness. Also hardened the route suite's `afterAll` against a partially-initialized server.
- **Verification:** Two consecutive full `npm run test` runs green (26 files, 379 tests each).

---

**Total deviations:** 3 (1 blocking, 2 bugs) — all in test/migration mechanics, none altered the delivered contract.
**Impact on plan:** No scope creep; the canonical sequence contract matches the locked decisions.

## Issues Encountered

- postgres.js masks the first error of a multi-statement `unsafe` batch with the aborted-transaction (25P02) error from the harness's unlock-in-`finally`. Diagnosed the real failing statement with a temporary dollar-quote-aware statement splitter (removed after use).

## Gate Results

- `npm run test` — **379 passed, 10 skipped** (26 files); confirmed green on two consecutive runs.
- `npm run build` — client + server build succeed.
- `npm run lint` — 0 warnings (`--max-warnings 0`).
- `npx tsc --noEmit -p tsconfig.json` (client) — clean.
- `npx tsc --noEmit -p tsconfig.server.json` (server) — clean.
- `rg "sequences\[0\]|findFirst\(.*sequences" src` — no matches.

## User Setup Required

None for development. **Production rollout is manual and gated:** run migration 040 via the documented PowerShell runbook after Phases 18/19 land; if a campaign already has body-less email drafts or conflicting multi-sequence data, the migration aborts with an actionable diagnostic to repair first (it never drops content).

## Next Phase Readiness

- Canonical sequence resolution and the transactional replace contract are ready for the settings-default, metrics-cohort, access-guard, and service-identity work in plans 20-02 / 20-03.
- Migration 040 is the highest migration; the next free integer is 041.

## Self-Check: PASSED

- All created files present on disk (service, migration 040, 3 db test suites, this summary).
- All three task commits present in git history (`2aa267b`, `162c305`, `143d678`).

---
*Phase: 20-outreach-product-and-api-consistency*
*Completed: 2026-07-16*
