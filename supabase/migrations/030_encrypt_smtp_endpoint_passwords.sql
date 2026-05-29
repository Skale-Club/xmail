-- Migration 030: add password_encrypted column to smtp_endpoints
-- The existing plaintext `password` column is kept during the transition period.
-- Run scripts/backfill-smtp-passwords.ts to encrypt any existing rows, then
-- drop the `password` column in a follow-up migration once all rows are migrated.

ALTER TABLE smtp_endpoints
    ADD COLUMN IF NOT EXISTS password_encrypted text;
