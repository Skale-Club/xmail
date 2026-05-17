# Phase 07: Pagination - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

All list endpoints return paginated results so that page loads don't degrade as data grows. This covers 5 endpoints that currently return all rows, extracting the duplicated pagination pattern into a shared utility, and adding frontend pagination controls.

</domain>

<decisions>
## Implementation Decisions

### Pagination Utility
- **D-01:** Extract duplicated inline pagination into a shared utility function — count query + data query + response shaping in one reusable helper. Lives in `src/lib/` or `src/server/lib/`.

### Frontend Pagination
- **D-02:** Add pagination controls to all outreach list pages — simple prev/next buttons + page indicator. Not infinite scroll.

### Default Page Size
- **D-03:** Default page size is 25 items. Matches requirement examples and provides faster initial load.

### Response Shape
- **D-04:** Standardize on existing codebase shape: `{ <resourceName>: [...], pagination: { page, limit, total, totalPages } }`. The ROADMAP says `{ items, pagination: { page, pageSize, total } }` but the codebase already uses `{ page, limit, total, totalPages }` consistently.

### Endpoints to Paginate
- **D-05:** Add server-side pagination to these 4 endpoints (leads and campaign-leads already paginate):
  1. `GET /api/outreach/campaigns` — PAGE-01
  2. `GET /api/outreach/leads/lists` — PAGE-03
  3. `GET /api/outreach/email-accounts` — PAGE-04
  4. `GET /api/outreach/campaigns/sequences` — PAGE-05
  5. `GET /api/outreach/campaigns/:campaignId/sequences` (org-wide sequences endpoint)

### Query Param Validation
- **D-06:** Use Zod schema for pagination query params (matching messages.ts pattern) — validates `page` (positive int, default 1) and `limit` (1-100, default 25).

### Agent's Discretion
- Utility function location and naming — agent decides where to place it
- Whether to also paginate the per-campaign sequences endpoint (it's small but should be consistent)

</decisions>

<canonical_refs>
## Canonical References

No external specs — requirements fully captured in decisions above.

### Project references
- `.planning/REQUIREMENTS.md` §PAGE-01 through PAGE-05 — acceptance criteria for each endpoint
- `.planning/ROADMAP.md` §Phase 07 — success criteria and dependency chain

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/api-client.ts` — generic fetch wrapper with auth, used by all frontend pages
- `src/hooks/useInfiniteScroll.ts` — infinite scroll hook (exists but NOT selected for this phase)
- Existing pagination pattern in `src/server/routes/messages.ts` lines 42-50 — Zod schema + inline count/data queries

### Established Patterns
- **React Query** — all list pages use `useQuery` with `queryKey` arrays
- **Zod validation** — messages.ts uses `searchMessagesSchema` for query param validation
- **Response shape** — `{ <resource>: [...], pagination: { page, limit, total, totalPages } }` used everywhere
- **No shared pagination utility** — each route duplicates: count query → data query → respond

### Integration Points
- `src/server/routes/outreach/campaigns.ts` — campaigns list (line 79), org-wide sequences (line 215)
- `src/server/routes/outreach/leads.ts` — lead lists (line 71), leads already paginated (line 177)
- `src/server/routes/outreach/email-accounts.ts` — email accounts list (line 77)
- Frontend pages: `CampaignsPage.tsx`, `LeadsPage.tsx`, `InboxesPage.tsx`, `SequencesPage.tsx`

</code_context>

<specifics>
## Specific Ideas

- Pagination controls: simple prev/next buttons + "Page X of Y" indicator, no page number list
- Total count displayed somewhere (existing LeadsPage already shows `data.pagination?.total` in a stat card)
- Query params: `?page=1&limit=25` (not `pageSize` — matches existing codebase convention)

</specifics>

<deferred>
## Deferred Ideas

- Infinite scroll for outreach lists — could reuse `useInfiniteScroll.ts` from webmail, but not needed now
- Cursor-based pagination — marked as v2 requirement (CURSOR-01), not needed at current scale
- Pre-computed denormalized counts — v2 requirement (CACHE-01)

</deferred>

---

*Phase: 07-pagination*
*Context gathered: 2026-04-01*
