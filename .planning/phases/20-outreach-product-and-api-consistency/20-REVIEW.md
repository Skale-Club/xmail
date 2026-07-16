---
phase: 20
phase_name: outreach-product-and-api-consistency
reviewed_at: "2026-07-16T11:30:00Z"
reviewers: 3 (authz/tenant security, correctness/data-migration, requirements verification)
range: 4e1e8c1..4980800
status: fixes_required
findings: 1 blocking gap, 5 non-blocking
---

# Phase 20 Code Review

Three independent reviewers over `git diff 4e1e8c1..HEAD` (14 commits, ~4700 insertions).
Fresh gates were green at review time (415/415 tests, build, lint 0 warnings, both `tsc` projects).

**The security surface is clean.** The full service-auth path (marker-header forgery, identity
override, IDOR on resource-derived routes, the 40-call-site read/write role split, timing-safe key
check, and the AdminCheck→OutreachCheck swap) was traced end to end and had **no findings** — the
markers are stripped as the first two statements of every inbound `/api` request and can only ever
*add* a deny condition. **The data migration is clean** — 040 is a single transaction with
abort-on-conflict preflights, collision-free reparenting, idempotent re-apply, and a byte-exact
schema mirror.

The one blocking item is an *absence*: the legacy endpoints around the new canonical contract were
not retired, so a live delete path bypasses the history protection the phase built. Both adversarial
reviewers missed it (it is missing delegation, not a bug in new code); the requirements verifier
caught it.

## BLOCKING

### B-1 — Legacy sequence/step DELETE endpoints silently cascade-delete send history

`src/server/routes/outreach/campaigns.ts:889` (`DELETE /sequences/:sequenceId`) and the
`DELETE /sequences/steps/:stepId` sibling delete `sequence_steps` rows directly. Because
`outreach_emails.sequence_step_id` is `ON DELETE CASCADE` (`schema.ts:923`), this cascade-deletes
send history — exactly what the canonical `PUT /:campaignId/sequence` refuses with
`409 sequence_step_referenced`.

The sequence delete is wired to a live delete button on the routed `/outreach/sequences` page
(`SequencesPage.tsx:120`). It also has a second failure: deleting the campaign's only (canonical)
sequence leaves the campaign with **zero** sequences, breaking the CONS-01 invariant that every
campaign resolves exactly one canonical sequence.

This contradicts:
- the CONS-01 declared truth "historical outreach email and campaign-lead references are preserved
  or the edit is rejected with an actionable conflict";
- the 20-CONTEXT locked decision that legacy single-step CRUD may remain "only as an internal
  compatibility path **if it delegates to the same validator**";
- the 20-01 summary's own claim that these became compat adapters that "can't create a second row".

**Fix:** route both DELETE paths through the canonical service so they reject with `409` when a step
is referenced by `outreach_emails`/`campaign_leads` and cannot drop a campaign to zero sequences (or
remove the endpoints entirely along with the `SequencesPage` delete affordance). Preserve
tenant/role guards (already correct via `requireOutreachWrite`). Add a `.db.test.ts` proving a
referenced step cannot be deleted and send history survives.

## NON-BLOCKING

### N-1 — `bouncedLeads` metric omits the sent-gate `contactedLeads` applies

`src/server/lib/outreach-campaign-metrics.ts:176` — `count(*) FILTER (WHERE cl.status = 'bounced')`
does not require a sent email, while `contactedLeads` (the `bounceRate` denominator) does. If a
`'bounced'` campaign_lead ever existed with no sent `outreach_email`, `bounceRate` could exceed 100%,
breaking the module's stated 0–100 invariant. Currently **untriggerable** (pre-send suppression sets
`'unsubscribed'`; DSN bounces imply a prior send), so this is defensive. Add
`AND sent.campaign_lead_id IS NOT NULL` to match the "subset of contacted" contract. Cheap and
correct.

### N-2 — Org-rollup metric labels overstate as "unique leads"

`src/server/lib/outreach-campaign-metrics.ts:12-15,231-243` — `computeCampaignMetrics` sums
per-campaign cohorts, so in the org rollup (`/stats`, `/analytics`) a lead enrolled in N campaigns
counts N times in `contactedLeads`/`uniqueOpeners`/etc. Rates stay bounded (numerator and denominator
share the grain), but the absolute counts are "unique (campaign, lead) pairs", not "unique leads" as
the doc claims. Fix the label/doc (or de-duplicate at the lead grain in the rollup if a true unique
count is wanted). Low priority.

### N-3 — No regression test pins the marker-forgery boundary

`service-auth.db.test.ts` covers key verification, identity binding, and org-scope, but never sends a
**forged inbound** `x-service-principal`/`x-service-organization-id` header to confirm the strip
neutralizes it. The strip is correct by inspection; a one-line test (forge the marker on a JWT
request, assert it grants no scope) locks the security boundary against future edits. Recommended.

### N-4 — `SettingsPage` shows a counterfeit `sk_test_****` API key with live buttons

`src/pages/outreach/SettingsPage.tsx` "API Access" card renders a hardcoded fake key and inert
copy/regenerate buttons. Building an API-key product is explicitly out of scope, but a fake key that
looks real reads as a shipped feature. Hide the card until a real API-credential plan owns it.

### N-5 — `suppressions` table `organization_id` schema drift (latent)

`schema.ts` declares `suppressions.organization_id`, but no committed migration adds it — the
disposable Testcontainers harness lacks the column, and 20-02's notification test patches it only in
its own setup. A migrations-only environment (production applied from `supabase/migrations/` alone)
would diverge from the TS mirror. Not a Phase 20 regression (pre-existing), but worth a reconciling
migration on the backlog. Flag, do not fix in this phase.

## Accepted (self-reported, judged acceptable)

- `weekly_report` DB column retained while removed from API/UI — additive-migration discipline,
  removed end-to-end from the contract. Acceptable.
- `notifyOnUnsubscribe` now defaults `false` — an intended honesty fix (the toggle now means what it
  says), but it silently changes an existing integration default. Low runtime risk (Xphere fails
  closed, outreach parked). Surface it in the summary; no code change required.

## Clean categories (recorded so they are not re-litigated)

- Marker forgery / identity override / IDOR / role enforcement / regression / timing-safe key —
  all traced, all clean (authz reviewer).
- Migration destructiveness / idempotency, CHECK-vs-existing-data, transactional replace,
  metric SQL math, search escaping + injection surface, schema mirror drift — all clean
  (correctness reviewer). Legacy body-less/negative-delay/duplicate-position rows abort the
  migration cleanly by design (never drop content); run a manual preflight query against a prod
  snapshot before applying 040.
- All seven requirements CONS-01..07 implemented in real code with DB-backed tests; the three
  service-principal env vars are wired into `build-deploy.yml`, both `deploy-hetzner.yml` blocks,
  `.env.example`, and `CLAUDE.md` (verifier).

## Out of scope (tracked, not Phase 20)

- `GET /o/u/check/:leadId/:campaignId` (`unsubscribe.ts:408`) is unauthenticated and discloses a
  lead's email for any known lead/campaign UUID pair. Pre-existing; a separate hardening task was
  filed.
