-- Migration: Document the 'native' email_accounts.provider value
--
-- email_accounts.provider is a VARCHAR(20) column (see 012_add_provider_to_email_accounts.sql),
-- NOT a Postgres native ENUM type — Drizzle's emailProviderEnum in src/db/schema.ts is a
-- TypeScript-side type helper only. No ALTER TYPE / CHECK constraint exists restricting the
-- column's values, so adding 'native' as a third value (alongside 'smtp' and 'outlook') requires
-- no structural DDL change. This migration only refreshes the column comment for future readers.
--
-- provider='native' accounts route outreach sending through the platform's native mailbox model
-- (src/server/lib/native-send.ts) instead of stored SMTP/IMAP credentials — smtp_*/imap_* columns
-- stay NULL for these rows (already nullable per migration 012).

COMMENT ON COLUMN email_accounts.provider IS 'Email provider type: smtp, outlook, native (native = sends via the platform native mailbox model, no stored credentials)';
