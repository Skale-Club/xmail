# Phase 15: Campaign Detail Page — Context

**Gathered:** 2026-05-17
**Status:** Ready for planning
**Mode:** Pre-authored from architectural analysis (discuss skipped)

<domain>
## Phase Boundary

After Phase 14, a user can CREATE a campaign via `/outreach/campaigns/new` and SEE it in the list at `/outreach/campaigns`. But every `<Link href="/outreach/campaigns/${campaign.id}">` in [CampaignsPage.tsx:86](src/pages/outreach/CampaignsPage.tsx:86) and [OutreachDashboard.tsx:126](src/pages/outreach/OutreachDashboard.tsx:126) leads to a route that **does not exist in `src/main.tsx`** — user falls into 404/blank.

This phase delivers `/outreach/campaigns/:id` (Campaign Detail page) so the funnel from create → manage → activate is end-to-end functional. The backend endpoints already exist; this is a frontend completion.

In scope: a multi-tab detail page (Overview / Leads / Sequence / Stats) wired to the existing `/api/outreach/campaigns/:id`, `/api/outreach/campaigns/:campaignId/leads`, `/api/outreach/campaigns/:campaignId/sequences`, `/api/outreach/campaigns/:campaignId/stats` endpoints.

Definition of done: user clicks a campaign in the list → lands on detail page with the campaign's name, status, totals; can navigate between Overview/Leads/Sequence/Stats tabs; can add leads to the campaign via UI; can change status (draft → active → paused); the redirect after creating a new campaign in Phase 14 ([NewCampaignPage](src/pages/outreach/campaigns/NewCampaignPage.tsx)) now lands on the actual detail page instead of the list fallback.

Out of scope: rich analytics charts (deferred to Phase 17 observability); template editor (already exists via `/outreach/campaigns/:id/sequences/new` from Phase 14); A/B variant management UI (P2).
</domain>

<decisions>
## Implementation Decisions

### Page structure
- Single page component `src/pages/outreach/campaigns/CampaignDetailPage.tsx` with internal tab state (no nested wouter routes — tabs are state, not URL segments, to keep the URL stable for sharing/bookmarking)
- Tabs: **Overview** (default) | **Leads** | **Sequence** | **Stats**
- Route registered in `src/main.tsx` AFTER `/outreach/campaigns/new` but BEFORE `/outreach/campaigns` (wouter order)
- Wraps `OutreachLayout` and the existing `<AdminCheck><OrganizationProvider>` wrappers

### Overview tab
- Header: campaign name (editable inline via pencil icon → save with PATCH), description, status badge, created date
- Action buttons: Activate/Pause (PATCH `/api/outreach/campaigns/:id` with `{status}`), Delete (DELETE with confirm)
- Stats summary cards: Total Leads, Emails Sent, Open Rate, Reply Rate, Bounce Rate (4 cards, read from `/stats` endpoint)
- "From inbox" display (read-only, from `email_account_id` if column exists; if not, show "Default")

### Leads tab
- Paginated table of `campaign_leads` joined with `leads` (use the existing `GET /api/outreach/campaigns/:campaignId/leads` — confirm pagination already supported per Phase 07; if not, add)
- Columns: Email, Name, Company, Status (pending/sent/replied/bounced/unsubscribed), Last Activity
- "Add Leads" button → modal: paste emails (comma/newline separated) OR select existing lead-list — calls `POST /api/outreach/campaigns/:campaignId/leads`
- Honest response handling: show `{added, existing, suppressed}` counts in the success toast (assumes Phase 16 may improve this; for now use whatever the endpoint returns)

### Sequence tab
- Read-only view of sequence steps (Step 1, Step 2, ..., with delay between, subject preview)
- "Edit Sequence" button → links to existing `/outreach/campaigns/:id/sequences/new` (or `/sequences/:sequenceId/edit` if exists; verify)

### Stats tab
- Time-series chart: emails sent per day (last 14 days) using existing `/stats` endpoint
- Bounce/reply/open/click rates as simple % numbers (charting library: reuse whatever the existing analytics page uses; recharts is standard React)
- Per-step breakdown table: Step | Sent | Opened | Clicked | Replied | Bounced

### Wiring & data fetching
- React Query (TanStack Query) for data fetching — matches CampaignsPage.tsx pattern
- Use existing `apiFetch`/`apiRequest` helpers + `useOrganization` hook
- Optimistic updates for status toggle (immediate UI feedback, rollback on error)
- Loading skeletons (not spinners) for each tab on first load

### UX details
- "Back to campaigns" breadcrumb at top
- 404 if campaign ID doesn't exist or belongs to another org (RLS will return empty → handle in component)
- Update Phase 14's [NewCampaignPage success path](src/pages/outreach/campaigns/NewCampaignPage.tsx) to redirect to `/outreach/campaigns/${newId}` (the new detail page) instead of the list

### Claude's Discretion
- Exact icon choices (lucide-react — match existing pages)
- Exact card layout / grid sizing
- Toast copy
- Whether to use shadcn Tabs primitive or roll a small custom tab component (recommend Tabs primitive if available; check `src/components/ui/`)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- **CampaignsPage.tsx**: pagination, table, status badges, status color map, action menu — patterns to follow
- **NewCampaignPage.tsx**: form pattern (react-hook-form + Zod), success toast, apiRequest usage
- **OutreachLayout**: page wrapper used by all outreach pages
- **shadcn UI**: Card, Badge, Button, Dialog, Input, Select, Tabs (if installed), Table primitives in `src/components/ui/`
- **API helpers**: `apiFetch`, `apiRequest` (see how CampaignsPage uses them)

### Backend endpoints already exist (confirm wiring)
- `GET /api/outreach/campaigns/:id?organizationId=...` — fetch single campaign
- `PATCH /api/outreach/campaigns/:id?organizationId=...` — update name/desc/status
- `DELETE /api/outreach/campaigns/:id?organizationId=...` — delete (cascade, tx-wrapped per Phase 14)
- `GET /api/outreach/campaigns/:campaignId/leads` — paginated leads list
- `POST /api/outreach/campaigns/:campaignId/leads` — add leads (the one that now sets nextScheduledAt correctly per Phase 14)
- `GET /api/outreach/campaigns/:campaignId/sequences` — sequence steps
- `GET /api/outreach/campaigns/:campaignId/stats` (verify path) — aggregated counts

### Established Patterns
- React Query: `useQuery({ queryKey: ['campaigns', orgId, ...], queryFn })`
- Status colors via const map: `const statusColors = { active: 'bg-green-...', paused: 'bg-yellow-...', ... }`
- Modals: inline `{showModal && <Dialog>...</Dialog>}` or shadcn Dialog
- Tab pattern: lookup if shadcn Tabs is installed; otherwise simple `useState<'overview' | 'leads' | ...>('overview')`

### Integration Points
- `src/main.tsx`: register `<Route path="/outreach/campaigns/:id">` BEFORE `/outreach/campaigns` (after `/new`)
- `src/pages/outreach/campaigns/NewCampaignPage.tsx`: update success redirect from `/outreach/campaigns` (list) to `/outreach/campaigns/${id}` (detail)
- All API calls require `?organizationId=...` query param per existing pattern

</code_context>

<specifics>
## Specific Ideas

- The "Add Leads" modal should handle BOTH freeform paste (one email per line) AND existing lead-list selection — the most common UX in cold-email tools
- Status transitions: draft → active (validation: must have ≥ 1 sequence step AND ≥ 1 lead AND a from-inbox); active ↔ paused; completed terminal
- For the back-end paginated `/leads` endpoint, follow Phase 07's pagination shape `{ items, pagination: {page, pageSize, total} }`

</specifics>

<deferred>
## Deferred Ideas

- Bulk actions on leads (delete selected, retry bounced) → P2 / Phase 18
- Per-lead activity timeline drawer (full message history) → P2
- A/B variant performance UI (`variantA` vs `variantB` columns) → P2 / Phase 18
- Email preview rendering inside the Sequence tab → P2
- Charts: per-hour send pattern, deliverability score trend → Phase 17 observability

</deferred>
