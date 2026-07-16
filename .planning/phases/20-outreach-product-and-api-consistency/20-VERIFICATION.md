---
phase: 20
phase_name: outreach-product-and-api-consistency
status: passed
score: "7/7 requirement contracts implemented and tested; blocking gap + non-blocking findings all fixed and re-reviewed clean (422/422 tests)"
verified_at: "2026-07-16T10:20:50Z"
resolved_at: "2026-07-16T11:00:00Z"
verifier: gsd-verifier
re_verification: true
gaps:
  - truth: "Historical outreach-email / campaign-lead references are preserved OR the edit is rejected with an actionable conflict (CONS-01)"
    status: partial
    reason: >
      The canonical PUT /campaigns/:id/sequence path is fully history-safe (409 sequence_step_referenced,
      idempotent, editable-status gated, tested). But the legacy mutation endpoints were NOT retired and do
      NOT delegate to the canonical validator, contradicting the locked decision ("single-step CRUD may remain
      only ... if it delegates to the same validator") and the 20-01 summary claim that they "carry Deprecation
      metadata". DELETE /campaigns/sequences/:sequenceId (UI-reachable from the routed SequencesPage delete
      button) and DELETE /campaigns/sequences/steps/:stepId delete sequence_steps directly; because
      outreach_emails.sequence_step_id is ON DELETE CASCADE (schema.ts:923), this silently cascade-deletes
      send history — the exact loss the canonical path refuses with 409. POST/PUT step endpoints also skip the
      editable-status gate and the canonical Zod validator (they use createSequenceStepSchema + raw insert).
    artifacts:
      - path: "src/server/routes/outreach/campaigns.ts:866-1025"
        issue: "Legacy DELETE sequence / POST-PUT-DELETE step endpoints do not delegate to replaceCanonicalSequence; no history-conflict gate, no editable-status gate, no Deprecation header on the step routes"
      - path: "src/pages/outreach/SequencesPage.tsx:120-124"
        issue: "deleteSequence() calls the cascade-deleting legacy DELETE endpoint and is wired to a live delete control on the routed /outreach/sequences page"
    missing:
      - "Make the legacy step/sequence mutation endpoints delegate to the canonical service (history-conflict + editable-status gate), or remove them and drop the SequencesPage delete affordance"
      - "If retained as compat, add the same 409 referenced-step guard before any sequence_step delete so cascade history loss cannot be triggered outside replaceCanonicalSequence"
human_verification: []
---

# Phase 20 Verification — Outreach Product and API Consistency

## Verdict

**Gaps found — narrow, targeted, one material.** The substance of Phase 20 is genuinely delivered:
all six CI gates pass on fresh runs, and every one of `CONS-01`…`CONS-07` is implemented in real code
backed by substantive disposable-PostgreSQL tests (not inference, not summary trust). The canonical
sequence contract, settings-as-defaults, honest named metric cohorts, bounded tenant-scoped lead
search, organization-member UI access, and server-bound machine identity are all real and correct on
their primary surfaces.

The blocking finding is a **coherence hole the 20-01 summary misreported**: the legacy sequence/step
mutation endpoints were not retired and do **not** delegate to the canonical validator. Two of them
(`DELETE /campaigns/sequences/:sequenceId`, reachable from the routed Sequences page's delete button,
and `DELETE /campaigns/sequences/steps/:stepId`) delete `sequence_steps` rows directly, which
**cascade-deletes `outreach_emails` send history** (`schema.ts:923` `onDelete: 'cascade'`) — precisely
the loss the canonical `PUT /sequence` refuses with `409 sequence_step_referenced`. This contradicts the
locked decision that legacy CRUD may remain "only … if it delegates to the same validator" and the
stated CONS-01 truth that history is preserved or the edit is rejected. Three additional non-blocking
warnings are recorded below.

This verdict is based on direct source inspection, call-path tracing, and fresh gate runs.

## Fresh verification evidence

| Check | Command | Result |
|---|---|---|
| Full test suite | `npm run test` | **415 passed / 0 failed (33 files)**; `postgres` project ran against Testcontainers (e.g. `outreach-settings.db.test.ts`, `outreach-notification-policy.db.test.ts`, migration + access + service-auth db suites all green). ~10s wall. |
| Production build | `npm run build` | **exit 0** — Vite client (built 5.68s, PWA precache 58 entries) + `tsc -p tsconfig.server.json` server build. |
| Lint | `npm run lint` | **exit 0**, zero warnings (`--max-warnings 0`). |
| Client typecheck (CI parity) | `npx tsc --noEmit -p tsconfig.json` | **exit 0** — build does NOT typecheck the client, so run separately; clean. |
| Server typecheck | `npx tsc --noEmit -p tsconfig.server.json` | **exit 0** — clean. |
| Canonical-selection scan | `rg "sequences\[0\]\|findFirst\(.*sequences" src` | **no matches** (getCanonicalSequence uses `db.query.sequences.findFirst` — `sequences` precedes `findFirst`, so it is not a first-row selector; correctness comes from the DB unique index, not ordering). |
| Local access-helper scan | `rg "function checkOrgMembership\|function canWriteOutreach" src/server/routes/outreach` | **no matches** — every tenant router imports the canonical `lib/outreach-access`. |
| Migration provenance | `ls supabase/migrations` | `040_outreach_product_consistency.sql` is the highest; follows `039` (Phase 19). Hand-written; no generated Drizzle migration in the diff. |

Migration 040 applies **twice** to the disposable harness in `outreach-sequences-migration.db.test.ts`
(idempotency + constraint assertions), and is applied to a Testcontainers `xmail_test_*` DB only — the
production application remains a manual, gated runbook step (`psql … -f 040_…sql`), by design.

## Requirement matrix

| Requirement | Status | Evidence (file:line) |
|---|---|---|
| `CONS-01` — unambiguous canonical sequence; edits replace/upsert transactionally, no duplicate append | **PASS (with gap on legacy paths)** | DB uniqueness `sequences_campaign_id_unique` in `supabase/migrations/040_outreach_product_consistency.sql:128` and mirrored `src/db/schema.ts:813`; transactional replace with `FOR UPDATE` lock, editable-status gate, and pre-write history-conflict gate in `src/server/lib/outreach-sequences.ts:204-308`; route delegates in `src/server/routes/outreach/campaigns.ts:728-781`; idempotency + `history_conflict` + cross-tenant proven in `src/server/lib/__tests__/outreach-sequences.db.test.ts:140-291`. **Gap:** legacy `campaigns.ts:866-1025` mutation endpoints bypass this (see Gaps). |
| `CONS-02` — org admins/members reach outreach UI via backend authority; platform admin stays separate | **PASS** | `OutreachCheck`/`OutreachAccessGate` admits platform admin OR any org member incl. viewer, no AdminCheck, redirect-in-effect for no-org (`src/main.tsx:189-217`, routes `514-572`); `/admin/*` still under `AdminCheck` (`main.tsx:443-511`); viewer read-only badge without hiding pages (`src/components/outreach/OutreachLayout.tsx:56,212-216`); backend authoritative via `requireOutreachRead/Write` on every route; role matrix + inventory tested in `src/server/lib/__tests__/outreach-access.db.test.ts`. |
| `CONS-03` — settings consumed as documented defaults/policy or removed | **PASS** | Single resolver `resolveOutreachSettings` / `OUTREACH_SETTINGS_DEFAULTS` (`src/server/lib/outreach-settings.ts:38-78`); create-time `explicit ?? resolved` merge for campaigns (`campaigns.ts:557-569`) and email accounts (`email-accounts.ts:456-459`, fields optional at `130-134`); not-retroactive + precedence tested in `outreach-settings.db.test.ts`. |
| `CONS-04` — notifications have real consumers or removed; metrics use explicit denominators | **PASS** | `shouldNotifyOutreachEvent` gates the real Xphere transport at the reply/bounce/unsubscribe call sites (`processReplies.ts:496`, `processBounces.ts:319`, `unsubscribe.ts:315` → `sendXphereOutreachEvent`); `weeklyReport` removed from API Zod (`settings.ts:35-37` only) and UI (`SettingsPage.tsx` labels "Notify on …", no weekly control) with DB column intentionally retained (`schema.ts:1026`); replay-safe/per-org isolation tested in `outreach-notification-policy.db.test.ts`. Metrics: `contactedLeads` = unique leads with ≥1 sent email, `eligibleLeads`, `sentEmails`, `preSendExcludedLeads` in `src/server/lib/outreach-campaign-metrics.ts:106-220`; consumed identically by list/stats/detail/analytics (`campaigns.ts:249,317,419,1355`). |
| `CONS-05` — lead search/pagination/sort bounded and UI/API-matched | **PASS** | Server-side, tenant-first (`leads.ts:227`), case-insensitive ILIKE across email/first/last/company/title (`234-242`), wildcard-escaped (`escapeLikePattern` `37-39`), hard cap `limit ≤ 100` (`19`), stable `id DESC` tie-breaker (`263`), all params 400-on-invalid; previously-ignored `search` now honored end-to-end; tested in `leads-query.db.test.ts`. |
| `CONS-06` — service auth binds identity + tenant server-side, never trusts caller header | **PASS** | Fails closed unless full trio present (`service-auth.ts:38-44`); timing-safe key (`65-74`); `x-user-id` overwritten + identity headers deleted, query/body org-mismatch → 403, marker + bound-org header set (`applyServicePrincipal 92-129`); anti-forgery header strip before auth + key never forwarded/logged (`api-auth.ts:44-73`); resource-derived enforcement via `violatesServiceScope` (`outreach-access.ts:67-71`); forged-id/mismatch/fail-closed proven in `src/server/__tests__/service-auth.db.test.ts:127-217`. Env trio wired into `build-deploy.yml:181-183` (active `run_app_container`), `deploy-hetzner.yml:203-205,367-369`, `.env.example:80-86`, `CLAUDE.md:169`. |
| `CONS-07` — Zod, Drizzle, and SQL enforce the same invariants | **PASS** | `step_order ≥ 1`, `delay_hours ≥ 0`, A/B percentage bounds, and email-content / non-email-empty rules present identically in Zod (`outreach-sequences.ts:24-84,104-136`), Drizzle (`schema.ts:848-869`), and SQL CHECKs (`040_…sql:131-160`); PG-boundary rejection + Drizzle-mirror-alignment tested in `outreach-sequences-migration.db.test.ts:90-149`. |

## Declared must-have verification

### Plan 20-01 (CONS-01, CONS-07)

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Every campaign resolves exactly one canonical sequence without first-row ordering | PASS | `sequences_campaign_id_unique` (`040:128`, `schema.ts:813`) makes >1 row structurally impossible; `getCanonicalSequence` (`outreach-sequences.ts:143-164`) returns the sole row. |
| Truth | Saving is a transactional replace/upsert, no duplicate positions / partial edits | PASS | `db.transaction` + `FOR UPDATE`, conflict gate before any write, in-place id-preserving update (`outreach-sequences.ts:204-308`); idempotent (same ids, count stays 3) at `outreach-sequences.db.test.ts:140-168`. |
| Truth | Step invariants match in Zod, schema.ts, and running PostgreSQL | PASS | See CONS-07 row; migration test asserts PG rejection + mirror alignment. |
| Truth | Historical references preserved OR edit rejected with actionable conflict | **PARTIAL** | True for canonical replace (`history_conflict` 409, tested `outreach-sequences.db.test.ts:252-291`). **Violated by legacy DELETE endpoints that cascade-delete `outreach_emails`** — see Gaps. |
| Artifact | `src/server/lib/outreach-sequences.ts` (`sequencePayloadSchema`, `getCanonicalSequence`, `replaceCanonicalSequence`) | PASS | Present, substantive, exported, wired into route + enrollment. |
| Artifact | `supabase/migrations/040_…sql` contains `UNIQUE` | PASS | `CREATE UNIQUE INDEX … sequences_campaign_id_unique` (`040:128`); non-destructive merge + preflights present. |
| Artifact | `campaigns.ts` canonical GET/PUT + transactional creation | PASS | GET/PUT `697-781`; campaign+sequence single transaction `573-586`. |
| Key link | route → one sequence service (`replaceCanonicalSequence`) | PASS | `campaigns.ts:749`. |
| Key link | schema.ts uniqueness/check mirrors migration | PASS | `schema.ts:813,850-869`. |

### Plan 20-02 (CONS-03, CONS-04, CONS-05)

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | New campaigns/accounts consume org defaults only for omitted fields | PASS | `campaigns.ts:557-569`, `email-accounts.ts:456-459`; not-retroactive tested. |
| Truth | Every visible notification setting has a real consumer or is removed end-to-end | PASS | reply/bounce/unsubscribe gated on real Xphere transport; `weeklyReport` removed from API+UI, DB column retained. |
| Truth | Lead search/filter/sort/pagination server-side, tenant-scoped, stable, ≤100 | PASS | `leads.ts:207-284`. |
| Truth | Campaign responses expose explicit eligible/contacted/sent denominators, consistent across screens | PASS | `outreach-campaign-metrics.ts` DTO consumed by list/stats/detail/analytics; `/analytics avgOpenRate` aliases `metrics.openRate` (`campaigns.ts:434-437`); UI surfaces only format server rates (no local recomputation). |
| Artifact | `outreach-settings.ts` (`OUTREACH_SETTINGS_DEFAULTS`, `resolveOutreachSettings`) | PASS | Present + `shouldNotifyOutreachEvent` policy gate. |
| Artifact | `leads.ts` validated list/search/filter/sort | PASS | `leadListQuerySchema` + escaped ILIKE + tie-breaker. |
| Artifact | `outreach-campaign-metrics.ts` named-cohort DTO | PASS | `computeCampaignMetrics` / `computeCampaignMetricsByCampaign`. |
| Key link | campaigns create → resolved defaults | PASS | `campaigns.ts:557`. |
| Key link | LeadsPage → leads route search schema | PASS | server honors `search`; client display bug (`company`→`companyName`) also fixed (`LeadsPage.tsx`). |

### Plan 20-03 (CONS-02, CONS-06)

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Authorized org members enter outreach without platform-admin | PASS | `OutreachCheck`/`OutreachAccessGate` (`main.tsx:189-217`). |
| Truth | Viewer read / member-admin write consistent across every outreach route | PASS | `requireOutreachRead/Write` on all routers; `canWriteOutreach` role rule (`outreach-access.ts:57-115`); matrix tested. |
| Truth | Valid service key maps to server-configured principal+org; client headers cannot override | PASS | `service-auth.ts` + `api-auth.ts`; `service-auth.db.test.ts` proves forged id ignored, org mismatch 403, fail-closed. |
| Truth | All tenant-scoped outreach routes import one canonical access helper | PASS | 5 routers import `lib/outreach-access`; zero local `checkOrgMembership`; `unsubscribe.ts` is public HMAC (correctly unguarded). |
| Artifact | `outreach-access.ts` (`checkOutreachAccess`, `requireOutreachRead/Write`) | PASS | Present + service-scope enforcement. |
| Artifact | `index.ts` service-key middleware with bound principal/org | PASS | Extracted to `api-auth.ts` (`createApiAuthMiddleware`), consumed by `index.ts`. |
| Artifact | `main.tsx` `OutreachCheck` separate from `AdminCheck` | PASS | `main.tsx:202-217`. |
| Key link | outreach routes → access helper (`requireOutreach`) | PASS | grep confirms 5 routers. |
| Key link | index.ts → bound service org (`XMAIL_SERVICE_ORGANIZATION_ID`) | PASS | `service-auth.ts:38-44`, marker enforced in `outreach-access.ts:67-71`. |

## Assessment of self-reported items

| Item | Verdict | Reasoning |
|---|---|---|
| `weekly_report` DB column retained (no drop migration) while removed from API/UI | **Acceptable** | Removed end-to-end from the public contract (Zod + UI), which is what CONS-04 requires. Leaving the column is consistent with the project's migration discipline (hand-rolled, additive) and carries no runtime behavior. Clean. |
| `notifyOnUnsubscribe` now defaults `false` → unsubscribe events stop forwarding to Xphere by default | **Acceptable, but surface it (Warning)** | It is an honesty fix (the toggle now truly gates emission), and runtime risk is low (Xphere transport already fails closed when `XPHERE_EVENTS_URL` unset; outreach is parked). However it IS a silent change to an existing integration default — any org relying on prior always-on unsubscribe forwarding will stop receiving it until the toggle is re-enabled. Documented in the 20-02 summary; should also be called out in operator release notes. Not a phase blocker. |
| Disposable-test `suppressions` table lacks `organization_id` (patched only in a test's setup) | **Latent schema-drift risk (Warning)** | `schema.ts` declares `suppressions.organizationId` + `suppression_org_email_unique` (`schema.ts:344-354`), but no committed migration adds the column / drops `server_id NOT NULL`; the harness baseline (old Drizzle snapshot) is server-scoped, so `outreach-notification-policy.db.test.ts:72-73` performs test-only DDL to match. Production reportedly has the column, but the migration history does not encode it — a fresh environment provisioned purely from `supabase/migrations` would diverge from both the code and production. Worth a reconciling migration; out of Phase 20's stated scope but a real backlog risk. |
| `SettingsPage.tsx` "API Access" card renders inert `sk_test_****` with active-looking buttons | **Reads as shipped-but-fake (Warning)** | Building an API-key product is explicitly out of scope, which justifies not implementing it — but leaving a fake key with live "Regenerate Key"/"View Docs" controls is exactly the decorative-UI pattern Phase 20 otherwise eliminated (it removed `weeklyReport` for this reason). The honest move is to hide/disable the card rather than display a counterfeit credential. Pre-existing, low-risk, but inconsistent with the phase's "no decorative controls" outcome. |

## Anti-patterns / call-path findings

| Location | Finding | Severity |
|---|---|---|
| `campaigns.ts:993-1025` `DELETE /sequences/steps/:stepId`; `campaigns.ts:866-897` `DELETE /sequences/:sequenceId` | Delete `sequence_steps` directly with no history-conflict gate; `outreach_emails.sequence_step_id` is `ON DELETE CASCADE` (`schema.ts:923`), so referenced send history is silently destroyed. `DELETE /sequences/:sequenceId` is UI-reachable (`SequencesPage.tsx:120-124`, routed at `/outreach/sequences`). | 🛑 Blocker (contradicts CONS-01 truth + locked decision) |
| `campaigns.ts:902-990` legacy step POST/PUT | Do not delegate to `sequencePayloadSchema`/`replaceCanonicalSequence`, skip the draft/paused editable-status gate, and (contra the 20-01 summary) carry no `Deprecation` header. DB CHECK/unique constraints backstop content/order once 040 is applied, but the status gate and array-derived ordering are not enforced. | ⚠️ Warning |
| `SettingsPage.tsx:330-342` | Inert `sk_test_****` API-key card (see self-reported item 4). | ⚠️ Warning |

## Migration discipline

- 040 is hand-written, follows 039, mirrored in `schema.ts`; no `drizzle-kit generate`/`db:push` in the diff.
- Migration verification runs only through the guarded Testcontainers harness (explicit test URL); applied twice for idempotency; production apply is an intentional deferred manual runbook step. **Caveat:** until 040 runs in production, the `sequences_campaign_id_unique` and step CHECK constraints do not yet exist there, so the DB-enforced guarantees of CONS-01/CONS-07 hold in code/schema/harness but not yet in the live database (same posture the Phase 18 verification accepted for migration 038).

## Gaps Summary

One material gap and three warnings. The material gap: Phase 20 built a correct, tested, DB-enforced
canonical sequence contract, but did not close the **legacy** sequence/step mutation surface around it.
Those endpoints remain mounted, skip the canonical validator and the editable-status/history guards, and
(for the two DELETE routes, one of them wired to a live UI button) cascade-delete `outreach_emails` send
history — directly undercutting the CONS-01 truth "history preserved OR rejected" and the locked decision
that legacy CRUD may remain only if it delegates to the same validator. The fix is small and contained:
route the legacy mutations through `replaceCanonicalSequence` (or its history/status guards), or remove
them and the SequencesPage delete affordance. The three warnings (unsubscribe-default behavior change,
`suppressions` harness/production schema drift, and the fake API-key card) are non-blocking but should be
surfaced to operators / added to the backlog rather than left silent.

---

_Verified: 2026-07-16T10:20:50Z_
_Verifier: Claude (gsd-verifier) — direct source inspection + fresh gate runs, not summary trust_

## Resolution addendum (2026-07-16, post review-fix)

The original verdict was `gaps_found` on one blocking coherence gap. Phase 20 also went through a
full 3-lens code review (`20-REVIEW.md`): the authorization/tenant-isolation surface and the
migration-040/transactional-replace surface were both **clean**, and this verification found the one
blocking gap plus five non-blocking items. All were addressed in a fix pass (`20-REVIEW-FIX.md`) and
independently re-reviewed.

**Blocking gap — RESOLVED.** The legacy `DELETE /sequences/:sequenceId` and
`DELETE /sequences/steps/:stepId` endpoints deleted `sequence_steps` directly, cascade-deleting
`outreach_emails` send history (`sequence_step_id ON DELETE CASCADE`) and able to drop a campaign to
zero sequences — bypassing the history protection the canonical `PUT` enforces. Fixed: a new
`deleteSequenceStep()` in `outreach-sequences.ts` reuses the same `findReferencedStepIds` gate inside
one transaction (referenced step → `409 sequence_step_referenced`, history row survives); the
sequence delete now returns `409 canonical_sequence_undeletable` so a campaign always retains its one
canonical sequence; the `SequencesPage.tsx` delete affordance was removed to match. A DB test proves
a step referenced by a sent `outreach_email` cannot be deleted and the send-history row survives, and
that a campaign cannot be left with zero sequences. Confirmed real via a RED test that reproduced the
cascade deletion before the fix. The re-review verified the fix reuses the canonical gate (not a
duplicate), preserves the `requireOutreachWrite` guards, and that no other route deletes steps
directly except deliberate whole-campaign/whole-org cascades.

**Non-blocking — all addressed:** `bouncedLeads` now carries the same sent-gate as `contactedLeads`
so `bounceRate` stays ≤ 100% (defensive, was untriggerable); the org-rollup metric doc/labels were
corrected to "unique (campaign, lead) pairs"; a regression test now pins the marker-forgery boundary
(verified to fail if the `api-auth.ts` strip is removed); the counterfeit `sk_test_****` API-key card
was removed from `SettingsPage.tsx`. `notifyOnUnsubscribe` defaulting to `false` is accepted as an
intended honesty fix. The `suppressions.organization_id` schema drift is pre-existing and deferred to
the backlog (reconciling migration, out of Phase 20 scope).

**Fresh gates after fixes (run on this machine):** `npm run test` **422 passed (35 files)**,
`npm run build` exit 0, `npm run lint` 0 warnings, client and server `tsc --noEmit` both clean.

Phase 20 status is therefore **passed**. All seven requirements CONS-01..07 are implemented in real,
tested code, and the canonical-sequence contract is now coherent across every mutation entrypoint.
