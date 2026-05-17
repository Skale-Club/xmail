# Phase 08: Query Optimization - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Background jobs and list endpoints load data efficiently with no N+1 patterns and no oversized payloads. Scope expanded beyond roadmap QRY-01/02/03 to include all N+1 patterns found in codebase audit.

</domain>

<decisions>
## Implementation Decisions

### QRY-01: processQueue.ts N+1 Fix
- **D-01:** Batch-load messages and organizations BEFORE the delivery loop — currently fetches message + org per delivery (up to 50× each)
- **D-02:** Pre-fetch all unique messages and orgs from the batched deliveries list, then look up from memory during delivery loop
- Target: 2 queries total instead of 3*N (1 fetch deliveries, 1 fetch messages, 1 fetch orgs — all batched)

### QRY-02: Column Filtering on List Endpoints
- **D-03:** Exclude `htmlBody`, `plainBody`, `attachments`, `headers`, `spamChecks` (large TEXT/JSONB columns) from list queries using Drizzle `columns` filter
- Applies to: messages list, mail messages list, campaigns list (eager-loaded steps), campaign leads (eager-loaded step bodies), templates list
- Detail views can still return full columns — only list endpoints filter

### QRY-03: processOutreachSequences Scoped Query
- **D-04:** Already filters by `nextScheduledAt <= now()` and uses the Phase 06 index — success criteria partially met
- **D-05:** Batch-load suppressed emails BEFORE the lead loop (currently 1 query per lead)
- **D-06:** Batch-load idempotency checks BEFORE the lead loop (currently 1 query per lead)
- **D-07:** Add `limit` to the pendingLeads query to prevent loading thousands of leads into memory

### Extra: Other N+1 Patterns
- **D-08:** Fix cascade.ts webhook deletion — use `inArray` instead of loop deletion
- **D-09:** Batch delivery inserts in messages.ts POST — single `db.insert(deliveries).values([...])` instead of loop
- **D-10:** Batch held message updates in processHeld.ts — single UPDATE WHERE IN instead of loop
- **D-11:** Fix markCompletedCampaigns N+1 — single query instead of per-campaign loop

### Agent's Discretion
- How much to batch (memory vs query trade-offs)
- Whether to add a `runFiltersOnMessage` batch variant for mail batch updates

</decisions>

<canonical_refs>
## Canonical References

No external specs — requirements fully captured in decisions above.

### Project references
- `.planning/REQUIREMENTS.md` §QRY-01 through QRY-03 — acceptance criteria
- `.planning/ROADMAP.md` §Phase 08 — success criteria and dependency chain

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Drizzle `inArray()` helper — available for batch WHERE IN queries
- Drizzle `columns` filter on `findMany()` — for excluding large columns
- Phase 06 indexes — `idxCampaignLeadsNextScheduled` already exists for QRY-03

### Established Patterns
- `db.query.table.findMany()` with `where`, `with` for eager loading
- `db.select({ count: sql<number>count(*) })` for count queries
- `db.insert(table).values([...])` for batch inserts (exists but not used everywhere)

### Integration Points
- `src/server/jobs/processQueue.ts` — delivery loop (QRY-01)
- `src/server/jobs/processOutreachSequences.ts` — sequence processor (QRY-03 + extras)
- `src/server/routes/messages.ts` — messages list (QRY-02 + batch insert)
- `src/server/routes/mail/messages.ts` — mail messages list (QRY-02)
- `src/server/routes/outreach/campaigns.ts` — campaigns list + campaign leads list (QRY-02)
- `src/server/routes/templates.ts` — templates list (QRY-02)
- `src/server/lib/cascade.ts` — cascade deletion (extra)
- `src/server/jobs/processHeld.ts` — held messages (extra)

</code_context>

<specifics>
## Specific Ideas

- processQueue fix: fetch all deliveries, collect unique messageIds and orgIds, batch-fetch messages and orgs with `inArray()`, build lookup maps, iterate deliveries with map lookups
- Column filtering: use Drizzle `columns: { htmlBody: false, plainBody: false, ... }` syntax on findMany queries
- Suppression batching: fetch all suppressed emails for the org at start, use Set for O(1) lookup in loop

</specifics>

<deferred>
## Deferred Ideas

- Cursor-based pagination (v2)
- Pre-computed denormalized counts (v2)
- Slow query logging with EXPLAIN ANALYZE (v2)
- Connection pooling changes (out of scope)

</deferred>

---

*Phase: 08-query-optimization*
*Context gathered: 2026-04-01*
