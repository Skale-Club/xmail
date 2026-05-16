---
phase: 14-low-and-ci
plan: 01
subsystem: api
tags: [eslint, vite, tracking, webhooks, system-routes, zod, refactor]

# Dependency graph
requires:
  - phase: 13-medium-consolidation
    provides: tsc-clean baseline (QUA-01) so cosmetic refactors land green
provides:
  - "GET /api/system/mail-diag now accepts optional ?testEmail= (Zod-validated); no personal email hardcoded"
  - "scripts/_check-db.ts and scripts/_setup-user.ts removed (dev artifacts with hardcoded PII)"
  - "Repo root nul artifact removed"
  - "index.html no longer triggers Vite 'can't be bundled without type=module' build warning"
  - "MAX_WEBHOOK_RESPONSE_BODY = 5000 exported from tracking.ts (no more magic number at usage site)"
affects: [14-02-ci-gates, 14-03-runbook-and-error-sink]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Diagnostic endpoints take their target via query param + Zod, never hardcoded user data"
    - "Webhook truncation cap exported as named constant for testability"
    - "Classic <script src> in index.html injected via document.write to dodge Vite's module-only warning while preserving load-order semantics"

key-files:
  created: []
  modified:
    - src/server/routes/system.ts
    - src/server/lib/tracking.ts
    - index.html

key-decisions:
  - "mail-diag's diagnosticTest section is OMITTED entirely when ?testEmail= is not provided (rather than emitted with nulls) — keeps default response shape minimal and signals 'no test run'"
  - "Both scripts/_*.ts files DELETED rather than renamed — _check-db is superseded by scripts/check-full.ts, _setup-user contained hardcoded vanildo@skale.club and is replaced by scripts/set-admin.ts + Supabase Auth flow. No external callers found."
  - "CLN-03 fix uses document.write classic-script injection (not type=text/javascript and not vite-ignore — both were tried and neither silences Vite's warning, which only accepts type=module exactly). document.write during HTML parsing is synchronous so /app-config.js still loads before /src/main.tsx."
  - "MAX_WEBHOOK_RESPONSE_BODY exported (not module-private) to allow future tests to assert against the cap."

patterns-established:
  - "Diagnostic / admin-only endpoints with per-target inspection MUST take the target from query (Zod-validated), never hardcoded"
  - "Magic numbers shared between business logic and storage limits should be exported named constants"

requirements-completed: [CLN-01, CLN-02, CLN-03, CLN-04]

# Metrics
duration: 12min
completed: 2026-05-16
---

# Phase 14 Plan 01: Cosmetic Cleanup Summary

**Removed hardcoded vanildo@skale.club PII from mail-diag (now Zod query param), deleted dev-only scripts/_*.ts artifacts, silenced Vite app-config.js build warning via document.write injection, and extracted MAX_WEBHOOK_RESPONSE_BODY=5000 as named exported constant.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 4
- **Files modified:** 3 (system.ts, tracking.ts, index.html)
- **Files deleted:** 2 (scripts/_check-db.ts, scripts/_setup-user.ts — deletion landed in parallel 14-03 commit 22872be)

## Accomplishments
- `/api/system/mail-diag` now takes `?testEmail=` (Zod `z.string().email().optional()`); when omitted, `diagnosticTest` section is excluded entirely — no more `vanildo@skale.club` in source.
- Both `scripts/_check-db.ts` and `scripts/_setup-user.ts` removed (the latter contained hardcoded PII + password update flow that's now handled by Supabase Auth).
- `nul` artifact at repo root no longer present on disk or in git index.
- `vite build` emits zero warnings (was previously emitting "can't be bundled without type=module" for `/app-config.js`).
- `MAX_WEBHOOK_RESPONSE_BODY = 5000` exported from `src/server/lib/tracking.ts`; `body.substring(0, MAX_WEBHOOK_RESPONSE_BODY)` replaces the magic-number call site.

## Task Commits

1. **Task 1: CLN-01 mail-diag testEmail from query** — `c3d5aea` (feat)
2. **Task 2: CLN-02 dev-artifact removal** — `22872be` (committed by parallel 14-03 executor; both scripts deleted as side-effect of that plan; `nul` was never tracked and is absent from disk)
3. **Task 3: CLN-03 Vite warning fix** — `ff4fc5e` (initial fix, did not silence warning) + `1e8ec87` (document.write fix-up that actually silences it)
4. **Task 4: CLN-04 MAX_WEBHOOK_RESPONSE_BODY** — `b4645c7` (refactor)

## Files Created/Modified
- `src/server/routes/system.ts` — `/mail-diag` now Zod-validates `req.query.testEmail`, omits `diagnosticTest` when absent, derives `testDomain` from email host instead of hardcoded `skale.club`
- `src/server/lib/tracking.ts` — Added `export const MAX_WEBHOOK_RESPONSE_BODY = 5000`, replaced `substring(0, 5000)` with constant
- `index.html` — Replaced `<script src="/app-config.js">` with inline `document.write('<scr'+'ipt src=...')` injection to avoid Vite's literal-src scan while preserving synchronous load-before-main.tsx behavior

## Decisions Made
- See `key-decisions` in frontmatter. Notable: rather than rename `scripts/_check-db.ts` to `scripts/check-db.ts`, we deleted both `_`-prefixed files because (a) `_check-db.ts` overlaps with the existing `scripts/check-full.ts` and (b) `_setup-user.ts` contained both `vanildo@skale.club` and a deprecated password-update flow — the plan's "or delete if obsolete" branch applies cleanly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] CLN-03 first attempt did not silence the warning**
- **Found during:** Task 3 verification (`vite build 2>&1 | grep "can't be bundled"`)
- **Issue:** The plan suggested adding `type="text/javascript"` OR `vite-ignore`. Both were attempted; neither silenced Vite's warning, which only accepts `type="module"` exactly when scanning a literal `<script src>` in `index.html`.
- **Fix:** Replaced the literal `<script src="/app-config.js">` tag with an inline classic script that uses `document.write` to inject the same tag at parse time. `document.write` during HTML parsing is synchronous so load-order is preserved (config available before module scripts run, as required by `src/lib/supabase.ts` which reads `window.__APP_CONFIG__`).
- **Files modified:** `index.html`
- **Verification:** `npx vite build 2>&1 | grep "can't be bundled"` returns no output; build emits zero warnings.
- **Committed in:** `1e8ec87` (CLN-03 fix-up). Earlier `ff4fc5e` is the failed first attempt and is left in history for traceability.

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Plan-specified approaches insufficient; document.write workaround is the canonical Vite escape-hatch for this pattern. No scope creep.

## Issues Encountered

- **Parallel executor collision on CLN-02:** A parallel 14-03 executor committed the deletion of `scripts/_check-db.ts` and `scripts/_setup-user.ts` in commit `22872be` (titled "docs(14-03): add ops runbook documenting /health/ready") before this executor ran `git rm` on them. Net effect: CLN-02 is satisfied, attribution lives in commit `22872be` rather than a dedicated 14-01 commit. Documented here to keep the audit trail honest.

## Verification

| Check | Command | Result |
|-------|---------|--------|
| No personal email in src/ | `grep "vanildo@skale.club" src/` | No matches |
| No nul / `_`-prefixed scripts tracked | `git ls-files \| grep -E "^(nul$\|scripts/_)"` | Empty |
| Vite build warning silenced | `npx vite build 2>&1 \| grep "can't be bundled"` | No output |
| MAX_WEBHOOK_RESPONSE_BODY used | `grep MAX_WEBHOOK_RESPONSE_BODY src/server/lib/tracking.ts` | 2 matches (declaration + usage) |
| Lint clean | `npm run lint` | exit 0 |
| Server tsc clean | `npx tsc --noEmit -p tsconfig.server.json` | exit 0 |
| Client tsc clean | `npx tsc --noEmit -p tsconfig.json` | exit 0 |

## Next Phase Readiness

- 14-02 (CI gates) and 14-03 (runbook + error-sink decision) already complete in parallel; Phase 14 is one verification step away from done.
- No blockers.

## Self-Check: PASSED

- File `src/server/routes/system.ts` modified — FOUND (commit `c3d5aea`)
- File `src/server/lib/tracking.ts` modified — FOUND (commit `b4645c7`)
- File `index.html` modified — FOUND (commits `ff4fc5e` + `1e8ec87`)
- Scripts deleted — FOUND (commit `22872be`, parallel executor)
- Commit `c3d5aea` — FOUND in `git log`
- Commit `ff4fc5e` — FOUND in `git log`
- Commit `b4645c7` — FOUND in `git log`
- Commit `1e8ec87` — FOUND in `git log`
- Commit `22872be` — FOUND in `git log`

---
*Phase: 14-low-and-ci*
*Completed: 2026-05-16*
