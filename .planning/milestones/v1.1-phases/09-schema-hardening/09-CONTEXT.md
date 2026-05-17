# Phase 09: Schema Hardening - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Database constraints prevent invalid data and the old migration file is properly deprecated. This is the final phase — independent of all others to avoid schema.ts merge conflicts.

</domain>

<decisions>
## Implementation Decisions

### SCH-01: CHECK Constraints
- **D-01:** Add CHECK constraint `sequence_steps_delay_hours_positive` on `sequenceSteps.delayHours >= 0`
- **D-02:** Add CHECK constraint `sequence_steps_order_positive` on `sequenceSteps.stepOrder >= 1`
- Defined in `src/db/schema.ts` using Drizzle `.check()` API
- Applied via `sql/` migration file or `db:push`

### SCH-02: Migration Deprecation
- **D-03:** Add deprecation comment header to `supabase/migrations/013_add_performance_indexes.sql`
- Comment explains that indexes are now managed via Drizzle schema.ts (Phase 06)

### Agent's Discretion
- Exact CHECK constraint syntax and naming
- Whether to use `.check()` in schema.ts or raw SQL in migration

</decisions>

<canonical_refs>
## Canonical References

No external specs — requirements fully captured in decisions above.

### Project references
- `.planning/REQUIREMENTS.md` §SCH-01, SCH-02 — acceptance criteria
- `.planning/ROADMAP.md` §Phase 09 — success criteria

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Drizzle `.check()` API — available for constraint definitions
- `supabase/migrations/013_add_performance_indexes.sql` — file to deprecate

### Established Patterns
- Schema defined in `src/db/schema.ts` using Drizzle pg-core
- Migrations in `supabase/migrations/`
- `sql/` directory for CONCURRENTLY operations

### Integration Points
- `src/db/schema.ts` — add CHECK constraints to campaignSteps table
- `supabase/migrations/013_add_performance_indexes.sql` — add deprecation comment

</code_context>

<specifics>
## Specific Ideas

- DelayHours constraint: prevents negative delay values between sequence steps
- Order constraint: prevents zero or negative step ordering

</specifics>

<deferred>
## Deferred Ideas

None — this is the final phase.

</deferred>

---

*Phase: 09-schema-hardening*
*Context gathered: 2026-04-01*
