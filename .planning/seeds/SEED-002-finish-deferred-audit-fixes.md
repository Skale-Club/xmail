---
id: SEED-002
status: mostly-superseded
planted: 2026-07-15
updated: 2026-07-15
planted_during: v1.4 — Outreach Hardening (planning)
trigger_when: A security-hardening pass, OR opportunistically when already working in the named files. The original outreach-reliability trigger is largely spent — see "What v1.4 already did".
scope: Small
---

# SEED-002: Residual system-audit fixes (most now done by v1.4)

## Status — read this first

This seed was planted on 2026-07-15 with six deferred items. Since then the **v1.4 milestone
(phases 18–23) landed and superseded most of it** — phase 18 rebuilt the outreach send path as a
lease-based dispatch state machine (migration `038_outreach_dispatch_state_machine.sql`, a Vitest
+ Postgres test harness), which is exactly the runtime-testable footing whose absence caused the
deferral. So the "wait for a live campaign" framing is spent for the reliability items.

What's left is a **small residual tail** plus an **untriaged security list** that no v1.4 phase
touched. Verified item-by-item against the v1.4-complete tree (local `main` at commit `5b6f396`).

## What v1.4 already did (do NOT redo)

- **Item 1 — stuck lead after send failure: DONE.** `processOutreachSequences.ts` no longer uses
  `onConflictDoNothing`; it reschedules via `dispatchResult.nextAttemptAt` and the lease states
  (`in_progress` / `lost_lease`). The claim/retry rewrite this seed asked for was done properly.
- **Item 3 — follow-up wrote no `outreach_emails` row: DONE.** `processFollowUps.ts` was
  refactored to dispatch through the shared executor; every follow-up is now a durable command
  with `origin='agentic'` (`src/server/lib/outreach-delivery-policy.ts`), so it gets a row.

## What still survives

**1. Soft-bounce still kills the lead (async DSN path) — LIKELY OPEN, verify first.**
`processBounces.ts markAsBounced` still sets `campaign_leads.status='bounced'` (a comment there
even notes a soft bounce writes no suppression row). The v1.4 dispatch retry model handles
**send-time** temporary failures, but an **asynchronous** soft DSN (mailbox-full/greylist arriving
after a "successful" send) appears to still route into `markAsBounced` and permanently kill the
lead. Confirm whether soft DSNs are now diverted to a reschedule before touching `markAsBounced`;
if not, thread `bounceType` through and reschedule on soft. Product decision: soft-retry ceiling.
File: `src/server/jobs/processBounces.ts` (`markAsBounced`, `bounceType` classifier ~line 50).

**2. Mail TLS reload / SNI — not covered by any phase.**
`src/server/lib/mail-tls.ts` caches certs with no hot-reload. Low value (frequent redeploys pick
up renewed certs) vs. real risk (touches live IMAP 993 / SMTP 587 TLS). Do as a focused change
with an explicit TLS-handshake test. Note: phase 18-03's plan verifies migrations with
`psql $DATABASE_URL -f ...`, but **psql is not installed on this box** — use the postgres.js
approach (see `xmail-applying-migrations` memory) if you touch that path.

**3. Migration runner breaks on CONCURRENTLY — not covered.**
`scripts/apply-pending-migrations.mjs` wraps everything in one transaction, so `CREATE INDEX
CONCURRENTLY` fails. Not run by the deploy; migrations are applied via a standalone postgres.js
script. Fix only if this runner becomes part of the pipeline.

**4. Frontend cosmetic — not covered.**
`src/lib/mock-data.ts` is a dead unimported file; `EmailDetailPage.tsx` has inline mock
scaffolding that never triggers for real UUIDs; client-side → server-side search is an
enhancement, not a bug. No user-facing defect. Touch only if already in that area. (Phases 21–23
reworked the unified inbox but did not remove these.)

## Untriaged security items — highest residual value

These were flagged by the audit branch but **never individually verified**, and no v1.4 phase
addressed them. Re-verify each against the current `5b6f396` tree before acting (the codebase
moved a lot):

- MX fail-open in `src/server/mx-server.ts`
- SSRF in `src/server/lib/route-matcher.ts` `deliverViaRoutes`
- viewer-can-send in `src/server/routes/messages.ts`
- unauthenticated PII endpoint in `src/server/routes/unsubscribe.ts`
- password-reset guard in `src/server/routes/users.ts`

## Already shipped from this audit (do NOT redo)

XSS in template preview (EmailHtmlViewer), webhook SSRF-via-redirect (`redirect:'manual'`), 587
cross-tenant From spoofing, bounce `LIKE '%%'` guard, `.dockerignore` `.env.*`, migrations 036 &
037, the `PATCH /system/branding` auth bypass, IMAP `UID EXPUNGE`, and (via v1.4) items 1 & 3
above.

## Notes

**Do NOT merge the source branch `origin/claude/system-error-analysis-9k0pyj` wholesale.** It is
stale (pre-outreach, ~50 files, migration number collisions) and its audit map errs roughly 1 in
3 — two of its own headline "critical" findings were already false or already fixed on inspection.
Verify every remaining item against current `main` first.

See project memory `xmail-deferred-audit-backlog` for the condensed list, and
`xmail-outreach-sending-domain` for why outreach is parked.
