# Phase 16: Reply detection v2 + per-inbox throttle — Context

**Gathered:** 2026-05-17
**Status:** Ready for planning
**Mode:** Pre-authored from architectural analysis (discuss skipped)

<domain>
## Phase Boundary

Two related improvements that both touch the outreach job loop and produce IMMEDIATE deliverability + correctness gains. Bundled because they share files (processOutreachSequences, processReplies, outreach-sender) and review/regression-testing overhead.

**Part A — Reply detection v2** (`src/server/jobs/processReplies.ts`): currently only matches `In-Reply-To` exact header. Misses:
- Auto-replies / out-of-office (incorrectly mark sequence as "replied")
- Replies from different email aliases (lead replies from `name@gmail.com` when contacted at `name@company.com`)
- Gmail/Outlook clients that re-stamp Message-ID on quote-reply
- References-chain matches when In-Reply-To is stripped

**Part B — Per-inbox throttle**: `schema.ts` defines `email_accounts.minMinutesBetweenEmails` / `maxMinutesBetweenEmails` but **no code reads them**. The processor sends all pending leads for an inbox in burst → Gmail/Yahoo trip rate-limit pattern detection → spam folder / IP rep damage. This is the single biggest deliverability risk in the system today.

Definition of done:
1. Auto-replies (Auto-Submitted/Precedence headers) are detected and DO NOT trigger sequence stop
2. Replies from related-domain addresses match against the lead and stop sequence appropriately
3. Each inbox enforces a min-spacing between sends (default 1 min, configurable per account) — second send for the same inbox waits at least `minMinutesBetweenEmails` after the previous
4. New leads added to a campaign get `nextScheduledAt` with jitter between `min` and `max` (not all at `now`) so they don't burst
5. The processor logs WHY it skipped a lead (rate-limit, suppression, no-active-step) for ops visibility
</domain>

<decisions>
## Implementation Decisions

### Part A: Reply detection
- **3-tier match strategy** in processReplies.ts (in priority order):
  1. `In-Reply-To` exact match against `outreach_emails.message_id`
  2. `References` chain — split on whitespace, check each token against `message_id`
  3. **From-address heuristic**: if `from_address` matches any `lead.email` in the org AND `to` is one of the org's inboxes AND there's an `outreach_email` to that lead within last 30 days → consider it a reply
- **Auto-reply filter (CRITICAL — before 3-tier match)**: reject messages with ANY of:
  - `Auto-Submitted: auto-replied` / `Auto-Submitted: auto-generated`
  - `Precedence: auto_reply` / `Precedence: bulk` / `Precedence: junk`
  - `X-Auto-Response-Suppress: All`
  - Subject matches `/^(out of office|auto[- ]?reply|automatic reply|on vacation|out of the office)/i`
  - These get a separate `outreach_emails.bounce_reason = 'auto_reply'` log but do NOT mark sequence as replied
- **Out-of-office handling**: when detected, increment a per-lead `auto_reply_count` and keep the sequence going (don't stop)
- **IMAP search optimization**: cap search to last 7 days (`SINCE` IMAP search) and 500 results per tick; if more remain, defer to next tick
- **Logging**: structured log on every match decision (`{leadId, campaignId, matchStrategy, decision: 'replied'|'auto_reply'|'unmatched'}`)

### Part B: Per-inbox throttle
- **Enforcement at lead-selection time** in `processOutreachSequences.ts`:
  - Add `lastSentAt` column to `email_accounts` (migration 021 — see below) — updated after every successful send
  - Filter leads where `emailAccount.lastSentAt + minMinutesBetweenEmails * 60s > now` (skip with structured log)
- **Jitter on schedule**: after sending lead N, advance the NEXT pending lead's `nextScheduledAt` by `random(min, max)` minutes so they don't all become eligible at the next tick simultaneously
- **Default values** for new email_accounts (already in schema): `minMinutesBetweenEmails: 1`, `maxMinutesBetweenEmails: 5`
- **Daily-limit aware**: when `currentDailySent >= dailySendLimit`, skip with log (already exists); ALSO refresh `currentDailySent` at midnight UTC (cron in jobs/index.ts)

### Schema migration 021
- `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sent_at timestamptz`
- `CREATE INDEX IF NOT EXISTS email_accounts_last_sent_at_idx ON email_accounts(last_sent_at) WHERE status = 'verified'`
- Mirror in `src/db/schema.ts`
- Idempotent (re-runnable)

### Logging strategy (preparatory for Phase 17)
- Use `console.log` with JSON.stringify for structured logs now — Phase 17 will swap to `pino`
- Standardize log shape: `[outreach.processor] {action, campaignId?, leadId?, emailAccountId?, reason?, latencyMs?}`
- Skip reasons enumerated: `rate_limit_per_inbox`, `daily_limit_reached`, `suppression`, `no_active_step`, `outside_send_window`, `claim_conflict`

### Claude's Discretion
- Whether to materialize a CTE for the "lastSentAt" join vs do it in JS post-fetch
- Exact regex for out-of-office subject detection (likely err on stricter side — false negatives are better than false positives)
- Whether to bucket the jitter math in a helper `nextSendTime(lastSentAt, min, max)` exported from `outreach-sender.ts`

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`processOutreachSequences.ts:79+`** (`PENDING_LEADS_LIMIT = 200`): the loop where rate-limit filter belongs
- **`outreach-sender.ts:79-89`** (`canSendFromAccount`): currently only checks `dailySendLimit`; extend to also check `lastSentAt + minMinutesBetweenEmails`
- **`processReplies.ts`**: existing IMAP read pattern — preserve, extend the matching block (lines ~107-150 per audit)
- **`generateOutreachToken`** + RFC 8058: unchanged, this phase doesn't touch unsubscribe

### Schema knowledge
- `email_accounts.dailySendLimit` (exists, used)
- `email_accounts.minMinutesBetweenEmails` / `maxMinutesBetweenEmails` (exist, UNUSED — this phase wires them)
- `email_accounts.warmupCurrentDay` / `warmupEnabled` (exist, NOT in scope this phase — defer warmup ramp-up to a later phase if needed)
- `email_accounts.lastSentAt` (DOES NOT exist — migration 021 adds it)
- `campaign_leads.nextScheduledAt` (exists, Phase 14 made it non-NULL on insert)
- `outreach_emails.message_id` (exists, used by sender)

### Integration Points
- `src/server/jobs/processOutreachSequences.ts` — add rate-limit filter in lead-eligibility section; update lastSentAt after successful send; apply jitter when computing next lead's nextScheduledAt
- `src/server/jobs/processReplies.ts` — replace single-match block with 3-tier function; add auto-reply filter at top
- `src/server/lib/outreach-sender.ts` — extend `canSendFromAccount` signature to include throttle check; export new `applySendJitter(lastSentAt, min, max): Date` helper
- `src/server/jobs/index.ts` — add midnight UTC cron to reset `currentDailySent` for all email_accounts (one line: `UPDATE email_accounts SET current_daily_sent=0`)
- `supabase/migrations/021_email_accounts_last_sent_at.sql` — new migration
- `src/db/schema.ts` — mirror migration 021

</code_context>

<specifics>
## Specific Ideas

- For 3-tier matching, isolate the function as `matchReplyToOutreach(headers, leadsRecent): {match: outreachEmail, strategy} | null` so it's testable in isolation when Phase 18 adds tests
- Auto-reply detection in subject line: cover EN + a few common PT/ES patterns since SkaleClub's target users may have multi-lingual lead lists
- After landing migration 021, run it on production via `scripts/apply-pending-migrations.mjs` (the helper from Phase 14 deploy) BEFORE the new code goes live

</specifics>

<deferred>
## Deferred Ideas

- Warmup ramp-up logic (`warmupCurrentDay` field is unused) → future phase
- ML-based reply intent detection (positive vs negative reply) → future
- Bounce categorization (hard/soft/complaint) — partial in Phase 14, full taxonomy deferred
- Per-domain (not per-inbox) rate limiting → P2

</deferred>
