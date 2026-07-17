---
gsd_state_version: 1.0
milestone: v1.4
milestone_name: Reliable Outreach + Unified Inbox
status: executing
stopped_at: Completed 23-04-PLAN.md
last_updated: "2026-07-16T23:04:06.188Z"
progress:
  total_phases: 15
  completed_phases: 10
  total_plans: 41
  completed_plans: 41
  percent: 60
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-15)

**Core value (v1.2):** An end-user can configure `user@skale.club` in Thunderbird / Outlook / Apple Mail and send/receive email reliably from/to the public internet.

## Deploy target

**Hetzner VPS** — Docker container via GitHub Actions `.github/workflows/deploy-hetzner.yml`. Caddy reverse-proxies HTTP only; mail ports (25/587/993) are direct TCP from container. **Not Vercel, not Railway.**

## Current Position

Phase: 23 (AI Inbox Automation and Guardrails) — COMPLETE + VERIFIED (FINAL phase). Milestone v1.4 is CODE-COMPLETE.
Plan: 4 of 4 complete (23-01 AI foundation+migration 043, 23-02 no-send suggestion endpoint, 23-03 retired legacy direct-send/leased autonomous dispatch, 23-04 opt-in controls+audit history+adversarial eval suite+milestone UAT). 3-lens review: tenant-isolation clean, 1 critical (autonomous follow-up cap was inoperative) + 4 minor all fixed and re-reviewed; 907/907 tests deterministic.
Phase 22 (Unified Inbox Operator Experience) — COMPLETE + VERIFIED (UIX-01..06, 19/19 must-haves; 3-lens review 1 critical + 6 warnings all fixed and re-reviewed; 700/700 tests deterministic)
Phase 21 (Unified Inbox Foundation) — COMPLETE + VERIFIED (UIF-01..05, 43/43 must-haves; 3-lens review 0 critical + 3 warnings all fixed and re-reviewed; 527/527 tests deterministic)
Phase 20 (Outreach Product and API Consistency) — COMPLETE + VERIFIED (CONS-01..07; security + data-migration reviews clean; verifier found 1 blocking gap + 5 non-blocking, all fixed and re-reviewed clean; 422/422 tests)
Phase 19 (Provider Parity and Deliverability) — COMPLETE + VERIFIED (PROV-01..05; review found 3 critical + 5 warnings, all fixed and re-reviewed clean; 353/353 tests)
Phase 18 (Outreach Safety and Execution Reliability) — COMPLETE + VERIFIED (6/6 requirements, 94/94 tests)
Milestone: v1.4 (Reliable Outreach + Unified Inbox) — **planned**
All 4 phase codebases (10-13) merged (commit `3b2cc41`).
Status: ★ MILESTONE v1.4 CODE-COMPLETE ★ — all 6 phases (18-23) implemented, reviewed (3-lens adversarial per phase), and verified. Full suite 907/907, deterministic. What remains is the manual production deploy (see Resume point), which is NOT auto-applied.

**Also this session:** made the Vitest postgres project a deterministic gate (commit a87ee0b) — root-level fileParallelism:false + container max_connections=300 + a suite that self-applies its migration. This fixed the flaky deadlocks/timeouts that dogged phases 19-20 reviews.

**Resume point:** Close Phase 23 after review-fix. Then the v1.4 milestone (phases 18-23) is CODE-COMPLETE. Remaining work is the manual production deploy, NOT auto-applied: apply migrations 038→043 in ascending order; provision the private inbox-attachments Storage bucket; set XMAIL_SERVICE_USER_ID + XMAIL_SERVICE_ORGANIZATION_ID; run the Outlook Graph sandbox gate; then the two-tenant/provider/restart UAT rows and the AI live-provider send.

**Every send in the system now flows through the Phase 18 shared delivery policy gate** (campaign, follow-up, manual, and inbox reply/forward). Phase 23 AI automation MUST use that same gate — no autonomous send may bypass it.

**Operator prerequisites — status (updated 2026-07-17):**

- ✅ **DONE — Migrations 038–043 APPLIED to production** (2026-07-17, via a targeted `postgres.js` runner, prepare:false, against the aws-1-us-east-2 pooler). All 14 v1.4 tables + key columns verified present; versions registered in `supabase_migrations.schema_migrations`. Prod had 0 campaigns/0 sequences so 040's merge was a no-op. NOTE: a pre-existing tracking drift remains — migrations 023–037 are applied to the schema but unregistered in `schema_migrations`; left untouched deliberately (do NOT run the naive "apply all pending" runner, it would try to re-run 023–037). The v1.4 apply used an explicit 038–043 whitelist.
- ✅ **DONE — private `inbox-attachments` Storage bucket** created by migration 042 (verified `public=false`).
- ✅ **DONE — git aligned**: local `main`, `origin/main`, local `dev`, `origin/dev` all at `656f45d`.
- ✅ **DONE — app deployed** (2026-07-17): the push's `[skip ci]` tip suppressed auto-deploy, so triggered manually via `gh workflow run "Build and Deploy" --ref main` (run 29579320899). Blue-green rollout succeeded; `mail.skale.club` healthy (`/` and `/health` → 200). v1.4 code is LIVE.
- ⏳ New env vars `XMAIL_SERVICE_USER_ID` + `XMAIL_SERVICE_ORGANIZATION_ID` — not set as GitHub secrets; until set, outreach machine auth (Xphere orchestrator) stays disabled (fails closed — safe). Values require the user's actual user/org IDs.
- ⏳ Outlook Graph sandbox gate (19-04) unrun — needs a real Microsoft 365 tenant. Entire Graph surface is mock-verified only.

> **Progress counters:** the `state` tool derives these from ROADMAP-registered phases
> only (05-09 + 14-23 = 15 phases, 41 plans, 24 summaries). Phases 10-13 exist under
> `.planning/phases/` and are code-merged, but have no ROADMAP section and no SUMMARY
> files, so they are excluded — which is why the counters read lower than the
> hand-maintained 45/28 series used before 2026-07-16. The tool's numbers are
> self-consistent and regenerated on every write; do not hand-edit them.

Progress: [██████░░░░] 60%

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
- 2026-07-15: Opened milestone v1.4 with phases 18–23 for outreach execution reliability, provider parity, product/API consistency, Unified Inbox, and guarded AI automation. Source: `.planning/AUDIT-PRD.md`; traceability: `.planning/REQUIREMENTS.md`.

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

Last session: 2026-07-16T23:03:48.241Z
Stopped at: Completed 23-04-PLAN.md
Resume file: None
Next action: execute Phase 19 Plan 04 (Outlook Graph inbound sync + activation gate).

## Performance Metrics

| Phase | Plan | Duration | Notes |
|-------|------|----------|-------|
| Phase 18 P01 | 13 min | 3 tasks | 11 files |
| Phase 18 P02 | 8 min | 2 tasks | 4 files |
| Phase 18 P03 | 18 min | 2 tasks | 10 files |
| Phase 18 P04 | 16 min | 3 tasks | 11 files |
| Phase 19 P01 | 12min | 2 tasks | 7 files |
| Phase 19 P02 | 18min | 2 tasks | 7 files |
| Phase 19 P03 | 22min | 2 tasks | 10 files |
| Phase 19 P04 | 32min | 3 tasks | 8 files |
| Phase 20 P01 | 34min | 3 tasks | 11 files |
| Phase 20 P02 | 41min | 3 tasks | 19 files |
| Phase 20 P03 | 24min | 3 tasks | 17 files |
| Phase 21 P01 | 35min | 3 tasks | 4 files |
| Phase 21 P02 | 35min | 3 tasks | 9 files |
| Phase 21 P03 | 30min | 3 tasks | 14 files |
| Phase 21 P04 | 17min | 3 tasks | 6 files |
| Phase 22 P01 | 42min | 3 tasks | 12 files |
| Phase 22 P02 | 23 min | 3 tasks | 11 files |
| Phase 22 P03 | 28min | 3 tasks | 13 files |
| Phase 22 P04 | 34min | 3 tasks | 16 files |
| Phase 22 P05 | 16 | 3 tasks | 12 files |
| Phase 23 P01 | 20min | 3 tasks | 6 files |
| Phase 23 P02 | 27min | 3 tasks | 11 files |
| Phase 23 P03 | 22min | 3 tasks | 9 files |
| Phase 23 P04 | 32min | 3 tasks | 13 files |

## Decisions

- [Phase 18]: Explicit delay rows own their wait; email-to-delay transitions are immediate. — Applies delayHours exactly once while preserving email-only timing.
- [Phase 18]: Activation validates the oldest-created canonical sequence and returns stable 422 issue codes. — Matches current enrollment selection until Phase 20 adds an explicit canonical sequence.
- [Phase 18]: Unknown provider acceptance becomes held and is never retried automatically. — SMTP cannot prove exactly-once delivery after remote acceptance and process loss.
- [Phase 18]: Every dispatch finalize is conditioned on the owning lease token. — Expired workers cannot overwrite a newer recovery decision.
- [Phase 18]: Retry classification distinguishes known pre-acceptance negatives from terminal and ambiguous failures. — Only safe SMTP 4xx, HTTP 408/429/5xx, DNS, and pre-DATA connection failures receive bounded backoff.
- [Phase 18]: Rank due work per account before applying the global cap. — One blocked or backlogged inbox cannot starve other verified accounts.
- [Phase 18]: All outreach origins use one durable dispatcher boundary. — Campaign, manual, and agentic sends share policy, leases, retries, and idempotency.
- [Phase 18]: Due-work selection and campaign completion import one exhaustive terminal-status set. — New lead statuses cannot silently diverge between scheduling and completion.
- [Phase 19]: SMTP port 465 = implicit TLS, 587 = required STARTTLS, 25 = opportunistic STARTTLS; one resolver (smtp-security.ts) shared by verify, send, presets, and CSV import
- [Phase 19]: Legacy smtp_secure/port contradictions normalize with a warning rather than failing; only explicit contradictory writes get 422 smtp_tls_mode_mismatch
- [Phase 19]: Outlook outreach uses Graph MIME sendMail; the JSON message shape cannot carry List-Unsubscribe and returns no Message-ID
- [Phase 19]: Outreach MIME is composed once and transmitted byte-identically by SMTP, native, and Outlook; the precomposed Message-ID always wins over a transport-invented one
- [Phase 19]: (19-03) Inbound classification happens ONCE at ingestion, DSN/bounce before auto-reply before human reply; reply and bounce jobs consume disjoint durable classifications from outreach_provider_events and can no longer race by marking a DSN read first.
- [Phase 19]: (19-03) Ingestion progress lives in outreach_provider_cursors (Graph delta / IMAP uidvalidity+uid / native received-at+id), never in user read state; the event-store port has no read-flag surface so isRead/\Seen cannot be reintroduced as a cursor.
- [Phase 19]: (19-03) IMAP provider_message_id prefers the internet Message-ID over uid coordinates, because uid:<validity>:<uid> is not stable across a UIDVALIDITY reset and would re-ingest the whole mailbox as new events.
- [Phase 19]: Outlook fresh-chain state is carried on the delta cursor itself; it cannot be inferred from a null cursor or the link shape
- [Phase 19]: Outlook send capability is asserted from the granted Mail.Send scope: Graph has no zero-send probe, and the gate is stated in the verify response
- [Phase 20]: Campaign sequences: one DB-enforced canonical sequence per campaign; transactional replace endpoint derives one-based step order from array position and returns 409 rather than orphaning referenced steps
- [Phase 20]: (20-02) Settings are create-time defaults merged explicit ?? resolved; existing rows never rewritten. Notification toggles gate the Xphere reply/bounce/unsubscribe event transport (weekly_report removed as unsupported).
- [Phase 20]: (20-02) Campaign metric denominators: contactedLeads = unique leads with >=1 sent email (excludes pre-send suppressed); sentEmails email-grain; one shared DTO across list/stats/detail/analytics. Lead list bounded to limit<=100 with escaped ILIKE search and id tie-break.
- [Phase 20]: (20-03) Outreach uses one canonical JS access module (requireOutreachRead/Write); the service key binds identity+org server-side (overwrite x-user-id, reject/marker-enforce org scope), and a dedicated OutreachCheck guard lets org members enter outreach without platform admin.
- [Phase 21]: (21-01) Provider-event materialization is a dedicated leased CAS lifecycle (materialization_status/lease/attempts/error/materialized_at/conversation_message_id), never reusing Phase 19 processed_at; a partial claim index over pending|processing drives it.
- [Phase 21]: (21-01) Message dedupe key is the provider-native source_key unique per (organization_id, email_account_id, source_key); RFC Message-ID is indexed but deliberately non-unique.
- [Phase 21]: (21-01) Cross-tenant safety is DB-enforced via composite (id, organization_id) FKs on every child; campaign_lead is bound through its campaign via (campaign_lead_id, campaign_id) since campaign_leads has no organization_id.
- [Phase 21]: (21-02) Two independent lifecycles on outreach_provider_events: Phase 19 processed_at (classification side effects) vs Phase 21 materialization_status/lease/attempts (durable message). The materializer never reads/writes/claims processed_at; idempotency is DB-enforced via unique (org,account,source_key) + FOR UPDATE + 'materialized' short-circuit.
- [Phase 21]: (21-02) Attribution precedence In-Reply-To -> References(root-first) -> trustworthy provider thread -> bounded address heuristic, scoped by org AND account with strategy+confidence recorded. Ambiguity = one lead across multiple campaigns (leads unique per org+email) -> unattributed; never cross-org.
- [Phase 21]: (21-03) Provider field mapping lives in one boundary (unified-inbox/providers/{native,imap,outlook}.ts); IMAP now retains the full safe-header allow-list (was a 6-header subset), so native/IMAP/Graph materialize equivalent fields. Attachments stay metadata-only (id/name/mime/size/inline/contentId).
- [Phase 21]: (21-03) Every durably sent outreach_email materializes to ONE outbound conversation message (source_key outreach-email:<id>) via the SOLE best-effort hook in outreach-dispatch.ts after finalizeSent; a bounded restart-safe NOT EXISTS anti-join backfill (outbound before inbound) closes crash windows without resending. Outbound roots its thread by its own Message-ID so inbound replies converge.
- [Phase 21]: Unified Inbox read API: opaque filter-bound keyset cursor (SHA-256 fingerprint of the filter set, lossless microsecond keyset timestamp); detail/read-state authorize org before id lookup so cross-tenant ids return an existence-safe 404; per-user idempotent read state
- [Phase 22]: (22-01) Archive is orthogonal to Phase 21 open/closed status (additive archived_at columns); operator state (labels/archive/reminders/snippets/send-commands) is durable org-scoped rows, never browser state. Composite (id,organization_id) FKs bind every operator row to its tenant; PG15+ column-list ON DELETE SET NULL keeps organization_id intact.
- [Phase 22]: (22-01) Bulk ops are transactional + bounded (<=100, dedup, matched/updated/skipped) and key every mutation on the org-matched id set so an empty/partial filter never widens to the org. Durable send commands are lease-claimed; executeInboxSendCommand is the ONE inbox caller of dispatchOutreachMessage and a stable idempotency key yields at-most-once across restarts. Reminders notify once via a transactional scheduled->notified + user_notification insert.
- [Phase 22]: (22-02) Unified Inbox is server-owned: validated URL filter/search/cursor state maps to the Phase 21 query; the client never downloads an org mailbox to filter in memory. Keyset cursor resets on any filter change.
- [Phase 22]: (22-02) Every React Query key is org-scoped (['outreach-inbox', organizationId, ...]); an org change yields fresh keys and drops the prior tenant's selected conversation+cursor from the URL — no cross-tenant cache reuse.
- [Phase 22]: (22-02) Responsive workspace is CSS-driven: desktop three regions, tablet filter overlay, mobile single staged list->thread with Back — no JS width math; list/thread async states are independently recoverable.
- [Phase 22]: (22-03) Operator actions use optimistic UI ONLY with rollback (locked #4): a shared engine snapshots every affected org list query + the detail, patches deterministic fields, restores the exact snapshot on 4xx/5xx, reconciles from the server response, and invalidates unread+list on settle so the server owns ordering/membership.
- [Phase 22]: (22-03) Suppression is server-authoritative (locked #8): client always previews server-side, always confirms, needs a SECOND confirm for domain scope; a public/free-mail domain block is refused with 400. Domain blocks store an @domain sentinel that the delivery policy matches, denying every current+future address at the domain. Bulk is bounded at the source to 100 and honest about its real selected count.
- [Phase 22]: (22-04) Reply/reply-all/forward recipients + RFC threading headers are resolved SERVER-SIDE from persisted messages (the route schema has no reply-mode recipient/header field, so a client cannot spoof them); every immediate or scheduled send is a durable command dispatched only by executeInboxSendCommand behind the Phase 18 policy gate.
- [Phase 22]: (22-04) Attachments are bounded, org-owned, private-bucket, non-base64 bytes (server measures actual size; authenticated raw-body upload; server-chosen path); reply-all Cc/Bcc are suppression-filtered before the MIME; policy denial reschedules and preserves the draft with a recoverable reason.
- [Phase 22]: Near-real-time via ONE org-scoped authenticated-fetch SSE stream (never EventSource) carrying ids/counts only; disconnect falls back to bounded unread/list polling with visible stale state
- [Phase 23]: Effective AI autonomy = intersection of org autonomous_enabled AND campaign ai_autonomous_enabled AND clear kill switch AND Phase 18 policy; both flags default OFF (migration 043)
- [Phase 23]: 23-02: AI draft suggestion path is no-send-by-construction (imports no dispatcher); draft flows into the existing Phase 22 composer; disabled setting = clean not_enabled gate
- [Phase 23]: Autonomous AI follow-up retires the direct-send path: every AI send is a durable Phase 22 command through the single executeInboxSendCommand executor + Phase 18 policy gate; effective autonomy = org+campaign+unpaused, rechecked at claim and before dispatch
- [Phase 23]: AI control changes audited via structured log (actor+org), no schema change
- [Phase 23]: Immediate pause is unconditional (kill switch never blockable); flag edits are 409-guarded
