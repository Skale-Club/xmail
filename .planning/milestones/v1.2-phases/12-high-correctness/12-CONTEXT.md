# Phase 12: HIGH Correctness & Validation - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning
**Mode:** Auto-generated (autonomous mode — audit is the spec)

<domain>
## Phase Boundary

Eliminate functional/data bugs and finally make lint enforceable. After this phase, webhooks recover from transient failures, click tracking ignores replays, suppression list actually blocks sends, /move can't corrupt folders, and `npm run lint` enforces zero warnings.

**In scope (ROADMAP success criteria):**
1. `POST /webhooks/:id/test` uses `AbortSignal.timeout(10_000)`.
2. `fireWebhooks` retries with exponential backoff (1s/3s/9s, max 3) and persists each attempt with `attempts` counter.
3. Click tracking deduplicates per `(messageId, token)` in 60s window.
4. `PUT /api/system/outreach/global-toggle` exists with Zod + audit response; old endpoint gone (or 410).
5. `POST /:mailboxId/messages/:messageId/move` validates folderId belongs to mailbox.
6. `POST /api/messages` checks `suppressions` before send.
7. `.eslintrc.cjs` exists, `npm run lint` passes zero warnings.

**Out of scope:** RLS consolidation migration (Phase 13), schema field rename (Phase 13), CSP hardening (Phase 13).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion (audit Fase 2 Blocos 2.2, 2.3, 2.7, 2.8, 2.9, 2.10)

### Webhook timeout/retry (COR-01, COR-02)
- Add `AbortSignal.timeout(10_000)` to test endpoint.
- `fireWebhooks` retry loop: 3 attempts, sleeps 1s/3s/9s between attempts. Each attempt inserts row in `webhook_requests` with `attempts` count.
- If schema lacks `attempts` column → add via migration 019.
- Retry only on 5xx/timeout/network error. 4xx = permanent fail.

### Click replay dedup (COR-03)
- Simplest: add `clicked_at TIMESTAMP` column to a `track_events (messageId, token, kind, last_at)` table if not exists, or use in-memory Map with TTL for ephemeral dedup.
- Plan: use existing tables if `messages.clickedAt` exists, otherwise create migration 020. Prefer in-DB dedup so multi-instance works.

### Outreach toggle (COR-04)
- New route: `PUT /api/system/outreach/global-toggle` with Zod `{ enabled: boolean }`.
- Returns `{ affectedRows, previousState, userId, timestamp }`.
- Old route returns 410 Gone or is removed (executor decision).
- Audit log: `console.log(`[audit] outreach-toggle user=${userId} from=${prev} to=${enabled}`)`.

### /move validation (COR-05)
- Query folder by `folderId AND mailboxId = mbox` before update. If null → 400.

### Suppression check (COR-06)
- `POST /api/messages`: query `suppressions WHERE organizationId = ? AND emailAddress IN to`. Return 400 with list.
- Use batch `inArray` (Phase 08 pattern).

### ESLint config (COR-07)
- Create `.eslintrc.cjs` with: `@typescript-eslint/parser`, plugins `react-hooks`, `react-refresh`. Rules: no-unused-vars (with `_` prefix exception), no-explicit-any (warn), react-hooks/exhaustive-deps.
- Run `npm run lint`, fix top warnings inline. Document remaining acceptable warnings in `.eslintrc.cjs` overrides.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/server/lib/tracking.ts` — `fireWebhooks` with timeout, no retry.
- `src/server/routes/webhooks.ts` — `POST /:id/test` without timeout.
- `src/server/routes/track.ts` — click handler.
- `src/server/routes/mail/messages.ts` — `/move` endpoint.
- `src/server/routes/messages.ts` — `POST /` (send) endpoint.
- `src/server/routes/system.ts` — outreach toggle endpoint.

### Established Patterns
- Zod on POST/PUT bodies.
- `inArray` for batch queries (Phase 08).
- `webhook_requests` table for audit log.

### Integration Points
- COR-02 may need migration 019 (`webhook_requests.attempts` column if missing).
- COR-03 may need migration 020 (track_events table).

</code_context>

<specifics>
## Specific Ideas

Audit Fase 2 Blocos 2.2, 2.3, 2.7, 2.8, 2.9, 2.10 — verbatim implementation notes.

</specifics>

<deferred>
## Deferred Ideas

- Webhook dead-letter queue (out-of-scope per REQUIREMENTS.md).
- Per-user rate limit (deferred to v1.3).

</deferred>
