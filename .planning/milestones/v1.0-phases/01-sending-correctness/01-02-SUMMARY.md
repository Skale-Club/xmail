---
phase: 01-sending-correctness
plan: 02
subsystem: api
tags: [outreach, email, smtp, outlook, ab-testing, deduplication]

# Dependency graph
requires:
  - phase: 01-sending-correctness/01-01
    provides: idempotency guard and resetDailyLimits in processOutreachSequences.ts
provides:
  - processOutreachSequences.ts routes all sends through sendOutreachEmail (Outlook-aware)
  - recordOutreachEmail called after every successful send — every send is logged
  - Deterministic A/B variant selection using md5(leadId + stepId)
  - Duplicate local functions (isWithinSendWindow, canSendFromAccount, sendEmail) removed
affects: [phase 3 ui wiring, outreach analytics, reply/bounce matching]

# Tech tracking
tech-stack:
  added: [Node.js crypto (createHash)]
  patterns: [shared module consolidation, deterministic hash for idempotent variant selection]

key-files:
  created: []
  modified:
    - src/server/jobs/processOutreachSequences.ts

key-decisions:
  - "Local calculateNextScheduledAt (5-param, enforces send windows) is kept — the shared module's 1-param version ignores windows"
  - "selectAbVariant uses md5(leadId + stepId) — same inputs always produce same variant without stored state (SEND-04)"
  - "sendOutreachEmail + recordOutreachEmail are called as a strict pair — sendOutreachEmail does not insert the outreachEmails row"

patterns-established:
  - "Shared sender module pattern: all SMTP/Outlook routing lives in outreach-sender.ts, job only orchestrates"
  - "Deterministic hash pattern for retry-safe variant assignment: md5(entityId + configId)"

requirements-completed: [SEND-02, SEND-03, SEND-04, SEND-06]

# Metrics
duration: 12min
completed: 2026-03-30
---

# Phase 1 Plan 02: Consolidate processOutreachSequences to shared outreach-sender module

**Removed three duplicate local functions and rewired all sends through sendOutreachEmail + recordOutreachEmail, fixing silent Outlook drops, missing email records, and non-deterministic A/B variants.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-03-30T00:00:00Z
- **Completed:** 2026-03-30T00:12:00Z
- **Tasks:** 2 (executed as single atomic rewrite)
- **Files modified:** 1

## Accomplishments

- Eliminated local `sendEmail` (SMTP-only) — Outlook accounts no longer silently skipped; all sends routed through `sendOutreachEmail` which branches on `account.provider === 'outlook'` (SEND-02)
- Guaranteed every successful send produces an `outreachEmails` row — `recordOutreachEmail` called immediately after `sendResult.success` check (SEND-03)
- Replaced `Math.random()`-style A/B with `md5(leadId + stepId)` hash — same lead+step always resolves to the same variant on any retry without stored state (SEND-04)
- Removed three dead local functions (`isWithinSendWindow`, `canSendFromAccount`, `sendEmail`) and four dead imports (nodemailer, decryptSecret, interpolateTemplate, injectTracking) (SEND-06)
- Replaced raw SQL `emailAccounts` and `campaigns` stat increments with `incrementAccountStats` / `incrementCampaignStats` from the shared module
- Preserved local `calculateNextScheduledAt` (5-parameter, enforces campaign send windows) — the shared module's 1-parameter version would have broken send-window enforcement

## Task Commits

Both tasks executed as a single atomic rewrite:

1. **Task 1 + Task 2: Remove duplicates, rewire imports, wire sendOutreachEmail + A/B** - `9950f13` (feat)

## Files Created/Modified

- `src/server/jobs/processOutreachSequences.ts` — removed 117 lines (duplicate functions + dead code), added 50 lines (new imports, selectAbVariant helper, sendOutreachEmail/recordOutreachEmail call pair, incrementAccountStats/incrementCampaignStats)

## Deviations from Plan

**1. [Rule 2 - Missing context] SEND-05 idempotency guard preserved**
- **Found during:** Reading file before rewrite
- **Issue:** Plan 01 had already added a SEND-05 idempotency guard (lines 250-260) that was not in the original file the plan described
- **Fix:** Kept the guard intact in the rewritten file — it is a correctness requirement
- **Files modified:** src/server/jobs/processOutreachSequences.ts

**2. [Rule 1 - Dead code] Removed interpolateTemplate calls**
- **Found during:** Rewrite — lines 262-264 interpolated subject/html/plainBody locally before passing to sendEmail
- **Issue:** sendOutreachEmail handles interpolation internally using the lead object; pre-interpolating and passing a raw subject/body string would have bypassed A/B variant body selection
- **Fix:** Removed the three local interpolateTemplate calls; sendOutreachEmail receives the raw step object and performs its own interpolation with variant selection
- **Files modified:** src/server/jobs/processOutreachSequences.ts

## Known Stubs

None — all send paths are wired to real SMTP/Outlook sending via the shared module.

## Self-Check: PASSED

- `src/server/jobs/processOutreachSequences.ts` — FOUND
- Commit `9950f13` — FOUND
- `.planning/phases/01-sending-correctness/01-02-SUMMARY.md` — FOUND
