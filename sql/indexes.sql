-- =============================================================================
-- indexes.sql — Safe Index Creation (CONCURRENTLY)
-- =============================================================================
--
-- This file contains CREATE INDEX CONCURRENTLY statements for all indexes.
--
-- IMPORTANT:
--   - Execute via:  npm run db:indexes
--   - DO NOT run through db:push or any tool that wraps statements in transactions
--   - CREATE INDEX CONCURRENTLY cannot run inside a transaction block
--   - CONCURRENTLY allows writes to continue during index creation
--
-- For index health verification after execution, run:
--   npx tsx scripts/verify-indexes.ts
-- =============================================================================

-- =============================================================================
-- Core tables — organizationId FK indexes
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_domains_organization_id
    ON domains (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credentials_organization_id
    ON credentials (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outlook_mailboxes_organization_id
    ON outlook_mailboxes (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_routes_organization_id
    ON routes (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_smtp_endpoints_organization_id
    ON smtp_endpoints (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_http_endpoints_organization_id
    ON http_endpoints (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_address_endpoints_organization_id
    ON address_endpoints (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_organization_id
    ON messages (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_org_status
    ON messages (organization_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_token
    ON messages (token);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhooks_organization_id
    ON webhooks (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_templates_organization_id
    ON templates (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_track_domains_organization_id
    ON track_domains (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_suppressions_organization_id
    ON suppressions (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_statistics_organization_id
    ON statistics (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lead_lists_organization_id
    ON lead_lists (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaigns_organization_id
    ON campaigns (organization_id);

-- =============================================================================
-- Deliveries — message + organization FK indexes
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deliveries_message_id
    ON deliveries (message_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deliveries_organization_id
    ON deliveries (organization_id);

-- =============================================================================
-- Webhook requests — webhook FK index
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_requests_webhook_id
    ON webhook_requests (webhook_id);

-- =============================================================================
-- Email accounts — organization + outlook mailbox FK indexes
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_accounts_organization_id
    ON email_accounts (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_accounts_outlook_mailbox_id
    ON email_accounts (outlook_mailbox_id);

-- =============================================================================
-- Leads — organization + lead list FK indexes
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_organization_id
    ON leads (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_lead_list_id
    ON leads (lead_list_id);

-- =============================================================================
-- Sequences + steps — campaign/sequence FK indexes
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sequences_campaign_id
    ON sequences (campaign_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sequence_steps_sequence_id
    ON sequence_steps (sequence_id);

-- =============================================================================
-- Campaign leads — multiple FK indexes
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_leads_campaign_id
    ON campaign_leads (campaign_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_leads_lead_id
    ON campaign_leads (lead_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_leads_assigned_email_account_id
    ON campaign_leads (assigned_email_account_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_leads_current_step_id
    ON campaign_leads (current_step_id);

-- =============================================================================
-- Outreach emails — multiple FK indexes
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_organization_id
    ON outreach_emails (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_campaign_id
    ON outreach_emails (campaign_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_campaign_lead_id
    ON outreach_emails (campaign_lead_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_sequence_step_id
    ON outreach_emails (sequence_step_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_email_account_id
    ON outreach_emails (email_account_id);

-- Claim-lock unique index (migration 027/035). Backs the ON CONFLICT
-- (campaign_lead_id, sequence_step_id) claim in processOutreachSequences.ts.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outreach_emails_campaign_lead_step_unique
    ON outreach_emails (campaign_lead_id, sequence_step_id);

-- Reply/bounce lookup key (migration 035). WHERE message_id = $1 / LIKE.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_message_id
    ON outreach_emails (message_id);

-- Health-endpoint rolling-window aggregates (migration 022): (sent_at, status).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_sent_at_status
    ON outreach_emails (sent_at, status);

-- Per-inbox throttle lookup (migration 021): partial index on last_sent_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_accounts_last_sent_at_idx
    ON email_accounts (last_sent_at)
    WHERE last_sent_at IS NOT NULL;

-- =============================================================================
-- Outreach analytics — FK indexes (some nullable)
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_analytics_organization_id
    ON outreach_analytics (organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_analytics_campaign_id
    ON outreach_analytics (campaign_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_analytics_email_account_id
    ON outreach_analytics (email_account_id);

-- =============================================================================
-- Mail module — user/mailbox FK indexes
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mailboxes_user_id
    ON mailboxes (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mail_folders_mailbox_id
    ON mail_folders (mailbox_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mail_messages_mailbox_id
    ON mail_messages (mailbox_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mail_messages_folder_id
    ON mail_messages (folder_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mail_filters_mailbox_id
    ON mail_filters (mailbox_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_signatures_mailbox_id
    ON signatures (mailbox_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_user_id
    ON contacts (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_notifications_user_id
    ON user_notifications (user_id);

-- =============================================================
-- Composite & Performance Indexes (Phase 06)
-- =============================================================

-- IDX-03: Campaign lead counts — campaignLeads WHERE campaignId AND status
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_leads_campaign_status
    ON campaign_leads (campaign_id, status);

-- IDX-04: Send pipeline cron — campaignLeads WHERE nextScheduledAt <= now()
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_leads_next_scheduled
    ON campaign_leads (next_scheduled_at);

-- NOTE: IDX-02 (idx_messages_org_status) and IDX-05 (idx_messages_token)
-- are defined in the Core tables section above.

-- =============================================================================
-- Agent gateway + durable outreach events (migration 045)
-- =============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaigns_agent_draft_idempotency_unique
    ON campaigns (organization_id, agent_credential_id, agent_idempotency_key);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outreach_agent_credentials_key_prefix_unique
    ON outreach_agent_credentials (key_prefix);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outreach_agent_credentials_key_hash_unique
    ON outreach_agent_credentials (key_hash);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_agent_credentials_organization
    ON outreach_agent_credentials (organization_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_agent_audit_org_created
    ON outreach_agent_audit_log (organization_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_agent_audit_credential_created
    ON outreach_agent_audit_log (credential_id, created_at DESC);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outreach_event_outbox_sequence_unique
    ON outreach_event_outbox (sequence_number);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outreach_event_outbox_deduplication_unique
    ON outreach_event_outbox (organization_id, deduplication_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_event_outbox_org_sequence
    ON outreach_event_outbox (organization_id, sequence_number);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_event_outbox_xphere_pending
    ON outreach_event_outbox (xphere_next_attempt_at, sequence_number)
    WHERE xphere_delivery_enabled = true AND xphere_delivered_at IS NULL AND xphere_attempts < 10;

-- =============================================================================
-- Provider-neutral prospecting pipeline (migration 046)
-- =============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS leads_id_organization_unique
    ON leads (id, organization_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_org_icp_score
    ON leads (organization_id, icp_score DESC) WHERE icp_score IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outreach_icp_profiles_one_default_per_org
    ON outreach_icp_profiles (organization_id) WHERE is_default = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospecting_runs_org_created
    ON prospecting_runs (organization_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospecting_runs_status
    ON prospecting_runs (status, updated_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospect_candidates_run_score
    ON prospect_candidates (run_id, score DESC, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospect_candidates_org_email
    ON prospect_candidates (organization_id, lower(email)) WHERE email IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospect_candidates_run_status
    ON prospect_candidates (run_id, status, score DESC);

-- =============================================================================
-- Durable human action approvals (migration 047)
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_action_approvals_org_status
    ON outreach_action_approvals (organization_id, status, requested_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_action_approvals_resource
    ON outreach_action_approvals (organization_id, action_kind, resource_id, requested_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_action_approvals_expiry
    ON outreach_action_approvals (status, expires_at)
    WHERE status IN ('requested', 'approved');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospecting_runs_enrichment_approval
    ON prospecting_runs (enrichment_approval_id) WHERE enrichment_approval_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaigns_activation_approval
    ON campaigns (activation_approval_id) WHERE activation_approval_id IS NOT NULL;

-- =============================================================================
-- Deliverability circuit breaker (migration 048)
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_campaign_sent
    ON outreach_emails (campaign_id, sent_at DESC) WHERE sent_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaigns_paused_reason
    ON campaigns (organization_id, paused_reason, paused_at DESC) WHERE paused_reason IS NOT NULL;

-- =============================================================================
-- Auditable AI prospect assessments (migration 049)
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospect_ai_assessments_candidate_created
    ON prospect_ai_assessments (candidate_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospect_ai_assessments_org_recommendation
    ON prospect_ai_assessments (organization_id, recommendation, confidence DESC, created_at DESC);
