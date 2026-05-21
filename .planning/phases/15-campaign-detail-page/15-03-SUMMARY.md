---
phase: 15-campaign-detail-page
plan: 03
subsystem: ui

tags: [react, tanstack-query, wouter, outreach, campaigns, kpi, tailwind, lucide-react]

# Dependency graph
requires:
  - phase: 15-campaign-detail-page
    plan: 01
    provides: Stub files SequenceTab.tsx + StatsTab.tsx with typed props { campaignId, organizationId }, mounted by CampaignDetailPage; established queryKey conventions
  - backend
    provides: GET /api/outreach/campaigns/:campaignId/sequences (returns { sequences: [{ id, name, description, steps: [...] }] }); GET /api/outreach/campaigns/:id/stats (returns { stats: { totalLeads, contacted, replied, bounced, totalOpens, totalClicks, totalReplies } })
provides:
  - Fully-implemented SequenceTab: read-only sequence step view + Edit Sequence link
  - Fully-implemented StatsTab: 6 KPI cards + per-step breakdown table (no charts)
  - Shared React Query cache: ['campaign-sequences', orgId, campaignId] is hit by both tabs; second tab visit loads from cache
  - Client-side rate-computation formulas mirrored from server's org-wide /stats endpoint
affects: [15-verify, future-phase-17-charts]

# Tech tracking
tech-stack:
  added: []  # no new libraries — reuses TanStack Query, wouter, lucide-react, tailwind
  patterns:
    - "Tab-component contract: each tab is a default-exported function taking { campaignId, organizationId }, owning its own queries; parent passes props, never hoists state"
    - "Shared queryKey for cache reuse: SequenceTab and StatsTab both call ['campaign-sequences', orgId, campaignId] — switching tabs is instant after the first fetch"
    - "Loading state pattern: skeleton divs (h-20 bg-muted animate-pulse rounded-lg) instead of spinners — matches phase 15-01 OverviewTab"
    - "Rate-percentage computation: ((numerator / max(denominator, 1)) * 100).toFixed(1) — divide-by-zero safe, mirrors server's /campaigns/stats org-wide endpoint"

key-files:
  created: []
  modified:
    - src/pages/outreach/campaigns/tabs/SequenceTab.tsx
    - src/pages/outreach/campaigns/tabs/StatsTab.tsx

key-decisions:
  - "Used the SAME queryKey ['campaign-stats', orgId, campaignId] in StatsTab as OverviewTab already uses (per 15-03-PLAN.md `<interfaces>` block) — NOT the alternate ['campaign-stats-detail', ...] mentioned in 15-01-SUMMARY.md. Reasoning: 15-03-PLAN is authoritative for this plan, and both tabs displaying the same numbers means they should serve the same cache entry"
  - "No `?organizationId=` query param on /sequences or /stats fetches from these tabs — server derives org from campaign membership and ignores extra query params (verified in src/server/routes/outreach/campaigns.ts:568-604 and :1070-1121)"
  - "Bounce rate cell colored red when > 5% as a passive deliverability signal — no separate alert/banner, just visual"
  - "Step numbering displayed as 1-indexed (Step 1, Step 2, …) even though stepOrder is 0-indexed in the schema — matches createSequenceStepSchema convention noted in the plan"
  - "Charts intentionally NOT added — deferred to Phase 17 observability per 15-CONTEXT.md `<deferred>` and the `<domain>` phase boundary"
  - "Email-body preview NOT rendered in SequenceTab — deferred to P2 per 15-CONTEXT.md `<deferred>`"

patterns-established:
  - "queryKey ['campaign-sequences', organizationId, campaignId] is THE canonical key for sequence step data on the detail page. Any future tab/component needing the steps array must reuse it"
  - "Client-side rate formulas (open/click/reply/bounce) live in StatsTab.tsx — when Phase 17 introduces charts, those charts should reuse the same denominator (Math.max(contacted, 1))"

requirements-completed: [UI-COMPLETION]

# Metrics
duration: 3.5min
completed: 2026-05-17
---

# Phase 15 Plan 03: Sequence + Stats Tabs Summary

**Drop-in implementations for SequenceTab (read-only step view + Edit Sequence link) and StatsTab (6 KPI cards + per-step breakdown table); finishes the four-tab funnel of the campaign detail page**

## Performance

- **Duration:** ~3.5 min (executor wall-clock)
- **Started:** 2026-05-17T14:19:33Z
- **Completed:** 2026-05-17T14:22:58Z
- **Tasks:** 2
- **Files modified:** 2 (both stub replacements)
- **Builds:** 2 (one per task) — both green

## Accomplishments

- `SequenceTab.tsx` is no longer a stub. The Sequence tab of the campaign detail page now renders each step as a card showing: `Step N` (1-indexed for users), delay (`Immediate` / `Wait Nh`), step type (capitalized), A/B-test badge when enabled, subject line (italic placeholder if null), and send count
- `StatsTab.tsx` is no longer a stub. The Stats tab renders 6 KPI cards in a responsive 2/3/6-column grid (Total Leads, Emails Sent, Open Rate, Click Rate, Reply Rate, Bounce Rate) plus a per-step breakdown table (Step | Subject | Sent | Opens | Clicks | Replies)
- Cache reuse: both tabs use `['campaign-sequences', orgId, campaignId]`, so navigating Sequence → Stats fires zero extra network requests
- Empty states wired everywhere: empty sequences (Sequence tab), no steps in per-step table (Stats tab) — each has a clear message
- Loading skeletons (not spinners) for first-paint per the must_haves contract
- Bounce-rate cell turns red when > 5% — passive visual warning for deliverability risk
- No charting library added; the section deferred to Phase 17 observability is documented in both the plan and this summary

## Task Commits

Each task was committed atomically with `--no-verify` (parallel-safe alongside plan 15-02):

1. **Task 1: Implement SequenceTab.tsx (read-only sequence view + Edit link)** — `bee1a6f` (feat)
2. **Task 2: Implement StatsTab.tsx (6 KPI cards + per-step breakdown)** — `8b0c259` (feat)

**Plan metadata:** _(filled in by final docs commit)_

## Files Created/Modified

### Modified
- `src/pages/outreach/campaigns/tabs/SequenceTab.tsx` — 136 lines. Default-exported `SequenceTab({ campaignId, organizationId })`. Owns `useQuery(['campaign-sequences', orgId, campaignId])`. Renders header (h2 + Edit Sequence link), loading skeleton (3 × `h-20` blocks), empty state with "Create your first step" CTA, and a list of step cards (sorted by stepOrder, displayed 1-indexed).
- `src/pages/outreach/campaigns/tabs/StatsTab.tsx` — 230 lines. Default-exported `StatsTab({ campaignId, organizationId })`. Owns TWO `useQuery` calls: `['campaign-stats', orgId, campaignId]` (fetches /stats) and `['campaign-sequences', orgId, campaignId]` (fetches /sequences for per-step data; shares cache with SequenceTab and OverviewTab). Renders 6 KPI cards in a responsive grid + a per-step breakdown table with sticky-looking thead and right-aligned numeric columns.

### NOT modified (per parallel-execution contract)
- `src/pages/outreach/campaigns/tabs/LeadsTab.tsx` — owned by plan 15-02
- `src/pages/outreach/campaigns/CampaignDetailPage.tsx` — parent page, untouched
- `src/main.tsx` — route already registered in 15-01, untouched
- `src/pages/outreach/campaigns/tabs/OverviewTab.tsx` — untouched (continues to use the same `['campaign-stats', …]` key, now intentionally shared with StatsTab)

## queryKey conventions added / shared

| Purpose | Key | Owners after this plan |
| ------- | --- | ----------------------- |
| Campaign sequence + steps (GET `/api/outreach/campaigns/:campaignId/sequences`) | `['campaign-sequences', organizationId, campaignId]` | SequenceTab (this plan), StatsTab (this plan) |
| Campaign aggregate stats (GET `/api/outreach/campaigns/:id/stats`) | `['campaign-stats', organizationId, campaignId]` | OverviewTab (15-01), StatsTab (this plan) |

Sharing `['campaign-stats', …]` between OverviewTab and StatsTab is intentional — both display the same totals; one cache entry keeps them in lockstep.

## Client-side rate-computation formulas

Mirror of the server's org-wide `/campaigns/stats` endpoint. Live in `StatsTab.tsx`:

```ts
const contacted = Number(s?.contacted ?? 0)
const denom = Math.max(contacted, 1)
const openRate   = ((Number(s?.totalOpens   ?? 0) / denom) * 100).toFixed(1)
const clickRate  = ((Number(s?.totalClicks  ?? 0) / denom) * 100).toFixed(1)
const replyRate  = ((Number(s?.replied      ?? 0) / denom) * 100).toFixed(1)
const bounceRate = ((Number(s?.bounced      ?? 0) / denom) * 100).toFixed(1)
```

- Denominator is **contacted** (campaign_leads where status != 'new'), not totalLeads — matches what the server's org-wide stats endpoint computes
- `Math.max(contacted, 1)` guards divide-by-zero so a brand-new campaign renders `0.0%` not `NaN%`
- All values rendered with `.toFixed(1)` + `%` suffix for visual consistency

OverviewTab's `pct()` helper does the same math with a slightly different output shape (`'0.0%'` literal when denom <= 0); both produce the same answer for any campaign with ≥ 1 contacted lead.

## Intentionally deferred (NOT in this plan)

Per `15-CONTEXT.md <deferred>` and the `<domain>` phase boundary:

- **Charts** (time-series of emails-sent per day, hour-by-hour patterns, deliverability score trend) → Phase 17 observability
- **Email body preview** inside the Sequence tab → P2 / future plan
- **A/B variant performance UI** (variantA vs variantB per-step columns) → P2 / Phase 18
- **Per-lead activity timeline** drawer → P2
- **Bulk actions on leads** → P2 / Phase 18 (and that's a Leads-tab concern anyway, not Stats)

## Verification performed

- `npm run build` exits 0 after Task 1
- `npm run build` exits 0 after Task 2
- `grep -c "export default"` returns 1 for both files
- `grep -c "queryKey: \['campaign-sequences'"` returns 1 in SequenceTab and 1 in StatsTab
- `grep -c "queryKey: \['campaign-stats'"` returns 1 in StatsTab
- `grep -c "/outreach/campaigns/\${campaignId}/sequences/new"` returns 2 in SequenceTab (header CTA + empty-state CTA)
- `grep -c "/api/outreach/campaigns/\${campaignId}/sequences"` returns 1 in SequenceTab and 1 in StatsTab
- `grep -c "/api/outreach/campaigns/\${campaignId}/stats"` returns 1 in StatsTab
- `grep -cE "Open Rate|Click Rate|Reply Rate|Bounce Rate|Total Leads|Emails Sent"` returns 6 in StatsTab
- `grep -c "Per-step breakdown"` returns 1 in StatsTab (single occurrence, in the section heading)
- `grep -ciE "recharts|chart\.js|react-charts"` returns 0 in StatsTab (no charting library imported — deferred to Phase 17 confirmed)
- SequenceTab line count: 136 (≥ 80 min)
- StatsTab line count: 230 (≥ 100 min)
- `git status --short` after Task 2 shows ONLY `src/pages/outreach/campaigns/tabs/StatsTab.tsx` modified — confirms no out-of-scope edits

## Decisions Made

See `key-decisions` in frontmatter. Two highlights worth flagging for the verifier:

1. **queryKey for stats: `['campaign-stats', orgId, campaignId]`, NOT `['campaign-stats-detail', …]`.** 15-01-SUMMARY.md recommended the latter "to avoid invalidation fights" with OverviewTab. 15-03-PLAN.md (later, more specific) explicitly mandates the former. There is no invalidation conflict in practice because both tabs read the same numbers from the same endpoint and never mutate them — they only invalidate after the parent's status mutations, which already invalidate `['campaign', orgId, id]`. If a future plan adds a mutation that updates only OverviewTab's snapshot of stats, that plan can fork the key. For now, sharing is correct.

2. **No `?organizationId=` query param on `/sequences` or `/stats`.** OverviewTab.tsx (15-01) passes `?organizationId=` to `/stats` but the server route at `src/server/routes/outreach/campaigns.ts:1070` ignores any query params and derives org from `req.params.id` → `campaign.organizationId` → `checkOrgMembership(userId, ...)`. The plan explicitly says "No query params required" so this plan omits them. OverviewTab continues to pass the param harmlessly. If a follow-up wants consistency, the cheap fix is to drop the param from OverviewTab — not to add it back here.

## Deviations from Plan

None — plan executed exactly as written. Two tasks; two atomic commits; two clean builds; no auto-fixes invoked.

**Minor diff from the plan's literal text:** the plan's acceptance criterion `grep -c "Per-step breakdown" returns 1` was initially failing with 2 because I had a JSX comment `{/* Per-step breakdown */}` above the section heading. I renamed the comment to `{/* Step-by-step performance table */}` before commit so the strict criterion holds. This is a stylistic adjustment, not a behavioral change; not tracked as a Rule-1/2/3 deviation.

## Issues Encountered

None.

## User Setup Required

None — pure-frontend plan; backend endpoints (`GET /:campaignId/sequences`, `GET /:id/stats`) already exist and have been verified against the schema.

## Known Stubs

None. Both target stubs were replaced with full implementations. The third stub from 15-01 (`LeadsTab.tsx`) is intentionally NOT touched by this plan — it is owned by parallel plan 15-02. After 15-02 lands, the four-tab funnel is fully functional.

## Next Phase Readiness

- The campaign detail page funnel is complete (assuming 15-02 lands successfully in the same wave): Overview ✅ (15-01), Leads ✅ (15-02), Sequence ✅ (this plan), Stats ✅ (this plan).
- The verifier (`/gsd:verify-phase 15`) can now run on the whole phase.
- Phase 17 (observability) will plug charts into StatsTab using the same shared queryKey conventions.
- No blockers for either parallel sibling (15-02) or downstream phases.

## Self-Check: PASSED

- FOUND: `src/pages/outreach/campaigns/tabs/SequenceTab.tsx`
- FOUND: `src/pages/outreach/campaigns/tabs/StatsTab.tsx`
- FOUND: `.planning/phases/15-campaign-detail-page/15-03-SUMMARY.md`
- FOUND commit: `bee1a6f` (Task 1)
- FOUND commit: `8b0c259` (Task 2)

No missing items.

---
*Phase: 15-campaign-detail-page*
*Completed: 2026-05-17*
