# Phase 13: MEDIUM Consolidation - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning
**Mode:** Auto-generated (autonomous mode — audit is the spec)

<domain>
## Phase Boundary

Eliminate inconsistencies: tsc errors, migration drift, RLS scattered files, mixed casing, weak CSP, PII logs.

**ROADMAP success criteria:**
1. `npx tsc --noEmit` 0 errors (both tsconfigs).
2. `013_add_performance_indexes.sql` archived; schema workflow documented.
3. `017_consolidate_rls.sql` exists, idempotent, verify-rls passes from this single migration.
4. Domain `EXAMPLE.COM` then `example.com` returns 400 duplicate; all DB rows lowercase.
5. CSP includes `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.
6. No `console.log` of PII in production code paths.
7. `organizations.ownerId`, `organizations.outreachEnabled` (camelCase TS).

**Note (carry-forward):** Phase 11 used migration 018 (skip_tls_verify), Phase 12 used 019 (clicked_at). RLS consolidation should be **migration 020** (NOT 017 — that's already in REQUIREMENTS but conflicts with sequence). Adjust the requirement text or rename file.

</domain>

<decisions>
## Implementation Decisions

### QUA-01 tsc-clean
- Fix `src/components/AppLogo.tsx:12` unused `isSuccess`. Fix `src/server/lib/tracking.ts:266` `event as any` (type properly). Run tsc for both configs, hunt remaining errors.

### QUA-02 migration cleanup
- Move `supabase/migrations/013_add_performance_indexes.sql` → `supabase/migrations/archive/013_add_performance_indexes.sql`.
- Document in `CLAUDE.md` and/or `README.md`: schema lives in `src/db/schema.ts` + hand-written `supabase/migrations/*.sql`. `npm run db:generate` is not used for new migrations.
- If `package.json` has stale `drizzle-kit generate:pg` syntax, fix to `generate` (or remove if deprecated).

### QUA-03 RLS consolidation
- Create `supabase/migrations/020_consolidate_rls.sql` (NOT 017 — number conflicts). Update REQUIREMENTS.md text + ROADMAP.md to reflect renumbering.
- `DROP POLICY IF EXISTS ... CREATE POLICY ...` idempotent for every active policy.
- Verify by running `scripts/verify-rls-policies.ts`.

### QUA-04 domain normalize
- `POST /api/domains`: `name: name.toLowerCase().trim()` before insert.
- Data backfill migration `021_lowercase_domains.sql`: `UPDATE domains SET name = LOWER(name) WHERE name <> LOWER(name)`.

### QUA-05 CSP hardening
- Update helmet config in `src/server/index.ts`: add `frame-ancestors: ['none']`, `object-src: ['none']`, `base-uri: ['self']`.

### QUA-06 PII log audit
- Grep `console.log` in `src/server/`. Wrap or remove logs that emit email/token. Keep startup messages.

### QUA-07 authLimiter calibrate
- Change auth limiter from 5/15min to 10/15min in `src/server/index.ts`.

### QUA-08 schema field rename
- `src/db/schema.ts`: rename `organizations.owner_id` → `ownerId`, `organizations.outreach_enabled` → `outreachEnabled` (TS property; SQL columns stay snake_case).
- Grep callers and update. Phase 12 lint gate catches regressions.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/verify-rls-policies.ts` — for QUA-03 verification.
- `helmet` already configured in `src/server/index.ts`.

### Established Patterns
- Drizzle column naming: `text('snake_case_db_column')` as `camelCaseProperty`.

### Integration Points
- Migration numbering: 018, 019 taken. Next free: 020.

</code_context>

<specifics>
## Specific Ideas

Audit Fase 3 Blocos 3.1–3.9.

</specifics>

<deferred>
## Deferred Ideas

- Full Drizzle migration regeneration (out-of-scope per QUA-02 doc decision).

</deferred>
