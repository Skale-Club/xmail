---
phase: 20-outreach-product-and-api-consistency
plan: 02
subsystem: api
tags: [outreach, settings, notifications, metrics, pagination, search, zod, postgres]

# Dependency graph
requires:
  - phase: 18-outreach-safety-and-execution-reliability
    provides: disposable Testcontainers postgres harness, TERMINAL_CAMPAIGN_LEAD_STATUSES, reply/bounce event paths
  - phase: 19-outreach-provider-events
    provides: durable inbound event ingestion, sendXphereOutreachEvent notification transport
  - phase: 20-outreach-product-and-api-consistency
    plan: 01
    provides: canonical sequence contract, migration 040, sequence_steps content-valid checks
provides:
  - Single settings resolver (OUTREACH_SETTINGS_DEFAULTS / resolveOutreachSettings) used as create-time defaults for campaigns and email accounts
  - Event-policy notification gate (shouldNotifyOutreachEvent) consumed by the reply/bounce/unsubscribe paths
  - Bounded, tenant-scoped, escaped lead list/search/sort contract (limit <= 100, stable id tie-break)
  - Explicit named campaign metric cohorts DTO (contactedLeads/sentEmails/eligibleLeads/preSendExcludedLeads) shared by list/stats/detail/analytics
affects: [outreach-settings, outreach-metrics, outreach-leads, outreach-notifications, campaign-enrollment]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Create-time default merge: schema fields are optional (not Zod .default), then merged `explicit ?? resolved` so an omitted field inherits org settings and existing rows are never rewritten"
    - "Notification transport gated on resolved per-org policy AND on the state transition, so a disabled toggle emits zero and a replay never double-notifies — without gating the inbound DB writes"
    - "LIKE-injection-safe search: escape %, _, \\ before ILIKE; default backslash ESCAPE treats them as literals"
    - "Stable pagination ordering: requested sort column plus a unique id tie-breaker (created_at DESC, id DESC)"
    - "One lead-grain metric DTO with named denominators; contacted = unique leads with >=1 actually-sent email (LEFT JOIN a DISTINCT campaign_lead_id subquery), excluding pre-send suppressed leads"

key-files:
  created:
    - src/server/lib/outreach-settings.ts
    - src/server/lib/__tests__/outreach-settings.db.test.ts
    - src/server/lib/__tests__/outreach-campaign-metrics.db.test.ts
    - src/server/jobs/__tests__/outreach-notification-policy.db.test.ts
    - src/server/routes/outreach/__tests__/campaign-metrics.db.test.ts
    - src/server/routes/outreach/__tests__/leads-query.db.test.ts
  modified:
    - src/server/lib/outreach-campaign-metrics.ts
    - src/server/routes/outreach/settings.ts
    - src/server/routes/outreach/campaigns.ts
    - src/server/routes/outreach/email-accounts.ts
    - src/server/routes/outreach/leads.ts
    - src/server/jobs/processReplies.ts
    - src/server/jobs/processBounces.ts
    - src/server/routes/outreach/unsubscribe.ts
    - src/pages/outreach/SettingsPage.tsx
    - src/pages/outreach/LeadsPage.tsx
    - src/pages/outreach/campaigns/tabs/LeadsTab.tsx
    - src/pages/outreach/campaigns/tabs/OverviewTab.tsx
    - src/pages/outreach/campaigns/tabs/StatsTab.tsx

key-decisions:
  - "Notification toggles gate the existing Xphere outreach-event transport (the only reply/bounce/unsubscribe notification that exists); labels relabeled honestly from 'Email me…' to 'Notify on…'"
  - "weekly_report removed from the API Zod schema and the React form — no weekly-report transport exists; the DB column is left in place (no migration) to preserve schema/DB parity"
  - "contactedLeads is redefined as unique leads with an actually-sent email, so a lead suppressed/unsubscribed before any send no longer inflates the denominator"
  - "Emails Sent means email-grain sentEmails everywhere; contactedLeads is the lead-grain denominator; the two are exposed separately"
  - "Whole-lead-list campaign enrollment is resolved server-side (leadListId on the enroll endpoint); the client's 1,000-row scan is gone and would now be rejected by the limit<=100 cap"

requirements-completed: [CONS-03, CONS-04, CONS-05]

# Metrics
duration: 41min
completed: 2026-07-16
---

# Phase 20 Plan 02: Settings, Leads, and Metrics Consistency Summary

**Settings become real create-time defaults, notification toggles gate the actual reply/bounce/unsubscribe event transport (or are removed), lead queries are bounded/searchable/tenant-safe, and every campaign surface reports one honest set of named metric cohorts.**

## Performance

- **Duration:** ~41 min
- **Started:** 2026-07-16T08:46:07Z
- **Completed:** 2026-07-16T09:26:53Z
- **Tasks:** 3
- **Files:** 19 (6 created, 13 modified)

## Task Commits

1. **Task 1: Failing db suites for all three contracts** — `213f577` (test)
2. **Task 2: Centralize settings defaults + wire notification policy** — `0878b2f` (feat)
3. **Task 3: Bounded lead queries + explicit metric cohorts** — `89c75c2` (feat)

**Plan metadata:** _(this commit)_ (docs: complete plan)

## Applied Defaults (CONS-03)

`src/server/lib/outreach-settings.ts` is the single source of default outreach configuration
(`OUTREACH_SETTINGS_DEFAULTS`) and the resolver (`resolveOutreachSettings`) returns the stored
`outreach_settings` row when present, otherwise the constants — it never creates a row on read.

- **Campaign creation** (`POST /api/outreach/campaigns`): `timezone`, `sendOnWeekends`,
  `sendStartTime`, `sendEndTime`, `trackOpens`, `trackClicks` are now optional in the Zod schema
  (Zod `.default()` removed) and merged `explicit ?? resolved` so an omitted field inherits the
  org default and an explicit field wins.
- **Email-account creation** (`POST /api/outreach/email-accounts`): `dailySendLimit`,
  `minMinutesBetweenEmails`, `warmupEnabled`, `warmupDays` inherit settings when omitted
  (`maxMinutesBetweenEmails` keeps its fixed fallback of 30 — no settings equivalent; inherited
  `warmupDays` is clamped to the account column's 60-day bound).
- **Not retroactive:** defaults are resolved once at creation; changing a default later never
  rewrites an existing campaign or account (asserted by test).

## Notification Policy (CONS-04)

The only reply/bounce/unsubscribe notification transport that exists is the outbound Xphere event
(`sendXphereOutreachEvent`). The three toggles now gate exactly that emission via
`shouldNotifyOutreachEvent(organizationId, event)` — resolved per organization, so one tenant's
setting can never gate another's event, and gating only touches the notification, never the
inbound DB writes.

| Setting | Wired / Removed | Consumer |
| --- | --- | --- |
| `notifyOnReply` | **Wired** | `markAsReplied` (processReplies.ts) — emits `replied` only on the transition into replied (replay-safe) |
| `notifyOnBounce` | **Wired** | `markAsBounced` (processBounces.ts) — emits `bounced` only when the CAS transitions the lead |
| `notifyOnUnsubscribe` | **Wired** | `processUnsubscribe` (unsubscribe.ts) — emits `unsubscribed` only on the first unsubscribe |
| `weeklyReport` | **Removed** | No weekly-report transport exists (the Phase 17 digest is daily, log-only, org-agnostic). Dropped from the API Zod schema, API formatting, and the React form. |

The Settings UI notification labels were relabeled from the misleading "Email me when…" to
"Notify on replies/bounces/unsubscribes", with helper text stating each toggle emits an outreach
event to connected integrations and that inbound processing always runs.

**Behavior note:** `notifyOnUnsubscribe` defaults to `false` (unchanged constant), so by default
unsubscribe events are no longer forwarded to Xphere. This makes the toggle honest; the orchestrator
integration is optional (`XPHERE_EVENTS_URL` fails closed when unset) and outreach is currently
parked, so the change is low risk.

## Lead Query Parameters (CONS-05)

`GET /api/outreach/leads` now validates one Zod schema and is tenant-scoped first:

- `page` (>= 1), `limit` (1–100, **hard cap 100**), `sort` (`createdAt|updatedAt|email|status`),
  `order` (`asc|desc`), optional `status` (enum), optional `leadListId` (uuid), optional `search`
  (trimmed, max 200 chars). Any out-of-range/malformed value is a **400** — no silent fallback.
- **Search** runs server-side across `email`, `first_name`, `last_name`, `company_name`, `title`
  via case-insensitive `ILIKE`. `%`, `_`, and `\` are escaped so they match literally (no
  LIKE-injection). The previous audit finding — the UI sent `search` and the backend ignored it —
  is fixed end to end.
- **Stable ordering:** requested sort column then `id DESC` as the unique tie-breaker
  (`created_at DESC, id DESC` by default) so equal keys never reorder between pages.
- **Cross-tenant safety:** identical lead emails in two tenants never appear in or count toward
  each other's results.
- **Client workarounds removed:** the campaign LeadsTab no longer scans `?limit=1000` or
  probes-by-create. Paste mode resolves emails through `POST /leads/bulk-import` (returns the full
  `leadIds` set); list mode enrolls the whole list via a new server-side `leadListId` on
  `POST /campaigns/:id/leads`. Also fixed a display bug: LeadsPage rendered `lead.company`
  (undefined) instead of `companyName`.

## Metric Denominator Formulas (CONS-04)

`src/server/lib/outreach-campaign-metrics.ts` exposes one lead-grain DTO with named cohorts,
computed per campaign (`computeCampaignMetricsByCampaign`) and aggregated
(`computeCampaignMetrics`) from the same query:

- `totalLeads` = enrolled `campaign_leads`.
- `contactedLeads` = **unique leads with >= 1 actually-sent outreach email**
  (`outreach_emails.sent_at IS NOT NULL`), via LEFT JOIN to a `DISTINCT campaign_lead_id` subquery.
  This replaces the audit-flagged `status != 'new'`, which wrongly counted leads suppressed/
  unsubscribed before any send.
- `preSendExcludedLeads` = leads in (`unsubscribed`, `bounced`) with no sent email.
- `eligibleLeads` = `totalLeads − preSendExcludedLeads`.
- `sentEmails` = count of `outreach_emails` with `sent_at IS NOT NULL` (email grain, >= contactedLeads).
- Numerators (subsets of contacted): `uniqueOpeners` (`total_opens > 0`), `uniqueClickers`
  (`total_clicks > 0`), `repliedLeads` (status in replied/interested OR `total_replies > 0`),
  `bouncedLeads` (status = bounced).
- **Rates** (0–100, bounded): `openRate = uniqueOpeners/contactedLeads`,
  `clickRate = uniqueClickers/contactedLeads`, `replyRate = repliedLeads/contactedLeads`,
  `bounceRate = bouncedLeads/contactedLeads`.

The campaign list, `/stats`, `/:id/stats`, `/analytics`, and their UI surfaces
(`OutreachDashboard`, `AnalyticsPage`, `OverviewTab`, `StatsTab`) all consume this DTO.
"Emails Sent" everywhere is `sentEmails`; `contactedLeads` is exposed as the lead-grain
denominator. A route-level test asserts list/stats/detail/analytics return identical cohorts and
rates for the same fixture. `AnalyticsPage`/`OutreachDashboard` needed no code change — their
field names were already correct and they read server-computed rates without local recomputation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] LeadsPage rendered a non-existent `company` field**
- **Found during:** Task 3 (lead query end-to-end)
- **Issue:** The list UI read `lead.company`, but the API returns `companyName` — the Company
  column was always blank.
- **Fix:** Interface + render use `companyName`.
- **Files modified:** `src/pages/outreach/LeadsPage.tsx`
- **Commit:** `89c75c2`

**2. [Rule 3 - Blocking] Harness `suppressions` table lacks org scoping**
- **Found during:** Task 2 (unsubscribe/bounce notification tests)
- **Issue:** The disposable baseline bootstraps `suppressions` from an old server-scoped Drizzle
  snapshot; no repo migration adds `organization_id` / drops `server_id NOT NULL` (a known
  local/CI vs. production schema-history gap — production has the column). The unsubscribe/bounce
  suppression insert therefore failed only in the test harness.
- **Fix:** The notification-policy test brings `suppressions` to the code's expected shape in its
  own setup (`ADD COLUMN IF NOT EXISTS organization_id`, `ALTER COLUMN server_id DROP NOT NULL`).
  Test-only scaffolding; no production DDL and no schema change.
- **Files modified:** `src/server/jobs/__tests__/outreach-notification-policy.db.test.ts`
- **Commit:** `0878b2f`

No migration was required for this plan (migration 040 remains the highest; next free integer is
041). No production DB was touched.

## Known Stubs

- **Settings page "API Access" card** (`SettingsPage.tsx`) still shows a hardcoded
  `sk_test_****` key with inert "Regenerate Key" / "View Docs" buttons. This is **out of scope**
  for Phase 20 by the locked decision "Do not create a general API-key product in this phase"
  (CONTEXT §Out of scope). It is a notification-unrelated placeholder, left untouched; a future
  API-credential plan (not this milestone) owns it.

## Gate Results

- `npm run test` — **399 passed** (31 files), including the 5 new suites (settings, notification
  policy, metrics lib, metrics route, leads query) and all Phase 18/19 cross-tenant tests.
- `npm run build` — client + server build succeed.
- `npm run lint` — 0 warnings (`--max-warnings 0`).
- `npx tsc --noEmit -p tsconfig.json` (client) — clean.
- `npx tsc --noEmit -p tsconfig.server.json` (server) — clean.

## Self-Check: PASSED

- All created files present on disk.
- All task commits present in git history (`213f577`, `0878b2f`, `89c75c2`).

---
*Phase: 20-outreach-product-and-api-consistency*
*Completed: 2026-07-16*
