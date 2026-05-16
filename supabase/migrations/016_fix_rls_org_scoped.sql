-- ========================================================================
-- SUPERSEDED BY supabase/migrations/020_consolidate_rls.sql (Phase 13 QUA-03).
-- This migration's RLS effects are now reflected in 020. Kept on disk
-- for historical record only. Do NOT add new policies here.
-- ========================================================================

-- Fix RLS policies that reference dropped server helper functions and server_id column
-- Migration 008 dropped is_server_member/is_server_admin/is_server_editor and the servers table,
-- but did NOT fix the RLS policies on server-scoped tables. These policies are now broken.
--
-- This migration:
-- 1. Drops dead server helper functions (safety)
-- 2. Drops all broken server-scoped RLS policies
-- 3. Recreates policies using organization_id and is_org_member/is_org_admin
-- 4. Consolidates duplicate is_outreach_org_member into is_org_member

-- ============================================================================
-- 1. DROP DEAD SERVER HELPER FUNCTIONS
-- ============================================================================
DROP FUNCTION IF EXISTS public.is_server_member(uuid);
DROP FUNCTION IF EXISTS public.is_server_admin(uuid);
DROP FUNCTION IF EXISTS public.is_server_editor(uuid);

-- ============================================================================
-- 2. DROP BROKEN SERVER-SCOPED RLS POLICIES
-- ============================================================================

-- Domains
DROP POLICY IF EXISTS domains_select_member ON public.domains;
DROP POLICY IF EXISTS domains_insert_admin ON public.domains;
DROP POLICY IF EXISTS domains_update_admin ON public.domains;
DROP POLICY IF EXISTS domains_delete_admin ON public.domains;

-- Credentials
DROP POLICY IF EXISTS credentials_select_member ON public.credentials;
DROP POLICY IF EXISTS credentials_insert_admin ON public.credentials;
DROP POLICY IF EXISTS credentials_update_admin ON public.credentials;
DROP POLICY IF EXISTS credentials_delete_admin ON public.credentials;

-- Routes
DROP POLICY IF EXISTS routes_select_member ON public.routes;
DROP POLICY IF EXISTS routes_insert_admin ON public.routes;
DROP POLICY IF EXISTS routes_update_admin ON public.routes;
DROP POLICY IF EXISTS routes_delete_admin ON public.routes;

-- SMTP Endpoints
DROP POLICY IF EXISTS smtp_endpoints_select_member ON public.smtp_endpoints;
DROP POLICY IF EXISTS smtp_endpoints_insert_admin ON public.smtp_endpoints;
DROP POLICY IF EXISTS smtp_endpoints_update_admin ON public.smtp_endpoints;
DROP POLICY IF EXISTS smtp_endpoints_delete_admin ON public.smtp_endpoints;

-- HTTP Endpoints
DROP POLICY IF EXISTS http_endpoints_select_member ON public.http_endpoints;
DROP POLICY IF EXISTS http_endpoints_insert_admin ON public.http_endpoints;
DROP POLICY IF EXISTS http_endpoints_update_admin ON public.http_endpoints;
DROP POLICY IF EXISTS http_endpoints_delete_admin ON public.http_endpoints;

-- Address Endpoints
DROP POLICY IF EXISTS address_endpoints_select_member ON public.address_endpoints;
DROP POLICY IF EXISTS address_endpoints_insert_admin ON public.address_endpoints;
DROP POLICY IF EXISTS address_endpoints_update_admin ON public.address_endpoints;
DROP POLICY IF EXISTS address_endpoints_delete_admin ON public.address_endpoints;

-- Messages
DROP POLICY IF EXISTS messages_select_member ON public.messages;
DROP POLICY IF EXISTS messages_insert_member ON public.messages;
DROP POLICY IF EXISTS messages_update_admin ON public.messages;
DROP POLICY IF EXISTS messages_delete_admin ON public.messages;

-- Deliveries
DROP POLICY IF EXISTS deliveries_select_member ON public.deliveries;

-- Track Domains
DROP POLICY IF EXISTS track_domains_select_member ON public.track_domains;
DROP POLICY IF EXISTS track_domains_insert_admin ON public.track_domains;
DROP POLICY IF EXISTS track_domains_update_admin ON public.track_domains;
DROP POLICY IF EXISTS track_domains_delete_admin ON public.track_domains;

-- Suppressions
DROP POLICY IF EXISTS suppressions_select_member ON public.suppressions;
DROP POLICY IF EXISTS suppressions_insert_admin ON public.suppressions;
DROP POLICY IF EXISTS suppressions_update_admin ON public.suppressions;
DROP POLICY IF EXISTS suppressions_delete_admin ON public.suppressions;

-- Statistics
DROP POLICY IF EXISTS statistics_select_member ON public.statistics;

-- Webhooks (also used server_id in migration 001; not fixed by migration 008)
DROP POLICY IF EXISTS webhooks_select_member ON public.webhooks;
DROP POLICY IF EXISTS webhooks_insert_admin ON public.webhooks;
DROP POLICY IF EXISTS webhooks_update_admin ON public.webhooks;
DROP POLICY IF EXISTS webhooks_delete_admin ON public.webhooks;

-- ============================================================================
-- 3. RECREATE POLICES USING organization_id
-- ============================================================================

-- DOMAINS
CREATE POLICY domains_select_member
    ON public.domains FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY domains_insert_admin
    ON public.domains FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY domains_update_admin
    ON public.domains FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY domains_delete_admin
    ON public.domains FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- CREDENTIALS
CREATE POLICY credentials_select_member
    ON public.credentials FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY credentials_insert_admin
    ON public.credentials FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY credentials_update_admin
    ON public.credentials FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY credentials_delete_admin
    ON public.credentials FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- ROUTES
CREATE POLICY routes_select_member
    ON public.routes FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY routes_insert_admin
    ON public.routes FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY routes_update_admin
    ON public.routes FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY routes_delete_admin
    ON public.routes FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- SMTP ENDPOINTS
CREATE POLICY smtp_endpoints_select_member
    ON public.smtp_endpoints FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY smtp_endpoints_insert_admin
    ON public.smtp_endpoints FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY smtp_endpoints_update_admin
    ON public.smtp_endpoints FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY smtp_endpoints_delete_admin
    ON public.smtp_endpoints FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- HTTP ENDPOINTS
CREATE POLICY http_endpoints_select_member
    ON public.http_endpoints FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY http_endpoints_insert_admin
    ON public.http_endpoints FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY http_endpoints_update_admin
    ON public.http_endpoints FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY http_endpoints_delete_admin
    ON public.http_endpoints FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- ADDRESS ENDPOINTS
CREATE POLICY address_endpoints_select_member
    ON public.address_endpoints FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY address_endpoints_insert_admin
    ON public.address_endpoints FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY address_endpoints_update_admin
    ON public.address_endpoints FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY address_endpoints_delete_admin
    ON public.address_endpoints FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- MESSAGES
CREATE POLICY messages_select_member
    ON public.messages FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY messages_insert_member
    ON public.messages FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY messages_update_admin
    ON public.messages FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY messages_delete_admin
    ON public.messages FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- DELIVERIES
CREATE POLICY deliveries_select_member
    ON public.deliveries FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- TRACK DOMAINS
CREATE POLICY track_domains_select_member
    ON public.track_domains FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY track_domains_insert_admin
    ON public.track_domains FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY track_domains_update_admin
    ON public.track_domains FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY track_domains_delete_admin
    ON public.track_domains FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- SUPPRESSIONS
CREATE POLICY suppressions_select_member
    ON public.suppressions FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY suppressions_insert_admin
    ON public.suppressions FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY suppressions_update_admin
    ON public.suppressions FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY suppressions_delete_admin
    ON public.suppressions FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- STATISTICS
CREATE POLICY statistics_select_member
    ON public.statistics FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- WEBHOOKS
CREATE POLICY webhooks_select_member
    ON public.webhooks FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY webhooks_insert_admin
    ON public.webhooks FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY webhooks_update_admin
    ON public.webhooks FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY webhooks_delete_admin
    ON public.webhooks FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- ============================================================================
-- 4. CONSOLIDATE DUPLICATE is_outreach_org_member
-- ============================================================================
-- is_outreach_org_member is identical to is_org_member. Drop it and update
-- outreach policies to use is_org_member directly.

DROP FUNCTION IF EXISTS public.is_outreach_org_member(uuid);

-- Email Accounts: update to use is_org_member
DROP POLICY IF EXISTS email_accounts_select ON public.email_accounts;
DROP POLICY IF EXISTS email_accounts_insert ON public.email_accounts;
DROP POLICY IF EXISTS email_accounts_update ON public.email_accounts;
DROP POLICY IF EXISTS email_accounts_delete ON public.email_accounts;

CREATE POLICY email_accounts_select ON public.email_accounts FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY email_accounts_insert ON public.email_accounts FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY email_accounts_update ON public.email_accounts FOR UPDATE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY email_accounts_delete ON public.email_accounts FOR DELETE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- Lead Lists: update to use is_org_member
DROP POLICY IF EXISTS lead_lists_select ON public.lead_lists;
DROP POLICY IF EXISTS lead_lists_insert ON public.lead_lists;
DROP POLICY IF EXISTS lead_lists_update ON public.lead_lists;
DROP POLICY IF EXISTS lead_lists_delete ON public.lead_lists;

CREATE POLICY lead_lists_select ON public.lead_lists FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY lead_lists_insert ON public.lead_lists FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY lead_lists_update ON public.lead_lists FOR UPDATE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY lead_lists_delete ON public.lead_lists FOR DELETE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- Leads: update to use is_org_member
DROP POLICY IF EXISTS leads_select ON public.leads;
DROP POLICY IF EXISTS leads_insert ON public.leads;
DROP POLICY IF EXISTS leads_update ON public.leads;
DROP POLICY IF EXISTS leads_delete ON public.leads;

CREATE POLICY leads_select ON public.leads FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY leads_insert ON public.leads FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY leads_update ON public.leads FOR UPDATE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY leads_delete ON public.leads FOR DELETE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- Campaigns: update to use is_org_member
DROP POLICY IF EXISTS campaigns_select ON public.campaigns;
DROP POLICY IF EXISTS campaigns_insert ON public.campaigns;
DROP POLICY IF EXISTS campaigns_update ON public.campaigns;
DROP POLICY IF EXISTS campaigns_delete ON public.campaigns;

CREATE POLICY campaigns_select ON public.campaigns FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY campaigns_insert ON public.campaigns FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY campaigns_update ON public.campaigns FOR UPDATE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY campaigns_delete ON public.campaigns FOR DELETE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- Outreach Emails: update to use is_org_member
DROP POLICY IF EXISTS outreach_emails_select ON public.outreach_emails;
DROP POLICY IF EXISTS outreach_emails_insert ON public.outreach_emails;
DROP POLICY IF EXISTS outreach_emails_update ON public.outreach_emails;

CREATE POLICY outreach_emails_select ON public.outreach_emails FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_emails_insert ON public.outreach_emails FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_emails_update ON public.outreach_emails FOR UPDATE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

-- Outreach Analytics: update to use is_org_member
DROP POLICY IF EXISTS outreach_analytics_select ON public.outreach_analytics;
DROP POLICY IF EXISTS outreach_analytics_insert ON public.outreach_analytics;
DROP POLICY IF EXISTS outreach_analytics_update ON public.outreach_analytics;

CREATE POLICY outreach_analytics_select ON public.outreach_analytics FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_analytics_insert ON public.outreach_analytics FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_analytics_update ON public.outreach_analytics FOR UPDATE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());
