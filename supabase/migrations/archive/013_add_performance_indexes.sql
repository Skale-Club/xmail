-- ARCHIVED 2026-05-16 (Phase 13 QUA-02 / audit M2).
-- This migration was marked DEPRECATED in-file but kept in the active migrations dir, causing confusion.
-- Indexes are now defined in `src/db/schema.ts` (Drizzle `index()`) and applied via `sql/indexes.sql` (CONCURRENTLY).
-- Run `npm run db:indexes` to apply. DO NOT run this archived file against a live DB.

-- DEPRECATED — This migration is superseded.
-- All indexes are now defined in src/db/schema.ts using Drizzle's index() API.
-- This file is kept for historical reference only. Do NOT run this migration.
-- See Phase 06: Index Foundation for details.
--

-- Performance indexes for frequently queried columns
-- These indexes target the most common query patterns in the application

-- Messages table indexes
CREATE INDEX IF NOT EXISTS idx_messages_organization_id ON messages(organization_id);
-- CREATE INDEX IF NOT EXISTS idx_messages_server_id ON messages(server_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_messages_sender_email ON messages(sender_email);

-- Mail messages indexes
CREATE INDEX IF NOT EXISTS idx_mail_messages_mailbox_id ON mail_messages(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_folder_id ON mail_messages(folder_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_is_read ON mail_messages(is_read);
CREATE INDEX IF NOT EXISTS idx_mail_messages_is_starred ON mail_messages(is_starred);
CREATE INDEX IF NOT EXISTS idx_mail_messages_created_at ON mail_messages(created_at DESC);

-- Campaign leads indexes
-- CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_id ON campaign_leads(campaign_id);
-- CREATE INDEX IF NOT EXISTS idx_campaign_leads_lead_id ON campaign_leads(lead_id);
-- CREATE INDEX IF NOT EXISTS idx_campaign_leads_status ON campaign_leads(status);
-- CREATE INDEX IF NOT EXISTS idx_campaign_leads_next_scheduled_at ON campaign_leads(next_scheduled_at);

-- Leads indexes
CREATE INDEX IF NOT EXISTS idx_leads_organization_id ON leads(organization_id);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

-- Email accounts indexes
CREATE INDEX IF NOT EXISTS idx_email_accounts_organization_id ON email_accounts(organization_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_status ON email_accounts(status);
CREATE INDEX IF NOT EXISTS idx_email_accounts_email ON email_accounts(email);

-- Outreach emails indexes
CREATE INDEX IF NOT EXISTS idx_outreach_emails_campaign_id ON outreach_emails(campaign_id);
-- CREATE INDEX IF NOT EXISTS idx_outreach_emails_lead_id ON outreach_emails(lead_id);
CREATE INDEX IF NOT EXISTS idx_outreach_emails_status ON outreach_emails(status);
CREATE INDEX IF NOT EXISTS idx_outreach_emails_created_at ON outreach_emails(created_at DESC);

-- Webhooks indexes
CREATE INDEX IF NOT EXISTS idx_webhooks_organization_id ON webhooks(organization_id);
-- CREATE INDEX IF NOT EXISTS idx_webhooks_server_id ON webhooks(server_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);

-- Domains indexes
CREATE INDEX IF NOT EXISTS idx_domains_organization_id ON domains(organization_id);
CREATE INDEX IF NOT EXISTS idx_domains_verification_status ON domains(verification_status);

-- Organization users indexes
CREATE INDEX IF NOT EXISTS idx_organization_users_user_id ON organization_users(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_users_organization_id ON organization_users(organization_id);

-- Suppressions indexes
CREATE INDEX IF NOT EXISTS idx_suppressions_organization_id ON suppressions(organization_id);
CREATE INDEX IF NOT EXISTS idx_suppressions_email ON suppressions(email_address);

-- Deliveries indexes
CREATE INDEX IF NOT EXISTS idx_deliveries_message_id ON deliveries(message_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);

-- Sequence steps indexes
CREATE INDEX IF NOT EXISTS idx_sequence_steps_sequence_id ON sequence_steps(sequence_id);

-- Campaigns indexes
CREATE INDEX IF NOT EXISTS idx_campaigns_organization_id ON campaigns(organization_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- Mailboxes indexes
CREATE INDEX IF NOT EXISTS idx_mailboxes_user_id ON mailboxes(user_id);
CREATE INDEX IF NOT EXISTS idx_mailboxes_is_active ON mailboxes(is_active);

-- Mail folders indexes
CREATE INDEX IF NOT EXISTS idx_mail_folders_mailbox_id ON mail_folders(mailbox_id);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_messages_org_status_created ON messages(organization_id, status, created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_status ON campaign_leads(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_mail_messages_mailbox_folder ON mail_messages(mailbox_id, folder_id);

-- Partial indexes for active records
-- CREATE INDEX IF NOT EXISTS idx_email_accounts_active ON email_accounts(organization_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_webhooks_active_partial ON webhooks(organization_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_campaigns_active_partial ON campaigns(organization_id) WHERE status = 'active';

-- Comment on the migration
COMMENT ON SCHEMA public IS 'Added performance indexes for frequently queried columns';
