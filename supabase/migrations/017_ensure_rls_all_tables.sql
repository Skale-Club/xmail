-- Migration 017: Ensure RLS is enabled on ALL public tables
-- This is a safety-net migration to address Supabase security advisor alert "rls_disabled_in_public"
-- All statements are idempotent — safe to run even if RLS is already enabled.

-- Core tables
ALTER TABLE IF EXISTS public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.organization_users ENABLE ROW LEVEL SECURITY;

-- Domain & routing tables
ALTER TABLE IF EXISTS public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.smtp_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.http_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.address_endpoints ENABLE ROW LEVEL SECURITY;

-- Messaging tables
ALTER TABLE IF EXISTS public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.templates ENABLE ROW LEVEL SECURITY;

-- Webhook tables
ALTER TABLE IF EXISTS public.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.webhook_requests ENABLE ROW LEVEL SECURITY;

-- Tracking & analytics tables
ALTER TABLE IF EXISTS public.track_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.statistics ENABLE ROW LEVEL SECURITY;

-- System tables
ALTER TABLE IF EXISTS public.system_branding ENABLE ROW LEVEL SECURITY;

-- Outlook integration
ALTER TABLE IF EXISTS public.outlook_mailboxes ENABLE ROW LEVEL SECURITY;

-- Outreach module tables
ALTER TABLE IF EXISTS public.email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.lead_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.campaign_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.outreach_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.outreach_analytics ENABLE ROW LEVEL SECURITY;

-- Webmail tables
ALTER TABLE IF EXISTS public.mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.mail_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.mail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.mail_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.contacts ENABLE ROW LEVEL SECURITY;

-- Notifications
ALTER TABLE IF EXISTS public.user_notifications ENABLE ROW LEVEL SECURITY;
