-- Owner approval for adding leads to an ACTIVE or PAUSED campaign.
--
-- Hermes may enroll leads directly only while a campaign is a draft. Adding recipients to a campaign
-- that is already running starts real email to new people, so the agent now files a
-- `campaign_enrollment` approval request (one Telegram card for the owner) and the leads enter only
-- after he approves. The kind has to be allowed by the CHECK constraint from migration 047.
--
-- Idempotent: drop and recreate the constraint with the new kind. No row uses the new kind yet, and
-- every existing row satisfies the wider list, so the re-add validates cleanly.

ALTER TABLE public.outreach_action_approvals
    DROP CONSTRAINT IF EXISTS outreach_action_approvals_action_check;

ALTER TABLE public.outreach_action_approvals
    ADD CONSTRAINT outreach_action_approvals_action_check
    CHECK (action_kind IN ('prospect_enrichment', 'campaign_activation', 'campaign_enrollment'));
