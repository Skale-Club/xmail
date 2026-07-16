# Phase 20 Research

## Codebase findings

### Sequence ownership is implicit

`src/server/routes/outreach/campaigns.ts` creates a `Main Sequence` after campaign insertion, but not in the same transaction. The API still allows more sequences through `POST /:campaignId/sequences`. Enrollment and all three React views select the oldest/first sequence. Step creation is append-oriented, and `createSequenceStepSchema` accepts `stepOrder: 0` although the Drizzle declaration says `>= 1`.

The safe simplification is one canonical sequence per campaign, enforced in SQL and exposed through one replace operation. This removes all first-row conventions and lets the executor atomically validate order/content before touching live steps.

### Settings are a storage-only contract

`src/server/routes/outreach/settings.ts` defines defaults, reads/writes `outreach_settings`, and exposes notification flags. Campaign creation uses Zod defaults embedded in `campaigns.ts`; Outlook account creation hard-codes daily/warmup defaults; SMTP/native account creation has its own defaults. No centralized settings resolver supplies those creation paths.

A small `outreach-settings` service should resolve `database row ?? constants`, and route schemas must distinguish omitted fields from explicit values. Zod `.default()` at parse time currently destroys that distinction, so creation schemas should be optional and defaults merged after parsing.

### Pagination/search contracts disagree

The generic `paginate` helper and `paginationQuerySchema` already exist, but outreach routes do not use them consistently. The lead UI emits `search`; the lead API currently does not implement it and campaign enrollment works around that by loading up to 1,000 rows. This is both a correctness and bounded-query issue.

Use a dedicated validated lead-list query schema, a server-side `ILIKE` predicate with wildcard escaping, and cursor or page metadata consistently. Phase 20 can retain page/limit for public compatibility while enforcing `limit <= 100`; Phase 21 will use opaque cursor pagination for conversations.

### Metrics need cohort names

`src/server/lib/outreach-campaign-metrics.ts` aggregates campaign-lead statuses, while the campaign list separately aggregates `outreach_emails`. The audit found pre-send exclusions in the contacted denominator. A shared metrics DTO should publish counts and named denominators so list, detail, analytics, and health cannot silently choose different cohorts.

### Frontend and backend authorization disagree

Every `/outreach/*` route in `src/main.tsx` is wrapped by `AdminCheck`, which redirects non-platform admins to webmail. Outreach API routes generally allow organization members and viewers (read), with member/admin write checks. `OrganizationProvider` already selects the active organization, so a dedicated `OutreachCheck` can authenticate first and let each page/API resolve organization membership.

### Service key does not bind identity

In `src/server/index.ts`, a valid `x-service-key` returns `next()` without overwriting `x-user-id`; downstream routes then trust whatever user id the caller supplied. Bind the service key to server-side environment configuration and reject an `organizationId` different from the configured organization before route handlers. Log only the principal/organization ids, never the key.

## Recommended file map

- `src/server/lib/outreach-access.ts`: canonical org membership/read/write helpers used by all outreach routes.
- `src/server/lib/outreach-settings.ts`: constants + resolved settings contract.
- `src/server/lib/outreach-campaign-metrics.ts`: explicit cohort DTO reused everywhere.
- `src/server/routes/outreach/campaigns.ts`: canonical sequence and replacement endpoint.
- `src/server/routes/outreach/leads.ts`: bounded search/sort/filter contract.
- `src/server/routes/outreach/email-accounts.ts`: settings-backed account defaults.
- `src/server/index.ts`: bound service principal middleware.
- `src/main.tsx`: outreach-specific authenticated guard.
- `src/hooks/useOrganizations.tsx` or the existing organization context: membership signal for the guard/navigation.
- `src/db/schema.ts` + hand-written migration `040` (subject to revalidation).

## Migration strategy

1. Revalidate the next free migration number.
2. In one transaction, rank sequences per campaign by `created_at, id`.
3. For campaigns with duplicates, choose the canonical row and reconcile steps. If two rows contain the same `step_order`, fail the migration with a diagnostic rather than silently dropping content; the executor must repair those rows explicitly.
4. Delete only verified-empty surplus sequences, then add uniqueness and check constraints.
5. Add content constraints only after a preflight query reports no violating rows. If legacy invalid rows exist, normalize them explicitly and document counts.
6. Mirror the final SQL constraints in Drizzle and assert the applied schema inside the protected `.db.test.ts`; do not run an automated audit that reads application `DATABASE_URL`.

## Verification risks

- Editing steps while campaign processing is active can race the queue. The replace endpoint must lock the campaign/sequence and reject edits unless the campaign is `draft` or `paused`.
- Deleting/reinserting steps can invalidate `campaign_leads.current_step_id` and historical `outreach_emails.sequence_step_id`. Prefer stable-id upsert for matching positions and refuse destructive edits once a step has history, or implement an explicit safe remap.
- Frontend authorization must not infer write access from platform-admin status alone.
- Search patterns must escape `%`, `_`, and backslash before `ILIKE`.
- Service scope must be enforced for query, body, and resource-derived organization ids.
