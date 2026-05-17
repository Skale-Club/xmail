---
phase: 05-rls-migration-safety
plan: 01
subsystem: database
tags: [supabase, rls, postgresql, security, multi-tenant]

requires:
  - phase: v1.0
    provides: existing RLS policies (broken), is_org_member helper function
provides:
  - Fixed RLS migration (016_fix_rls_org_scoped.sql)
  - RLS verification script (verify-rls-policies.ts)
  - Data isolation between organizations restored
affects: [06-index-foundation]

tech-stack:
  added: []
  patterns: [org-scoped RLS via is_org_member, RLS static analysis verification]

key-files:
  created:
    - supabase/migrations/016_fix_rls_org_scoped.sql
    - scripts/verify-rls-policies.ts
  modified: []

key-decisions:
  - "Consolidated is_outreach_org_member into is_org_member — identical logic, single function"
  - "Used is_org_member for SELECT, is_org_admin for write operations — follows Supabase RLS best practices"
  - "Static analysis verification instead of runtime tests — no test framework configured"

patterns-established:
  - "RLS policies use organizationId column with is_org_member/is_org_admin helpers"
  - "Verification scripts analyze migration SQL statically rather than requiring runtime setup"

requirements-completed: [DBS-01]

# Metrics
duration: ~8min
completed: 2026-03-31
---

# Phase 05-01: Fix Broken RLS Policies

**Migration 016 drops 11 dead server-scoped RLS policies and rewrites all policies to use organizationId with is_org_member/is_org_admin helpers, plus a static analysis verification script**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-31T16:21:00Z
- **Completed:** 2026-03-31T16:29:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Created `supabase/migrations/016_fix_rls_org_scoped.sql` — drops dead helper functions (is_server_member/admin/editor), drops all 11 broken server-scoped policies, recreates with org-scoped policies using is_org_member/is_org_admin
- Consolidated duplicate `is_outreach_org_member` into `is_org_member` (identical logic)
- Updated all outreach table policies to use `is_org_member`
- Created `scripts/verify-rls-policies.ts` — static analysis that checks for dead functions, server_id references, and verifies critical tables have active policies

## Task Commits

1. **Task 1: Create RLS fix migration** - `1c7a251` (feat)
2. **Task 2: Create RLS verification script** - `a01a92f` (feat)

## Files Created/Modified
- `supabase/migrations/016_fix_rls_org_scoped.sql` - Fixes all broken RLS policies (458 lines)
- `scripts/verify-rls-policies.ts` - Static analysis verification script (370 lines)

## Decisions Made
- Consolidated is_outreach_org_member into is_org_member — identical function body, reduces maintenance surface
- Used is_org_member for SELECT, is_org_admin for write operations — follows principle of least privilege
- Static analysis verification instead of runtime tests — no testing framework configured in project

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None

## Next Phase Readiness
- RLS policies fixed and verified — data isolation between orgs restored
- Phase 06 (Index Foundation) can proceed — RLS is no longer a prerequisite blocker

---

*Phase: 05-rls-migration-safety*
*Completed: 2026-03-31*
