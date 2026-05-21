-- 021_email_accounts_last_sent_at.sql
-- Phase 16 — Per-inbox throttle (INBOX-THROTTLE)
-- Adds email_accounts.last_sent_at so the outreach processor can enforce
-- minMinutesBetweenEmails between sends per inbox. The Drizzle schema.ts
-- already declares this column (line 681); this migration adds it to prod
-- to close the schema/prod drift before Plan 16-02 wires the throttle.
--
-- Idempotent: safe to re-run. Uses IF NOT EXISTS on column + index.

BEGIN;

ALTER TABLE email_accounts
    ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;

-- Partial index: only verified accounts ever participate in the rate-limit
-- lookup (canSendFromAccount short-circuits on status != 'verified'), so we
-- keep the index lean. Used by processOutreachSequences when filtering
-- pending leads by emailAccount throttle eligibility.
CREATE INDEX IF NOT EXISTS email_accounts_last_sent_at_idx
    ON email_accounts(last_sent_at)
    WHERE status = 'verified';

COMMIT;
