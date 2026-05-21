---
phase: 14-outreach-p0-fixes
verified: 2026-05-17T00:00:00Z
status: human_needed
score: 14/14 must-haves verified (automated) — 5 UAT scenarios deferred to human
re_verification: null
human_verification:
  - test: "Org-admin (non-platform-admin) click-through: log in, navigate to /outreach/campaigns, click 'New Campaign', confirm form renders (no black screen), submit with valid inbox, confirm redirect to list with success toast."
    expected: "Form renders inside OutreachLayout; POST returns 201; redirect to /outreach/campaigns; new campaign visible in list."
    why_human: "Wouter route resolution, OutreachLayout shell rendering, AdminCheck wrapper behavior, and Supabase JWT round-trip cannot be verified by static grep — requires running browser + server with real session."
  - test: "Gmail/Yahoo List-Unsubscribe compliance smoke: send a real outreach to a Gmail + Yahoo inbox, view raw email source, confirm List-Unsubscribe + List-Unsubscribe-Post headers are present and well-formed."
    expected: "Both headers visible in raw source; one-click unsubscribe button appears in Gmail's UI; POST /o/u/:token from Gmail's prefetcher succeeds with 200 and writes a suppressions row."
    why_human: "Header injection from Nodemailer transport AND Gmail's UI surfacing AND prefetcher behavior all need a live SMTP send to a real Gmail account."
  - test: "RFC 8058 GET-safety: paste a generated /o/u/{token} URL into a browser, confirm the confirmation HTML page appears, re-query the lead row to confirm unsubscribedAt is STILL NULL after GET, then click the form button to POST, confirm unsubscribedAt is now set + suppressions row exists with source='unsubscribe'."
    expected: "GET = confirmation page only (no DB writes). POST = unsubscribe applied + suppression row inserted."
    why_human: "Requires a real Express server up + a valid HMAC token generated against the live ENCRYPTION_KEY; visual confirmation of the rendered HTML page."
  - test: "Multi-instance advisory lock: run two concurrent invocations of runOutreachProcessorWithLock() (e.g., from two SSH shells or a brief two-container overlap during a blue-green deploy) and confirm only one acquires the lock; the other logs 'advisory lock held by another instance — skipping tick'."
    expected: "Exactly one of the two concurrent invocations processes leads; the other returns acquired:false and logs the skip message."
    why_human: "Requires a live Postgres connection from two different DB sessions/PIDs — cannot be simulated in a single-process unit test against the real driver shape."
  - test: "Crash-safe send: send 1 outreach email via the processor tick, kill the container mid-send (docker kill), restart, wait for next 5-min tick, confirm the email is NOT re-sent (claim row at status='queued' blocks the unique index re-insert)."
    expected: "After restart, outreach_emails row for (campaignLead, step) exists with status in ('queued','sent','failed'); next tick logs claim conflict / does not call sendOutreachEmail for that slot."
    why_human: "Requires actually killing a Node process mid-network-call and observing the next cron tick — production-host operation, not a code property."
gaps: []
---

# Phase 14: Outreach P0 Fixes — Verification Report

**Phase Goal:** Make the outreach module functional end-to-end and compliant with bulk-sender requirements (Gmail/Yahoo, CAN-SPAM, GDPR). Close all 11 P0 findings from `.planning/debug/outreach-system-deep-audit.md`.

**Verified:** 2026-05-17
**Status:** human_needed (14/14 automated must-haves PASS; 5 UAT scenarios require human testing)
**Re-verification:** No — initial verification

## Executive Summary

Phase 14 successfully closed all 11 P0 findings at the code level. Every grep/file/build check in the must-haves list passes against the actual codebase: the middleware no longer blocks org users (P0-04), the NewCampaignPage exists and is route-registered before the catch-all (P0-11), migration 020 lands cascade FKs + tracking_token + suppressions.source (P0-10/02/07 schema), the broken Drizzle subquery is gone and nextScheduledAt is now always populated (P0-09/01), deleteCampaign is transaction-wrapped (P0-10 code), HMAC tokens with fail-loud module load gate exist (P0-02/03), the unsubscribe router is mounted at `/o/u` with RFC 8058 GET-safety + suppression-write (P0-03/07), List-Unsubscribe headers are injected on SMTP sends (P0-03), track.ts now looks up outreach_emails first (P0-02), bounce-path suppressions write fires for hard bounces (P0-07), the IMAP UUID/LOWER bug is fixed (P0-08), the processor uses an idempotent claim with `onConflictDoNothing` + `pg_try_advisory_lock(4014)` (P0-05/06), the recordOutreachEmail caller is removed, and the TEMP placeholder marker from 14-03 is fully replaced. `npm run build` exits 0 with no errors. The 5 UAT items below cannot be verified by static analysis and require a running deployment.

## Goal Achievement — Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| T1 | Org-admin can reach `/api/outreach/*` without 403 | VERIFIED (static) | `src/server/routes/outreach/index.ts` middleware reads only `x-user-id`; no `isPlatformAdmin` import or call (`grep -c isPlatformAdmin` returns 0) |
| T2 | `/outreach/campaigns/new` renders a campaign form, not a black screen | VERIFIED (static) — UAT pending | `NewCampaignPage.tsx` exists with default export and OutreachLayout wrapping; route registered at line 443 of `main.tsx`, before list route at line 457 |
| T3 | Campaign deletion succeeds even with sent emails/leads/sequences | VERIFIED (static) | Migration 020 contains 8 ON DELETE CASCADE FKs + 1 SET NULL; `deleteCampaign` wraps in `db.transaction(async (tx) =>` |
| T4 | Adding leads to a campaign with a sequence succeeds and the lead is picked up on the next processor tick | VERIFIED (static) | Broken Drizzle subquery removed (`grep db.select({ id: sequences.id })` returns 0); two-query pattern in place; `nextScheduledAt: now` set on insert (line 998) |
| T5 | Open/click tracking populates `outreach_emails.openedCount`/`clickedCount` | VERIFIED (static) | `track.ts` has outreach-first lookup in both /open (line 50) and /click (line 139); fallback to messages.token preserved |
| T6 | Outreach emails carry RFC-8058-compliant List-Unsubscribe headers | VERIFIED (static) — UAT pending | `outreach-sender.ts` lines 145-150 inject both `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` in SMTP headers |
| T7 | Unsubscribe is exposed at `/o/u/:token` and is safe under URL prefetch | VERIFIED (static) — UAT pending | Mounted at line 246 of `src/server/index.ts` with dedicated rate limiter; GET handler at line 299 of `unsubscribe.ts` is read-only (no `processUnsubscribe` call); POST handler at line 336 does the work |
| T8 | Unsubscribe writes to `suppressions` with source='unsubscribe' | VERIFIED (static) | `unsubscribe.ts:287` INSERTs into suppressions with `source: 'unsubscribe'` inside `processUnsubscribe` |
| T9 | Hard bounces auto-write to `suppressions` with source='bounce' | VERIFIED (static) | `processBounces.ts:283` INSERTs into suppressions with `source: 'bounce'` after regex match on hard-bounce reasons |
| T10 | Processor is crash-safe and multi-instance-safe | VERIFIED (static) — UAT pending | `pg_try_advisory_lock(4014)` wrapping at `processOutreachSequences.ts:376`; idempotent claim via `onConflictDoNothing` at line 247; `isSequenceProcessing` flag removed (0 hits in `jobs/index.ts`) |
| T11 | IMAP bounce lookup no longer raises `function lower(uuid) does not exist` | VERIFIED (static) | `processBounces.ts:186-194` — LOWER() removed from UUID column; remaining LOWER calls operate on text columns only (`l.email`, `messageId`) |
| T12 | HMAC tokens are signed by a real secret (no silent fallback to empty string) | VERIFIED (static) | `outreach-tokens.ts:20-23` throws at module load if both `ENCRYPTION_KEY` and `JWT_SECRET` are unset |
| T13 | Build is green after all 14-* commits | VERIFIED | `npm run build` exits 0; tsc + Vite both succeed; PWA precache 53 entries |
| T14 | `{{unsubscribeUrl}}` template variable resolves AND existing field handling is preserved | VERIFIED (static) | `template-variables.ts:84` adds optional `context` parameter; line 99 resolves `unsubscribeUrl` first; BUILTIN_VARIABLES sweep + customFields lookup + empty-string fallback all preserved |

**Score:** 14/14 truths verified at the static-analysis level. 5 truths additionally flagged for UAT (T2, T6, T7, T10 — and a derived T5b for live tracking write) because they exercise runtime behavior (browser rendering, SMTP transport, Gmail UI, multi-instance race, mid-send crash recovery) that grep cannot prove.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/server/routes/outreach/index.ts` | Auth-only middleware, no isPlatformAdmin | VERIFIED | 26 lines, single `router.use` reading `x-user-id`, three sub-router mounts |
| `src/pages/outreach/campaigns/NewCampaignPage.tsx` | Default-exporting NewCampaignPage with OutreachLayout + form | VERIFIED | 164 lines; OutreachLayout wraps form; name/description/inbox-select fields; mutation POSTs to `/api/outreach/campaigns`; success redirect to list |
| `supabase/migrations/020_outreach_p0_fixes.sql` | Cascade FKs + tracking_token + suppressions.source, idempotent | VERIFIED | 107 lines, BEGIN/COMMIT block, 8 CASCADE FKs, 1 SET NULL FK, tracking_token text NOT NULL UNIQUE with backfill, suppressions.source with CHECK constraint |
| `src/db/schema.ts` | Mirrors migration 020 | VERIFIED | 7 `onDelete: 'cascade'` entries, 1+ `onDelete: 'set null'`, `trackingToken: text('tracking_token').notNull()` at line 877, `source: text('source').notNull().default('manual')` at line 347 |
| `src/server/routes/outreach/campaigns.ts` addLeadsToCampaign | Two-query pattern, nextScheduledAt populated, returns 400 if no sequence/step | VERIFIED | Lines 970-1000 — `firstSequence` query, null-check returns 400, `firstStep` query, null-check returns 400, `now` constant + `nextScheduledAt: now` on insert |
| `src/server/routes/outreach/campaigns.ts` deleteCampaign | `db.transaction` wrap | VERIFIED | Line 554-556 — `await db.transaction(async (tx) => { await tx.delete(campaigns)... })` |
| `src/server/lib/outreach-tokens.ts` | HMAC helper, fail-loud on missing secret | VERIFIED | 79 lines; `generateOutreachToken` + `verifyOutreachToken`; `timingSafeEqual`; throws at module load if neither ENCRYPTION_KEY nor JWT_SECRET set; 60-day TTL |
| `src/server/routes/outreach/unsubscribe.ts` | HMAC tokens, GET-safe, POST does action, suppressions write | VERIFIED | 429 lines; `verifyOutreachToken` used in GET (line 302) + POST (line 339); GET handler (299-333) contains NO call to `processUnsubscribe`; POST handler (336-380) calls `processUnsubscribe`; suppressions INSERT inside `processUnsubscribe` (287); `generateUnsubscribeLink` produces `/o/u/${token}` URLs |
| `src/server/lib/outreach-sender.ts` | Headers, tracking token, no TEMP marker | VERIFIED | List-Unsubscribe + List-Unsubscribe-Post in headers (145-150); generateUnsubscribeLink + generateOutreachToken imported and called; TEMP placeholder marker fully removed (`grep TEMP: placeholder token` returns 0) |
| `src/server/index.ts` | Mounts unsubscribe router at /o/u (NOT under /api) | VERIFIED | `app.use('/o/u', unsubscribeRoutes)` at line 246; dedicated `unsubscribeLimiter` at line 85 |
| `src/server/routes/track.ts` | Outreach-first lookup in both /open and /click | VERIFIED | `outreachEmails.trackingToken` queried at lines 51 and 140; `if (outreachEmail)` branches at 54 + 143; messages.token fallback preserved at 73 + later |
| `src/server/jobs/processBounces.ts` | suppressions write for hard bounces, UUID/LOWER bug fixed | VERIFIED | INSERT into suppressions with `source: 'bounce'` at line 283; LOWER() only on text columns (`l.email`, `messageId`); 2 `markAsBounced` call sites both pass `organizationId` |
| `src/server/jobs/processOutreachSequences.ts` | Advisory lock + idempotent claim, no recordOutreachEmail | VERIFIED | `pg_try_advisory_lock(4014)` at line 376; `onConflictDoNothing` at line 247; `status: 'queued'`/`'failed'`/`'sent'` claim+update flow; `grep recordOutreachEmail` returns 0 (import + call removed) |
| `src/server/jobs/index.ts` | Calls locked wrapper, no isSequenceProcessing | VERIFIED | Imports `runOutreachProcessorWithLock`; `grep isSequenceProcessing` returns 0; cron at line 39 calls the locked wrapper |
| `src/server/lib/template-variables.ts` | unsubscribeUrl handling + all existing behaviors preserved | VERIFIED | `TemplateContext` interface added; `interpolateTemplate` signature now `(template, lead, context = {})`; `unsubscribeUrl` branch at line 99 inside replace callback; BUILTIN_VARIABLES sweep at 90-94, lead.customFields lookup at 101, empty-string fallback at 116 all intact |

## Key Link Verification

| From | To | Via | Status |
| ---- | -- | --- | ------ |
| `outreach/index.ts` middleware | Sub-router `checkOrgMembership` | Pass-through after auth | VERIFIED — sub-router calls preserved (we did not touch campaigns.ts/leads.ts/email-accounts.ts auth) |
| `CampaignsPage.tsx` "New Campaign" Link | `main.tsx` Route `/outreach/campaigns/new` | Wouter Link → Route match, ordering before list route | VERIFIED — new route at line 443, list route at line 457 (correct order) |
| `addLeadsToCampaign` insert | `processOutreachSequences` `lte(nextScheduledAt, now)` filter | DB column populated → processor query matches | VERIFIED — `nextScheduledAt: now` set on insert; processor filter unchanged |
| `outreach-sender.ts` mailOptions.headers | `generateUnsubscribeLink` from unsubscribe.ts | Import + call with `campaignLeadId, campaignId, baseUrl` | VERIFIED — both imports present in sender; URL appears in both List-Unsubscribe header AND {{unsubscribeUrl}} template context |
| `server/index.ts` mount | `unsubscribe.ts` default export router | Express `app.use('/o/u', unsubscribeRoutes)` | VERIFIED — line 246 |
| `track.ts` /open & /click | `outreach_emails.tracking_token` | Drizzle query on indexed column | VERIFIED — uses unique index from migration 020 |
| `processOutreachSequences` claim INSERT | `outreach_emails_campaign_lead_step_unique` index | `onConflictDoNothing({ target: [campaignLeadId, sequenceStepId] })` | VERIFIED — line 247 |
| `processBounces.markAsBounced` | `suppressions` write | Hard-bounce regex → INSERT with source='bounce' | VERIFIED — INSERT at line 283, onConflictDoNothing for idempotency |
| `jobs/index.ts` cron | `runOutreachProcessorWithLock` | Import + invocation in `*/5 * * * *` cron | VERIFIED — line 5 import, line 39 call |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Full TypeScript + Vite build | `npm run build` | exits 0, 53 PWA entries, no errors/warnings in stderr | PASS |
| Migration file SQL grammar (BEGIN/COMMIT, CASCADE count) | `grep -c "ON DELETE CASCADE" migrations/020_*.sql` | 16 occurrences (8 unique FKs ×2 DROP+ADD patterns) | PASS — exceeds minimum of 7 |
| isPlatformAdmin fully removed from outreach root | `grep -c isPlatformAdmin src/server/routes/outreach/index.ts` | 0 | PASS |
| Route ordering in main.tsx | new at L443, sequences/new at L450, list at L457 | new < list | PASS |
| Both unsubscribe + bounce paths INSERT into suppressions | `grep -rn 'insert(suppressions)' src/` | 2 hits (unsubscribe.ts:287, processBounces.ts:283) | PASS — was 0 per audit P0-07 |
| TEMP marker fully replaced | `grep -rn 'TEMP: placeholder token' src/` | 0 | PASS |
| recordOutreachEmail caller removed | `grep -c recordOutreachEmail src/server/jobs/processOutreachSequences.ts` | 0 | PASS |

## Requirements Coverage (P0-01 through P0-11)

| Req | Description (audit) | Source Plan | Status | Evidence |
| --- | ------------------- | ----------- | ------ | -------- |
| P0-01 | campaign_leads.nextScheduledAt NULL prevents processor pickup | 14-04 | SATISFIED | `campaigns.ts:998` sets `nextScheduledAt: now` on insert |
| P0-02 | Open/click tracking never recorded for outreach | 14-03 (schema) + 14-05 (code) | SATISFIED | `outreach_emails.tracking_token` UNIQUE; `track.ts` outreach-first lookup |
| P0-03 | List-Unsubscribe headers missing + unsubscribe route never mounted | 14-05 | SATISFIED | Headers in sender, router mounted at `/o/u` with rate limit, GET-safe per RFC 8058 |
| P0-04 | isPlatformAdmin blocks all org users with 403 | 14-01 | SATISFIED | Middleware replaced with auth-only check |
| P0-05 | Race: send succeeds then record fails → duplicate send on next tick | 14-06 | SATISFIED | Idempotent claim INSERT via `onConflictDoNothing` BEFORE send; unique index acts as lock |
| P0-06 | Multi-instance race on in-memory mutex | 14-06 | SATISFIED | `pg_try_advisory_lock(4014)` wrapper; in-memory flag removed |
| P0-07 | suppressions never written for bounces or unsubscribes | 14-05 (unsub path) + 14-06 (bounce path) | SATISFIED | Both paths INSERT with appropriate source ('unsubscribe' / 'bounce') |
| P0-08 | IMAP bounce lookup uses LOWER(uuid) → SQL error | 14-06 | SATISFIED | LOWER removed from UUID; only text columns wrapped |
| P0-09 | addLeadsToCampaign uses broken Drizzle subquery | 14-04 | SATISFIED | Two sequential queries (firstSequence then firstStep) + 400 returns on missing |
| P0-10 | Cascade FKs missing → deleteCampaign fails on populated campaigns | 14-03 (schema) + 14-04 (transaction wrap) | SATISFIED | Migration 020 adds 8 CASCADE + 1 SET NULL FKs; schema.ts mirrored; deleteCampaign in db.transaction |
| P0-11 | NewCampaignPage missing → black screen on "New Campaign" click | 14-02 | SATISFIED | Page exists, route registered before list, OutreachLayout wraps, form posts and redirects |

**Coverage: 11/11 P0 requirements satisfied at the static-analysis level.**

## Anti-Patterns Scan

| File | Pattern | Severity | Impact |
| ---- | ------- | -------- | ------ |
| (none found relevant to phase 14) | — | — | — |

No TODO/FIXME/PLACEHOLDER markers introduced by this phase; the only `TODO(phase-15)` annotations are intentional hand-offs (advisory locks for processReplies/processBounces, recordOutreachEmail dead-export removal, Outlook OAuth header limitation) documented in the plan summaries. The plan summaries' explicit `// TODO(phase-15)` comments are deferred-work markers, not stubs.

## Human Verification Required

See frontmatter `human_verification:` block — five scenarios that exercise runtime behavior not provable by static analysis:

1. **End-to-end campaign creation UAT (T2)** — browser + server + JWT round-trip.
2. **Gmail/Yahoo List-Unsubscribe header compliance (T6)** — live SMTP send + Gmail UI inspection.
3. **RFC 8058 GET-safety check (T7)** — paste-URL test confirming no DB writes on GET, writes on POST.
4. **Multi-instance advisory lock (T10)** — concurrent invocations against real Postgres.
5. **Crash-safe send (derived T5/T10)** — docker kill mid-send + restart + next tick observation.

## Operator follow-up reminders (from 14-03 SUMMARY)

- Migration `020_outreach_p0_fixes.sql` must be applied to production Postgres BEFORE the new code is deployed (or simultaneously) — the new code expects `outreach_emails.tracking_token` and `suppressions.source` columns to exist. If applied after a new-code deploy, inserts into outreach_emails will fail with column-not-found.
- The change-of-status enum value used by the processor claim is `'queued'` (intentional auto-fix during 14-06 — `'sending'` is not in `messageStatusEnum`). No additional schema migration required.

## Recommended Next Step

Phase 14 is **code-complete and build-green**. All 14 automated must-haves pass. The phase should proceed to staging/production deploy with the following gates in this order:

1. **Operator:** apply `supabase/migrations/020_outreach_p0_fixes.sql` to production Postgres.
2. **CI:** push to main → GitHub Actions `deploy-hetzner.yml` triggers; rollback to `:previous` on `/health` failure.
3. **Post-deploy UAT:** run the 5 human-verification scenarios above against the live deploy.
4. **Monitor:** for the first 24h, watch container logs for `function lower(uuid) does not exist` (should be absent — P0-08 fix), `advisory lock held by another instance` (expected during overlap windows, not at steady state), and any `outreach-tokens: ENCRYPTION_KEY or JWT_SECRET must be set` (would indicate a misconfigured env — must fix immediately).

If any of the 5 UAT scenarios fail, file specific gap items against the failing truth(s) and rerun verification with `--gaps`.

---

_Verified: 2026-05-17_
_Verifier: Claude (gsd-verifier, opus 4.7)_
