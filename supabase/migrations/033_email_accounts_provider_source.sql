-- 033_email_accounts_provider_source.sql
-- P006 (Outreach Intelligence & Sending Infrastructure) — provider-agnostic cold-mailbox sourcing.
--
-- Records WHICH external vendor a sending inbox came from (manual paste, IceMail, Primeforge, ...)
-- and its external reference id, so Xmail can plug multiple mailbox providers behind one
-- InboxProvider abstraction (src/server/lib/inbox-providers.ts) and later sync warmup state or
-- re-provision via the vendor API (P007 Primeforge / P008 IceMail).
--
-- NOTE: this is DISTINCT from email_accounts.provider ('smtp' | 'outlook'), which is the SENDING
-- MECHANISM (SMTP vs Outlook OAuth), not the sourcing vendor.
--
-- Idempotent: safe to re-run.

BEGIN;

ALTER TABLE email_accounts
    ADD COLUMN IF NOT EXISTS mailbox_provider TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE email_accounts
    ADD COLUMN IF NOT EXISTS provider_ref TEXT;

COMMIT;
