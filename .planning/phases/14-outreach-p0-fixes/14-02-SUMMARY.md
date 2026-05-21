---
phase: 14-outreach-p0-fixes
plan: 02
subsystem: ui
tags: [react, wouter, react-query, outreach, campaigns]

# Dependency graph
requires:
  - phase: 14-outreach-p0-fixes
    provides: "(Wave 1 parallel) 14-01 lifts the isPlatformAdmin gate so the POST /api/outreach/campaigns request this form submits actually succeeds for org users"
provides:
  - "Working /outreach/campaigns/new page (no more black screen)"
  - "End-to-end campaign creation flow from CampaignsPage → form → list refresh"
affects: ["future plans adding /outreach/campaigns/:id detail page", "phase 15 outreach hardening if from_email_account_id becomes a campaign-level field"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Outreach 'new resource' page pattern: lazy import in main.tsx, Route registered BEFORE the more general /outreach/{resource} route, AdminCheck > OrganizationProvider > PageSuspense wrapping, OutreachLayout wrapper inside the page itself"

key-files:
  created:
    - "src/pages/outreach/campaigns/NewCampaignPage.tsx"
  modified:
    - "src/main.tsx (added lazy import + Route before /outreach/campaigns)"

key-decisions:
  - "Use plain React useState (not react-hook-form + Zod) for the 3-field form — matches the NewSequencePage sibling precedent and avoids over-engineering a minimal-viable form (CONTEXT.md said RHF+Zod is preferred but not required; precedent won out)"
  - "Collect from_email_account_id in the UI but do NOT send it to POST /api/outreach/campaigns — the backend createCampaignSchema does not accept it and assignment is per-campaign-lead, not per-campaign. UI captures it for a future schema migration"
  - "Success redirect goes to /outreach/campaigns (list) instead of /outreach/campaigns/{id} (detail) because the detail page does not exist yet (verified against src/main.tsx) — CONTEXT.md's stated fallback"
  - "Route /outreach/campaigns/new placed BEFORE /outreach/campaigns/:id/sequences/new in main.tsx, which is in turn before /outreach/campaigns — satisfies the wouter-matches-in-declaration-order constraint with margin"

patterns-established:
  - "When adding a new sibling page under /outreach/{resource}/, register the more specific route ABOVE the list route in src/main.tsx (wouter Switch matches in source order)"
  - "Captured-but-not-sent form fields should carry an inline comment explaining the backend gap and the future-work flag (here: from_email_account_id)"

requirements-completed: [P0-11]

# Metrics
duration: ~5 min
completed: 2026-05-17
---

# Phase 14 Plan 02: NewCampaignPage Summary

**Created the missing `NewCampaignPage` (minimal-viable form: name + description + sending-inbox select) and registered `/outreach/campaigns/new` ABOVE `/outreach/campaigns` in `src/main.tsx`, killing the "tela preta" the user hit when clicking the "New Campaign" button.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-17T04:12:52Z
- **Completed:** 2026-05-17T04:17:50Z
- **Tasks:** 2
- **Files modified:** 2 (1 created, 1 edited)

## Accomplishments

- Created `src/pages/outreach/campaigns/NewCampaignPage.tsx` — a 163-line form page wrapped in `OutreachLayout`, using `apiFetch` for the JWT-authenticated POST, with React Query for both the email-accounts dropdown query and the create mutation.
- Registered the route in `src/main.tsx` declared BEFORE the existing `/outreach/campaigns` list route so wouter's source-order matching can find it.
- Confirmed the client TypeScript pass (`tsc -p tsconfig.json --noEmit`) reports zero errors in any file I touched.

## Task Commits

1. **Task 1: Create NewCampaignPage component** — `8efed7d` (feat)
2. **Task 2: Register /outreach/campaigns/new route in src/main.tsx** — `ee94ecd` (feat)

**Plan metadata:** _(committed last, see git log after this summary lands)_

## Files Created/Modified

- `src/pages/outreach/campaigns/NewCampaignPage.tsx` (NEW, 163 lines) — Campaign creation form. Uses `useOrganization` for the active org, `useQuery` to load verified email accounts for the inbox Select, `useMutation` to POST to `/api/outreach/campaigns?organizationId=...`, and `useLocation` to redirect to `/outreach/campaigns` on success.
- `src/main.tsx` — Two minimal edits:
  - Line 81: added `const NewCampaignPage = React.lazy(() => import('./pages/outreach/campaigns/NewCampaignPage'))`
  - Lines 443-449: added `<Route path="/outreach/campaigns/new">` block ABOVE the existing `/outreach/campaigns/:id/sequences/new` and `/outreach/campaigns` Routes. Confirmed order: new=443 < sequences/new=450 < list=457.

## Decisions Made

See `key-decisions` in frontmatter — four decisions, the most important being the **route ordering** (must be before the list route, otherwise the list would swallow `/outreach/campaigns/new` since wouter matches in declaration order, just like Express).

## Deviations from Plan

None — plan executed exactly as written. The plan's pre-baked source code was used verbatim modulo the literal `<` character which I preserved (it's in a JSX-string `<` placeholder for the email format `Display Name <email@example.com>`).

## Issues Encountered

**Mid-flight server-side type error in `src/server/lib/outreach-sender.ts:197`** — `npm run build` succeeded for the client (PWA generated, all 53 chunks emitted, my route is in there) but the server-side `tsc -p tsconfig.server.json` failed with `Property 'trackingToken' is missing` on an insert into `outreachEmails`.

This error is **out of scope** for plan 14-02 per the SCOPE BOUNDARY in deviation rules:
- It is in a file I did not touch (`src/server/lib/outreach-sender.ts`).
- It was caused by parallel agent 14-03 having just landed commit `528d6f5` "feat(14-03): mirror migration 020 in Drizzle schema" which made `outreachEmails.trackingToken` `NOT NULL`. The matching `outreach-sender.ts` update to actually populate that column is part of 14-03's remaining work in this same wave.
- 14-03 will resolve it on their own commit.

Verified my own work is clean by running `npx tsc -p tsconfig.json --noEmit` (client-only) — zero errors related to `NewCampaignPage`, `main.tsx`, or `pages/outreach/campaigns/*`. Client production bundle built successfully.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The `/outreach/campaigns/new` URL now resolves to the form page (UAT-verifiable after deploy).
- Form submission **fully works** once both Wave 1 commits land: 14-01 (middleware unblock, ALREADY MERGED at `f693039` / `6865152`) and 14-03 (schema + sender, in flight). 14-01 is the critical dependency for non-platform-admin org users; that's already done as of this writing, so the form is end-to-end functional for them.
- No blockers introduced for downstream Wave 2 plans.

## Self-Check: PASSED

- `src/pages/outreach/campaigns/NewCampaignPage.tsx` — FOUND on disk
- `.planning/phases/14-outreach-p0-fixes/14-02-SUMMARY.md` — FOUND on disk
- Commit `8efed7d` (Task 1) — FOUND in `git log --all`
- Commit `ee94ecd` (Task 2) — FOUND in `git log --all`
- Client TypeScript pass (`tsc -p tsconfig.json --noEmit`) — zero errors in touched files
- Route ordering `awk` check — new (line 443) < list (line 457) ✓

---
*Phase: 14-outreach-p0-fixes*
*Completed: 2026-05-17*
