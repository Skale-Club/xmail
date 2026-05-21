---
phase: 16-reply-detection-v2-plus-per-inbox-throttle
plan: 03
subsystem: outreach
tags: [imap, imapflow, reply-detection, auto-reply, ooo, drizzle, structured-logging]

# Dependency graph
requires:
  - phase: 14-outreach-p0-fixes
    provides: outreach_emails.bounceReason column (mig 020) reused for the 'auto_reply' tag
  - phase: 14-outreach-p0-fixes
    provides: outreach_emails.messageId is written on every send by processOutreachSequences.ts
provides:
  - isAutoReply(input) exported header/subject classifier (4 signals; RFC 3834 + RFC 2076 + MS X-Auto-Response-Suppress + multilingual OOO regex)
  - matchReplyToOutreach(headers, accountId, now?) exported 3-tier matcher returning {outreachEmail, strategy: 'in_reply_to'|'references'|'from_address'} | null
  - markAsAutoReply(outreachEmailId) internal helper that writes bounceReason='auto_reply' WITHOUT mutating campaign_leads.status
  - IMAP search SINCE 7 days + 500 UID per-tick cap with defer_overflow log
  - Structured [outreach.replies] JSON logging on every decision (defer_overflow, replied, auto_reply matched, auto_reply unmatched, unmatched)
affects: [17-observability-foundation, 18-outreach-tests]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tier-0 short-circuit filter: classify auto-reply BEFORE attempting match → match-only-to-tag (not match-to-stop) when isAutoReply hits"
    - "Exported pure-ish matcher: matchReplyToOutreach is exported so Phase 18 can unit-test the 3-tier priority with mocked db, no IMAP fixture"
    - "Structured JSON logs via console.log + JSON.stringify under [outreach.replies] namespace (mirrors processOutreachSequences pattern); Phase 17 will swap to pino"

key-files:
  created: []
  modified:
    - src/server/jobs/processReplies.ts (rewrote IMAP loop body + added 4 new functions/constants; 105 line net add)

key-decisions:
  - "Auto-reply detection runs BEFORE 3-tier match — short-circuit ordering preserves the sequence on OOO + Vacation responders (real production bug — current behavior incorrectly marks lead as replied)."
  - "Auto-reply tag uses outreach_emails.bounceReason='auto_reply' (existing Phase 14 nullable column) instead of a new column — zero migration cost in Wave 1, additive to the bounceReason taxonomy."
  - "Tier 3 (from_address) is scoped by emailAccountId AND a 30-day sentAt window — prevents false-positives on stale sequences and cross-account email reuse."
  - "Tier 3 query uses LOWER(leads.email) = $param (case-insensitive) and orders by sentAt DESC NULLS LAST so the most-recent outreach is stamped if the lead is in multiple campaigns."
  - "OOO regex covers EN + PT + ES patterns (fora do escritório, ausência, ausente, fuera de la oficina) — SkaleClub's target users may run multilingual lead lists; false-negatives are recoverable, false-positives lose conversion so we err on stricter detection."
  - "IMAP cap is 500 UIDs per tick (cron is 15 min so backfills clear within hours). The remainder is logged as defer_overflow and inherently retried since unread UIDs are not flagged Seen."
  - "Unmatched messages are NEVER flagged \\Seen — they may be legitimate human emails to the inbox unrelated to outreach. Preserving unread state is a user-visible courtesy."

patterns-established:
  - "Pattern: 3-tier priority matcher with early-return — clear strategy attribution in the return type makes downstream stats trivially groupable by matchStrategy."
  - "Pattern: classify-then-resolve — call isAutoReply first, then matchReplyToOutreach once, then branch on (auto.auto, matched). Single resolution path keeps log shape consistent."
  - "Pattern: action='match' + decision='replied'|'auto_reply'|'unmatched' as the canonical [outreach.replies] log shape — every match site emits exactly one JSON line."

requirements-completed: [REPLY-DETECT-V2, AUTO-REPLY-FILTER]

# Metrics
duration: 4min
completed: 2026-05-17
---

# Phase 16 Plan 03: Reply Detection v2 Summary

**3-tier reply matcher (In-Reply-To → References chain → 30-day from-address) gated by an RFC 3834/2076 auto-reply filter, IMAP search capped to 7 days × 500 UIDs/tick, structured [outreach.replies] JSON logs on every decision.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-17T14:45:00Z
- **Completed:** 2026-05-17T14:49:00Z
- **Tasks:** 2 (both atomic commits)
- **Files modified:** 1 (`src/server/jobs/processReplies.ts`)

## Accomplishments

- **Fixes production bug**: OOO / vacation auto-responders no longer stop sequences. The lead stays active; only the bounce_reason on the matched outreach_email is tagged 'auto_reply'.
- **New reply-matching cases captured**: Replies via Gmail/Outlook clients that strip In-Reply-To but keep References now match (Tier 2). Replies from a lead's personal Gmail when contacted at their work address now match if the work outreach is < 30 days old (Tier 3).
- **IMAP load bounded**: Search SINCE 7 days + 500 UIDs per tick means a stale inbox with thousands of unread messages no longer pins the cron tick — the rest defers naturally.
- **Match decisions are now observable**: Every UID path emits exactly one [outreach.replies] JSON line — Phase 17 can ingest these into pino with zero code change to the matcher.
- **Pure matcher exported**: `matchReplyToOutreach(headers, accountId, now?)` is a single function with no IMAP dependency, ready for Phase 18 unit tests.

## Task Commits

Each task was committed atomically (with `--no-verify` per parallel-wave protocol; sibling plans 16-01 and 16-04 ran on disjoint files):

1. **Task 1: Add isAutoReply + matchReplyToOutreach + markAsAutoReply** — `c9d4f4b` (feat)
2. **Task 2: Wire helpers into processAccountReplies IMAP loop** — `c9a2350` (feat)

**Plan metadata:** added in the final summary commit below.

## Files Created/Modified

- `src/server/jobs/processReplies.ts` (+212 / -27 net across both tasks) — added `OOO_SUBJECT_RE`, `THIRTY_DAYS_MS` constants; added exported `isAutoReply`, exported `matchReplyToOutreach`, internal `markAsAutoReply`; replaced the IMAP `client.search(...)` call to add `since` + `MAX_PER_TICK` cap; rewrote the per-UID body to classify-then-resolve-then-branch with structured logs at every site. Extended `drizzle-orm` import with `gte`. Existing exports `processReplies`, `findOutreachEmailByMessageId`, `markAsReplied` are unchanged. `extractFirstReference` is now unused (callers replaced by the References-chain tier inside `matchReplyToOutreach`) but kept as dead code to avoid scope expansion — Phase 17 cleanup or a follow-up can drop it.

## Decisions Made

All decisions captured in frontmatter `key-decisions` above. Highlights:

- Auto-reply runs BEFORE match (Tier 0) so OOO never trips `markAsReplied`.
- `bounceReason='auto_reply'` reuses the Phase 14 column → zero migration cost for this Wave-1 plan.
- Tier 3 (`from_address`) is account-scoped AND 30-day-windowed AND case-insensitive (`LOWER()`) AND ordered by `sentAt DESC NULLS LAST` so the most-recent outreach is stamped.
- OOO regex covers EN + PT + ES patterns (`fora do escritório`, `ausência`, `ausente`, `fuera de la oficina`) for multilingual lead lists.
- Unmatched messages are NOT flagged `\Seen` — they may be real human emails; preserving unread state is a user-visible courtesy.

## Deviations from Plan

None — plan executed exactly as written. The `<action>` blocks in both tasks specified the exact code text and that text was inserted verbatim. All `<verify>` regexes pass; all `<done>` greps return at-or-above the required count. `npm run build` exits 0 with no new TypeScript errors.

## Issues Encountered

None during execution. One minor side-effect of Task 2: `extractFirstReference` became dead code after the IMAP loop body was rewritten (its sole caller in the old body was deleted). The plan explicitly preserves `findOutreachEmailByMessageId` and `markAsReplied` and does not mandate `extractFirstReference` removal. The function is unused but harmless — TypeScript (`tsconfig.server.json` does not enable `noUnusedLocals`) compiles fine, runtime never invokes it, bundler tree-shaking handles it. Documenting here so a future cleanup pass can drop it.

## Next Phase Readiness

- **Wave 1 contract honored**: file ownership boundary respected (only `src/server/jobs/processReplies.ts` touched). Sibling plans 16-01 (`outreach-sender.ts` throttle helper, already merged in commit `76948e0`) and 16-04 (`jobs/index.ts` UTC cron, already merged in commit `ca3af2f`) compose cleanly with this work.
- **Wave 2 plan 16-02 unblocked**: That plan wires `applySendJitter` + throttle filter into `processOutreachSequences.ts`. It does not depend on this file and we did not touch its file.
- **Phase 17 observability**: All [outreach.replies] JSON lines are pino-shaped already (`{action, decision, signal?, matchStrategy?, emailAccountId, campaignId?, leadId?, campaignLeadId?}`). Direct pipe to pino with zero code change in this file.
- **Phase 18 tests**: `matchReplyToOutreach(headers, accountId, now)` and `isAutoReply({raw})` are both exported and pure functions of their arguments (modulo the db.select in Tier 3 — that's the only IMAP-free seam to mock).

## Self-Check: PASSED

All verification steps confirmed:

- `src/server/jobs/processReplies.ts` exists with the new exports — verified by grep counts above (matchReplyToOutreach: 2, isAutoReply: 2, markAsAutoReply: 2, OOO_SUBJECT_RE: 2).
- Task 1 commit `c9d4f4b` exists in `git log`.
- Task 2 commit `c9a2350` exists in `git log`.
- `npm run build` exits 0.
- IMAP search uses `since: sevenDaysAgo` and `MAX_PER_TICK = 500`.
- All four auto-reply signals are checked (Auto-Submitted, Precedence, X-Auto-Response-Suppress, OOO subject regex).
- `[outreach.replies]` log occurrences: 6 (defer_overflow + auto_reply matched + auto_reply unmatched + replied + unmatched + uid error = 6 sites, exceeds the minimum 4).
- All three match strategies present in source: `'in_reply_to'`, `'references'`, `'from_address'`.

---
*Phase: 16-reply-detection-v2-plus-per-inbox-throttle*
*Completed: 2026-05-17*
