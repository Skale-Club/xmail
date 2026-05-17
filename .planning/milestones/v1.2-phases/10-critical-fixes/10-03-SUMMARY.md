---
phase: 10-critical-fixes
plan: 03
subsystem: server/auth + docs
tags: [authorization, rls, defense-in-depth, docs, critical]
status: complete
completed: 2026-05-16
requirements:
  - CRIT-04
dependency_graph:
  requires: []
  provides:
    - "src/server/lib/access.ts as canonical import surface for checkXAccess helpers"
    - "Honest CLAUDE.md Authentication Flow + Multi-Tenancy + Database sections"
  affects:
    - src/server/lib/access.ts
    - src/server/routes/{domains,messages,credentials,webhooks,outlook,templates,routes}.ts
    - src/server/routes/mail/mailboxes.ts
    - CLAUDE.md
tech_stack:
  added: []
  patterns:
    - "Re-export pattern: src/server/lib/access.ts re-exports helpers from their original locations (no mass call-site rename in this phase)."
    - "Convention: every API route MUST call a checkXAccess helper before tenant-scoped reads/writes (documented in CLAUDE.md)."
key_files:
  created:
    - src/server/lib/access.ts
  modified:
    - src/server/routes/domains.ts
    - src/server/routes/messages.ts
    - src/server/routes/credentials.ts
    - src/server/routes/webhooks.ts
    - src/server/routes/outlook.ts
    - src/server/routes/templates.ts
    - src/server/routes/routes.ts
    - CLAUDE.md
decisions:
  - "Re-export only (no implementation move) — preserves all existing call sites; Phase 11+ can normalize signatures and migrate imports."
  - "Promoted 7 previously-local helpers from `async function` to `export async function`. Non-breaking: local callers still see the same identifier."
  - "Added defense-in-depth clarifier to CLAUDE.md Database section (line 116) so the 'All tables have RLS enabled' line cannot be misread as the sole tenant-isolation mechanism."
metrics:
  duration: "~8 min"
  tasks: 2
  files_modified: 9
  commits: 2
---

# Phase 10 Plan 03: Consolidate checkAccess + honest auth docs — Summary

**Single-import-surface `src/server/lib/access.ts` re-exports all 9 access helpers; CLAUDE.md now states plainly that the `DATABASE_URL` role bypasses RLS, that JS-side helpers are the source of truth, and that every API route MUST call a `checkXAccess` helper.**

## Performance

- **Duration:** ~8 min
- **Tasks:** 2
- **Files modified:** 9 (1 created, 8 modified)
- **Commits:** 2 task commits

## Discovery: existing checkAccess helpers

Grep across `src/server` (patterns: `(async function|function|const) check[A-Z][a-zA-Z]*Access`) found **8 helpers**:

| Helper                    | Source                                          | Scope          | Originally exported? |
| ------------------------- | ----------------------------------------------- | -------------- | -------------------- |
| `checkDomainAccess`       | `src/server/routes/domains.ts:48`               | org-scoped     | no (local)           |
| `checkMessageAccess`      | `src/server/routes/messages.ts:52`              | org-scoped     | no (local)           |
| `checkCredentialAccess`   | `src/server/routes/credentials.ts:26`           | org-scoped     | no (local)           |
| `checkWebhookAccess`      | `src/server/routes/webhooks.ts:39`              | org-scoped     | no (local)           |
| `checkOutlookAccess`      | `src/server/routes/outlook.ts:31`               | org-scoped     | no (local)           |
| `checkOrganizationAccess` | `src/server/routes/templates.ts:40`             | org-scoped     | no (local)           |
| `checkRouteAccess`        | `src/server/routes/routes.ts:31`                | org-scoped     | no (local)           |
| `checkUserMailboxAccess`  | `src/server/routes/mail/mailboxes.ts:11`        | user-scoped    | **yes**              |

Plus one admin-only helper from `src/server/lib/admin.ts`:

| Helper            | Source                              | Scope             |
| ----------------- | ----------------------------------- | ----------------- |
| `isPlatformAdmin` | `src/server/lib/admin.ts:5`         | platform admin    |

All 7 org-scoped helpers share an identical signature `(userId, organizationId) => Promise<{ organization, membership }>`, where `membership === null` means access denied. Phase 11+ can normalize this into a single helper.

## Re-exports in src/server/lib/access.ts (final)

```ts
// Org-scoped
export { checkDomainAccess }       from '../routes/domains'
export { checkMessageAccess }      from '../routes/messages'
export { checkCredentialAccess }   from '../routes/credentials'
export { checkWebhookAccess }      from '../routes/webhooks'
export { checkOutlookAccess }      from '../routes/outlook'
export { checkOrganizationAccess } from '../routes/templates'
export { checkRouteAccess }        from '../routes/routes'
// User-scoped
export { checkUserMailboxAccess }  from '../routes/mail/mailboxes'
// Admin
export { isPlatformAdmin }         from './admin'
```

To make this work, the 7 previously-local helpers were promoted from `async function ...` to `export async function ...`. This is a strict superset change — no existing call sites break, no signatures change, no imports change.

## CLAUDE.md edits (line numbers in HEAD = `7d8fb16`)

### Edit 1 — `### Authentication Flow` bullet 4

**Before (line 67):**

```
4. RLS policies enforce organization-level data isolation at the database layer
```

**After (lines 67–76):**

```
4. **Authorization is JS-side, not DB-side.** The app's DB connection uses
   the `DATABASE_URL` Postgres role, which bypasses Row-Level Security
   (no `auth.uid()` is set per request). RLS policies in
   `supabase/migrations/` remain as defense-in-depth, but the real
   authorization check lives in `src/server/lib/access.ts`. **Every API
   route MUST call a `checkXAccess` helper before reading or writing
   tenant-scoped data — there is no DB safety net.** Background jobs
   and scripts that use the same connection also bypass RLS and must
   enforce their own scoping in code.
```

### Edit 2 — `### Multi-Tenancy Model` last bullet

**Before (line 73):**

```
- RLS policies enforce org-scoped data access
```

**After (lines 81–83):**

```
- **Authorization model:** JS-side helpers in `src/server/lib/access.ts`
  enforce org-scoped data access. RLS policies are defense-in-depth and
  do NOT alone protect tenants (the app role bypasses RLS).
```

### Edit 3 — `## Database` section (covered by plan Task 2 step 4 grep sweep)

**Before (line 106):**

```
All tables have RLS enabled (policies in `supabase/migrations/001_enable_rls.sql`).
```

**After (line 116):**

```
All tables have RLS enabled (policies in `supabase/migrations/001_enable_rls.sql`).
RLS is **defense-in-depth only** — the app's `DATABASE_URL` Postgres role
bypasses RLS, so tenant isolation is enforced in JS via
`src/server/lib/access.ts`. See `### Authentication Flow` above.
```

This was the only other line in CLAUDE.md that risked being misread as "RLS alone enforces tenants." No other RLS-misleading phrases remained (verified by `grep -nE "RLS .*(enforce|protect|isolat)" CLAUDE.md` returning only the new defense-in-depth wording).

## Task Commits

1. **Task 1 — Consolidate checkAccess helpers in src/server/lib/access.ts** — `e3c4ca5` (feat)
2. **Task 2 — Rewrite CLAUDE.md auth flow** — `7d8fb16` (docs)

## Verification

Plan-spec checks, all pass:

| Check                                                          | Expected | Actual |
| -------------------------------------------------------------- | -------- | ------ |
| `npx tsc --noEmit -p tsconfig.server.json` matches `access.ts` | 0        | 0      |
| `grep -nE "^export \{" src/server/lib/access.ts`               | ≥1       | 9      |
| `grep -nE "defense-in-depth" CLAUDE.md`                        | ≥1       | 3      |
| `grep -nE "access\.ts" CLAUDE.md`                              | ≥1       | 3      |
| `grep -nE "RLS policies enforce.*at the database layer" CLAUDE.md` | 0    | 0      |

Full server tsc: exit code 0 (zero errors). No existing import paths broken — re-export is purely additive.

## Decisions Made

1. **Re-export only, no implementation move.** Moving the 7 helper bodies into `access.ts` would require updating every call site in 7 route files (40+ call sites). Plan and 10-CONTEXT.md explicitly defer that to Phase 11+. Re-exports give the new canonical path without touching callers.
2. **Promote local helpers to `export`.** The 7 org-scoped helpers were declared `async function` (file-local). Adding the `export` keyword is non-breaking — local references in the same file continue to resolve to the same identifier. This was necessary because TypeScript cannot re-export a non-exported binding.
3. **Add CLAUDE.md Database-section clarifier.** Plan Task 2 step 4 mandated grepping for any remaining RLS-misleading phrases. The "All tables have RLS enabled" line at line 116 was technically accurate but easy to misread. Appended a defense-in-depth note + cross-reference instead of rewriting.

## Deviations from Plan

**None.** Plan executed exactly as written. The plan's step-2 fallback ("if no helpers exist, build a stub") did not trigger — the audit's assumption was correct, helpers were present, and consolidation proceeded normally.

The plan suggested re-exporting names like `checkOrgAccess` and `checkOrgAdminAccess` in the JSDoc example. Reality: the existing helpers use resource-specific names (`checkDomainAccess`, `checkMessageAccess`, etc.) plus the misleading-but-existing `checkOrganizationAccess` (which is actually org-scoped on the templates router). I documented the actual names rather than inventing `checkOrgAccess`/`checkOrgAdminAccess` — consistent with the plan's instruction "do NOT invent helper names that don't exist."

## Issues Encountered

None.

## Next Phase Readiness

- **CRIT-04 closed.** The auth model is now documented honestly and there is a single discoverable entry point for new route authors.
- **Phase 11 SEC follow-ups remain:**
  - Migrate existing call sites from `import { checkDomainAccess } from '../routes/domains'` patterns to `import { checkDomainAccess } from '../lib/access'`. Mechanical, low-risk; can be a single codemod commit.
  - Normalize the 7 org-scoped helpers into a single `checkOrgAccess(userId, orgId)` + `checkOrgAdminAccess(userId, orgId)` once call sites are migrated. The signatures are already identical; only the names differ.
  - Audit every route for missing `checkXAccess` calls (deferred per 10-CONTEXT.md).
  - Add a lint rule or boundary check that fails CI if a new `/api/*` route handler is added without an `access.ts` import (longer-term hardening).

## Self-Check: PASSED

- `src/server/lib/access.ts` — exists (created in commit `e3c4ca5`).
- `CLAUDE.md` — modified, contains 3 occurrences each of `defense-in-depth` and `access.ts`, 0 of `RLS policies enforce ... at the database layer`.
- Commit `e3c4ca5` (Task 1) — verified in `git log`.
- Commit `7d8fb16` (Task 2) — verified in `git log`.
- `npx tsc --noEmit -p tsconfig.server.json` — exits 0.

---
*Phase: 10-critical-fixes*
*Plan: 10-03*
*Completed: 2026-05-16*
