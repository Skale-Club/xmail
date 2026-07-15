-- 036_email_accounts_case_insensitive_unique.sql
-- Closes the case-variant duplicate hole between the two email_accounts write paths.
--
-- POST /api/outreach/email-accounts stores the address verbatim (createEmailAccountSchema does not
-- normalize), while P006's POST /bulk-import lowercases it (importMailboxSchema). The unique index
-- was ON (organization_id, email) — raw, therefore case-sensitive — so the two paths could each
-- insert a row for the SAME physical mailbox:
--
--   POST /            {email: "Bob@Acme.com", provider: "native"}  -> row A (native)
--   POST /bulk-import {email: "BOB@ACME.COM", smtpHost: ...}       -> row B (smtp), NOT deduped
--
-- Both rows carry their own daily_send_limit / current_daily_sent, and processOutreachSequences.ts
-- evaluates the cap per row, so the real mailbox would send up to 2x its intended daily volume —
-- the exact reputation damage P009 exists to prevent.
--
-- The native mailbox table already got this right in 026_enforce_unique_native_mailboxes.sql
-- (UNIQUE ON mailboxes (lower(email)) WHERE is_native); this brings email_accounts in line. The
-- code side is fixed in the same commit: createEmailAccountSchema now lowercases like
-- importMailboxSchema, and POST /'s duplicate pre-check compares the normalized value instead of
-- computing normalizedEmail and then ignoring it.
--
-- ALREADY APPLIED TO PRODUCTION on 2026-07-15, ahead of this file landing on main (the index was
-- applied while this fix was still being prepared on a branch, so production briefly carried an
-- index no migration declared). Re-running is harmless and reconciles any environment that does
-- not have it yet. State at apply time: 4 email_accounts rows, 0 stored in mixed case, 0 collisions
-- on (organization_id, lower(email)) — step 1 was a no-op and step 3 could not fail. The index is a
-- plain index, not a constraint, and nothing targets it via ON CONFLICT.
--
-- Idempotent: safe to re-run.

BEGIN;

-- 1. Normalize any address stored in mixed case. No-op on current production data; matters for any
--    environment that accumulated rows through POST / before this migration.
UPDATE email_accounts SET email = lower(email) WHERE email <> lower(email);

-- 2. Drop the case-sensitive index.
DROP INDEX IF EXISTS email_account_org_email_unique;

-- 3. Recreate it case-insensitively. If a rebuilt-from-migrations environment DOES hold two rows
--    differing only by case, this CREATE fails loudly here rather than letting the mailbox silently
--    double its send cap in production — that is intended: reconcile the rows by hand, then re-run.
CREATE UNIQUE INDEX IF NOT EXISTS email_account_org_email_unique
    ON email_accounts (organization_id, lower(email));

COMMIT;
