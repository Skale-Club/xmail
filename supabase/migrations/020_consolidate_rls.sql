-- ========================================================================
-- 020_consolidate_rls.sql — RLS policy end-state, single idempotent source
-- ========================================================================
-- Phase 13 QUA-03 / audit M5.
--
-- This migration replaces the scattered RLS history (001, 004, 005, 006,
-- 007, 009, 014, 016 — all annotated SUPERSEDED). Migration 015 also
-- defines RLS policies for mail_filters / signatures / contacts inline
-- with their table-create statements; those policies are re-asserted here
-- so 020 is a complete end-state.
--
-- It is IDEMPOTENT — running it twice produces zero errors:
--     DROP POLICY IF EXISTS <name> ON <table>;
--     CREATE POLICY <name> ON <table> FOR <verb> USING (...);
--
-- Helper functions (is_org_member / is_org_admin / is_platform_admin /
-- can_manage_org_member / is_webhook_member / is_campaign_org_member /
-- is_sequence_org_member / is_campaign_lead_org_member) are defined via
-- CREATE OR REPLACE FUNCTION at the top.
--
-- IMPORTANT: The application connects with the `DATABASE_URL` Postgres
-- role which bypasses RLS (no auth.uid() context). These policies are
-- defense-in-depth only — the real authorization layer lives in
-- src/server/lib/access.ts (every API route MUST call a checkXAccess
-- helper). See CLAUDE.md ### Authentication Flow.
--
-- Renumber note: REQUIREMENTS.md and the system-wide audit refer to
-- this file as 017_consolidate_rls.sql. Migrations 018 (Phase 11 SEC-02 —
-- mailboxes.skip_tls_verify) and 019 (Phase 12 COR-03 —
-- messages.clicked_at) were taken before this plan executed, so this
-- file is numbered 020 to preserve sequential ordering.
-- ========================================================================

BEGIN;

-- ========================================================================
-- 1. HELPER FUNCTIONS
-- ========================================================================

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.users
        WHERE id = auth.uid()
          AND is_admin = true
    );
$$;

CREATE OR REPLACE FUNCTION public.is_org_member(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_users
        WHERE organization_id = target_organization_id
          AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_users
        WHERE organization_id = target_organization_id
          AND user_id = auth.uid()
          AND role = 'admin'
    );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_org_member(
    target_organization_id uuid,
    target_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_users ou
        JOIN public.organizations o ON o.id = ou.organization_id
        WHERE ou.organization_id = target_organization_id
          AND ou.user_id = auth.uid()
          AND ou.role = 'admin'
          AND o.owner_id <> target_user_id
    );
$$;

-- Webhook helper — joins webhook_id → webhooks.organization_id → organization_users.
CREATE OR REPLACE FUNCTION public.is_webhook_member(target_webhook_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.webhooks w
        JOIN public.organization_users ou ON ou.organization_id = w.organization_id
        WHERE w.id = target_webhook_id
          AND ou.user_id = auth.uid()
    );
$$;

-- Outreach hierarchy helpers (campaign → sequence → campaign_lead).
CREATE OR REPLACE FUNCTION public.is_campaign_org_member(target_campaign_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.campaigns c
        JOIN public.organization_users ou ON ou.organization_id = c.organization_id
        WHERE c.id = target_campaign_id
          AND ou.user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_sequence_org_member(target_sequence_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.sequences s
        JOIN public.campaigns c ON c.id = s.campaign_id
        JOIN public.organization_users ou ON ou.organization_id = c.organization_id
        WHERE s.id = target_sequence_id
          AND ou.user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_campaign_lead_org_member(target_campaign_lead_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.campaign_leads cl
        JOIN public.campaigns c ON c.id = cl.campaign_id
        JOIN public.organization_users ou ON ou.organization_id = c.organization_id
        WHERE cl.id = target_campaign_lead_id
          AND ou.user_id = auth.uid()
    );
$$;

-- Drop legacy server-scoped helpers if they still exist on the target DB.
DROP FUNCTION IF EXISTS public.is_server_member(uuid);
DROP FUNCTION IF EXISTS public.is_server_admin(uuid);
DROP FUNCTION IF EXISTS public.is_server_editor(uuid);

-- Drop duplicate outreach-org-member helper (is_org_member supersedes it).
DROP FUNCTION IF EXISTS public.is_outreach_org_member(uuid);

-- ========================================================================
-- 2. ENABLE RLS ON EVERY TENANT-SCOPED TABLE
-- ========================================================================

-- Core platform
ALTER TABLE IF EXISTS public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.organization_users ENABLE ROW LEVEL SECURITY;

-- Org-scoped data
ALTER TABLE IF EXISTS public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.smtp_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.http_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.address_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.webhook_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.track_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.system_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.outlook_mailboxes ENABLE ROW LEVEL SECURITY;

-- Outreach (org-scoped)
ALTER TABLE IF EXISTS public.email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.lead_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.campaign_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.outreach_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.outreach_analytics ENABLE ROW LEVEL SECURITY;

-- Mail (user-scoped via mailboxes.user_id)
ALTER TABLE IF EXISTS public.mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.mail_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.mail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.mail_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.signatures ENABLE ROW LEVEL SECURITY;

-- User-scoped
ALTER TABLE IF EXISTS public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_notifications ENABLE ROW LEVEL SECURITY;

-- ========================================================================
-- 3. USERS — own row + platform admin
-- ========================================================================

DROP POLICY IF EXISTS users_select_self_or_admin ON public.users;
DROP POLICY IF EXISTS users_insert_self_or_admin ON public.users;
DROP POLICY IF EXISTS users_update_self_or_admin ON public.users;
DROP POLICY IF EXISTS users_delete_admin_only ON public.users;
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.users;

CREATE POLICY users_select_self_or_admin
    ON public.users FOR SELECT
    TO authenticated
    USING (auth.uid() = id OR public.is_platform_admin());

CREATE POLICY users_insert_self_or_admin
    ON public.users FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = id OR public.is_platform_admin());

CREATE POLICY users_update_self_or_admin
    ON public.users FOR UPDATE
    TO authenticated
    USING (auth.uid() = id OR public.is_platform_admin())
    WITH CHECK (auth.uid() = id OR public.is_platform_admin());

CREATE POLICY users_delete_admin_only
    ON public.users FOR DELETE
    TO authenticated
    USING (public.is_platform_admin() AND auth.uid() <> id);

-- ========================================================================
-- 4. ORGANIZATIONS
-- ========================================================================

DROP POLICY IF EXISTS organizations_select_member ON public.organizations;
DROP POLICY IF EXISTS organizations_insert_owner ON public.organizations;
DROP POLICY IF EXISTS organizations_update_admin ON public.organizations;
DROP POLICY IF EXISTS organizations_delete_owner ON public.organizations;
DROP POLICY IF EXISTS "Users can view their organizations" ON public.organizations;
DROP POLICY IF EXISTS "Users can create organizations" ON public.organizations;
DROP POLICY IF EXISTS "Only owners can update organizations" ON public.organizations;
DROP POLICY IF EXISTS "Only owners can delete organizations" ON public.organizations;

CREATE POLICY organizations_select_member
    ON public.organizations FOR SELECT
    TO authenticated
    USING (public.is_org_member(id) OR owner_id = auth.uid() OR public.is_platform_admin());

CREATE POLICY organizations_insert_owner
    ON public.organizations FOR INSERT
    TO authenticated
    WITH CHECK (owner_id = auth.uid() OR public.is_platform_admin());

CREATE POLICY organizations_update_admin
    ON public.organizations FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(id) OR owner_id = auth.uid() OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(id) OR owner_id = auth.uid() OR public.is_platform_admin());

CREATE POLICY organizations_delete_owner
    ON public.organizations FOR DELETE
    TO authenticated
    USING (owner_id = auth.uid() OR public.is_platform_admin());

-- ========================================================================
-- 5. ORGANIZATION USERS
-- ========================================================================

DROP POLICY IF EXISTS organization_users_select_member ON public.organization_users;
DROP POLICY IF EXISTS organization_users_insert_admin ON public.organization_users;
DROP POLICY IF EXISTS organization_users_update_admin ON public.organization_users;
DROP POLICY IF EXISTS organization_users_delete_admin ON public.organization_users;
DROP POLICY IF EXISTS "Users can view organization members" ON public.organization_users;
DROP POLICY IF EXISTS "Owners and admins can add members" ON public.organization_users;
DROP POLICY IF EXISTS "Owners can remove members" ON public.organization_users;

CREATE POLICY organization_users_select_member
    ON public.organization_users FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY organization_users_insert_admin
    ON public.organization_users FOR INSERT
    TO authenticated
    WITH CHECK (
        public.is_platform_admin()
        OR public.is_org_admin(organization_id)
        OR (
            user_id = auth.uid()
            AND role = 'admin'
            AND EXISTS (
                SELECT 1
                FROM public.organizations o
                WHERE o.id = organization_id
                  AND o.owner_id = auth.uid()
            )
        )
    );

CREATE POLICY organization_users_update_admin
    ON public.organization_users FOR UPDATE
    TO authenticated
    USING (public.can_manage_org_member(organization_id, user_id) OR public.is_platform_admin())
    WITH CHECK (public.can_manage_org_member(organization_id, user_id) OR public.is_platform_admin());

CREATE POLICY organization_users_delete_admin
    ON public.organization_users FOR DELETE
    TO authenticated
    USING (public.can_manage_org_member(organization_id, user_id) OR public.is_platform_admin());

-- ========================================================================
-- 6. ORG-SCOPED RESOURCE TABLES — uniform pattern
--    SELECT  → is_org_member
--    INSERT  → is_org_admin (mutation gate)
--    UPDATE  → is_org_admin
--    DELETE  → is_org_admin
-- ========================================================================

-- DOMAINS -----------------------------------------------------------------
DROP POLICY IF EXISTS domains_select_member ON public.domains;
DROP POLICY IF EXISTS domains_insert_admin ON public.domains;
DROP POLICY IF EXISTS domains_update_admin ON public.domains;
DROP POLICY IF EXISTS domains_delete_admin ON public.domains;
DROP POLICY IF EXISTS "Users can view organization domains" ON public.domains;
DROP POLICY IF EXISTS "Owners and admins can create domains" ON public.domains;
DROP POLICY IF EXISTS "Owners and admins can update domains" ON public.domains;
DROP POLICY IF EXISTS "Only owners can delete domains" ON public.domains;

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

-- CREDENTIALS -------------------------------------------------------------
DROP POLICY IF EXISTS credentials_select_member ON public.credentials;
DROP POLICY IF EXISTS credentials_insert_admin ON public.credentials;
DROP POLICY IF EXISTS credentials_update_admin ON public.credentials;
DROP POLICY IF EXISTS credentials_delete_admin ON public.credentials;
DROP POLICY IF EXISTS "Users can view organization credentials" ON public.credentials;
DROP POLICY IF EXISTS "Owners and admins can create credentials" ON public.credentials;
DROP POLICY IF EXISTS "Owners and admins can update credentials" ON public.credentials;
DROP POLICY IF EXISTS "Only owners can delete credentials" ON public.credentials;

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

-- ROUTES ------------------------------------------------------------------
DROP POLICY IF EXISTS routes_select_member ON public.routes;
DROP POLICY IF EXISTS routes_insert_admin ON public.routes;
DROP POLICY IF EXISTS routes_update_admin ON public.routes;
DROP POLICY IF EXISTS routes_delete_admin ON public.routes;
DROP POLICY IF EXISTS "Users can view organization routes" ON public.routes;
DROP POLICY IF EXISTS "Owners and admins can create routes" ON public.routes;
DROP POLICY IF EXISTS "Owners and admins can update routes" ON public.routes;
DROP POLICY IF EXISTS "Only owners can delete routes" ON public.routes;

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

-- SMTP ENDPOINTS ----------------------------------------------------------
DROP POLICY IF EXISTS smtp_endpoints_select_member ON public.smtp_endpoints;
DROP POLICY IF EXISTS smtp_endpoints_insert_admin ON public.smtp_endpoints;
DROP POLICY IF EXISTS smtp_endpoints_update_admin ON public.smtp_endpoints;
DROP POLICY IF EXISTS smtp_endpoints_delete_admin ON public.smtp_endpoints;

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

-- HTTP ENDPOINTS ----------------------------------------------------------
DROP POLICY IF EXISTS http_endpoints_select_member ON public.http_endpoints;
DROP POLICY IF EXISTS http_endpoints_insert_admin ON public.http_endpoints;
DROP POLICY IF EXISTS http_endpoints_update_admin ON public.http_endpoints;
DROP POLICY IF EXISTS http_endpoints_delete_admin ON public.http_endpoints;

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

-- ADDRESS ENDPOINTS -------------------------------------------------------
DROP POLICY IF EXISTS address_endpoints_select_member ON public.address_endpoints;
DROP POLICY IF EXISTS address_endpoints_insert_admin ON public.address_endpoints;
DROP POLICY IF EXISTS address_endpoints_update_admin ON public.address_endpoints;
DROP POLICY IF EXISTS address_endpoints_delete_admin ON public.address_endpoints;

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

-- MESSAGES (insert is member-level, mutations admin-level) ----------------
DROP POLICY IF EXISTS messages_select_member ON public.messages;
DROP POLICY IF EXISTS messages_insert_member ON public.messages;
DROP POLICY IF EXISTS messages_update_admin ON public.messages;
DROP POLICY IF EXISTS messages_delete_admin ON public.messages;
DROP POLICY IF EXISTS "Users can view organization messages" ON public.messages;
DROP POLICY IF EXISTS "Users can create messages" ON public.messages;
DROP POLICY IF EXISTS "Owners and admins can update messages" ON public.messages;
DROP POLICY IF EXISTS "Only owners can delete messages" ON public.messages;

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

-- DELIVERIES (SELECT only — system writes via DATABASE_URL role) ----------
DROP POLICY IF EXISTS deliveries_select_member ON public.deliveries;
DROP POLICY IF EXISTS "Users can view organization deliveries" ON public.deliveries;
DROP POLICY IF EXISTS "System can insert deliveries" ON public.deliveries;
DROP POLICY IF EXISTS "System can update deliveries" ON public.deliveries;

CREATE POLICY deliveries_select_member
    ON public.deliveries FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- WEBHOOKS ----------------------------------------------------------------
DROP POLICY IF EXISTS webhooks_select_member ON public.webhooks;
DROP POLICY IF EXISTS webhooks_insert_admin ON public.webhooks;
DROP POLICY IF EXISTS webhooks_update_admin ON public.webhooks;
DROP POLICY IF EXISTS webhooks_delete_admin ON public.webhooks;
DROP POLICY IF EXISTS "Users can view organization webhooks" ON public.webhooks;
DROP POLICY IF EXISTS "Owners and admins can create webhooks" ON public.webhooks;
DROP POLICY IF EXISTS "Owners and admins can update webhooks" ON public.webhooks;
DROP POLICY IF EXISTS "Only owners can delete webhooks" ON public.webhooks;

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

-- WEBHOOK REQUESTS (SELECT via is_webhook_member helper) ------------------
DROP POLICY IF EXISTS webhook_requests_select_member ON public.webhook_requests;
DROP POLICY IF EXISTS "Users can view organization webhook requests" ON public.webhook_requests;
DROP POLICY IF EXISTS "System can insert webhook requests" ON public.webhook_requests;

CREATE POLICY webhook_requests_select_member
    ON public.webhook_requests FOR SELECT
    TO authenticated
    USING (public.is_webhook_member(webhook_id) OR public.is_platform_admin());

-- TRACK DOMAINS -----------------------------------------------------------
DROP POLICY IF EXISTS track_domains_select_member ON public.track_domains;
DROP POLICY IF EXISTS track_domains_insert_admin ON public.track_domains;
DROP POLICY IF EXISTS track_domains_update_admin ON public.track_domains;
DROP POLICY IF EXISTS track_domains_delete_admin ON public.track_domains;
DROP POLICY IF EXISTS "Users can view organization track domains" ON public.track_domains;
DROP POLICY IF EXISTS "Owners and admins can create track domains" ON public.track_domains;
DROP POLICY IF EXISTS "Owners and admins can update track domains" ON public.track_domains;
DROP POLICY IF EXISTS "Only owners can delete track domains" ON public.track_domains;

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

-- SUPPRESSIONS ------------------------------------------------------------
DROP POLICY IF EXISTS suppressions_select_member ON public.suppressions;
DROP POLICY IF EXISTS suppressions_insert_admin ON public.suppressions;
DROP POLICY IF EXISTS suppressions_update_admin ON public.suppressions;
DROP POLICY IF EXISTS suppressions_delete_admin ON public.suppressions;
DROP POLICY IF EXISTS "Users can view organization suppressions" ON public.suppressions;
DROP POLICY IF EXISTS "Owners and admins can create suppressions" ON public.suppressions;
DROP POLICY IF EXISTS "Owners and admins can update suppressions" ON public.suppressions;
DROP POLICY IF EXISTS "Only owners can delete suppressions" ON public.suppressions;

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

-- STATISTICS (SELECT only — system writes via DATABASE_URL role) ----------
DROP POLICY IF EXISTS statistics_select_member ON public.statistics;
DROP POLICY IF EXISTS "Users can view organization statistics" ON public.statistics;
DROP POLICY IF EXISTS "System can insert statistics" ON public.statistics;
DROP POLICY IF EXISTS "System can update statistics" ON public.statistics;

CREATE POLICY statistics_select_member
    ON public.statistics FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- TEMPLATES ---------------------------------------------------------------
DROP POLICY IF EXISTS templates_select_member ON public.templates;
DROP POLICY IF EXISTS templates_insert_editor ON public.templates;
DROP POLICY IF EXISTS templates_update_editor ON public.templates;
DROP POLICY IF EXISTS templates_delete_editor ON public.templates;
DROP POLICY IF EXISTS "Users can view organization templates" ON public.templates;
DROP POLICY IF EXISTS "Members can create templates" ON public.templates;
DROP POLICY IF EXISTS "Members can update templates" ON public.templates;
DROP POLICY IF EXISTS "Admins can delete templates" ON public.templates;

CREATE POLICY templates_select_member
    ON public.templates FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY templates_insert_editor
    ON public.templates FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY templates_update_editor
    ON public.templates FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY templates_delete_editor
    ON public.templates FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- OUTLOOK MAILBOXES -------------------------------------------------------
DROP POLICY IF EXISTS outlook_mailboxes_select ON public.outlook_mailboxes;
DROP POLICY IF EXISTS outlook_mailboxes_insert ON public.outlook_mailboxes;
DROP POLICY IF EXISTS outlook_mailboxes_update ON public.outlook_mailboxes;
DROP POLICY IF EXISTS outlook_mailboxes_delete ON public.outlook_mailboxes;

CREATE POLICY outlook_mailboxes_select ON public.outlook_mailboxes FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outlook_mailboxes_insert ON public.outlook_mailboxes FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY outlook_mailboxes_update ON public.outlook_mailboxes FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY outlook_mailboxes_delete ON public.outlook_mailboxes FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- SYSTEM BRANDING (public read, platform-admin write) --------------------
DROP POLICY IF EXISTS "Allow public read access to system_branding" ON public.system_branding;
DROP POLICY IF EXISTS "Allow admin write access to system_branding" ON public.system_branding;

CREATE POLICY "Allow public read access to system_branding"
    ON public.system_branding FOR SELECT
    USING (true);

CREATE POLICY "Allow admin write access to system_branding"
    ON public.system_branding FOR ALL
    USING (public.is_platform_admin());

-- ========================================================================
-- 7. OUTREACH TABLES — org-scoped via organization_id or campaign helper
--    Note: outreach mutations use is_org_member (NOT is_org_admin) per 016.
-- ========================================================================

-- EMAIL ACCOUNTS ----------------------------------------------------------
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

-- LEAD LISTS --------------------------------------------------------------
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

-- LEADS -------------------------------------------------------------------
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

-- CAMPAIGNS ---------------------------------------------------------------
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

-- SEQUENCES (via campaign helper) -----------------------------------------
DROP POLICY IF EXISTS sequences_select ON public.sequences;
DROP POLICY IF EXISTS sequences_insert ON public.sequences;
DROP POLICY IF EXISTS sequences_update ON public.sequences;
DROP POLICY IF EXISTS sequences_delete ON public.sequences;

CREATE POLICY sequences_select ON public.sequences FOR SELECT
    TO authenticated
    USING (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin());

CREATE POLICY sequences_insert ON public.sequences FOR INSERT
    TO authenticated
    WITH CHECK (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin());

CREATE POLICY sequences_update ON public.sequences FOR UPDATE
    TO authenticated
    USING (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin())
    WITH CHECK (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin());

CREATE POLICY sequences_delete ON public.sequences FOR DELETE
    TO authenticated
    USING (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin());

-- SEQUENCE STEPS (via sequence helper) ------------------------------------
DROP POLICY IF EXISTS sequence_steps_select ON public.sequence_steps;
DROP POLICY IF EXISTS sequence_steps_insert ON public.sequence_steps;
DROP POLICY IF EXISTS sequence_steps_update ON public.sequence_steps;
DROP POLICY IF EXISTS sequence_steps_delete ON public.sequence_steps;

CREATE POLICY sequence_steps_select ON public.sequence_steps FOR SELECT
    TO authenticated
    USING (public.is_sequence_org_member(sequence_id) OR public.is_platform_admin());

CREATE POLICY sequence_steps_insert ON public.sequence_steps FOR INSERT
    TO authenticated
    WITH CHECK (public.is_sequence_org_member(sequence_id) OR public.is_platform_admin());

CREATE POLICY sequence_steps_update ON public.sequence_steps FOR UPDATE
    TO authenticated
    USING (public.is_sequence_org_member(sequence_id) OR public.is_platform_admin())
    WITH CHECK (public.is_sequence_org_member(sequence_id) OR public.is_platform_admin());

CREATE POLICY sequence_steps_delete ON public.sequence_steps FOR DELETE
    TO authenticated
    USING (public.is_sequence_org_member(sequence_id) OR public.is_platform_admin());

-- CAMPAIGN LEADS (via campaign helper) ------------------------------------
DROP POLICY IF EXISTS campaign_leads_select ON public.campaign_leads;
DROP POLICY IF EXISTS campaign_leads_insert ON public.campaign_leads;
DROP POLICY IF EXISTS campaign_leads_update ON public.campaign_leads;
DROP POLICY IF EXISTS campaign_leads_delete ON public.campaign_leads;

CREATE POLICY campaign_leads_select ON public.campaign_leads FOR SELECT
    TO authenticated
    USING (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin());

CREATE POLICY campaign_leads_insert ON public.campaign_leads FOR INSERT
    TO authenticated
    WITH CHECK (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin());

CREATE POLICY campaign_leads_update ON public.campaign_leads FOR UPDATE
    TO authenticated
    USING (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin())
    WITH CHECK (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin());

CREATE POLICY campaign_leads_delete ON public.campaign_leads FOR DELETE
    TO authenticated
    USING (public.is_campaign_org_member(campaign_id) OR public.is_platform_admin());

-- OUTREACH EMAILS ---------------------------------------------------------
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

-- OUTREACH ANALYTICS ------------------------------------------------------
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

-- ========================================================================
-- 8. MAIL TABLES — user-scoped (own mailbox)
-- ========================================================================

-- MAILBOXES (direct user_id) ----------------------------------------------
DROP POLICY IF EXISTS mailboxes_select_owner ON public.mailboxes;
DROP POLICY IF EXISTS mailboxes_insert_owner ON public.mailboxes;
DROP POLICY IF EXISTS mailboxes_update_owner ON public.mailboxes;
DROP POLICY IF EXISTS mailboxes_delete_owner ON public.mailboxes;

CREATE POLICY mailboxes_select_owner
    ON public.mailboxes FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY mailboxes_insert_owner
    ON public.mailboxes FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY mailboxes_update_owner
    ON public.mailboxes FOR UPDATE
    TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY mailboxes_delete_owner
    ON public.mailboxes FOR DELETE
    TO authenticated
    USING (user_id = auth.uid());

-- MAIL FOLDERS (via mailbox.user_id) --------------------------------------
DROP POLICY IF EXISTS mail_folders_select_owner ON public.mail_folders;
DROP POLICY IF EXISTS mail_folders_insert_owner ON public.mail_folders;
DROP POLICY IF EXISTS mail_folders_delete_owner ON public.mail_folders;

CREATE POLICY mail_folders_select_owner
    ON public.mail_folders FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.mail_folders.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_folders_insert_owner
    ON public.mail_folders FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_folders_delete_owner
    ON public.mail_folders FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.mail_folders.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

-- MAIL MESSAGES (via mailbox.user_id) -------------------------------------
DROP POLICY IF EXISTS mail_messages_select_owner ON public.mail_messages;
DROP POLICY IF EXISTS mail_messages_insert_owner ON public.mail_messages;
DROP POLICY IF EXISTS mail_messages_update_owner ON public.mail_messages;
DROP POLICY IF EXISTS mail_messages_delete_owner ON public.mail_messages;

CREATE POLICY mail_messages_select_owner
    ON public.mail_messages FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.mail_messages.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_messages_insert_owner
    ON public.mail_messages FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_messages_update_owner
    ON public.mail_messages FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.mail_messages.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_messages_delete_owner
    ON public.mail_messages FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.mail_messages.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

-- MAIL FILTERS (via mailbox.user_id) --------------------------------------
DROP POLICY IF EXISTS mail_filters_select_owner ON public.mail_filters;
DROP POLICY IF EXISTS mail_filters_insert_owner ON public.mail_filters;
DROP POLICY IF EXISTS mail_filters_update_owner ON public.mail_filters;
DROP POLICY IF EXISTS mail_filters_delete_owner ON public.mail_filters;

CREATE POLICY mail_filters_select_owner
    ON public.mail_filters FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.mail_filters.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_filters_insert_owner
    ON public.mail_filters FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_filters_update_owner
    ON public.mail_filters FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.mail_filters.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_filters_delete_owner
    ON public.mail_filters FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.mail_filters.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

-- SIGNATURES (via mailbox.user_id) ----------------------------------------
DROP POLICY IF EXISTS signatures_select_owner ON public.signatures;
DROP POLICY IF EXISTS signatures_insert_owner ON public.signatures;
DROP POLICY IF EXISTS signatures_update_owner ON public.signatures;
DROP POLICY IF EXISTS signatures_delete_owner ON public.signatures;

CREATE POLICY signatures_select_owner
    ON public.signatures FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.signatures.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY signatures_insert_owner
    ON public.signatures FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY signatures_update_owner
    ON public.signatures FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.signatures.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY signatures_delete_owner
    ON public.signatures FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.mailboxes
            WHERE public.mailboxes.id = public.signatures.mailbox_id
              AND public.mailboxes.user_id = auth.uid()
        )
    );

-- ========================================================================
-- 9. USER-SCOPED TABLES (own rows)
-- ========================================================================

-- CONTACTS ----------------------------------------------------------------
DROP POLICY IF EXISTS contacts_select_owner ON public.contacts;
DROP POLICY IF EXISTS contacts_insert_owner ON public.contacts;
DROP POLICY IF EXISTS contacts_update_owner ON public.contacts;
DROP POLICY IF EXISTS contacts_delete_owner ON public.contacts;

CREATE POLICY contacts_select_owner
    ON public.contacts FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY contacts_insert_owner
    ON public.contacts FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY contacts_update_owner
    ON public.contacts FOR UPDATE
    TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY contacts_delete_owner
    ON public.contacts FOR DELETE
    TO authenticated
    USING (user_id = auth.uid());

-- USER NOTIFICATIONS ------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own notifications" ON public.user_notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON public.user_notifications;
DROP POLICY IF EXISTS "Users can delete own notifications" ON public.user_notifications;

CREATE POLICY "Users can view own notifications" ON public.user_notifications
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications" ON public.user_notifications
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own notifications" ON public.user_notifications
    FOR DELETE USING (auth.uid() = user_id);

COMMIT;

-- ========================================================================
-- END 020_consolidate_rls.sql
-- Validation: run `tsx scripts/verify-rls-policies.ts` (checks server_id
-- references, dead-function calls, critical-table coverage, duplicate
-- helper functions). Expected outcome: RESULT: PASS.
-- ========================================================================
