---
phase: 20-outreach-product-and-api-consistency
plan: 03
subsystem: api
tags: [outreach, authorization, access-control, service-auth, machine-identity, react-guard, multi-tenant]

# Dependency graph
requires:
  - phase: 18-outreach-safety-and-execution-reliability
    provides: disposable Testcontainers postgres harness (serial, advisory-locked migration applies)
  - phase: 20-outreach-product-and-api-consistency
    plan: 01
    provides: canonical campaign sequence + resource-derived campaign routes
  - phase: 20-outreach-product-and-api-consistency
    plan: 02
    provides: outreach settings/leads/metrics routes now consuming shared helpers
provides:
  - One canonical outreach authorization module (checkOutreachAccess / requireOutreachRead / requireOutreachWrite) imported by every tenant-scoped outreach router
  - Bound machine identity — x-service-key maps to a server-configured principal + organization; caller-supplied x-user-id and org scope are overwritten/rejected
  - Extracted, testable /api auth middleware (createApiAuthMiddleware) with anti-forgery marker stripping
  - Dedicated frontend OutreachCheck guard so organization members (admin/member/viewer) reach outreach without platform-admin privileges
  - XMAIL_SERVICE_USER_ID + XMAIL_SERVICE_ORGANIZATION_ID env bindings wired into both deploy workflows and documented
affects: [outreach-campaigns, outreach-leads, outreach-email-accounts, outreach-settings, unified-inbox, xphere-orchestrator]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One canonical JS-side access module per resource family; routes import request-scoped guards (requireOutreachRead/Write) rather than owning a per-file membership copy"
    - "Service-key auth binds identity + tenant server-side: overwrite x-user-id, reject query/body org mismatch, set an internal service-principal marker so resource-derived routes enforce the bound org through the shared helper"
    - "Internal trust-marker headers are stripped from every inbound /api request before authentication, so a client can never forge them"
    - "Fail-closed machine auth: the service path activates only when the full env trio is present; a key without a bound principal/org never authenticates"
    - "Frontend access guard mirrors backend roles but is non-authoritative; navigation redirects run in effects, not during render"

key-files:
  created:
    - src/server/lib/outreach-access.ts
    - src/server/lib/service-auth.ts
    - src/server/lib/api-auth.ts
    - src/server/lib/__tests__/outreach-access.db.test.ts
    - src/server/__tests__/service-auth.db.test.ts
  modified:
    - src/server/index.ts
    - src/server/routes/outreach/campaigns.ts
    - src/server/routes/outreach/leads.ts
    - src/server/routes/outreach/email-accounts.ts
    - src/server/routes/outreach/settings.ts
    - src/server/routes/outreach/send-message.ts
    - src/main.tsx
    - src/components/outreach/OutreachLayout.tsx
    - .github/workflows/build-deploy.yml
    - .github/workflows/deploy-hetzner.yml
    - .env.example
    - CLAUDE.md

key-decisions:
  - "Routes call request-aware guards requireOutreachRead/requireOutreachWrite(req,res,org); the guards enforce the service-principal org binding, so resource-derived routes are covered without a query param"
  - "The service org binding is enforced by BOTH the middleware (query/body mismatch -> 403) AND the shared helper via an internal marker (bound org != resolved org -> 403), so a platform-admin or multi-org service user still cannot escape its bound tenant"
  - "req.query is a read-only getter in Express 5 (verified empirically), so query-org scope is enforced by reject-on-mismatch + the marker rather than by mutation; body-org is overwritten in place"
  - "Frontend OutreachCheck permits platform admins and any org member (admin/member/viewer); users with no accessible organization get a clear safe page, not a blank redirect"
  - "Machine auth fails closed unless all three of XMAIL_SERVICE_KEY / XMAIL_SERVICE_USER_ID / XMAIL_SERVICE_ORGANIZATION_ID are set; a partial config logs a loud startup warning and stays disabled"

patterns-established:
  - "Canonical outreach authorization: import { requireOutreachRead, requireOutreachWrite } from lib/outreach-access — never a local checkOrgMembership"
  - "Extract cross-cutting Express middleware into a factory (createApiAuthMiddleware) so it can be exercised end-to-end in a .db.test.ts"

requirements-completed: [CONS-02, CONS-06]

# Metrics
duration: 24min
completed: 2026-07-16
---

# Phase 20 Plan 03: Outreach Access and Service Identity Summary

**One canonical outreach authorization module gates every tenant route, a dedicated OutreachCheck guard lets organization members (not just platform admins) reach outreach, and the machine service key now binds identity + tenant server-side so a caller can never pick its own principal or organization.**

## Performance

- **Duration:** ~24 min
- **Started:** 2026-07-16T09:42:17Z
- **Completed:** 2026-07-16T10:06:24Z
- **Tasks:** 3 (TDD: RED test commit, GREEN implementation, frontend guard)
- **Files:** 17 (5 created, 12 modified)

## Accomplishments

- **One canonical access module.** `src/server/lib/outreach-access.ts` exports `checkOutreachAccess` (platform-admin bypass + org membership), `canWriteOutreach`, and the request guards `requireOutreachRead` / `requireOutreachWrite`. All five tenant-scoped outreach routers (campaigns, leads, email-accounts, settings, send-message) import it; the five divergent per-file `checkOrgMembership`/`canWriteOutreach` copies are deleted (`rg "function checkOrgMembership" src/server/routes/outreach` → zero).
- **Bound machine identity (CONS-06).** A valid `x-service-key` now authenticates the server-configured principal + organization. Caller-supplied `x-user-id` is overwritten; a query/body `organizationId` that mismatches the bound org is rejected (403); an internal service-principal marker + bound-org header let resource-derived routes enforce the scope through the shared helper. The verified key is stripped from the request so it never travels downstream, and it is never logged.
- **Organization-aware frontend access (CONS-02).** New `OutreachCheck` guard in `src/main.tsx` (separate from `AdminCheck`) admits platform admins and any org admin/member/viewer, mounts `OrganizationProvider`, waits for membership resolution, and shows a clear safe page for users with no accessible organization. `/admin/*` stays under `AdminCheck`. `OutreachLayout` shows the real org role and a read-only badge for viewers without hiding any data page.
- **Testable middleware.** The `/api` auth chain was extracted into `createApiAuthMiddleware` (`src/server/lib/api-auth.ts`), exercised end-to-end in `service-auth.db.test.ts`. `index.ts` consumes it and warns loudly on a partial service-auth config.
- **Deploy + docs wired.** `XMAIL_SERVICE_USER_ID` and `XMAIL_SERVICE_ORGANIZATION_ID` added to `run_app_container()` in the active `build-deploy.yml` and both blocks of the legacy `deploy-hetzner.yml`, documented in `.env.example` and `CLAUDE.md`.

## Role Matrix

| Actor | Read (GET /campaigns, GET /leads, GET /campaigns/:id) | Write (POST /leads, PATCH /settings, POST /campaigns) |
| --- | --- | --- |
| Platform admin (no org membership) | ✅ (membership bypass) | ✅ |
| Organization admin | ✅ | ✅ |
| Organization member | ✅ | ✅ |
| Organization viewer | ✅ | ❌ 403 (write access denied) |
| Non-member (authenticated) | ❌ 403 | ❌ 403 |
| Cross-tenant member (member of another org) | ❌ 403 | ❌ 403 |

Resource-derived routes (e.g. `GET /campaigns/:id`) resolve the organization from the resource first, then apply the same matrix through `requireOutreachRead/Write`.

## Service-Principal Binding — how forged identity/scope is rejected

`x-service-key` proves the caller is the single configured orchestrator; it does **not** let the caller say who it is or which tenant it acts on.

1. **Fail closed.** `resolveServiceAuthConfig` returns a config only when `XMAIL_SERVICE_KEY` **and** `XMAIL_SERVICE_USER_ID` **and** `XMAIL_SERVICE_ORGANIZATION_ID` are all set. A key alone (or nothing) → the service path does not exist → the request falls through to JWT and 401s. A partial config logs a startup warning.
2. **Timing-safe key check.** Wrong key → 401. The key is never echoed in a response or a log line, and it is deleted from `req.headers` after verification.
3. **Identity is overwritten, not trusted.** `applyServicePrincipal` sets `x-user-id` to the bound `XMAIL_SERVICE_USER_ID` and deletes the derived identity headers. A forged `x-user-id` sent by the caller is discarded — proven by a test where the forged id is a non-member: the request still succeeds as the bound (member) principal.
4. **Tenant is bound, not chosen.** A `organizationId` in the query or body that differs from `XMAIL_SERVICE_ORGANIZATION_ID` → 403 at the middleware. Because Express 5 `req.query` is a read-only getter (verified empirically), query scope is enforced by reject-on-mismatch plus an internal `x-service-organization-id` marker that the shared helper checks on **every** outreach access; body scope is additionally overwritten in place.
5. **Resource-derived scope.** Routes that derive the org from a path resource (`/campaigns/:id`) carry no query org, so the middleware cannot see a mismatch — but `requireOutreachRead/Write` compares the resolved org against the bound-org marker and 403s a foreign resource, even for a platform-admin or multi-org service account.
6. **Anti-forgery.** The internal marker headers (`x-service-principal`, `x-service-organization-id`) are stripped from every inbound `/api` request before authentication, so a normal client cannot set them.

## Environment Variables Added (where wired)

| Variable | Purpose |
| --- | --- |
| `XMAIL_SERVICE_USER_ID` | UUID of the server-configured principal the service key acts as |
| `XMAIL_SERVICE_ORGANIZATION_ID` | UUID of the single organization the service key is bound to |

Wired into:
- `.github/workflows/build-deploy.yml` — `run_app_container()` env block (the ACTIVE deploy path), next to `XMAIL_SERVICE_KEY`.
- `.github/workflows/deploy-hetzner.yml` — both `-e` env blocks (LEGACY, kept in sync).
- `.env.example` — documented under the Xphere Orchestrator section.
- `CLAUDE.md` — Optional env-var list.

**Operator note:** set all three secrets together in GitHub. `XMAIL_SERVICE_USER_ID` should be a dedicated org-member service account (not a platform admin, though the marker binding blocks cross-tenant access even if it were).

## Migrated Route Inventory

| Router | checkOrgMembership copies before | After |
| --- | --- | --- |
| `campaigns.ts` | 1 def + 21 call sites | canonical `requireOutreachRead/Write` |
| `leads.ts` | 1 def + 10 call sites | canonical |
| `email-accounts.ts` | 1 def + 7 call sites | canonical |
| `settings.ts` | 1 def + 2 call sites | canonical |
| `send-message.ts` | 1 def + 1 call site | canonical |

40 call sites migrated (24 write, 16 read); 5 local helper definitions removed. `unsubscribe.ts` is a public HMAC-token endpoint and correctly has no membership check.

## Security-Test Evidence

Two `.db.test.ts` suites run against the disposable Testcontainers postgres:

- `src/server/lib/__tests__/outreach-access.db.test.ts` (8 tests): role matrix over `GET /campaigns`, `POST /leads`, and resource-derived `GET /campaigns/:id`; viewer read-vs-write; non-member and cross-tenant denial; a static route-inventory assertion that no outreach router owns a divergent helper and every router imports `lib/outreach-access`.
- `src/server/__tests__/service-auth.db.test.ts` (8 tests): fails closed when unconfigured/partial; 401 on wrong key without echoing the secret; forged `x-user-id` ignored in favor of the bound principal; query/body/resource organization mismatches all 403.

## Task Commits

1. **Task 1: Failing role-matrix + service-principal tests (RED)** — `ae7a921` (test)
2. **Task 2: Centralize outreach access + bind service identity (GREEN)** — `32c7b64` (feat), `7f486ff` (fix: drop now-unused settings import)
3. **Task 3: Organization-aware frontend guard** — `025e53d` (feat)
4. **Env/deploy wiring** — `278a70d` (chore)

**Plan metadata:** _(this commit)_ (docs: complete plan)

## Decisions Made

See `key-decisions` frontmatter. Notable: the org binding is enforced twice (middleware reject + shared-helper marker) so it holds even for an admin/multi-org service user; `req.query` immutability in Express 5 shaped the reject-plus-marker approach over mutation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extracted the /api auth middleware into a testable factory**
- **Found during:** Task 1/2 (the service-auth suite needs to exercise the real middleware)
- **Issue:** The service-key logic lived inline in `index.ts`, which starts the HTTP + mail servers on import and cannot be mounted in a test app.
- **Fix:** Extracted the chain into `createApiAuthMiddleware` (`src/server/lib/api-auth.ts`); `index.ts` consumes it. The test mounts the factory + real outreach router.
- **Files modified:** `src/server/index.ts`, `src/server/lib/api-auth.ts`
- **Committed in:** `32c7b64`

**2. [Rule 1 - Bug] Removed now-unused drizzle-orm import in settings.ts**
- **Found during:** Task 3 gates (lint)
- **Issue:** `eq`/`and` were only used by the removed local `checkOrgMembership`; leaving them tripped `@typescript-eslint/no-unused-vars` under `--max-warnings 0`.
- **Fix:** Dropped the `import { eq, and } from 'drizzle-orm'` line.
- **Files modified:** `src/server/routes/outreach/settings.ts`
- **Committed in:** `7f486ff`

**3. [Rule 3 - Blocking] Dynamic import of app modules in the service-auth test**
- **Found during:** Task 2 (first service-auth run)
- **Issue:** Statically importing `api-auth` pulls in the Supabase client at module load, which throws `supabaseUrl is required` before the test could set env.
- **Fix:** Import `createApiAuthMiddleware`/`resolveServiceAuthConfig` dynamically in `beforeAll` after setting dummy Supabase env (matching the existing harness pattern).
- **Files modified:** `src/server/__tests__/service-auth.db.test.ts`
- **Committed in:** `32c7b64`

---

**Total deviations:** 3 (2 blocking, 1 bug) — all in test/build mechanics; none changed the delivered authorization contract.
**Impact on plan:** No scope creep. The extraction of `api-auth.ts` is a net improvement (testability) required by the plan's own test boundary.

## Issues Encountered

- The route files are CRLF and `send-message.ts` is LF; the canonical migration was applied with line-ending-aware codemods (verified by `tsc`, lint, and the full suite) rather than by hand across 40 call sites.
- Running the outreach route suites in isolation logs `relation "outreach_settings" does not exist` — a pre-existing artifact of the shared serial disposable DB (the table is provisioned by another suite in the full run, a 20-02 dependency), not a regression from this plan. The full `npm run test` is green.

## Gate Results

- `npm run test` — **415 passed** (33 files); +16 over the 399 baseline (8 outreach-access + 8 service-auth).
- `npm run build` — client + server build succeed.
- `npm run lint` — 0 warnings (`--max-warnings 0`).
- `npx tsc --noEmit -p tsconfig.json` (client) — clean.
- `npx tsc --noEmit -p tsconfig.server.json` (server) — clean.
- `rg "function checkOrgMembership" src/server/routes/outreach` — zero matches.
- `/admin/*` still uses `AdminCheck`; `/outreach/*` uses `OutreachCheck`.

## Known Stubs

None introduced. The `SettingsPage.tsx` "API Access" card (hardcoded `sk_test_****`) remains out of scope by CONTEXT §Out of scope ("do not create a general API-key product") — untouched, carried from 20-02.

## User Setup Required

**Production:** set three GitHub secrets together — `XMAIL_SERVICE_KEY`, `XMAIL_SERVICE_USER_ID`, `XMAIL_SERVICE_ORGANIZATION_ID`. With only the key set, machine auth stays disabled (fails closed) and a startup warning is logged. No database migration in this plan.

## Next Phase Readiness

- Canonical outreach authorization and the bound service principal are the access foundation for the Unified Inbox work (Phase 21+). Migration 040 remains the highest; next free integer is 041.
- CONS-02 and CONS-06 complete this closes Phase 20 (CONS-01..07 all delivered across plans 20-01/20-02/20-03).

## Self-Check: PASSED

---
*Phase: 20-outreach-product-and-api-consistency*
*Completed: 2026-07-16*
