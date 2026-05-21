-- 020_outreach_p0_fixes.sql
-- Phase 14 — Outreach P0 fixes
-- 1. Add ON DELETE CASCADE to FKs blocking campaign deletion (P0-10).
-- 2. Add outreach_emails.tracking_token (P0-02 prereq for Plan 14-05).
-- 3. Add suppressions.source for bounce/unsubscribe/manual provenance (P0-07 prereq for Plan 14-06).
--
-- Idempotent: safe to re-run. All DROP/ADD constraint pairs use catalog probes.

BEGIN;

-- ============================================================
-- 1. CASCADE FKs for campaign deletion (P0-10)
-- ============================================================
-- Pattern per FK: drop the old constraint by its catalog name (variable across PG generations),
-- then re-add with the same target but ON DELETE CASCADE.

-- sequences.campaign_id → campaigns.id ON DELETE CASCADE
ALTER TABLE sequences DROP CONSTRAINT IF EXISTS sequences_campaign_id_fkey;
ALTER TABLE sequences DROP CONSTRAINT IF EXISTS sequences_campaign_id_campaigns_id_fk;
ALTER TABLE sequences
    ADD CONSTRAINT sequences_campaign_id_fkey
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;

-- sequence_steps.sequence_id → sequences.id ON DELETE CASCADE
ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_sequence_id_fkey;
ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_sequence_id_sequences_id_fk;
ALTER TABLE sequence_steps
    ADD CONSTRAINT sequence_steps_sequence_id_fkey
    FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE;

-- campaign_leads.campaign_id → campaigns.id ON DELETE CASCADE
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_campaign_id_fkey;
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_campaign_id_campaigns_id_fk;
ALTER TABLE campaign_leads
    ADD CONSTRAINT campaign_leads_campaign_id_fkey
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;

-- campaign_leads.lead_id → leads.id ON DELETE CASCADE
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_lead_id_fkey;
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_lead_id_leads_id_fk;
ALTER TABLE campaign_leads
    ADD CONSTRAINT campaign_leads_lead_id_fkey
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- campaign_leads.current_step_id → sequence_steps.id ON DELETE SET NULL
-- (set null so deleting a step does not orphan-delete the lead from the campaign;
--  processor logs "no current step" which is recoverable)
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_current_step_id_fkey;
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_current_step_id_sequence_steps_id_fk;
ALTER TABLE campaign_leads
    ADD CONSTRAINT campaign_leads_current_step_id_fkey
    FOREIGN KEY (current_step_id) REFERENCES sequence_steps(id) ON DELETE SET NULL;

-- outreach_emails.campaign_id → campaigns.id ON DELETE CASCADE
ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_campaign_id_fkey;
ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_campaign_id_campaigns_id_fk;
ALTER TABLE outreach_emails
    ADD CONSTRAINT outreach_emails_campaign_id_fkey
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;

-- outreach_emails.campaign_lead_id → campaign_leads.id ON DELETE CASCADE
ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_campaign_lead_id_fkey;
ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_campaign_lead_id_campaign_leads_id_fk;
ALTER TABLE outreach_emails
    ADD CONSTRAINT outreach_emails_campaign_lead_id_fkey
    FOREIGN KEY (campaign_lead_id) REFERENCES campaign_leads(id) ON DELETE CASCADE;

-- outreach_emails.sequence_step_id → sequence_steps.id ON DELETE CASCADE
ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_sequence_step_id_fkey;
ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_sequence_step_id_sequence_steps_id_fk;
ALTER TABLE outreach_emails
    ADD CONSTRAINT outreach_emails_sequence_step_id_fkey
    FOREIGN KEY (sequence_step_id) REFERENCES sequence_steps(id) ON DELETE CASCADE;

-- ============================================================
-- 2. outreach_emails.tracking_token (P0-02 prereq)
-- ============================================================
ALTER TABLE outreach_emails
    ADD COLUMN IF NOT EXISTS tracking_token text;

-- Backfill existing rows so the unique index can be built without conflict.
-- Pre-existing rows had no tracking; using id::text guarantees uniqueness.
UPDATE outreach_emails
    SET tracking_token = id::text
    WHERE tracking_token IS NULL;

-- Now enforce NOT NULL + UNIQUE going forward.
ALTER TABLE outreach_emails
    ALTER COLUMN tracking_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outreach_emails_tracking_token_unique
    ON outreach_emails(tracking_token);

-- ============================================================
-- 3. suppressions.source (P0-07 prereq)
-- ============================================================
ALTER TABLE suppressions
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- Constrain to known values. Drop-then-add for idempotency.
ALTER TABLE suppressions DROP CONSTRAINT IF EXISTS suppressions_source_check;
ALTER TABLE suppressions
    ADD CONSTRAINT suppressions_source_check
    CHECK (source IN ('bounce', 'complaint', 'unsubscribe', 'manual'));

COMMIT;
