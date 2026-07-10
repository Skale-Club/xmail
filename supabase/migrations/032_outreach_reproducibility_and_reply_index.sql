-- 032_outreach_reproducibility_and_reply_index.sql
-- Outreach audit fixes (2026-07):
--   1. Track the claim-lock unique index in SQL. It was previously created out-of-band
--      (via the now-removed db:push) and existed only in src/db/schema.ts, so any DB
--      rebuilt from migrations (staging, DR, local) had NO unique index backing the
--      ON CONFLICT (campaign_lead_id, sequence_step_id) claim in
--      processOutreachSequences.ts — the insert would fail with 42P10, be swallowed,
--      and the sender would silently send zero emails. This makes it reproducible.
--   2. Index outreach_emails.message_id — the primary lookup key for the reply and
--      bounce processors (WHERE message_id = $1 / LIKE). Previously unindexed → seq
--      scans inside cron ticks as the table grows.
--
-- Idempotent: safe to re-run.

BEGIN;

-- 1. Claim-lock unique index (matches schema.ts outreach_emails_campaign_lead_step_unique).
CREATE UNIQUE INDEX IF NOT EXISTS outreach_emails_campaign_lead_step_unique
    ON outreach_emails (campaign_lead_id, sequence_step_id);

-- 2. Reply/bounce lookup index on message_id.
CREATE INDEX IF NOT EXISTS idx_outreach_emails_message_id
    ON outreach_emails (message_id);

COMMIT;
