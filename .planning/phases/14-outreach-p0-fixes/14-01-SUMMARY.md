---
phase: 14-outreach-p0-fixes
plan: 01
subsystem: api
tags: [outreach, auth, middleware, express, supabase-jwt, multi-tenant]

# Dependency graph
requires:
  - phase: pre-14
    provides: "Existing checkOrgMembership helpers in outreach sub-routers (campaigns.ts, leads.ts, email-accounts.ts) that short-circuit for platform admins and otherwise consult organization_users."
  - phase: pre-14
    provides: "Express auth-injection middleware at src/server/index.ts:165-194 that validates the Supabase JWT and sets req.headers['x-user-id']."
provides:
  - "Auth-only root middleware for /api/outreach/* — any logged-in user passes the root gate."
  - "Re-enabled the dormant per-org authorization layer (checkOrgMembership) for org admins/members, which the previous isPlatformAdmin gate had short-circuited into dead code."
  - "Unblocks all downstream Phase 14 plans (14-02 UI flow, 14-03 schema/sender, and Wave 2 plans) from being end-to-end testable by a real org user."
affects: [14-02-new-campaign-page, 14-03-outreach-sender-and-schema, 14-04+, all future outreach work]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-layer outreach auth: (1) thin root middleware asserts authentication only; (2) per-handler checkOrgMembership asserts organization membership."

key-files:
  created: []
  modified:
    - "src/server/routes/outreach/index.ts — removed isPlatformAdmin import + gate, replaced with minimal x-user-id presence check."

key-decisions:
  - "Auth-only middleware at outreach root: defer all org-scoped authorization to existing sub-router checkOrgMembership calls (per .planning/debug/outreach-system-deep-audit.md P0-04 'Fix sugerido')."
  - "Defer removal of the now-redundant 'if (admin) return { role: admin }' short-circuit inside checkOrgMembership to phase 15 cleanup (per 14-CONTEXT.md deferred ideas)."

patterns-established:
  - "Outreach router uses auth-only root middleware and per-route org-membership checks — replaces the prior 'platform-admin-everywhere' pattern that conflicts with the multi-tenant model."

requirements-completed: [P0-04]

# Metrics
duration: 5min
completed: 2026-05-17
---

# Phase 14 Plan 01: Outreach root middleware unblock Summary

**Replaced the `isPlatformAdmin` gate at the outreach router root with an auth-only middleware so org admins/members can reach the existing `checkOrgMembership` checks in each sub-router.**

## Performance

- **Duration:** ~5 min
- **Completed:** 2026-05-17
- **Tasks:** 1 of 1
- **Files modified:** 1

## Accomplishments
- Org admins (and members) calling `GET /api/outreach/campaigns?organizationId=…` will now reach the sub-router instead of receiving a blanket 401/403 at the outreach root. Per-org authorization is enforced by the pre-existing `checkOrgMembership` calls (untouched).
- Unauthenticated callers still receive 401 (the root middleware retains the `x-user-id` presence check).
- Removed the now-unused `isPlatformAdmin` import from `src/server/routes/outreach/index.ts`. Sub-routers (`campaigns.ts`, `leads.ts`, `email-accounts.ts`) keep their own `isPlatformAdmin` usage inside `checkOrgMembership`'s admin short-circuit.

## Task Commits

1. **Task 1: Replace isPlatformAdmin gate with auth-only middleware in outreach/index.ts** — `f693039` (fix)

(The orchestrator will produce the plan-metadata commit after the wave completes.)

## Files Created/Modified
- `src/server/routes/outreach/index.ts` — Replaced the try/catch admin middleware (lines 9-26 before, 4 lines after) with a minimal `userId` presence check, and removed `import { isPlatformAdmin } from '../../lib/admin'`. Net diff: +4 / -16.

## Why `isPlatformAdmin` was the wrong gate

The outreach feature is org-scoped, not platform-scoped: every outreach resource (campaign, lead, email account) belongs to an organization. Requiring platform-admin status at the router root meant:

1. Every real customer (an org admin/member who is not a platform admin) received `403` on every `/api/outreach/*` call — the product was inaccessible.
2. The downstream `checkOrgMembership` calls in `campaigns.ts:64-75`, `leads.ts:56`, and `email-accounts.ts:56` were dead code for non-admins, and their `if (admin) return { role: 'admin' as const }` short-circuit was tautological (only platform admins could ever reach those lines).

The correct boundary is: authentication at the root, authorization (per-organization) at the handler. That is now the case.

## Confirmation: `checkOrgMembership` is the effective auth boundary

After this change:
- `src/server/routes/outreach/campaigns.ts` — 20 references to `checkOrgMembership` remain (verified via grep), all unchanged.
- The pattern in each handler is unchanged: extract `userId` and `organizationId`, call `await checkOrgMembership(userId, organizationId)`, return 403 if no membership returned.
- Platform admins still pass via the `if (admin) return { role: 'admin' as const }` short-circuit; org admins/members pass via `organizationUsers` lookup; unrelated users receive 403.

## Decisions Made
- Followed the audit's `Fix sugerido` verbatim — no improvisation on auth design in a Wave 1 P0 fix.
- Deferred removal of the redundant `if (admin) …` short-circuit inside each sub-router's `checkOrgMembership` to phase 15 cleanup (per 14-CONTEXT.md "Deferred Ideas" — keeping the diff in this plan minimal and focused).

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Acceptance Criteria Verification

| Check | Expected | Actual |
|---|---|---|
| `grep "isPlatformAdmin" src/server/routes/outreach/index.ts` | 0 lines | 0 (no matches) |
| `grep "x-user-id" src/server/routes/outreach/index.ts` | 1 line | 1 (line 9) |
| `grep -c "next()" src/server/routes/outreach/index.ts` | 1 | 1 |
| `grep -c "checkOrgMembership" src/server/routes/outreach/campaigns.ts` | multiple | 20 (sub-router untouched) |
| `npm run build` | exit 0 | exit 0 (vite + tsc both succeeded) |

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- 14-02 (NewCampaignPage) and 14-03 (schema + outreach-sender) can proceed: a real org user can now reach the API, enabling end-to-end UAT once those plans land.
- Subsequent waves (P0-01, P0-09, P0-02, P0-03, P0-07, P0-05/06, P0-08, P0-10 — see 14-CONTEXT.md "Implementation order") are unblocked from a testability standpoint.

## Self-Check: PASSED

- `src/server/routes/outreach/index.ts` — FOUND (modified content present, 25 lines, no `isPlatformAdmin`)
- Commit `f693039` — FOUND (`git log --oneline` confirms `fix(14-01): replace isPlatformAdmin gate ...`)

---
*Phase: 14-outreach-p0-fixes*
*Plan: 01*
*Completed: 2026-05-17*
