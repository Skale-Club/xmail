---
id: SEED-002
status: dormant
planted: 2026-07-15
planted_during: v1.4 — Outreach Hardening (planning)
trigger_when: Outreach is unparked — a disposable (non-skale.club) sending domain is registered/verified and a real campaign can run. At that moment these items both START MATTERING and become RUNTIME-TESTABLE at the same time.
scope: Medium
---

# SEED-002: Finish the deferred system-audit fixes

## Why This Matters

On 2026-07-15 the system-audit branch (`claude/system-error-analysis-9k0pyj`) was triaged
item by item. The safe, verifiable fixes were shipped to `main`. Six items were **real,
code-verified bugs** that were deliberately **deferred** — not because they're wrong, but
because build-green ≠ runtime-verified and they touch concurrency/product-semantic code that
cannot be exercised without a live outreach campaign. Shipping them blind would have been the
exact anti-pattern that session spent its time avoiding.

They are deferred, not dropped. This seed keeps the full WHY so they resurface at the moment
they become both important and testable — instead of rotting in a Deferred list.

## When to Surface

**Trigger:** when outreach is unparked. Concretely, surface this seed during
`/gsd:new-milestone` when the milestone scope matches any of:

- A disposable / non-`skale.club` sending domain is being added or verified (the P009 unblock).
- Any milestone that turns on real cold-outreach campaigns, warmup, or deliverability at scale.
- Any work that reopens the outreach send / bounce / reply pipeline.

Related standing decision: `skale.club` never sends cold outreach; P009 blocks all current
native inboxes, so outreach stays parked until a disposable domain exists (see the
`xmail-outreach-sending-domain` project memory).

## Scope Estimate

**Medium** — a focused phase or two. Items 1–3 (the outreach-reliability trio) belong together
in one phase, gated behind a live campaign to test against. Items 4–6 are independent, smaller,
and can be picked up opportunistically.

## The deferred items

**Need a live campaign to verify (do these together, when outreach is unparked):**

1. **Stuck lead after send failure** — `src/server/jobs/processOutreachSequences.ts`. On
   send-failed the `outreach_emails` row goes `status='failed'` but the `campaign_leads`
   schedule isn't advanced, so the lead is re-selected every tick and blocked as
   `claim_conflict` forever, saturating `PENDING_LEADS_LIMIT` (200). Fix = reclaim via
   `onConflictDoUpdate` + backoff. Delicate: rewrites the ON CONFLICT claim logic PR #6
   deliberately designed. Needs a campaign to test the claim/retry path.

2. **Soft bounce kills the lead** — `src/server/jobs/processBounces.ts` `markAsBounced`. The
   classifier detects soft vs hard, but `markAsBounced` ignores it and always sets lead
   `status='bounced'`, so a mailbox-full/greylist permanently kills the lead. Fix = thread
   `bounceType`, reschedule on soft. Open product decision: how many soft retries before
   giving up.

3. **processFollowUps writes no `outreach_emails` row** — the agentic follow-up it sends
   discards `messageId` and never increments stats, so a reply to the follow-up only matches
   by fallback. Design gap. Agentic follow-up is OFF by default, so dormant until enabled.

**Independent of a campaign (can be done earlier, still deferred for risk/low-value):**

4. **Mail TLS reload / SNI** — `src/server/lib/mail-tls.ts`. Certs are cached with no
   hot-reload. Low value (frequent redeploys pick up renewed certs) vs. real risk (touches
   live IMAP 993 / SMTP 587 TLS). Do as a focused change with an explicit TLS handshake test.

5. **Migration runner** — `scripts/apply-pending-migrations.mjs` wraps everything in one
   transaction, so it breaks on `CREATE INDEX CONCURRENTLY`. Not run by the deploy; migrations
   are applied manually via a postgres.js script (psql isn't installed on the dev box). Fix it
   only if this runner becomes part of the pipeline.

6. **Frontend cosmetic** — `src/lib/mock-data.ts` is a dead unimported file; `EmailDetailPage`
   has inline mock scaffolding that never triggers for real UUIDs; client-side → server-side
   search is an enhancement, not a bug. No user-facing defect. Touch only if already working
   in that area.

## Breadcrumbs

- `src/server/jobs/processOutreachSequences.ts` — item 1 (claim logic, `PENDING_LEADS_LIMIT`)
- `src/server/jobs/processBounces.ts` — item 2 (`markAsBounced`, soft/hard classifier)
- `src/server/jobs/processFollowUps.ts` — item 3 (no `outreach_emails` write)
- `src/server/lib/mail-tls.ts` — item 4 (cert cache, no reload)
- `scripts/apply-pending-migrations.mjs` — item 5 (CONCURRENTLY in a txn)
- `src/lib/mock-data.ts` + `src/pages/mail/EmailDetailPage.tsx` — item 6 (dead/scaffolding)
- Source branch: `origin/claude/system-error-analysis-9k0pyj` (audit report at
  `docs/auditoria-sistema-2026-07.md` on that branch)

## Notes

**Do NOT merge the source branch wholesale.** It is stale (pre-outreach, ~50 files, migration
number collisions incl. a third `032`) and its audit map errs roughly 1 in 3 — every item must
be re-verified against current `main` before acting. Two of its own headline "critical" findings
were already false or already fixed on inspection.

**Already shipped from this audit (do NOT redo):** XSS in template preview (EmailHtmlViewer),
webhook SSRF-via-redirect (`redirect:'manual'`), 587 cross-tenant From spoofing, bounce
`LIKE '%%'` guard, `.dockerignore` `.env.*`, migration 037 (schema-only unique indexes), the
`PATCH /system/branding` auth bypass, and IMAP `UID EXPUNGE`.

**Untriaged on the branch (verify individually before trusting):** MX fail-open in
`mx-server.ts`, SSRF in `route-matcher.ts` `deliverViaRoutes`, viewer-can-send in
`routes/messages.ts`, unauthenticated PII endpoint in `unsubscribe.ts`, password-reset guard in
`users.ts`. None of these were verified in the 2026-07-15 pass.

See project memory `xmail-deferred-audit-backlog` for the same list in condensed form.
