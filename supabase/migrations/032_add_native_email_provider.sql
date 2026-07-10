-- Migration: Add 'native' to the email_provider enum
--
-- email_accounts.provider IS a real Postgres enum (email_provider) — the original
-- version of this migration wrongly claimed it was a VARCHAR(20) and shipped as a
-- comment-only change, which made inserting provider='native' fail in production
-- with: invalid input value for enum email_provider: "native".
--
-- provider='native' accounts route outreach sending through the platform's native
-- mailbox model (src/server/lib/native-send.ts) instead of stored SMTP/IMAP
-- credentials — smtp_*/imap_* columns stay NULL for these rows (already nullable
-- per migration 012).
--
-- Applied to production 2026-07-10 (idempotent).

ALTER TYPE email_provider ADD VALUE IF NOT EXISTS 'native';

COMMENT ON COLUMN email_accounts.provider IS 'Email provider type: smtp, outlook, native (native = sends via the platform native mailbox model, no stored credentials)';
