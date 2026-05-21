---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: — Outreach Hardening)
status: verifying
stopped_at: Completed 17-04-PLAN.md (daily outreach digest cron) — Phase 17 + v1.3 milestone DONE
last_updated: "2026-05-17T15:50:38.131Z"
progress:
  total_phases: 9
  completed_phases: 9
  total_plans: 28
  completed_plans: 28
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-15)

**Core value (v1.2):** An end-user can configure `user@skale.club` in Thunderbird / Outlook / Apple Mail and send/receive email reliably from/to the public internet.

## Deploy target

**Hetzner VPS** — Docker container via GitHub Actions `.github/workflows/deploy-hetzner.yml`. Caddy reverse-proxies HTTP only; mail ports (25/587/993) are direct TCP from container. **Not Vercel, not Railway.**

## Current Position

Phase: 17
Plan: Not started
Milestone: v1.3 (Outreach Hardening) — **all code complete**
All 4 phase codebases (10-13) merged (commit `3b2cc41`).
Status: Phase 17 complete — ready for verification

**Resume point:** Verification pass on Phase 17, then attend `.planning/OPERATOR-CHECKLIST.md` items (certbot install on Hetzner, Hetzner port 25 ticket, Thunderbird end-to-end test).

Progress: [██████████] 100% (code 28/28 plans done; v1.2 ops still pending)

### v1.2 Phase Status

| Phase | Code | Ops | Notes |
|---|---|---|---|
| 10 TLS certs | ✅ merged | ⏳ certbot install on host + docker restart | Deploy wiring in `.github/workflows/deploy-hetzner.yml` ready |
| 11 DNS + autoconfig | ✅ merged | ✅ **DNS records already published** | Verified: `skale.club` is `verification_status=verified` in DB with spf/dkim/dmarc/mx all verified |
| 12 DKIM + mailauth | ✅ merged | — (no ops) | Active on next deploy; `src/server/lib/dkim.ts`, `mail-auth.ts`; wired into `smtp-server.ts` and `mx-server.ts` |
| 13 MX hardening | ✅ merged | ⏳ Hetzner ticket for port 25 unblock | `src/server/lib/mx-guard.ts` with rate-limit/DNSBL/greylist wired into `mx-server.ts` |

## Completed milestones

### v1.1 — Database Health (2026-04-01)

- [x] Phase 05: RLS & Migration Safety
- [x] Phase 06: Index Foundation
- [x] Phase 07: Pagination
- [x] Phase 08: Query Optimization
- [x] Phase 09: Schema Hardening

### v1.1 mid-cycle — Mail Server Core (2026-04-15, commit `8316a86`)

Full IMAP/SMTP/MX stack, SASL PLAIN/LOGIN, UID ops, autodiscovery routes, UI card, migration 018.

### v1.2 code (2026-04-15, commit `3b2cc41`)

- TLS deploy wiring (volume mount + env vars)
- DKIM signing in relayMessage via nodemailer `dkim` option
- mailauth SPF/DKIM/DMARC verification in MX receiver
- MX hardening (rate-limit, DNSBL, greylist, header validators)
- `scripts/dns-checklist.ts` helper
- `.planning/OPERATOR-CHECKLIST.md` for remaining manual ops

## Pending next actions (in order)

1. **Install certbot on Hetzner host** (one-time, ~5 min). See `.planning/OPERATOR-CHECKLIST.md` §2.
2. **Open Hetzner ticket** requesting port 25 unblock. See `.planning/OPERATOR-CHECKLIST.md` §3. Wait 24-48h.
3. **End-to-end Thunderbird test** with `user@skale.club`. See `.planning/OPERATOR-CHECKLIST.md` §4.
4. **48h observability** of MX logs for false positives (`.planning/OPERATOR-CHECKLIST.md` §5).
5. **Optional — promote DMARC policy** from `p=none` to `p=quarantine` after 1-2 weeks clean (`.planning/OPERATOR-CHECKLIST.md` §6).

## Accumulated Context

### Roadmap Evolution

- 2026-05-16: Phase 14 added — **Outreach P0 fixes** (numbered 14 to follow v1.2 phases 10-13; effectively kicks off informal milestone v1.3 "Outreach Hardening"). Driven by deep audit at `.planning/debug/outreach-system-deep-audit.md` (10 P0 / 20 P1 / 19 P2 findings).

### Decisions (v1.3 — Outreach Hardening)

- **(17-02) Pino action namespace `outreach.<area>.<event>`**: 6 areas (send, processor, replies, bounce, track, jobs) × ~3-7 events each; the `action` field is the primary `jq` grep key. Skip events kept at `info` level (not debug) because they are the primary "why isn't this campaign sending?" ops signal and must be visible at default LOG_LEVEL=info. Track HMAC tokens truncated to 12 chars + `...` at log call sites (explicit boundary redaction, not lazy global config).
- **(17-02) Processor tick ring buffer co-located in `processOutreachSequences.ts`** (not a separate `lib/processor-metrics.ts` file): the `recordTick()` call lives 2 lines below the `performance.now()` measurement so co-location prevents temporal coupling bugs. 17-03 writes its own `outreach-metrics.ts` for DB-aggregate concerns — different problem.
- **(17-03) Health endpoint shape + aggregate helper reuse**: `GET /api/admin/outreach/health` returns `{asOf, overall, byOrg, topBouncingCampaigns, alerts, thresholds, _meta}`. Aggregate SQL helpers live in `src/server/lib/outreach-metrics.ts` (pure, no logger calls) and are reused verbatim by Plan 17-04's daily digest. Sample-size floors on bounce alerts (sent>=20 for 1h, sent>=100 for 24h) prevent tiny-window false positives. Composite index `(sent_at, status)` on `outreach_emails` added via migration 022 (CONCURRENTLY IF NOT EXISTS).
- **(17-04) Daily outreach digest is LOG-ONLY at 09:00 UTC**: cron `0 9 * * *` with explicit `{ timezone: 'UTC' }` (matches 16-04 resetDailyLimits idiom). Emits ONE pino info line with `action='outreach.digest.daily'` containing the full snapshot (overall + byOrg + topBouncingCampaigns + alerts) plus a `summary` scoreboard block (healthy/warning/critical org counts + alertCount). Reuses 17-03 aggregate helpers verbatim — zero SQL duplication. Job catches its own exceptions (logs `outreach.digest.failed`); cron wrapper has defence-in-depth `.catch` (logs `outreach.jobs.dailyOutreachDigest_failed`). No email/slack/webhook per Phase 17 scope — Phase 18+ wires notifications by reading the same JSON payload.
- **(15-01) Campaign detail tabs as component state, not nested wouter routes**: preserves `/outreach/campaigns/:id` as a stable bookmarkable URL; skips installing the shadcn Tabs primitive since `src/components/ui/` doesn't have one. CONTEXT.md §66 authorises the fallback.
- **(15-01) Stub-then-fill pattern for parallel waves**: `CampaignDetailPage.tsx` imports default-exported placeholder tab children (`LeadsTab`, `SequenceTab`, `StatsTab`) so plans 15-02 and 15-03 can overwrite entire tab files in parallel without touching the parent page or `main.tsx`.
- **(15-01) queryKey conventions for parallel tabs**: `['campaign', orgId, id]` for the detail fetch; `['campaign-stats', orgId, campaignId]` for OverviewTab stats. Plan 15-03's Stats tab should use a distinct key (e.g. `['campaign-stats-detail', ...]`) to avoid invalidation fights with Overview.
- **(16-03) Auto-reply filter runs BEFORE 3-tier match**: `isAutoReply` short-circuit (RFC 3834 Auto-Submitted + RFC 2076 Precedence + MS X-Auto-Response-Suppress + EN/PT/ES OOO subject regex) prevents OOO from tripping `markAsReplied`. Auto-reply hits tag `outreach_emails.bounceReason='auto_reply'` (existing Phase 14 column — zero migration cost) without mutating `campaign_leads.status`, so the sequence keeps progressing.
- **(16-03) Exported `matchReplyToOutreach` 3-tier matcher**: priority order is In-Reply-To → References chain (split on whitespace, each token tried) → from-address heuristic. Tier 3 is account-scoped + 30-day `sentAt` windowed + `LOWER(leads.email)` case-insensitive + ordered by `sentAt DESC NULLS LAST` so the most-recent outreach is stamped if the lead is in multiple campaigns. Pure-ish (only db dependency in Tier 3) so Phase 18 can unit-test without an IMAP fixture.
- **(16-03) IMAP search bounded**: search SINCE 7 days + 500 UIDs per tick cap; overflow logged as `defer_overflow` and inherently retried (unread UIDs are not flagged Seen on overflow). Unmatched messages are NEVER flagged `\Seen` — they may be legitimate human emails; preserving unread state is a user-visible courtesy.

### Decisions (v1.2)

- **Hetzner over Vercel for mail**: Vercel Functions are HTTP-only serverless; mail servers need long-lived TCP. Hetzner VPS + Docker + GitHub Actions already in place.
- **mx-server.ts kept, smtp-inbound.ts removed during merge**: mine has TLS + UID allocation + folder-count recompute.
- **Let's Encrypt via certbot, not Caddy**: Caddy has its own certs but in Caddy-specific layout. Dedicated certbot keeps standard path `/etc/letsencrypt/live/...` and clear renewal hook via `docker restart`.
- **mailauth over custom verification code**: one-call SPF/DKIM/DMARC/ARC verification; actively maintained; used by Postal itself.
- **DKIM signing ONLY in relayMessage (not outreach-sender)**: outreach-sender uses user's own SMTP (Gmail/Outlook) which signs with their own DKIM — re-signing with ours would invalidate.
- **DMARC reject downgraded to quarantine in dev**: `hasMailTLS()=false` → `verdict: 'reject' → 'quarantine'` so local testing with spoofed From isn't blocked.
- **Greylist in-memory Map, not DB**: acceptable for single-container deploy; resets on restart re-greylists everyone for 5min (acceptable trade-off).

### Blockers/Concerns

- **Hetzner port 25 approval timing** — 24-48h SLA; don't block parallel work
- **Supabase migration history drift** (015-017 local/remote mismatch) — carried from v1.1
- **ESLint config missing** — pre-existing; not blocking

## Session Continuity

Last session: 2026-05-17T15:46:34.589Z
Stopped at: Completed 17-04-PLAN.md (daily outreach digest cron) — Phase 17 + v1.3 milestone DONE
Resume file: None
Next action: execute `.planning/OPERATOR-CHECKLIST.md` section 2 (install certbot on Hetzner) — unblocks Thunderbird TLS connection
