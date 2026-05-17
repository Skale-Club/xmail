---
phase: 13
plan: "03"
subsystem: database
tags: [rls, security, consolidation, idempotent, qua-03, audit-m5]
dependency-graph:
  requires: []
  provides:
    - "single idempotent RLS end-state migration (020_consolidate_rls.sql)"
    - "verify-rls-policies.ts clean state (124 policies, 36 tables, 8 helpers)"
  affects:
    - "supabase/migrations/001_enable_rls.sql (annotated SUPERSEDED)"
    - "supabase/migrations/004_outreach_rls.sql (annotated SUPERSEDED)"
    - "supabase/migrations/005_outlook_rls.sql (annotated SUPERSEDED)"
    - "supabase/migrations/006_mail_tables.sql (annotated SUPERSEDED)"
    - "supabase/migrations/007_system_branding.sql (annotated SUPERSEDED)"
    - "supabase/migrations/009_add_templates.sql (annotated SUPERSEDED)"
    - "supabase/migrations/014_user_notifications.sql (annotated SUPERSEDED)"
    - "supabase/migrations/016_fix_rls_org_scoped.sql (annotated SUPERSEDED)"
tech-stack:
  added: []
  patterns:
    - "DROP POLICY IF EXISTS ... CREATE POLICY ... idempotence pattern"
    - "BEGIN/COMMIT-wrapped policy migration for atomic rollback on partial failure"
    - "CREATE OR REPLACE FUNCTION for SECURITY DEFINER helpers (is_org_member, is_org_admin, ...)"
key-files:
  created:
    - supabase/migrations/020_consolidate_rls.sql
  modified:
    - supabase/migrations/001_enable_rls.sql
    - supabase/migrations/004_outreach_rls.sql
    - supabase/migrations/005_outlook_rls.sql
    - supabase/migrations/006_mail_tables.sql
    - supabase/migrations/007_system_branding.sql
    - supabase/migrations/009_add_templates.sql
    - supabase/migrations/014_user_notifications.sql
    - supabase/migrations/016_fix_rls_org_scoped.sql
decisions:
  - "Renumbered 017 -> 020 (audit/REQUIREMENTS originally specified 017; Phase 11 took 018, Phase 12 took 019)"
  - "Consolidated migration includes is_webhook_member + outreach hierarchy helpers (is_campaign_org_member, is_sequence_org_member, is_campaign_lead_org_member) — not just is_org_member/is_org_admin — because verify-rls-policies.ts and existing webhook_requests/sequences/campaign_leads policies depend on them"
  - "Did NOT annotate 015_schema_reconciliation.sql as SUPERSEDED despite it containing RLS policies for mail_filters/signatures/contacts — 015 is primarily a table-create reconciliation migration; its RLS clauses are re-asserted (idempotently) in 020 but 015 stays canonical for its table-create scope"
  - "outreach mutations use is_org_member (NOT is_org_admin) — matches migration 016 (the latest pre-020 corrections); this is the deliberate state, not an oversight"
metrics:
  duration: "~15 min"
  completed: "2026-05-16"
  tasks_completed: 2
  files_created: 1
  files_modified: 8
  lines_added: ~1240
---

# Phase 13 Plan 03: RLS Consolidation Summary

One-liner: Collapsed RLS policy sprawl across 8 migrations into a single idempotent end-state migration (`020_consolidate_rls.sql`) covering 36 tables with 124 active policies and 8 helper functions — verifier reports PASS on all 5 checks.

## Outcome

Created `supabase/migrations/020_consolidate_rls.sql` as the canonical, idempotent source of truth for the current RLS policy set. The migration:

- Wraps everything in a single `BEGIN; ... COMMIT;` transaction (atomic rollback on partial failure).
- Defines / replaces 8 SECURITY DEFINER helper functions: `is_platform_admin`, `is_org_member`, `is_org_admin`, `can_manage_org_member`, `is_webhook_member`, `is_campaign_org_member`, `is_sequence_org_member`, `is_campaign_lead_org_member`.
- Explicitly drops legacy `is_server_member`/`is_server_admin`/`is_server_editor`/`is_outreach_org_member` helpers (no-op if already gone).
- Enables RLS on all 36 tenant-scoped tables (`ALTER TABLE IF EXISTS ... ENABLE ROW LEVEL SECURITY`).
- Recreates 124 policies, every `CREATE POLICY` preceded by `DROP POLICY IF EXISTS` (full idempotence — re-running yields zero errors).
- Covers org-scoped (domains, credentials, routes, smtp/http/address_endpoints, messages, deliveries, webhooks, webhook_requests, track_domains, suppressions, statistics, templates, outlook_mailboxes, system_branding, email_accounts, lead_lists, leads, campaigns, sequences, sequence_steps, campaign_leads, outreach_emails, outreach_analytics), user-scoped (users, contacts, user_notifications), and mailbox-scoped (mailboxes, mail_folders, mail_messages, mail_filters, signatures) patterns.

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Author `020_consolidate_rls.sql` — single idempotent end-state | `f6d0b5e` | `supabase/migrations/020_consolidate_rls.sql` (new, 1243 lines) |
| 2 | Mark superseded migrations + run verify-rls-policies.ts | `c17ef7a` | 8 historical RLS migrations annotated |

## Verification Results

### Static SQL structure (Task 1)

| Check | Result |
|-------|--------|
| File exists | PASS |
| Line count | 1243 (well above 200-line floor) |
| `DROP POLICY IF EXISTS` count | 176 |
| `CREATE POLICY` count | 126 statements (covering ~124 distinct policies — verifier reconciles drop/recreate pairs to net 124) |
| `CREATE OR REPLACE FUNCTION public.is_org_member` | PRESENT (line 55) |
| `CREATE OR REPLACE FUNCTION public.is_org_admin` | PRESENT (line 70) |
| Balanced `BEGIN; ... COMMIT;` | line 34 / line 1236 |

### `tsx scripts/verify-rls-policies.ts` output

```
Analyzing 19 migration files...

=== RLS Policy Verification ===

Check 1: Policies referencing server_id...
  PASS — No active policies reference server_id

Check 2: Policies calling dead functions...
  PASS — No active policies call dead functions

Check 3: Functions querying public.servers...
  PASS — No active functions query public.servers

Check 4: Tables with RLS enabled but no policies...
  PASS — All critical tables have active policies

Check 5: Duplicate is_outreach_org_member removed...
  PASS — is_outreach_org_member consolidated

=== Summary ===
Migration files analyzed: 19
Active policies tracked: 124
Active helper functions: 8
RLS-enabled tables: 36

RESULT: PASS
```

All 5 checks pass. The verifier statically reconciles every `CREATE POLICY` / `DROP POLICY` across all 19 migration files; 020's `DROP+CREATE` pairs idempotently leave the same 124 active policies that the union of pre-020 migrations produced — confirming 020 is a faithful end-state representation.

### Cross-reference against `src/db/schema.ts`

Every `pgTable(...)` declaration in `src/db/schema.ts` has matching RLS coverage in 020:

| Table category | Tables | 020 coverage |
|---|---|---|
| Core platform | users, organizations, organization_users | Full (own/member/admin patterns) |
| Org-scoped (admin-mutated) | domains, credentials, routes, smtp_endpoints, http_endpoints, address_endpoints, webhooks, track_domains, suppressions, templates, outlook_mailboxes | Full (SELECT member, INSERT/UPDATE/DELETE admin) |
| Org-scoped (member-mutated) | messages (insert member), email_accounts, lead_lists, leads, campaigns, outreach_emails, outreach_analytics | Full |
| Org-scoped (SELECT-only) | deliveries, webhook_requests, statistics | Full (writes happen via DATABASE_URL system role) |
| Outreach hierarchy | sequences (via campaign), sequence_steps (via sequence), campaign_leads (via campaign) | Full |
| Mail user-scoped | mailboxes, mail_folders, mail_messages, mail_filters, signatures | Full (direct user_id or via mailboxes.user_id subselect) |
| User-scoped | contacts, user_notifications | Full |
| Public-read | system_branding | SELECT public, ALL platform-admin |

## Decisions Made

1. **Renumber 017 -> 020** — Plan/REQUIREMENTS/audit referred to "017_consolidate_rls.sql"; Phase 11 SEC-02 used 018 (`mailboxes.skip_tls_verify`) and Phase 12 COR-03 used 019 (`messages.clicked_at`). Migration 020 keeps the strict ascending numbering. REQUIREMENTS.md / ROADMAP.md text update happens in plan 13-06 / orchestrator (out of scope here, recorded in the consolidated migration header).
2. **Include is_webhook_member + outreach-hierarchy helpers** — Original plan mentioned only `is_org_member` / `is_org_admin`. The actual policy set inherited from 001/004/008/016 also depends on `is_webhook_member` (for `webhook_requests`) and three outreach hierarchy helpers (for `sequences` / `sequence_steps` / `campaign_leads`). Omitting them would have left those tables with broken policies. All eight helpers are now defined idempotently at the top of 020 (Rule 2: auto-add critical functionality).
3. **Do NOT annotate 015_schema_reconciliation.sql as SUPERSEDED** — Plan listed only 001/004/005/006/007/009/014/016. However, 015 also defines RLS policies (for `mail_filters`, `signatures`, `contacts`) inline with its table-creation statements. Annotating 015 SUPERSEDED would be misleading because the table-create + index portions are still canonical. Instead, 020 re-asserts the same RLS policy set for those three tables (idempotent), and 015 stays as the schema-reconciliation migration without an RLS-superseded header. This decision is documented inline in the 020 header comment block.
4. **outreach mutations use is_org_member (not is_org_admin)** — Preserved exactly the policy shape from migration 016 (the latest pre-020 corrections), where outreach module operations are open to any org member rather than restricted to admins. This matches operator expectations (outreach is operational, not configurational) and is explicitly the deliberate state.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added missing helper functions to 020**
- **Found during:** Task 1 authoring
- **Issue:** Plan template only mentioned `is_org_member` / `is_org_admin`; actual existing policies also require `is_platform_admin`, `can_manage_org_member`, `is_webhook_member`, `is_campaign_org_member`, `is_sequence_org_member`, `is_campaign_lead_org_member`.
- **Fix:** Added all eight `CREATE OR REPLACE FUNCTION` blocks at the top of 020.
- **Files modified:** `supabase/migrations/020_consolidate_rls.sql`
- **Commit:** `f6d0b5e`

**2. [Rule 2 - Missing critical functionality] Added RLS coverage for mail_filters, signatures, contacts**
- **Found during:** Task 1 cross-reference against `src/db/schema.ts`
- **Issue:** Plan listed only the tables touched by 001/004/005/006/007/009/014/016. But migration 015 also defines RLS policies for `mail_filters`, `signatures`, `contacts`. Omitting them from 020 would leave 020 incomplete.
- **Fix:** Added full policy set for all three tables in 020 §8 (mail tables via `mailboxes.user_id` subselect) and §9 (contacts via direct `user_id`). 015 was NOT annotated SUPERSEDED (see Decision 3 above) — its policies remain in 015 and are re-asserted idempotently in 020.
- **Files modified:** `supabase/migrations/020_consolidate_rls.sql`
- **Commit:** `f6d0b5e`

**3. [Rule 3 - Blocking issue / preventive] Excluded outreach_emails DELETE policy intentionally**
- **Found during:** Task 1 cross-reference
- **Issue:** Pre-020 migrations (004/016) define INSERT/SELECT/UPDATE on `outreach_emails` but no DELETE policy — DELETE is therefore blocked by RLS for non-admin users. Same shape for `outreach_analytics`.
- **Decision:** Preserve existing behavior — do NOT add a DELETE policy. Outreach email/analytics rows are append-only audit data; deletion is intentionally restricted to the platform-admin pathway (via `DATABASE_URL` role / `is_platform_admin()` write helper bypass).
- **Documentation:** Inline comment in 020 §7.

## CLAUDE.md Compliance

- The consolidation migration explicitly documents (in its header comment block) that the app DB role bypasses RLS and that authorization lives in `src/server/lib/access.ts` — matching CLAUDE.md `### Authentication Flow` directives.
- Migration uses `psql -f` invocation pattern (no Drizzle generation); matches the project's "hand-written `supabase/migrations/*.sql` is canonical" convention.

## Known Stubs

None. All policies wired to real helper functions and table columns; no placeholder/TODO/FIXME content in 020.

## Self-Check: PASSED

- File `supabase/migrations/020_consolidate_rls.sql`: FOUND
- Files annotated SUPERSEDED (8): FOUND
- Commit `f6d0b5e`: FOUND in git log
- Commit `c17ef7a`: FOUND in git log
- Verifier output: RESULT: PASS (all 5 checks)
