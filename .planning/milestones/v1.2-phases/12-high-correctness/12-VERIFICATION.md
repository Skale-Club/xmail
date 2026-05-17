---
phase: 12-high-correctness
verified: 2026-05-16T23:30:00Z
status: human_needed
score: 7/7 must-haves verified at code level; 6/7 require live HTTP probes
re_verification:
  previous_status: none
  previous_score: n/a
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Webhook test endpoint hangs <10s"
    expected: "POST /api/webhooks/:id/test against a slow-loris/hanging URL returns within ~10s with success=false and error mentioning Abort/Timeout"
    why_human: "Requires running dev server (npm run dev:server), valid admin JWT, and a controllable slow URL (e.g. nc -l listening but never responding). Code review confirms AbortSignal.timeout(10_000) at src/server/routes/webhooks.ts:365 but actual timing behaviour needs runtime evidence."
  - test: "Webhook 503 retried 3 times at ~1s/4s/13s"
    expected: "fireWebhooks dispatching to a URL returning 503 produces 3 rows in webhook_requests with attempts=1,2,3 and timestamps roughly 0s, 3s, ~12s apart (audit/ROADMAP tolerance: 1s/4s/13s)"
    why_human: "Requires a target URL that reliably returns 503 (e.g. local express stub) and DB inspection of webhook_requests. Code review confirms the for-loop, BACKOFF_MS=[0,3000,9000], and per-attempt insert at src/server/lib/tracking.ts:262-300, but actual delivery sequencing depends on event-loop timing and DB persistence."
  - test: "10 clicks in 30s → linksClicked increments exactly once"
    expected: "Hitting GET /t/click/:token?u=... 10x within 30s results in statistics.links_clicked delta = +1; one webhook_request for link_clicked; messages.clicked_at populated"
    why_human: "Requires a real tracked message (sent via SMTP-configured mailbox), live server, and DB query against statistics. Code review confirms atomic UPDATE-with-WHERE gate using NOW() - INTERVAL '60 seconds' at src/server/routes/track.ts:104-121."
  - test: "PUT /api/system/outreach/global-toggle returns structured response"
    expected: "With valid platform-admin JWT and body {enabled:true} → 200 with {affectedRows, previousState:{enabledCount,totalCount}, userId, timestamp}; with body {} → 400 Zod errors; without x-user-id → 401; with non-admin user → 403; PUT /api/system/outreach → 410 with newPath breadcrumb"
    why_human: "Requires running server + platform-admin JWT. Code review confirms route, Zod schema, previous-state capture, audit log line, and 410 stub at src/server/routes/system.ts:426-492."
  - test: "POST /move with cross-mailbox folderId → 400"
    expected: "Authenticated user posts {folderId:<UUID of folder in OTHER mailbox>} to POST /api/mail/mailboxes/:mailboxId/messages/:messageId/move → 400 with error 'Folder does not belong to this mailbox'"
    why_human: "Requires two distinct mailboxes belonging to the same user (or two test users), valid JWT, seeded message + foreign folder. Code review confirms validate-before-write SELECT against mailFolders.mailboxId = mailboxId at src/server/routes/mail/messages.ts:651-656."
  - test: "POST /api/messages with suppressed recipient → 400"
    expected: "With a row in suppressions where organization_id=X, email_address=foo@bar.com, posting {organizationId:X, to:['foo@bar.com', ...], ...} → 400 with {error:'Recipients are suppressed', suppressed:['foo@bar.com']}"
    why_human: "Requires running server, valid JWT, seeded suppression row. Code review confirms batch inArray() lookup keyed on (organizationId, emailAddress) at src/server/routes/messages.ts:213-228."
---

# Phase 12: HIGH Correctness & Validation Verification Report

**Phase Goal:** Eliminate functional/data bugs and make lint enforceable. After this phase, webhooks recover from transient failures, click tracking ignores replays, suppression list actually blocks sends, /move can't corrupt folders, and `npm run lint` enforces zero warnings.
**Verified:** 2026-05-16T23:30:00Z
**Status:** human_needed (all code-level invariants verified; behavioural probes 1-6 require live server)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (mapped to ROADMAP Success Criteria)

| # | Truth (ROADMAP success criterion) | REQ | Status | Evidence |
| - | --------------------------------- | --- | ------ | -------- |
| 1 | POST /webhooks/:id/test with hanging URL returns within 10s | COR-01 | ✓ CODE-VERIFIED, ? RUNTIME | `AbortSignal.timeout(10_000)` at `src/server/routes/webhooks.ts:365`; catch block records TimeoutError/AbortError to webhook_requests.success=false at line 387-393 |
| 2 | Webhook URL returning 503 produces 3 attempts ~1s/4s/13s apart | COR-02 | ✓ CODE-VERIFIED, ? RUNTIME | `BACKOFF_MS=[0,3000,9000]`, `MAX_ATTEMPTS=3`, sleep-before-attempt loop at `src/server/lib/tracking.ts:125-127, 262-300`; per-attempt `webhook_requests` insert with `attempts: attempt` at lines 275-283 (success path) and 290-297 (error path); 4xx exits loop at line 286; 5xx + network/timeout retries |
| 3 | 10 clicks in 30s increments `linksClicked` exactly once | COR-03 | ✓ CODE-VERIFIED, ? RUNTIME | Atomic UPDATE with WHERE clause `clickedAt IS NULL OR clickedAt < NOW() - INTERVAL '60 seconds'` at `src/server/routes/track.ts:104-115`; `.returning()` empty array on replay → no stat/webhook increment at line 123-127; `messages.clickedAt` schema field at `src/db/schema.ts:247`; migration 019 idempotent ALTER TABLE at `supabase/migrations/019_add_message_clicked_at.sql` |
| 4 | `PUT /api/system/outreach/global-toggle` Zod-validated, returns {affectedRows, previousState}; old endpoint 410 | COR-04 | ✓ CODE-VERIFIED, ? RUNTIME | `outreachGlobalToggleSchema = z.object({enabled: z.boolean()})` at `src/server/routes/system.ts:429-431`; auth chain (x-user-id → 401, isPlatformAdmin → 403); previous-state SELECT before UPDATE at line 453-457; `.returning({id})` for `affectedRows` at line 460-464; audit log `[audit] outreach-toggle user=... from=N/M to=BOOL affected=N at=ISO` at line 470; old endpoint 410 with `{error, newPath, deprecatedAt}` at line 486-492 |
| 5 | `/move` with cross-mailbox `folderId` → 400 | COR-05 | ✓ CODE-VERIFIED, ? RUNTIME | Validate-before-write SELECT at `src/server/routes/mail/messages.ts:651-653` checks `mailFolders.id = folderId AND mailFolders.mailboxId = req.params.mailboxId`; 400 with error 'Folder does not belong to this mailbox' at line 654-656 BEFORE the UPDATE at line 658-660 |
| 6 | `POST /api/messages` with suppressed recipient → 400 listing addresses | COR-06 | ✓ CODE-VERIFIED, ? RUNTIME | Batch inArray check at `src/server/routes/messages.ts:213-228`: builds `allRecipients = [...to, ...cc, ...bcc]`, queries `suppressions WHERE organizationId = X AND emailAddress IN (...)`, returns 400 with `{error, suppressed:[…]}` on any match; runs AFTER auth/access check, BEFORE template/outlook resolution and DB insert |
| 7 | `npm run lint` exits 0 with zero warnings | COR-07 | ✓ VERIFIED | `npm run lint` executed in this verification — exit code 0, no warnings, no errors output. `.eslintrc.cjs` (108 lines) and `.eslintignore` (35 lines) exist at repo root; `package.json:23` lint script uses `--max-warnings 0`; rule demotions documented inline with TODO references to Phase 13/14 |

**Score:** 7/7 truths code-level verified; 6/7 require live HTTP runtime evidence (routed to human verification).

### Required Artifacts

| Artifact | Expected Provides | Exists | Substantive | Wired | Data Flows | Status |
| -------- | ----------------- | ------ | ----------- | ----- | ---------- | ------ |
| `src/server/routes/webhooks.ts` | AbortSignal.timeout on /test | ✓ | ✓ (line 365) | ✓ (route registered, used in admin UI tests) | ✓ (fetch invokes timeout signal) | ✓ VERIFIED |
| `src/server/lib/tracking.ts` | fireWebhooks retry loop with attempts persist | ✓ | ✓ (lines 125-127, 262-300) | ✓ (called from track.ts open/click and messages.ts send) | ✓ (writes webhook_requests per attempt) | ✓ VERIFIED |
| `src/server/routes/track.ts` | Click dedup gate | ✓ | ✓ (lines 71-146) | ✓ (router mounted via src/server/index.ts) | ✓ (writes messages.clicked_at; reads/skips on replay) | ✓ VERIFIED |
| `supabase/migrations/019_add_message_clicked_at.sql` | clicked_at column DDL | ✓ | ✓ (16 lines, idempotent ALTER) | n/a (migration applied manually per project workflow) | n/a (DDL) | ✓ VERIFIED (apply-pending on staging) |
| `src/db/schema.ts` (clickedAt field) | Drizzle field mapping | ✓ | ✓ (line 247: `clickedAt: timestamp('clicked_at')`) | ✓ (used in track.ts:106, 111, 112) | ✓ | ✓ VERIFIED |
| `src/server/routes/system.ts` (global-toggle + 410) | New endpoint + deprecation stub | ✓ | ✓ (lines 426-492) | ✓ (router mounted at /api/system) | ✓ (reads/writes organizations table; audit-log emits) | ✓ VERIFIED |
| `src/server/routes/mail/messages.ts` (/move guard) | Folder-ownership SELECT before UPDATE | ✓ | ✓ (lines 651-656) | ✓ (route registered) | ✓ (queries mailFolders; aborts before bad UPDATE) | ✓ VERIFIED |
| `src/server/routes/messages.ts` (suppression check) | Batch inArray lookup | ✓ | ✓ (lines 213-228) | ✓ (route registered; suppressions schema imported line 6, inArray line 3) | ✓ (queries real suppressions table) | ✓ VERIFIED |
| `.eslintrc.cjs` | ESLint config | ✓ | ✓ (108 lines, all required plugins + 3 override blocks) | ✓ (consumed by `npm run lint` via package.json:23) | ✓ (rules applied to source) | ✓ VERIFIED |
| `.eslintignore` | Ignore patterns | ✓ | ✓ (35 lines covering dist, api, drizzle, migrations, scripts/_*, nul, configs, planning dirs) | ✓ | ✓ | ✓ VERIFIED |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `webhooks.ts POST /:id/test` | external webhook URL | `fetch(... signal: AbortSignal.timeout(10_000))` | ✓ WIRED | Code path: signed payload → fetch with timeout → response.text → webhook_requests insert → JSON response. catch block separately records failure to webhook_requests.success=false. |
| `tracking.ts fireWebhooks` | external webhook URLs | retry loop with `fetch + AbortSignal.timeout(10_000)` per attempt | ✓ WIRED | for-loop 1..3, sleep(BACKOFF_MS[attempt-1]) before attempt N>1, fetch, classify response (2xx/4xx exit, 5xx/network retry), insert webhook_requests with attempts=N. |
| `track.ts GET /click/:token` | `messages` table | atomic UPDATE-with-WHERE returning() | ✓ WIRED | UPDATE sets clickedAt=now where token=X AND (clickedAt IS NULL OR clickedAt < NOW()-60s). returning() yields message row only on "winning" hit. Empty result → silent skip (replay or unknown token). |
| `track.ts /click winning hit` | `incrementStat('linksClicked') + fireWebhooks('link_clicked')` | `Promise.allSettled` | ✓ WIRED | Both side-effects gated by `updated.length === 0` early return at line 123. Statistics + webhook only fire when the dedup gate yields a row. |
| `system.ts PUT /outreach/global-toggle` | `organizations.outreach_enabled` | `db.update().set().returning({id})` | ✓ WIRED | Zod parse → auth check → previous-state SELECT → UPDATE-and-return → audit-log to stdout → JSON response. |
| `system.ts PUT /outreach (legacy)` | 410 response | `res.status(410).json({error, newPath, deprecatedAt})` | ✓ WIRED | Route deliberately preserved as 410 stub (not router.delete'd) so callers learn the new path. No auth check on 410 (intentional per plan). |
| `mail/messages.ts POST /move` | `mailFolders` table | `db.query.mailFolders.findFirst({where: and(eq(id,folderId), eq(mailboxId,mailboxId))})` | ✓ WIRED | SELECT executes BEFORE the UPDATE at line 658-660. Mismatch → 400 short-circuit. |
| `messages.ts POST /` | `suppressions` table | `db.select().from(suppressions).where(and(eq(organizationId, X), inArray(emailAddress, recipients)))` | ✓ WIRED | Query executes AFTER auth/access but BEFORE template resolution/insert. Indexed via unique (organization_id, email_address) constraint. |
| `package.json:23 lint script` | `eslint .` walk | `.eslintrc.cjs` + `.eslintignore` | ✓ WIRED | Lint config picked up automatically by ESLint from CWD; --max-warnings 0 flag enforces zero-warning policy; verification run produced no output (exit 0). |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| webhook_requests per-attempt rows | `attempts` column | tracking.ts retry loop writes attempt-N integer literal | ✓ Real (1/2/3 reflect actual attempt number) | ✓ FLOWING |
| messages.clicked_at | `clickedAt` column | track.ts UPDATE with `new Date()` | ✓ Real (server clock) | ✓ FLOWING |
| Outreach global-toggle response `previousState` | enabledCount, totalCount | SELECT outreach_enabled FROM organizations before UPDATE | ✓ Real (full org table scan, count + filter) | ✓ FLOWING |
| Outreach global-toggle response `affectedRows` | updated.length | db.update().returning({id}) | ✓ Real (Postgres returns one row per UPDATEd row) | ✓ FLOWING |
| /move 400 response | error string | hardcoded 'Folder does not belong to this mailbox' | n/a (error message is literal) | ✓ FLOWING (validation logic uses real DB query) |
| messages POST /api 400 response | `suppressed` array | suppressions table SELECT result, mapped to emailAddress | ✓ Real | ✓ FLOWING |

No HOLLOW or DISCONNECTED artifacts found. All renderable/observable outputs trace to real DB queries or real server state.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| ESLint config + zero-warning lint | `npm run lint` | Exit 0, no stdout/stderr output beyond `> eslint . --ext ...` banner | ✓ PASS |
| TypeScript compilation (server) | Implicit — exercised by tsx during npm run dev:server; also passes per all 5 SUMMARYs' tsc probe | Not re-run here; SUMMARYs document `npx tsc --noEmit -p tsconfig.server.json` exit 0 across all 5 plans | ? SKIP (covered by SUMMARY probes; Phase 13 QUA-01 will gate tsc clean across both tsconfigs) |
| Git commit existence (15 commits expected) | `git log --oneline` shows: 27443de, e39689e (12-01); 9fdab4e, c379b5c, 51eed30 (12-02); 8434846, ba2b260 (12-03); a95f471, 7d0760d (12-04); 2155b4a, bcecee8, f1a9d9c (12-05); plus 5 docs commits (effd070, f4011c5, 281bbd8, 68546a1, ce93129) | All 12 feat/chore commits + 5 docs commits present | ✓ PASS |
| Webhook /test endpoint timeout behaviour | curl against slow URL | Requires live server | ? SKIP → human verification |
| Webhook retry sequencing under 503 | curl against 503-returning stub + webhook_requests DB inspection | Requires live server + stub URL | ? SKIP → human verification |
| Click dedup 10x in 30s | 10× curl /t/click/:token + statistics SELECT | Requires live server + sent message | ? SKIP → human verification |
| /move cross-mailbox rejection | curl with foreign folderId | Requires live server + two mailbox fixture | ? SKIP → human verification |
| POST /messages suppressed recipient block | curl with suppressed-email recipient | Requires live server + suppressions seed | ? SKIP → human verification |
| Outreach global-toggle 4-way response shape | curl with admin JWT | Requires live server + platform-admin JWT | ? SKIP → human verification |

Spot-checks all match expectations OR are appropriately deferred to runtime (human) verification with documented rationale.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| COR-01 | 12-01 | POST /webhooks/:id/test uses AbortSignal.timeout(10_000) | ✓ SATISFIED | webhooks.ts:365 |
| COR-02 | 12-01 | fireWebhooks retries with backoff (1s/3s/9s, max 3) and persists each attempt to webhook_requests | ✓ SATISFIED | tracking.ts:125-127, 262-300; webhook_requests.attempts column at schema.ts:303 (default 1, not null) — no new migration needed (column pre-existed in schema) |
| COR-03 | 12-02 | Click tracking 60s window dedup per (messageId, token) | ✓ SATISFIED | track.ts:104-127 + messages.clickedAt (schema.ts:247) + migration 019 |
| COR-04 | 12-03 | PUT /api/system/outreach/global-toggle: Zod, {affectedRows, previousState}, audit log | ✓ SATISFIED | system.ts:426-492 |
| COR-05 | 12-04 | /move validates folderId belongs to mailboxId | ✓ SATISFIED | mail/messages.ts:651-656 |
| COR-06 | 12-04 | POST /api/messages checks suppressions for each recipient | ✓ SATISFIED | messages.ts:213-228 |
| COR-07 | 12-05 | ESLint config exists; npm run lint passes zero-warning; whitelisted rules documented inline | ✓ SATISFIED | `.eslintrc.cjs` (with inline TODO references to phases 13/14 per demoted rule); `.eslintignore`; lint run in this verification → exit 0 |

**REQUIREMENTS.md drift:** REQUIREMENTS.md lines 31-32 list COR-05 and COR-06 as `[ ]` (unchecked) even though Phase 12 is marked complete in ROADMAP.md line 16 and the 12-04 SUMMARY (commits a95f471 + 7d0760d) closed both. Recommend `roadmap mark-checklist` or manual `sed` to flip those two boxes to `[x]` for consistency. This is a documentation-hygiene drift, NOT a verification gap.

No orphaned requirements — every COR-* in the Phase 12 row of the traceability table is claimed by exactly one plan, all 5 plans report complete, and all 7 requirements have code-level evidence.

### Anti-Patterns Found

Scanned files modified across the 5 plans for TODO/FIXME/placeholder, empty returns, hardcoded-empty data, console.log-only handlers, and props with hardcoded empty values.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `.eslintrc.cjs` | 49, 56, 62 | `TODO Phase 13 QUA-01` / `TODO Phase 14 CLN-XX` comments on three demoted rules | ℹ️ Info | Intentional and required per ROADMAP success criterion #7 ("any whitelisted rules are documented inline"). Each TODO names the phase and requirement that will tighten the rule. |
| `src/server/lib/tracking.ts` | 277, 292 | `event as any` cast in webhook_requests insert | ℹ️ Info | Pre-existing (carried over from before Phase 12); explicitly scheduled for Phase 13 QUA-01 type sweep per audit M12. Not a Phase 12 regression. |
| `src/server/routes/system.ts` | 470 | `console.log('[audit] outreach-toggle ...')` to stdout | ℹ️ Info | Intentional audit-log mechanism (documented in 12-03-SUMMARY decisions); Phase 13 QUA-06 will route via structured logger. The `[audit]` prefix is greppable. |
| `src/server/jobs/cleanupMessages.ts` | (file-level disable) | `/* eslint-disable no-constant-condition */` with rationale | ℹ️ Info | 5× `while(true)+break` batch-cleanup loops; refactor to async generators tracked in Phase 13 QUA-01 follow-up. Documented in 12-05-SUMMARY. |
| `src/server/lib/tracking.ts` | 247-302 | `Promise.allSettled` retry loop blocks per-webhook for up to ~12s | ℹ️ Info | Acceptable per 12-01-SUMMARY decision: all callers are background tracking handlers (open/click/send pipeline), not request-response paths. Cross-webhook parallelism preserved. |

**No 🛑 Blockers found.** No ⚠️ Warnings found. All Info-level items are pre-documented as Phase 13/14 follow-ups in the respective summaries and in 12-05-SUMMARY § "Phase 13 / 14 Follow-Ups Captured."

### Human Verification Required

Six items require a running dev server, valid JWT, and (for some) a controllable external URL or seeded DB state. See `human_verification` array in frontmatter for the complete list with curl-ready expectations:

1. **Webhook test endpoint hangs <10s** — requires controllable slow URL.
2. **Webhook 503 retried 3× at ~1s/4s/13s** — requires stub server returning 503 + webhook_requests DB inspection.
3. **10 clicks in 30s → linksClicked +1 exactly** — requires sent tracked message + statistics SELECT.
4. **/outreach/global-toggle response shape (200/400/401/403/410)** — requires platform-admin JWT.
5. **/move cross-mailbox folderId → 400** — requires two-mailbox fixture.
6. **POST /api/messages suppressed recipient → 400** — requires suppressions seed row.

Recommended runtime probe schedule: bundle into the first staging deploy alongside Phase 11 deferred probes (per 7f43747 "Phase 11 verification (passed code-level, 6 items routed to human probes)"). Each probe is documented step-by-step in the respective `12-XX-PLAN.md` Task N sections.

### Gaps Summary

**No correctness or completeness gaps were found at the code level.** All 7 ROADMAP success criteria have substantive, wired, data-flowing implementations matching the plans. All 7 v1.2 COR-* requirements are satisfied by code with greppable evidence.

Two minor housekeeping notes (neither blocking):

1. **REQUIREMENTS.md checkbox drift:** COR-05 and COR-06 are `[ ]` in REQUIREMENTS.md despite being implemented and committed (commits a95f471 + 7d0760d) and despite Phase 12 being marked complete in ROADMAP.md. Recommend flipping to `[x]` for consistency.
2. **Migration 019 application:** `supabase/migrations/019_add_message_clicked_at.sql` is committed but per project workflow is applied manually via `psql ... -f`. The click-dedup feature will silently degrade (UPDATE matches 0 rows because the column doesn't exist → all clicks no-op) until the migration is applied. Operators should include this in the staging deploy checklist. The 12-02-SUMMARY documents the apply command explicitly.

Phase 12 is **functionally complete and ready for staging-deploy runtime verification.** Status `human_needed` reflects that the goal-bearing observable truths (criteria 1-6) require live HTTP probes; criterion 7 (lint) was verified directly here.

---

*Verified: 2026-05-16T23:30:00Z*
*Verifier: Claude (gsd-verifier, model claude-opus-4-7)*
