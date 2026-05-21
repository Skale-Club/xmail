---
status: partial
phase: 14-outreach-p0-fixes
source: [14-VERIFICATION.md]
started: 2026-05-17T00:00:00Z
updated: 2026-05-17T00:00:00Z
---

## Current Test

[awaiting human testing — operator must apply migration 020 first, then deploy, then run these]

## Tests

### 1. End-to-end campaign creation (smoke)
expected: Log in as org-admin (non-platform-admin), navigate to `/outreach/campaigns`, click "New Campaign", form renders inside OutreachLayout (no black screen), submit with valid inbox, POST returns 201, redirect to `/outreach/campaigns` with success toast, new campaign visible in list.
result: [pending]
why_human: Wouter route resolution, OutreachLayout shell rendering, AdminCheck wrapper, and Supabase JWT round-trip require a real browser + server session.

### 2. Gmail/Yahoo List-Unsubscribe compliance
expected: Send a real outreach email to a Gmail + Yahoo inbox; view raw email source; confirm `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers are present; Gmail UI shows the one-click unsubscribe button; clicking it (POST from Gmail prefetcher) returns 200 and writes a `suppressions` row with `source='unsubscribe'`.
result: [pending]
why_human: Header injection from Nodemailer + Gmail UI surfacing + prefetcher behavior all require a live SMTP send to a real Gmail account.

### 3. RFC 8058 GET-safety
expected: Generate a valid `/o/u/{token}` URL via `generateOutreachToken({kind:'unsub', clid, cid})`; paste into a browser; confirm confirmation HTML page renders; re-query lead row → `unsubscribedAt` is STILL NULL after GET; click the form button to POST; `unsubscribedAt` is now set + suppressions row exists with `source='unsubscribe'`.
result: [pending]
why_human: Requires a live server + valid HMAC token from live ENCRYPTION_KEY; visual confirmation of rendered HTML.

### 4. Multi-instance advisory lock
expected: Run two concurrent invocations of `runOutreachProcessorWithLock()` (e.g., two SSH shells or brief blue-green overlap); only one acquires the lock; the other logs `advisory lock held by another instance — skipping tick`.
result: [pending]
why_human: Requires two distinct Postgres sessions/PIDs — cannot be simulated in-process.

### 5. Crash-safe send
expected: Trigger one outreach send via the processor tick; `docker kill` the container mid-send; restart; wait for next 5-min tick; confirm the email is NOT re-sent (claim row at `status='queued'` blocks unique-index re-insert). Verify `outreach_emails` row for (campaign_lead, step) exists with status in `('queued','sent','failed')` and next tick logs claim conflict.
result: [pending]
why_human: Requires actually killing a Node process mid-network-call and observing the cron tick — host operation, not a code property.

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps

(none — all 14 automated must-haves PASSED against the codebase; these 5 items are runtime-only checks)
