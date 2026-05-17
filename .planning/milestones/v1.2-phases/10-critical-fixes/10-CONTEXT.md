# Phase 10: CRITICAL Fixes - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss — autonomous mode, audit is the spec)

<domain>
## Phase Boundary

Eliminate the four CRITICAL audit findings (C1–C4) so cascade deletes are safe, health checks tell the truth, the test-connection proxy is closed, and the auth model is honestly documented.

**In scope (from ROADMAP success criteria):**
1. `deleteOrganizationCascade` runs in a single transaction, deletes every row in tables with `organizationId` FK, leaves zero orphans, and preserves user mailboxes/passwordHash for users who are members of other orgs.
2. `/health/ready` returns HTTP 503 with `database.ok=false` when DB is unreachable.
3. `POST /api/mail/mailboxes/test-connection` requires auth (`userId` from Supabase token), rejects private/loopback hosts, and is covered by a per-user rate limit.
4. `CLAUDE.md` describes the auth model accurately (RLS = defense-in-depth, JS-side = source of truth). `src/server/lib/access.ts` exposes consolidated `checkAccess` helpers.

**Out of scope:** SSRF guard centralization (Phase 11), webhook retries (Phase 12), broader RLS consolidation migration 017 (Phase 13).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — discuss phase was skipped per workflow.skip_discuss. The 2026-05-16 audit (`.planning/debug/system-wide-audit-2026-05-16.md`) is the authoritative spec, including specific file:line references and the remediation plan (Fase 1, blocks 1.1–1.4).

### Cascade Rewrite (CRIT-01)
- Wrap whole operation in `db.transaction(async (tx) => { ... })`.
- Use `inArray` to batch-collect dependent rows (users, mailboxes) before deletes.
- For each member of the deleted org, count their memberships in OTHER orgs:
  - If count == 0 → delete their `mailboxes`, set `passwordHash = null`.
  - If count > 0 → only remove from `organization_users`; leave mailbox and password untouched.
- Delete order respects FK dependencies: leaf-first (outreach_emails, outreach_analytics, campaign_leads, sequence_steps, sequences, campaigns, leads, lead_lists, email_accounts, outlook_mailboxes, templates, track_domains, suppressions, statistics, webhook_requests, webhooks, deliveries, messages, domains, credentials, routes, smtp/http/address_endpoints, organization_users, organizations).

### Health Check Truth (CRIT-02)
- Fix `src/server/lib/health.ts:11-13`: check `dbResult.value.ok` in addition to `dbResult.status === 'fulfilled'`. Mirror for Supabase auth probe if applicable.

### /test-connection Hardening (CRIT-03)
- Add `if (!userId) return res.status(401).json(...)` at the top of the handler.
- Inline an SSRF host check (will be refactored to use `network-guard.ts` in Phase 11; for now, copy `isPrivateHost` from `track.ts`).
- Apply existing rate limit middleware or add a route-scoped limiter (5 req/min/user).

### RLS Doc Honesty (CRIT-04)
- Create `src/server/lib/access.ts` consolidating existing scattered `checkXAccess` helpers (org-scoped, user-scoped, admin-only). Re-export from current locations to avoid mass-rename in this phase.
- Update `CLAUDE.md` Authentication Flow section: replace "RLS policies enforce organization-level data isolation at the database layer" with accurate description.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/server/middleware/*` — existing auth middleware sets `x-user-id` header.
- `src/server/lib/auth.ts` (or similar) — likely has `checkOrgAccess`-style helpers to consolidate.
- `src/server/lib/checkDatabaseHealth.ts` (or inline in `health.ts`) — returns `{ ok, latencyMs, error? }`.
- `src/server/routes/track.ts` — has the existing `isPrivateHost` function to copy/extract.

### Established Patterns
- All API routes are mounted under `/api/` via `src/server/index.ts`.
- Rate limiting via `express-rate-limit` with multiple limiters (global, auth, tracking).
- Zod validation on POST/PUT bodies; ad-hoc `typeof` checks are a code smell.
- Transactions: `db.transaction(async (tx) => { ... })` — already used elsewhere in `src/server/lib`.

### Integration Points
- `src/server/routes/organizations.ts` calls `deleteOrganizationCascade`.
- `src/server/routes/mail/mailboxes.ts:358` is the `/test-connection` handler.
- `src/server/index.ts` mounts `/health/ready`.
- `CLAUDE.md` Authentication Flow section needs the doc fix.

</code_context>

<specifics>
## Specific Ideas

Refer to `.planning/debug/system-wide-audit-2026-05-16.md` "ROBUST REMEDIATION PLAN > Fase 1" for the per-block implementation notes. Each plan in this phase corresponds to one block (1.1–1.4 collapsed to 3 plans).

</specifics>

<deferred>
## Deferred Ideas

- Centralized `network-guard.ts` library (Phase 11 SEC-01).
- Adding `checkAccess` to every route systematically (Phase 13 audit / future hardening).
- Persistent audit log table for sensitive operations (future).

</deferred>
