-- Phase 29: configurable deliverability circuit breaker with auditable campaign pause reason.

BEGIN;

ALTER TABLE public.outreach_settings ADD COLUMN IF NOT EXISTS deliverability_guard_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.outreach_settings ADD COLUMN IF NOT EXISTS bounce_rate_limit_percent integer NOT NULL DEFAULT 5;
ALTER TABLE public.outreach_settings ADD COLUMN IF NOT EXISTS bounce_rate_min_sample integer NOT NULL DEFAULT 20;
ALTER TABLE public.outreach_settings ADD COLUMN IF NOT EXISTS unsubscribe_rate_limit_percent integer NOT NULL DEFAULT 2;
ALTER TABLE public.outreach_settings ADD COLUMN IF NOT EXISTS unsubscribe_rate_min_sample integer NOT NULL DEFAULT 50;

ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS paused_at timestamp;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS paused_reason text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_settings_bounce_rate_limit_check') THEN
        ALTER TABLE public.outreach_settings ADD CONSTRAINT outreach_settings_bounce_rate_limit_check
            CHECK (bounce_rate_limit_percent BETWEEN 1 AND 100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_settings_bounce_sample_check') THEN
        ALTER TABLE public.outreach_settings ADD CONSTRAINT outreach_settings_bounce_sample_check
            CHECK (bounce_rate_min_sample BETWEEN 10 AND 10000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_settings_unsubscribe_rate_limit_check') THEN
        ALTER TABLE public.outreach_settings ADD CONSTRAINT outreach_settings_unsubscribe_rate_limit_check
            CHECK (unsubscribe_rate_limit_percent BETWEEN 1 AND 100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_settings_unsubscribe_sample_check') THEN
        ALTER TABLE public.outreach_settings ADD CONSTRAINT outreach_settings_unsubscribe_sample_check
            CHECK (unsubscribe_rate_min_sample BETWEEN 10 AND 10000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_paused_reason_check') THEN
        ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_paused_reason_check
            CHECK (paused_reason IS NULL OR paused_reason IN ('human', 'agent', 'bounce_rate', 'unsubscribe_rate'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_outreach_emails_campaign_sent
    ON public.outreach_emails (campaign_id, sent_at DESC) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaigns_paused_reason
    ON public.campaigns (organization_id, paused_reason, paused_at DESC) WHERE paused_reason IS NOT NULL;

COMMIT;
