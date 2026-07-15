-- 034_outreach_agentic_followup.sql
-- P001/P002 (Outreach Intelligence) — agentic follow-up.
--
-- Lets a campaign optionally answer replies instead of only stopping the sequence: when an inbound
-- reply is matched, Xmail captures it and schedules a follow-up decision. A decider (Xphere by
-- default — "Xphere decides, Xmail executes") returns send / wait / complete; Xmail threads the
-- reply and re-arms or terminates. GATED per campaign and OFF by default, so existing behaviour
-- (mark 'replied', stop) is unchanged unless explicitly enabled.
--
-- Idempotent: safe to re-run.

BEGIN;

-- Campaign-level switches.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS agentic_followup_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS max_follow_ups INTEGER NOT NULL DEFAULT 2;

-- Per-lead follow-up scheduling + the latest inbound reply the decider reasons over.
ALTER TABLE campaign_leads
    ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMP;
ALTER TABLE campaign_leads
    ADD COLUMN IF NOT EXISTS follow_up_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_leads
    ADD COLUMN IF NOT EXISTS last_reply_message_id TEXT;
ALTER TABLE campaign_leads
    ADD COLUMN IF NOT EXISTS last_reply_text TEXT;
ALTER TABLE campaign_leads
    ADD COLUMN IF NOT EXISTS last_reply_at TIMESTAMP;

-- Follow-up job scans due leads by (next_follow_up_at). Partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_campaign_leads_next_follow_up
    ON campaign_leads (next_follow_up_at)
    WHERE next_follow_up_at IS NOT NULL;

COMMIT;
