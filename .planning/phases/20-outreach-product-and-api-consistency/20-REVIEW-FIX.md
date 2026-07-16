---
phase: 20
phase_name: outreach-product-and-api-consistency
fixed_at: "2026-07-16T11:00:00Z"
review_source: 20-REVIEW.md
findings_addressed: [B-1, N-1, N-2, N-3, N-4]
findings_deferred: [N-5]
gates:
  test: "422 passed (35 files)"
  lint: "0 warnings"
  build: "client + server OK"
  tsc_client: clean
  tsc_server: clean
---

# Phase 20 Review Fix Report

All five actionable findings from `20-REVIEW.md` were fixed (B-1 blocking + N-1..N-4).
N-5 is left for the backlog per the review and the task instruction. TDD was followed: each
behavioural fix has a `.db.test.ts` committed RED-before-GREEN (or as a teeth-verified guard),
run only against the disposable Testcontainers postgres.

## Commits (test → fix per finding)

| Commit    | Type  | Finding | Summary                                                     |
| --------- | ----- | ------- | ----------------------------------------------------------- |
| `d0b81b0` | test  | B-1     | Pin history preservation on legacy sequence/step DELETE     |
| `1476f1f` | fix   | B-1     | Honour history preservation on legacy sequence/step DELETE  |
| `3469a48` | test  | N-1     | Pin bouncedLeads sent-gate so bounceRate stays bounded      |
| `5e253a1` | fix   | N-1     | Gate bouncedLeads on a sent email                           |
| `350d613` | test  | N-3     | Lock the service-marker forgery boundary                    |
| `240c2f9` | fix   | N-4     | Remove counterfeit API-key card from outreach Settings      |
| `5349de1` | docs  | N-2     | Make org-rollup metric grain honest                         |

---

## B-1 (BLOCKING) — legacy sequence/step DELETE endpoints cascade-delete send history — FIXED

**Real.** Confirmed by a RED test: with the old code, `DELETE /sequences/steps/:stepId` on a step
referenced by a sent `outreach_email` returned `200` and the send-history row was cascade-deleted
(`outreach_emails.sequence_step_id` is `ON DELETE CASCADE`, `schema.ts:923`); `DELETE
/sequences/:sequenceId` returned `200` and dropped the campaign to **zero** sequences (breaking the
CONS-01 invariant).

**Fix (`1476f1f`):**
- New canonical-service function `deleteSequenceStep({ stepId, organizationId })` in
  `src/server/lib/outreach-sequences.ts`. It runs in one transaction, resolves the step scoped
  through its campaign organization, and **reuses the existing `findReferencedStepIds`** gate (no
  duplicated reference check): a step still referenced by `outreach_emails.sequence_step_id` or
  `campaign_leads.current_step_id` returns `{ ok:false, reason:'step_referenced' }`; only an
  unreferenced step is hard-deleted.
- `DELETE /sequences/steps/:stepId` (`campaigns.ts`) delegates to it and returns
  `409 { code: 'sequence_step_referenced', conflicts:[{stepId, stepOrder}] }` for a referenced step
  — the same contract as the canonical replace.
- `DELETE /sequences/:sequenceId` now refuses with `409 { code: 'canonical_sequence_undeletable' }`.
  A campaign always retains its one canonical sequence (CONS-01); "deleting the sequence" is
  meaningless in the one-sequence-per-campaign model and would both cascade send history and drop
  to zero sequences. Editing goes through the history-safe `PUT /:campaignId/sequence`.
- Both paths keep the existing `requireOutreachWrite` tenant/role guard.
- `SequencesPage.tsx` drops the now-meaningless delete affordance (dropdown menu + delete
  mutation/handler removed; the card is read-only) so the UI matches the backend. Removed the
  now-unused `ChevronDown`/`apiRequest` imports.

**Reproducing/guard test:** `src/server/routes/outreach/__tests__/campaign-sequence-delete.db.test.ts`
(self-sufficient: applies migrations 038 + 040, seeds via SQL, drives the real express handlers):
- (a) referenced step → `409 sequence_step_referenced`; the `outreach_email` row **and** the step
  survive.
- Unreferenced trailing step → still `200` (deletes are not blanket-blocked).
- Viewer → `403` (write guard preserved).
- (b) canonical sequence delete → `409`; the campaign still has exactly one sequence.

RED (before fix): 2 failures (referenced-step delete returned 200 + destroyed history; sequence
delete returned 200 + zero sequences). GREEN (after fix): 4/4 pass.

---

## N-1 (hardening) — `bouncedLeads` omits the sent-gate — FIXED

**Real (defensive).** Reproduced with a seeded `'bounced'` campaign_lead that was never sent:
`bouncedLeads` counted it (2) while `contactedLeads` did not (1), so `bounceRate` computed to 200%,
violating the module's 0–100 invariant.

**Fix (`5e253a1`):** `outreach-campaign-metrics.ts` — the bounced filter is now
`FILTER (WHERE cl.status = 'bounced' AND sent.campaign_lead_id IS NOT NULL)`, matching the sent-gate
`contactedLeads` (the denominator) already applies. `bouncedLeads` is now a strict subset of
`contactedLeads`.

**Reproducing test:** added to `src/server/lib/__tests__/outreach-campaign-metrics.db.test.ts`
(Campaign 3: one bounced-never-sent lead + one bounced-after-send lead). Asserts
`bouncedLeads === 1`, `bounceRate <= 100`, `round(bounceRate) === 100`. Also made that suite apply
migration 038 in `beforeAll` so it runs standalone. RED: `bouncedLeads` was 2. GREEN: 1.

---

## N-2 (label) — org-rollup metric labels overstate as "unique leads" — FIXED (doc only)

**Real (labelling).** `computeCampaignMetrics` sums per-campaign cohorts, so in the org rollup a
lead enrolled in N campaigns is counted N times; the absolute counts are "unique (campaign, lead)
pairs", not distinct people. Rates are unaffected (numerator and denominator share the grain).

**Fix (`5349de1`):** doc-comment honesty only, as scoped — added a "GRAIN HONESTY" note to the
module header, clarified the `computeCampaignMetrics` docstring, and corrected the `CampaignMetrics`
field comments. The rollup is **not** re-architected (de-duplicating would not change any rate).

---

## N-3 (hardening) — pin the marker-forgery boundary — FIXED (guard)

**Not a bug — boundary lock.** The strip at `api-auth.ts:44-46` is correct; the review asked for a
regression test. Added `src/server/__tests__/service-auth-marker-forgery.db.test.ts` (`350d613`),
which mocks token resolution (`vi.mock('../lib/auth-cache')`) so a known bearer token maps to a real
DB-backed member, leaves service-key auth unconfigured (forcing the JWT branch), and forges inbound
`x-service-principal: true` + `x-service-organization-id` (+ a forged `x-user-id`):
- forged marker on an in-scope request → `200` (the strip neutralises it; JWT identity wins);
- forged marker on a cross-tenant request → `403` (grants no scope, `checkOutreachAccess` still
  denies).

As the review predicted, it passes immediately (the code is correct). I verified it has teeth by
temporarily disabling the two strip lines: the in-scope request then spuriously `403`s (the forged
`x-service-organization-id` mismatch trips `violatesServiceScope`). The strip was restored (no net
change to `api-auth.ts`).

---

## N-4 (honesty) — hide the counterfeit API-key card — FIXED

**Real (honesty).** `SettingsPage.tsx` rendered a hardcoded `sk_test_****` key with inert
copy/regenerate buttons — reads as a shipped feature. There is no self-serve API-key product
(machine access is the single server-bound Xphere service principal, CONS-06).

**Fix (`240c2f9`):** removed the entire "API Access" card and the now-unused `Key` icon import;
left a short comment explaining why there is no such card. No backend change. No automated test was
added (a pure static removal of a hardcoded string; verified `sk_test_` no longer appears in any
rendered source, only in the explanatory comment). Verified via lint/build/tsc.

---

## N-5 (deferred, not fixed) — `suppressions.organization_id` schema drift

Left as-is per the review ("flag, do not fix in this phase") and the task instruction. `schema.ts`
declares `suppressions.organization_id` but no committed migration adds it; the Testcontainers
baseline lacks the column and 20-02's notification test patches it in its own setup. Pre-existing
(not a Phase 20 regression). **Backlog item:** a reconciling migration (next free integer `041`) to
add `suppressions.organization_id` so a migrations-only production apply matches the TS mirror.

---

## Gate results (final)

- `npm run test` — **422 passed (35 files)** (was 415 at review time; +7 new: 4 B-1, 1 N-1, 2 N-3).
- `npm run lint` — **0 warnings** (`--max-warnings 0`).
- `npm run build` — client + server build succeed.
- `npx tsc --noEmit -p tsconfig.json` (client) — clean.
- `npx tsc --noEmit -p tsconfig.server.json` (server) — clean.
- No Phase 18/19/20 cross-tenant or canonical-sequence tests regressed (full suite green).

## Notes / discipline

- No `drizzle-kit generate` / `db:generate` / `db:push`; no production DB touched. All `.db.test.ts`
  ran only against the guarded disposable Testcontainers postgres.
- Tenant isolation remains JS-side; `requireOutreachWrite` guards preserved on the DELETE paths.
