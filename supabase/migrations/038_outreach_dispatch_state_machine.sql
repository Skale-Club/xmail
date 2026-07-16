-- 038_outreach_dispatch_state_machine.sql
-- Phase 18: durable outreach dispatch claims, retries, and ambiguity handling.
--
-- The application cannot guarantee exactly-once SMTP delivery after a process dies
-- following remote acceptance. This ledger therefore distinguishes a recoverable
-- pre-dispatch lease from a post-dispatch ambiguous send, which is held for manual
-- reconciliation rather than resent automatically.
--
-- Idempotent where practical: columns use IF NOT EXISTS, constraints are replaced
-- by stable names, indexes use IF NOT EXISTS, and deterministic backfills are safe
-- to repeat.

BEGIN;

ALTER TABLE outreach_emails
    ADD COLUMN IF NOT EXISTS origin text,
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS to_address text,
    ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS next_attempt_at timestamp,
    ADD COLUMN IF NOT EXISTS lease_token uuid,
    ADD COLUMN IF NOT EXISTS lease_expires_at timestamp,
    ADD COLUMN IF NOT EXISTS dispatch_started_at timestamp,
    ADD COLUMN IF NOT EXISTS last_attempt_at timestamp,
    ADD COLUMN IF NOT EXISTS last_error_code text,
    ADD COLUMN IF NOT EXISTS in_reply_to text,
    ADD COLUMN IF NOT EXISTS message_references text;
ALTER TABLE outreach_emails
    ADD COLUMN IF NOT EXISTS capacity_reserved_at timestamp,
    ADD COLUMN IF NOT EXISTS capacity_released_at timestamp;

-- Every pre-038 row represented a campaign sequence email. Keep the logical key
-- independent from the physical row id so restarts derive the same value.
UPDATE outreach_emails
SET origin = 'campaign'
WHERE origin IS NULL;

UPDATE outreach_emails
SET idempotency_key = 'campaign:' || campaign_lead_id::text || ':' || sequence_step_id::text
WHERE idempotency_key IS NULL
  AND campaign_lead_id IS NOT NULL
  AND sequence_step_id IS NOT NULL;

UPDATE outreach_emails AS outreach_email
SET to_address = lead.email
FROM campaign_leads AS campaign_lead
JOIN leads AS lead ON lead.id = campaign_lead.lead_id
WHERE outreach_email.campaign_lead_id = campaign_lead.id
  AND outreach_email.to_address IS NULL;

-- Historical terminal records have already consumed one provider attempt. Pending
-- or queued records remain at zero so the new dispatcher owns their first attempt.
UPDATE outreach_emails
SET attempt_count = 1
WHERE attempt_count = 0
  AND status NOT IN ('pending', 'queued');

ALTER TABLE outreach_emails
    ALTER COLUMN origin SET DEFAULT 'campaign',
    ALTER COLUMN origin SET NOT NULL,
    ALTER COLUMN idempotency_key SET NOT NULL,
    ALTER COLUMN to_address SET NOT NULL,
    ALTER COLUMN campaign_id DROP NOT NULL,
    ALTER COLUMN campaign_lead_id DROP NOT NULL,
    ALTER COLUMN sequence_step_id DROP NOT NULL,
    ALTER COLUMN tracking_token DROP NOT NULL;

ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_origin_check;
ALTER TABLE outreach_emails
    ADD CONSTRAINT outreach_emails_origin_check
    CHECK (origin IN ('campaign', 'manual', 'agentic', 'unified_inbox'));

ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_attempts_check;
ALTER TABLE outreach_emails
    ADD CONSTRAINT outreach_emails_attempts_check
    CHECK (attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts);

ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_recipient_key_check;
ALTER TABLE outreach_emails
    ADD CONSTRAINT outreach_emails_recipient_key_check
    CHECK (
        length(btrim(to_address)) > 0
        AND length(btrim(idempotency_key)) > 0
    );

ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_origin_shape_check;
ALTER TABLE outreach_emails
    ADD CONSTRAINT outreach_emails_origin_shape_check
    CHECK (
        (
            origin = 'campaign'
            AND campaign_id IS NOT NULL
            AND campaign_lead_id IS NOT NULL
            AND sequence_step_id IS NOT NULL
            AND tracking_token IS NOT NULL
        )
        OR (
            origin = 'agentic'
            AND campaign_id IS NOT NULL
            AND campaign_lead_id IS NOT NULL
            AND sequence_step_id IS NULL
        )
        OR (
            origin IN ('manual', 'unified_inbox')
            AND campaign_id IS NULL
            AND campaign_lead_id IS NULL
            AND sequence_step_id IS NULL
        )
    );

ALTER TABLE outreach_emails DROP CONSTRAINT IF EXISTS outreach_emails_capacity_reservation_check;
ALTER TABLE outreach_emails
    ADD CONSTRAINT outreach_emails_capacity_reservation_check
    CHECK (capacity_released_at IS NULL OR capacity_reserved_at IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS outreach_emails_org_idempotency_unique
    ON outreach_emails (organization_id, idempotency_key);

-- Keep the established campaign claim invariant. NULL semantics allow non-campaign
-- origins without weakening uniqueness for campaign rows.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_emails_campaign_lead_step_unique
    ON outreach_emails (campaign_lead_id, sequence_step_id);

CREATE INDEX IF NOT EXISTS idx_outreach_emails_dispatch_eligibility
    ON outreach_emails (status, next_attempt_at, lease_expires_at, created_at)
    WHERE status IN ('queued', 'failed');

COMMIT;

-- Production runbook (manual only):
-- psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/038_outreach_dispatch_state_machine.sql
