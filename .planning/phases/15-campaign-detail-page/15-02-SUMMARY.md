---
phase: 15-campaign-detail-page
plan: 02
subsystem: ui

tags: [react, tanstack-query, outreach, campaigns, leads, modal, pagination]

# Dependency graph
requires:
  - phase: 15-campaign-detail-page
    plan: 01
    provides: "LeadsTab stub mounted by CampaignDetailPage with props { campaignId, organizationId }; queryKey contract ['campaign-leads', orgId, campaignId, page]"
provides:
  - "Fully-implemented LeadsTab component: paginated table of campaign_leads joined with leads + dual-mode 'Add Leads' modal (paste raw emails OR pick a lead list)"
  - "Email-resolution flow: try POST /api/outreach/leads per email, fall back to one-shot GET-all + local map on duplicate-email 400"
  - "Cache invalidation: ['campaign-leads', orgId, campaignId] AND ['campaign', orgId, campaignId] after successful add (the latter refreshes the campaign's totalLeads denormalised counter shown by OverviewTab and the header)"
affects: [15-03-sequence-stats-tabs, future-lead-search-endpoint, future-bulk-add-ux]

# Tech tracking
tech-stack:
  added: []  # no new libraries
  patterns:
    - "Per-email resolve-or-create loop with a session-cached fallback Map for duplicates (works around the absent server-side search-by-email)"
    - "Modal inline-JSX pattern (matches MEMORY.md modal convention) — backdrop click closes when not submitting, child stopPropagation, mode toggle as two flex-1 buttons"
    - "Dual queryKey shapes: ['campaign-leads', orgId, campaignId, page] (paginated table) and ['lead-lists', orgId] (modal lookup, enabled-gated to only fire when modal is open in 'list' mode)"

key-files:
  created:
    - .planning/phases/15-campaign-detail-page/15-02-SUMMARY.md
  modified:
    - src/pages/outreach/campaigns/tabs/LeadsTab.tsx  # stub overwritten — 14 lines -> 502 lines

key-decisions:
  - "Mode default = 'paste' — cold-email power-users overwhelmingly paste; lead-list pre-existence is the rarer case"
  - "Use apiRequest + ApiClientError for the POST create-lead call (rather than apiFetch) because we need the structured 400 'already exists' to drive the duplicate-fallback branch — apiFetch would throw the same error but the typed Error message check is identical"
  - "Resolution fallback is one-shot GET ?limit=1000 (then cached for the rest of the submission), NOT one GET per duplicate — keeps the worst-case at N+1 round-trips (N creates + 1 lookup) instead of 2N"
  - "Pagination invalidation broadcasts on ['campaign-leads', orgId, campaignId] (3-key prefix) so any page resets correctly; we also reset setPage(1) after a successful add so the user sees the freshly-added rows at the top"
  - "Status badge palette is intentionally different from CampaignsPage's per-campaign-status palette to visually distinguish 'this lead's progress through the campaign' from 'this campaign's lifecycle state'"
  - "Skipped a delete-from-campaign action and a per-lead status edit — deferred to Phase 18 per CONTEXT.md 'Deferred Ideas' (bulk actions, per-lead activity drawer)"

patterns-established:
  - "When a server endpoint is missing a needed query param (here: leads search-by-email), prefer a degrade-gracefully fallback (per-email POST + cached GET-all map) over blocking on a server change — keeps the parallel wave shippable"
  - "useQuery `enabled` gate (showAddModal && mode === 'list') prevents fetching lead lists on tab mount; only loads when the user actually opens the modal AND picks list mode"
  - "Form reset on close: setShowAddModal(false) is always paired with clearing pastedEmails, selectedListId, and mode — defined as a closeModal() helper instead of repeated inline"

requirements-completed: [UI-COMPLETION]

# Metrics
duration: 3min
completed: 2026-05-17
---

# Phase 15 Plan 02: Leads Tab — Paginated Table + Add Leads Modal Summary

**The Leads tab now renders a real table of campaign_leads (paginated, status-coloured) and lets the user populate a campaign for the first time via either pasted emails OR an existing lead-list pick — closes the create → add leads → activate loop end-to-end from the UI.**

## Performance

- **Duration:** ~3 min (executor wall-clock; not counting context window load)
- **Started:** 2026-05-17T14:18:55Z
- **Completed:** 2026-05-17T14:21:52Z
- **Tasks:** 1
- **Files modified:** 1 (`src/pages/outreach/campaigns/tabs/LeadsTab.tsx`)
- **Build time:** 5.30s (Vite + tsc, all green)

## Accomplishments

- The Leads tab on `/outreach/campaigns/:id` no longer says "coming in plan 15-02" — it renders a real table with columns **Email / Name / Company / Status / Last Activity**, paginated at 25 rows per page via the existing `PaginationControls`.
- **Empty state**: when a campaign has zero leads, the tab shows a clean "No leads in this campaign yet" card with a primary "Add your first leads" CTA. Both this and the header `Add Leads` button open the same modal.
- **Add Leads modal** offers two clearly-toggled modes:
  - **Paste Emails**: textarea accepting newline / comma / semicolon separated emails. Filtered by `^[^\s@]+@[^\s@]+\.[^\s@]+$` and deduped (lowercased) before resolution.
  - **From Lead List**: native `<select>` populated from `GET /api/outreach/leads/lists?organizationId=...` (gated to only fetch when this mode is active). Fetches up to 1000 leads from the picked list.
- **Resolution flow** (paste mode): per-email POST to `/api/outreach/leads`; on the server's 400 `"Lead with this email already exists"` we GET all org leads once (cached in a Map for the submission), and look up by lowercased email. Successes are passed to `POST /api/outreach/campaigns/:id/leads`; failures are surfaced in the success toast description (`"… · 2 emails failed to resolve"`).
- **Success toast** shows `Added N lead(s)` as the title and combines `existing` (server-side dup count) and `failed` (resolution failures) into a single human-readable description.
- **Cache invalidation** on success: `['campaign-leads', orgId, campaignId]` (table) AND `['campaign', orgId, campaignId]` (CampaignDetailPage's header + OverviewTab's `totalLeads` denormalised counter). Page is reset to 1 so the user sees their newly-added rows at the top.
- **Per-status colour badges** for the 7 `campaignLeads.status` enum values (new / contacted / replied / interested / not_interested / bounced / unsubscribed) — palette chosen to be visually distinct from the campaign-status palette in `CampaignsPage`.

## Task Commits

1. **Task 1: Implement LeadsTab — paginated table + Add Leads modal** — `86d36fc` (feat)

## Files Created/Modified

### Created
- `.planning/phases/15-campaign-detail-page/15-02-SUMMARY.md` — this file.

### Modified
- `src/pages/outreach/campaigns/tabs/LeadsTab.tsx` — 14 lines (stub) → **502 lines**. Default-exported `LeadsTab({ campaignId, organizationId })` exactly matching the 15-01 contract. Imports `useQuery`/`useQueryClient` from `@tanstack/react-query`, `apiFetch`/`apiRequest`/`ApiClientError` from `'../../../../lib/api-client'`, `toast` from `'../../../../components/ui/toaster'`, `PaginationControls`, and 4 icons from `lucide-react` (Plus, X, Mail, AlertCircle). No new files needed — `CampaignDetailPage.tsx` already mounts the tab.

## queryKey conventions added

| Purpose | Key | Source |
| ------- | --- | ------ |
| Paginated campaign-leads table | `['campaign-leads', organizationId, campaignId, page]` | `LeadsTab` main query |
| Lead-lists picker (modal-gated) | `['lead-lists', organizationId]` | `LeadsTab` modal `mode === 'list'` |

Both keys are **invalidation-safe** under prefix-match: after a successful add, `invalidateQueries({ queryKey: ['campaign-leads', orgId, campaignId] })` refetches **all pages** of the current campaign's leads list (not just the current page), matching React Query's default prefix-match behaviour.

`['lead-lists', orgId]` was already used by `LeadsPage.tsx` (`src/pages/outreach/LeadsPage.tsx:178`) for the same purpose — we reuse it deliberately so that creating a new lead list elsewhere invalidates this tab's modal dropdown too.

## Email-resolution flow

```
For each pasted email (lowercased, deduped, regex-validated):

  1. POST /api/outreach/leads?organizationId=<org>
       body: { email }
     ──> 201 { lead: { id } }            → push id
     ──> 400 "already exists"            → goto step 2
     ──> any other error                 → push email to failed[]

  2. (only on first 400 in the batch)
     GET /api/outreach/leads?organizationId=<org>&limit=1000
     Build Map<emailLower, id>; cache for the rest of the submission.

  3. existing = map.get(email)
     ──> found  → push id
     ──> miss   → push email to failed[]

Then:
  POST /api/outreach/campaigns/<campaignId>/leads
    body: { leadIds: [...resolved ids] }
  ──> 201 { added, existing, campaignLeads }
```

This works around the fact that `GET /api/outreach/leads` in `src/server/routes/outreach/leads.ts` has **no `search` query param** (only `status`, `leadListId`, `page`, `limit`). See the Deviations section.

## Add Leads modal UX

- **Trigger**: either the header "Add Leads" button or the empty-state CTA.
- **Header**: title + close (X) icon. Close is disabled during submission so the user can't backdrop-click their way out of a pending request.
- **Mode toggle**: two equally-weighted flex-1 buttons. Active mode = primary fill, inactive = muted. Always visible at the top of the modal body so the user sees the alternative before committing.
- **Paste mode**: textarea (6 rows, monospace), helper text `"One per line or comma-separated. New emails will be created as leads; existing ones will be reused."` with an AlertCircle icon so the user knows duplicates are safe.
- **List mode**: `<select>` showing `name (N leads)` for each lead list. If no lead lists exist, helper text directs to the Leads page.
- **Footer**: Cancel + Add buttons right-aligned. Add is disabled while submitting and shows "Adding…" text.
- **Reset behaviour**: closing the modal (Cancel, X, or backdrop click) ALWAYS clears `pastedEmails`, `selectedListId`, and resets `mode` to `'paste'`. Successful add does the same plus `setPage(1)`.

## Decisions Made

See `key-decisions` in frontmatter. Highlights:
- Default mode = `paste` (most common UX for cold-email tools).
- Resolution uses **one-shot GET-all-on-first-dup** rather than per-dup GET — caps worst-case round-trips at N+1.
- Pagination resets to page 1 after a successful add so the user sees their new rows immediately.
- Per-lead delete + per-lead status edit explicitly **deferred** to Phase 18 per CONTEXT.md "Deferred Ideas".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Missing API capability] Server has no `search` query param on `GET /api/outreach/leads`**
- **Found during:** Task 1 — verifying the interfaces in `src/server/routes/outreach/leads.ts:182–250`
- **Issue:** The plan's `<interfaces>` section instructs `GET /api/outreach/leads?organizationId=...&search=<exact-email>&limit=1` as the lookup step. The route handler reads only `status`, `leadListId`, `page`, `limit` from the query — `search` is silently ignored, so the response would be the org's most recent 50 leads, which would mis-match emails 99% of the time.
- **Fix:** Inverted the strategy — POST-first (cheapest happy path: brand-new emails), and only on the server's existing 400 `"Lead with this email already exists"` response do we fall back to a one-shot `GET /api/outreach/leads?...&limit=1000` (cached in a Map). This is documented inline in the source (the multi-line comment block above `resolveEmailsToLeadIds`) and is acceptable per CONTEXT.md ("no bulk efficiency requirement in v1"). A future plan can add a proper search-by-email server endpoint; the function is structured to make that swap a one-line change.
- **Files modified:** `src/pages/outreach/campaigns/tabs/LeadsTab.tsx` (the resolution helper)
- **Commit:** `86d36fc`

No architectural changes. No CLAUDE.md violations encountered (this is a pure UI plan; no Hetzner/deploy concerns; no Supabase RLS changes; no new env vars).

## Issues Encountered

None blocking. One worth noting for future planners:

- The success-toast spec said "show whatever the endpoint returns (`{added, existing, suppressed}`)". The current server response is `{ added, existing }` only (no `suppressed` field). I render `added` in the title and conditionally include `existing` in the description. If a future plan adds suppression-aware counting to the POST endpoint, the toast only needs a one-line update.

## User Setup Required

None. Backend endpoints already exist and were deployed pre-Phase-14. No env-var, no migration, no infra change.

## Known Stubs

None. All states (loading / empty / table / pagination / modal-paste / modal-list / submitting) render real UI wired to real endpoints. The two sibling tab stubs (`SequenceTab.tsx`, `StatsTab.tsx`) remain — they belong to plan **15-03**, which is the parallel executor running alongside this plan.

## Next Phase Readiness

- **Plan 15-03** (Sequence + Stats tabs) is unaffected — disjoint file ownership confirmed: 15-03 owns `SequenceTab.tsx` + `StatsTab.tsx`; this plan touched only `LeadsTab.tsx`. CampaignDetailPage.tsx untouched.
- **Phase 15 verifier** can now check the full Leads flow end-to-end on `/outreach/campaigns/:id`.
- **Phase 18 / future** carries deferred items: per-lead delete from campaign, per-lead status edit, bulk actions, server-side search-by-email endpoint.

## Self-Check: PASSED

- File `src/pages/outreach/campaigns/tabs/LeadsTab.tsx` exists on disk (502 lines)
- Commit `86d36fc` exists in `git log --oneline -5`
- `npm run build` exits 0 (verified above — full bundle output appended to assets, server tsc clean)
- All 9 plan-specified acceptance criteria match (export count, queryKey, GET/POST URL patterns, lead-lists URL, PaginationControls, setMode toggle, leadStatusColors, column headers, line count >= 180)
- No files outside the owned path were touched (`git status --short` shows only the one modified file)

---
*Phase: 15-campaign-detail-page*
*Plan: 02*
*Completed: 2026-05-17*
