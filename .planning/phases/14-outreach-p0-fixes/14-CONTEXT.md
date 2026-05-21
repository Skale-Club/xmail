# Phase 14: Outreach P0 fixes — Context

**Gathered:** 2026-05-16
**Status:** Ready for planning
**Mode:** Smart discuss (4 grey areas, all defaults accepted)

<domain>
## Phase Boundary

Make the outreach module **functional end-to-end** and **compliant with bulk-sender requirements** (Gmail/Yahoo bulk sender policy, CAN-SPAM, GDPR). Close all 11 P0 findings documented in `.planning/debug/outreach-system-deep-audit.md` (audited 2026-05-16, including the user-reported "tela preta no New Campaign" bug appended as P0-11 on the same day).

In scope: P0-01 through P0-11. **Out of scope:** P1 (20 items, deferred to phase 15/v1.4), P2 (19 items, deferred indefinitely), and any new outreach features beyond what is needed to unbreak the existing flow.

Definition of done: a user logged into the platform as an org admin can (1) log into `/outreach`, (2) click "New Campaign" without a black screen, (3) create a campaign and add leads, (4) see the first email actually dispatch via their connected Gmail/Outlook inbox, (5) have open/click tracking populate dashboards, (6) have hard bounces auto-suppress the address, (7) have List-Unsubscribe headers pass Gmail/Yahoo compliance checks, and (8) delete a campaign without FK errors.

</domain>

<decisions>
## Implementation Decisions

### Scope & Sequencing
- **Single phase, sequenced in dependency order** — the 11 P0s share files (`outreach-sender.ts`, `processOutreachSequences.ts`, `routes/outreach/campaigns.ts`); splitting into multiple PRs would create merge conflicts.
- **Implementation order** (each subsequent fix can be tested only after the prior ones):
  1. P0-04 (middleware 403 unblocking the API for org users)
  2. P0-11 (NewCampaignPage + route — unblocks the UI flow)
  3. P0-09 (Drizzle subquery fix in `addLeadsToCampaign` — unblocks lead enrollment)
  4. P0-01 (scheduling NULL — unblocks the first email send)
  5. P0-02 (tracking lookup table — required for analytics to be meaningful)
  6. P0-03 (List-Unsubscribe headers + route mounting — Gmail/Yahoo compliance)
  7. P0-07 (suppressions write on bounce — reputation protection)
  8. P0-05, P0-06 (race conditions in processor — robustness)
  9. P0-08 (IMAP bounce SQL — only fires after real bounces accumulate)
  10. P0-10 (cascade delete — only fires when a campaign has sent emails)
- **Only P0s in this phase.** P1 (20 items) and P2 (19 items) deferred to phase 15 (v1.4).
- **DKIM in outreach: remains unsigned.** Reaffirms PROJECT.md decision — outreach uses the user's own SMTP (Gmail/Outlook) which already DKIM-signs with their domain; re-signing with skale.club would invalidate.

### Schema & Migrations
- **P0-10 cascade fix uses both schema migration AND in-code transaction wrap** (defense-in-depth).
- **Single aggregated migration:** `supabase/migrations/019_outreach_p0_fixes.sql` covering all DDL changes (cascade FKs, new columns).
- **`outreach_emails.tracking_token`:** check current schema; if column does not exist, add as `text` with `unique` constraint and populate on send (P0-02 prerequisite).
- **`suppressions` columns:** check current schema for `source` (enum: `bounce`, `complaint`, `unsubscribe`, `manual`) and `reason` (nullable text). Add via migration if missing.

### List-Unsubscribe & Compliance (P0-03)
- **HMAC-signed token** (`campaignLeadId:timestamp` HMAC-SHA256 with `ENCRYPTION_KEY`) — stateless, non-enumerable, idempotent. No DB lookup required for the token itself; only writes on the action.
- **Two endpoints**:
  - `POST /o/u/:token` — RFC 8058 one-click (Gmail)
  - `GET /o/u/:token` — browser-friendly with HTML confirmation page
- **Headers injected on every outreach send** (in `outreach-sender.ts`):
  - `List-Unsubscribe: <https://{host}/o/u/{token}>, <mailto:unsubscribe@{domain}>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- **Action on unsubscribe**: `INSERT INTO suppressions (source='unsubscribe', ...)` AND `UPDATE campaign_leads SET status='unsubscribed'` for all leads of that email in any campaign of the org.

### NewCampaignPage (P0-11)
- **Minimal viable form:** `name` (required), `description` (optional), `from_email_account_id` (Select populated by `GET /api/outreach/email-accounts`).
- **Validation:** react-hook-form + Zod (matches existing admin pages per CLAUDE.md).
- **Success behavior:** POST `/api/outreach/campaigns?organizationId=...`, redirect to `/outreach/campaigns/{id}` (campaign detail). **Note:** verify the detail page exists; if not, redirect to `/outreach/campaigns` (list) with success toast as fallback.
- **Layout:** wrap in `OutreachLayout`; shadcn primitives (`Card`, `Input`, `Textarea`, `Select`, `Button`).
- **Route placement in `main.tsx`:** must come **before** `/outreach/campaigns` (wouter matches in order, and `/outreach/campaigns/new` should not be swallowed by a `:id` route if added later).

### Claude's Discretion
- Naming of new helper functions, internal module organization, exact error messages, toast copy, loading-state visuals.
- Whether to extract a shared `generateOutreachToken()` / `verifyOutreachToken()` helper or inline (recommend extract since unsubscribe and tracking both need it).
- Test additions (no test framework configured — see CLAUDE.md Key Constraints; new tests not required this phase but if any are added, prefer node:test).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Auth/middleware:** `src/server/index.ts` already validates JWT and injects `x-user-id`. The fix for P0-04 is to swap `isPlatformAdmin` for the existing `checkOrgMembership` (which lives in sub-routers and is currently dead code).
- **Tracking infra:** `src/server/lib/tracking.ts` and `src/server/routes/track.ts` already exist for transactional mail. P0-02 fix needs `track.ts` to also look up `outreach_emails.tracking_token` (not just `messages.token`).
- **OutreachLayout:** `src/components/outreach/OutreachLayout.tsx` wraps all outreach pages — new NewCampaignPage uses it.
- **shadcn primitives:** `Card`, `Input`, `Textarea`, `Select`, `Button`, `Label` already in `src/components/ui/`.
- **react-query + supabase JWT pattern:** see `CampaignsPage.tsx` — `apiFetch`/`apiRequest` helpers, `useOrganization` hook, `queryClient.invalidateQueries`.
- **HMAC pattern:** likely needs new helper; check `src/server/lib/` for any existing crypto util before writing.

### Established Patterns
- React Query for server state on outreach pages (transition from `useState`/`useEffect` used on admin pages).
- Forms use react-hook-form + Zod (`SequencesPage`, `NewSequencePage` precedent).
- Toast notifications via the project's toast system.
- Modals as inline JSX (`{showModal && ...}`); but NewCampaignPage should be a full page (not a modal) for URL-shareability.
- All migrations are raw SQL in `supabase/migrations/NNN_name.sql`; Drizzle schema in `src/db/schema.ts` mirrors.

### Integration Points
- **Routes:** `src/main.tsx` — register `/outreach/campaigns/new` BEFORE `/outreach/campaigns`; register `/o/u/:token` is NOT in SPA (it's an Express route on the server).
- **Express:** `src/server/index.ts` — mount `outreach/unsubscribe.ts` router under `/o/u` (currently never mounted).
- **DB:** `src/db/schema.ts` — update FK declarations to add `onDelete: 'cascade'`; add new columns; run `npm run db:generate` and `npm run db:push` (or write migration manually since project uses raw SQL migrations).
- **Job processor:** `src/server/jobs/processOutreachSequences.ts` — fix race conditions (P0-05, P0-06) and ensure suppressions are checked AND written.

</code_context>

<specifics>
## Specific Ideas

- Audit report `.planning/debug/outreach-system-deep-audit.md` is the canonical spec for every fix. Each P0 has a "Fix sugerido" section with code-level guidance.
- User reported the New Campaign black screen bug live; fix must be UAT-verifiable by clicking the button after deploy.

</specifics>

<deferred>
## Deferred Ideas

- All 20 P1 findings (rate limiting per inbox, OAuth refresh, reply matching robustness, `outreach_enabled` flag enforcement, etc.) → phase 15 (v1.4 — Outreach Hardening cont.).
- All 19 P2 findings (UX polish, observability, deliverability fine-tuning).
- Removing the dead `isPlatformAdmin` requirement entirely from outreach module — phase 15 cleanup.
- Wizard-style multi-step campaign creation UI (deferred from Area 4 Q1).

</deferred>
