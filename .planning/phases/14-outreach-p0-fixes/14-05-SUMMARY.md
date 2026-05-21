---
phase: 14-outreach-p0-fixes
plan: 05
subsystem: outreach/email-delivery
tags: [outreach, hmac, unsubscribe, list-unsubscribe, tracking, rfc8058, can-spam, suppressions]
requirements_satisfied:
  - P0-02
  - P0-03
  - P0-07 (unsubscribe path only — bounce path lands in 14-06)
dependency_graph:
  requires:
    - "14-03 (outreach_emails.tracking_token column + UNIQUE index, suppressions.source column)"
  provides:
    - "Shared outreach-tokens HMAC helper (generateOutreachToken / verifyOutreachToken) for unsub + track"
    - "RFC 8058-compliant unsubscribe endpoints at /o/u (GET = confirm page, POST = action + suppressions write)"
    - "List-Unsubscribe + List-Unsubscribe-Post headers on every SMTP outreach send (Gmail/Yahoo bulk-sender compliance)"
    - "{{unsubscribeUrl}} template variable in outreach bodies"
    - "Per-send HMAC tracking_token persisted into outreach_emails (replaces 14-03 placeholder)"
    - "Outreach lookup fork in /t/open + /t/click (analytics dashboards stop reporting 0% open rates)"
  affects:
    - "Plan 14-06 Task 2 must remove the transient call-site edit in processOutreachSequences (the trackingToken: sendResult.trackingToken! arg) as part of the idempotent-claim INSERT refactor"
tech_stack:
  added: []
  patterns:
    - "Stateless HMAC-SHA256 tokens (base64url(payload).base64url(hmac)) with constant-time compare (timingSafeEqual)"
    - "Fail-loud at module load when secret env var is missing (mirrors src/db/index.ts:7-9)"
    - "RFC 8058 GET-safety: read on GET, write on POST (defeats email-client URL prefetch)"
    - "Public-route mounting outside /api with dedicated rate limiter (auth via HMAC token, not JWT)"
key_files:
  created:
    - src/server/lib/outreach-tokens.ts
  modified:
    - src/server/routes/outreach/unsubscribe.ts
    - src/server/index.ts
    - src/server/lib/outreach-sender.ts
    - src/server/lib/template-variables.ts
    - src/server/routes/track.ts
    - src/server/jobs/processOutreachSequences.ts (transient — 1-line bridge to keep build green between 14-05 and 14-06)
decisions:
  - "HMAC secret falls back ENCRYPTION_KEY → JWT_SECRET, throws if both unset (production safety: empty-keyed HMAC would let any attacker forge mass-unsubscribe tokens)"
  - "60-day token TTL (P1-12 audit guidance — long enough for stale-link unsubscribes from old campaigns, short enough that a leaked key eventually rotates out)"
  - "expectedKind parameter on verify (kind: 'unsub' | 'track') so an unsub token cannot be replayed against /t/open and vice versa"
  - "GET /o/u/:token is side-effect-free (RFC 8058) — renders confirmation page with POST form. POST does the actual work. Defeats Gmail prefetch / Outlook Safelinks / anti-virus URL scanners that would otherwise fire unsubscribes without recipient intent"
  - "Unsubscribe mounted at /o/u (NOT /api/outreach/unsubscribe) so JWT middleware does not 401 email recipients; HMAC token IS the auth"
  - "Dedicated rate limiter (30/min) for /o/u/ — tighter than /t/ (100/min) because unsubscribe is human-interactive, not pixel-hit volume"
  - "track.ts does NOT HMAC-verify the token — the DB lookup (WHERE tracking_token = ?) is the gate. Forged tokens simply will not match any row. Skipping verify avoids one CPU op per pixel hit (high volume)"
  - "List-Unsubscribe headers injected on SMTP path only. Outlook OAuth path (sendMessageWithOutlook) does not currently accept arbitrary headers — known P1 limitation, deferred to phase 15"
  - "interpolateTemplate widened with optional 3rd-arg context, default {}; all existing 2-arg callers continue to work; surgical 3-edit instead of rewrite preserves built-in field handling + custom field lookup + case-variant scan"
metrics:
  duration_seconds: 484
  duration_human: "~8 minutes"
  tasks_completed: 6
  files_touched: 6
  commits: 6
  completed_at: "2026-05-17T04:33:35Z"
---

# Phase 14 Plan 05: Unsubscribe + outreach tracking + List-Unsubscribe headers Summary

One HMAC helper module + six surgical edits land three intertwined P0s (P0-02 tracking lookup, P0-03 unsubscribe wiring + compliance, P0-07 unsubscribe-path suppression write) in a single wave, taking the outreach module from "non-compliant with Gmail/Yahoo bulk-sender policy and gaslighting users with 0% open rates" to "RFC 8058-compliant with real per-send analytics".

## What was built

### 1. `src/server/lib/outreach-tokens.ts` (new, 78 lines)

Stateless HMAC-SHA256 token helper shared by unsubscribe + open/click tracking.

| Export | Purpose |
|---|---|
| `TokenKind = 'unsub' \| 'track'` | Type-level discriminator |
| `OutreachTokenPayload` | `{ kind, clid, cid?, ts }` |
| `generateOutreachToken(payload)` | Returns `base64url(payload).base64url(hmac)` |
| `verifyOutreachToken(token, expectedKind)` | Returns payload or `null`; constant-time compare; TTL check |

Module-load throw if `ENCRYPTION_KEY` AND `JWT_SECRET` are both unset (security: empty-keyed HMAC would let any attacker forge tokens).

### 2. `src/server/routes/outreach/unsubscribe.ts` (rewrite, 432 lines)

| Concern | Change |
|---|---|
| Token codec | base64-JSON → HMAC (drops `encodeToken`/`decodeToken`, adds `generateOutreachToken`/`verifyOutreachToken` imports) |
| RFC 8058 split | GET `/o/u/:token` renders confirm page (read-only). POST `/o/u/:token` performs unsubscribe. Old code did everything on GET, breaking under URL prefetch. |
| Suppressions | `processUnsubscribe` now `INSERT INTO suppressions (source='unsubscribe', ...) ON CONFLICT DO NOTHING` (P0-07 unsub path) |
| Link path | `generateUnsubscribeLink` now points to `/o/u/{token}` (was `/unsubscribe/{token}`) |
| New helper | `generateConfirmHtml(email, campaignName, token)` with a single-action `<form method="POST">` button |
| Safety | `escapeHtml` applied to all interpolated user data in HTML |

### 3. `src/server/index.ts` (+14 lines)

- Import `unsubscribeRoutes from './routes/outreach/unsubscribe'`
- `unsubscribeLimiter` (30 req/min) registered at line 85 before mount at line 246
- `app.use('/o/u', unsubscribeRoutes)` mounted OUTSIDE `/api/` (no JWT middleware, no 401 for email recipients)

### 4. `src/server/lib/outreach-sender.ts` (rewrite of `sendOutreachEmail` body, +33/-7)

- `SendResult` interface gains optional `trackingToken: string`
- At start of `sendOutreachEmail`: compute `baseUrl`, `unsubscribeUrl = generateUnsubscribeLink(...)`, `trackingToken = generateOutreachToken({kind:'track', clid, cid})`
- Pass `tplContext = { unsubscribeUrl }` as 3rd arg to `interpolateTemplate(...)` for subject/html/text
- `injectTracking` now receives the real HMAC `trackingToken` instead of the raw `campaignLeadId`
- `mailOptions.headers` includes `List-Unsubscribe: <https://.../o/u/{token}>, <mailto:unsubscribe@{domain}?subject=unsubscribe>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- Both Outlook and SMTP return paths now include `trackingToken` in `SendResult`
- `recordOutreachEmail`: removed TEMP placeholder, signature now requires `trackingToken: string`, INSERT writes the real value

### 5. `src/server/lib/template-variables.ts` (surgical 3-edit, +9/-1)

| Edit | Change |
|---|---|
| 1 | Added `export interface TemplateContext { unsubscribeUrl?: string }` before `DEFAULT_VALUES` |
| 2 | Widened signature: `interpolateTemplate(template, lead, context: TemplateContext = {})` (backward compatible — `= {}` default) |
| 3 | Added `if (variableName === 'unsubscribeUrl') return context.unsubscribeUrl ?? ''` as the FIRST line inside the existing `result.replace` callback |

All existing handling (BUILTIN_VARIABLES sweep, custom-field lookup, case-variant scan, fallback) PRESERVED untouched. Verified by post-edit greps: `BUILTIN_VARIABLES` still appears 4× and `lead.customFields` still appears 4×.

### 6. `src/server/routes/track.ts` (+52/-2)

| Handler | Change |
|---|---|
| `/t/open/:token` | Look up `outreach_emails.tracking_token` FIRST. If match: bump `openedAt` (if NULL), `openedCount + 1`, and propagate `totalOpens + 1` to `campaignLeads`, `campaigns`, `emailAccounts`. Fall through to `messages.token` for non-outreach mail. |
| `/t/click/:token` | Mirror with `clickedAt` / `clickedCount` / `totalClicks` |

Pixel response (`res.end(PIXEL)`) and 302 redirect (`res.redirect(targetUrl)`) still happen BEFORE the DB lookup — no recipient-side latency change.

### 7. `src/server/jobs/processOutreachSequences.ts` (transient +3, will be removed by 14-06)

Single 1-line addition to the `recordOutreachEmail` call site: `trackingToken: sendResult.trackingToken!`. This is **transient** — Plan 14-06 Task 2 removes the entire `recordOutreachEmail` call in favor of an idempotent-claim INSERT pattern (the trackingToken goes onto the placeholder row before send). Kept here to avoid breaking the build between 14-05 and 14-06 landing.

## HMAC token format (contract for future plans)

```
${base64url(JSON.stringify({ kind, clid, cid?, ts }))}.${base64url(hmacSha256(secret, payloadB64))}
```

- **kind**: `'unsub'` (issued by `generateUnsubscribeLink`) or `'track'` (issued in `sendOutreachEmail`)
- **clid**: campaignLeadId (the per-campaign per-lead row id)
- **cid**: campaignId (required for `'unsub'`, optional for `'track'`)
- **ts**: epoch ms; verify rejects if `Date.now() - ts > 60 days`
- **secret**: `process.env.ENCRYPTION_KEY || process.env.JWT_SECRET`

`verifyOutreachToken(token, expectedKind)` cross-checks the `kind` to prevent replay across endpoints.

## Deviations from Plan

None — plan executed exactly as written. All six tasks landed in the prescribed order with the prescribed grep counts:

- `outreach-tokens.ts`: `generateOutreachToken` (1), `verifyOutreachToken` (1), `timingSafeEqual` (1), `TOKEN_TTL_MS` (≥2), throw line (1) — all PASS
- `unsubscribe.ts`: `encodeToken|decodeToken` (0), `verifyOutreachToken` (3), `generateOutreachToken` (2), `db.insert(suppressions)` (1), `source: 'unsubscribe'` (1), `/o/u/` (3), `router.post` (1), `generateConfirmHtml` (2), `processUnsubscribe` (2 — definition + POST handler only, NOT in GET) — all PASS
- `index.ts`: `unsubscribeRoutes` import + mount + `unsubscribeLimiter` (2 lines: declare + apply), limiter on line 85 < mount on line 246 — all PASS
- `outreach-sender.ts`: `List-Unsubscribe` (2 — header + Post variant), `generateUnsubscribeLink` (2 — import + call), `generateOutreachToken` (2 — import + call), `TEMP: placeholder token` (0 — bridge removed), `trackingToken: params.trackingToken` (1) — all PASS
- `template-variables.ts`: `TemplateContext` (2 — export + signature), `context.unsubscribeUrl` (1, inside `result.replace` callback), `BUILTIN_VARIABLES` (4 — preserved), `lead.customFields` (4 — preserved) — all PASS
- `track.ts`: `outreachEmails.trackingToken` (2 — one per handler), `if (outreachEmail)` (2), `openedCount`/`clickedCount` (1 each), `db.query.messages.findFirst` (2 — fallback preserved) — all PASS

## Known limitations (documented, deferred)

| Item | Path | Resolution |
|---|---|---|
| Outlook OAuth send does not propagate `List-Unsubscribe` headers | `sendMessageWithOutlook` — Graph API constraint | Deferred to phase 15 (P1 in audit) — for now, only Outlook outreach sends miss the header; SMTP path (the majority) is compliant |
| `processOutreachSequences.ts` call site is transient | `recordOutreachEmail({ ..., trackingToken: sendResult.trackingToken! })` | Plan 14-06 Task 2 removes the entire call as part of the idempotent-claim refactor |

## RFC 8058 GET-safety — why the split matters

Before this plan, GET `/unsubscribe/{token}` called `processUnsubscribe` directly. That was a silent compliance bug:

- **Gmail Inbox** prefetches URLs in plain-text + HTML email bodies to show preview cards. Prefetch = GET. Recipient would be unsubscribed without ever clicking.
- **Outlook Safe Links** rewrites URLs and follows them server-side for malware scanning. Same problem.
- **Corporate antivirus URL scanners** (Mimecast, Proofpoint, Cisco ESA) do the same.

The new split:

```
GET  /o/u/:token  →  render confirmation HTML with <form method="POST"> button (NO DB writes)
POST /o/u/:token  →  processUnsubscribe + suppressions INSERT + respond (HTML or JSON per Accept header)
```

is the RFC 8058 contract and matches what Gmail's one-click unsubscribe specifically requires (`List-Unsubscribe-Post: List-Unsubscribe=One-Click` tells Gmail "you may POST this URL with no body to unsubscribe").

## Commits

| # | Hash | Message |
|---|---|---|
| 1 | `e8592c6` | feat(14-05): add outreach-tokens HMAC helper with fail-loud module load |
| 2 | `131652b` | feat(14-05): unsubscribe router HMAC tokens + RFC 8058 GET-safety + suppressions write |
| 3 | `01e92c6` | feat(14-05): mount unsubscribe router at /o/u with dedicated rate limiter |
| 4 | `1ef49da` | feat(14-05): inject List-Unsubscribe headers + real HMAC tracking_token in outreach-sender |
| 5 | `3c70417` | feat(14-05): add TemplateContext + {{unsubscribeUrl}} variable to interpolateTemplate |
| 6 | `41400ad` | feat(14-05): fork /t/open and /t/click to look up outreach_emails.tracking_token first |

(Commit #4 also includes the transient 1-line edit to `processOutreachSequences.ts` to keep the build green; that file is otherwise owned by Plan 14-06.)

## Verification

- `npm run build` exits 0 (after Task 5 widens `interpolateTemplate`; transiently red between Task 4 and Task 5 by design)
- All acceptance-criteria greps PASS (counts enumerated under "Deviations from Plan" above)
- `grep -c "TEMP: placeholder token" src/server/lib/outreach-sender.ts` returns 0 — bridge from 14-03 removed
- No edits to `src/server/routes/outreach/campaigns.ts` (14-04 territory)

## Contracts published for later plans

**Plan 14-06 (P0-07 bounce-path suppression + P0-05/P0-06 race fixes):**
- The `recordOutreachEmail` call in `src/server/jobs/processOutreachSequences.ts:237` is **owned by 14-06 Task 2** for removal. Replace with an idempotent-claim INSERT of the `outreach_emails` placeholder row (with the trackingToken pre-generated) before the send call.
- To generate the tracking token for the placeholder row before send: `generateOutreachToken({ kind: 'track', clid: campaignLeadId, cid: campaign.id })` from `src/server/lib/outreach-tokens.ts`.
- Bounce-path suppression: `INSERT INTO suppressions (..., source: 'bounce') ON CONFLICT DO NOTHING` — mirror the pattern in `unsubscribe.ts:286-294`.

**Operator follow-up (none required for this plan):**

Migration 020 already covers all schema needs (landed in 14-03). No new SQL to run. The HMAC secret env vars (`ENCRYPTION_KEY` or `JWT_SECRET`) are already in the GitHub Secrets list per CLAUDE.md.

## Self-Check: PASSED

Files verified to exist:
- FOUND: src/server/lib/outreach-tokens.ts (new)
- FOUND: src/server/routes/outreach/unsubscribe.ts (modified)
- FOUND: src/server/index.ts (modified)
- FOUND: src/server/lib/outreach-sender.ts (modified)
- FOUND: src/server/lib/template-variables.ts (modified)
- FOUND: src/server/routes/track.ts (modified)
- FOUND: src/server/jobs/processOutreachSequences.ts (transient 1-line edit)

Commits verified in git log:
- FOUND: e8592c6
- FOUND: 131652b
- FOUND: 01e92c6
- FOUND: 1ef49da
- FOUND: 3c70417
- FOUND: 41400ad
