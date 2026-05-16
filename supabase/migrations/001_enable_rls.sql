-- ========================================================================
-- SUPERSEDED BY supabase/migrations/020_consolidate_rls.sql (Phase 13 QUA-03).
-- This migration's RLS effects are now reflected in 020. Kept on disk
-- for historical record only. Do NOT add new policies here.
-- ========================================================================

-- Enable Row Level Security for all public tables except templates.
-- Templates are handled in 002_add_templates.sql so that the table can be
-- created and secured independently.

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================
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

CREATE OR REPLACE FUNCTION public.is_server_member(target_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.servers s
        JOIN public.organization_users ou ON ou.organization_id = s.organization_id
        WHERE s.id = target_server_id
          AND ou.user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_server_admin(target_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.servers s
        JOIN public.organization_users ou ON ou.organization_id = s.organization_id
        WHERE s.id = target_server_id
          AND ou.user_id = auth.uid()
          AND ou.role = 'admin'
    );
$$;

CREATE OR REPLACE FUNCTION public.is_server_editor(target_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.servers s
        JOIN public.organization_users ou ON ou.organization_id = s.organization_id
        WHERE s.id = target_server_id
          AND ou.user_id = auth.uid()
          AND ou.role IN ('admin', 'member')
    );
$$;

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
        JOIN public.servers s ON s.id = w.server_id
        JOIN public.organization_users ou ON ou.organization_id = s.organization_id
        WHERE w.id = target_webhook_id
          AND ou.user_id = auth.uid()
    );
$$;

-- ============================================================================
-- USERS
-- ============================================================================
ALTER TABLE IF EXISTS public.users ENABLE ROW LEVEL SECURITY;

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

-- ============================================================================
-- ORGANIZATIONS
-- ============================================================================
ALTER TABLE IF EXISTS public.organizations ENABLE ROW LEVEL SECURITY;

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

-- ============================================================================
-- ORGANIZATION USERS
-- ============================================================================
ALTER TABLE IF EXISTS public.organization_users ENABLE ROW LEVEL SECURITY;

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

-- ============================================================================
-- SERVERS
-- ============================================================================
ALTER TABLE IF EXISTS public.servers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS servers_select_member ON public.servers;
DROP POLICY IF EXISTS servers_insert_admin ON public.servers;
DROP POLICY IF EXISTS servers_update_admin ON public.servers;
DROP POLICY IF EXISTS servers_delete_admin ON public.servers;
DROP POLICY IF EXISTS "Users can view organization servers" ON public.servers;
DROP POLICY IF EXISTS "Owners and admins can create servers" ON public.servers;
DROP POLICY IF EXISTS "Owners and admins can update servers" ON public.servers;
DROP POLICY IF EXISTS "Only owners can delete servers" ON public.servers;

CREATE POLICY servers_select_member
    ON public.servers FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY servers_insert_admin
    ON public.servers FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY servers_update_admin
    ON public.servers FOR UPDATE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_admin(organization_id) OR public.is_platform_admin());

CREATE POLICY servers_delete_admin
    ON public.servers FOR DELETE
    TO authenticated
    USING (public.is_org_admin(organization_id) OR public.is_platform_admin());

-- ============================================================================
-- SERVER-SCOPED TABLES
-- ============================================================================
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
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY domains_insert_admin
    ON public.domains FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY domains_update_admin
    ON public.domains FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY domains_delete_admin
    ON public.domains FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

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
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY credentials_insert_admin
    ON public.credentials FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY credentials_update_admin
    ON public.credentials FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY credentials_delete_admin
    ON public.credentials FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

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
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY routes_insert_admin
    ON public.routes FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY routes_update_admin
    ON public.routes FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY routes_delete_admin
    ON public.routes FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS smtp_endpoints_select_member ON public.smtp_endpoints;
DROP POLICY IF EXISTS smtp_endpoints_insert_admin ON public.smtp_endpoints;
DROP POLICY IF EXISTS smtp_endpoints_update_admin ON public.smtp_endpoints;
DROP POLICY IF EXISTS smtp_endpoints_delete_admin ON public.smtp_endpoints;
DROP POLICY IF EXISTS "Users can view organization smtp endpoints" ON public.smtp_endpoints;
DROP POLICY IF EXISTS "Owners and admins can create smtp endpoints" ON public.smtp_endpoints;
DROP POLICY IF EXISTS "Owners and admins can update smtp endpoints" ON public.smtp_endpoints;
DROP POLICY IF EXISTS "Only owners can delete smtp endpoints" ON public.smtp_endpoints;

CREATE POLICY smtp_endpoints_select_member
    ON public.smtp_endpoints FOR SELECT
    TO authenticated
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY smtp_endpoints_insert_admin
    ON public.smtp_endpoints FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY smtp_endpoints_update_admin
    ON public.smtp_endpoints FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY smtp_endpoints_delete_admin
    ON public.smtp_endpoints FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS http_endpoints_select_member ON public.http_endpoints;
DROP POLICY IF EXISTS http_endpoints_insert_admin ON public.http_endpoints;
DROP POLICY IF EXISTS http_endpoints_update_admin ON public.http_endpoints;
DROP POLICY IF EXISTS http_endpoints_delete_admin ON public.http_endpoints;
DROP POLICY IF EXISTS "Users can view organization http endpoints" ON public.http_endpoints;
DROP POLICY IF EXISTS "Owners and admins can create http endpoints" ON public.http_endpoints;
DROP POLICY IF EXISTS "Owners and admins can update http endpoints" ON public.http_endpoints;
DROP POLICY IF EXISTS "Only owners can delete http endpoints" ON public.http_endpoints;

CREATE POLICY http_endpoints_select_member
    ON public.http_endpoints FOR SELECT
    TO authenticated
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY http_endpoints_insert_admin
    ON public.http_endpoints FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY http_endpoints_update_admin
    ON public.http_endpoints FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY http_endpoints_delete_admin
    ON public.http_endpoints FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS address_endpoints_select_member ON public.address_endpoints;
DROP POLICY IF EXISTS address_endpoints_insert_admin ON public.address_endpoints;
DROP POLICY IF EXISTS address_endpoints_update_admin ON public.address_endpoints;
DROP POLICY IF EXISTS address_endpoints_delete_admin ON public.address_endpoints;
DROP POLICY IF EXISTS "Users can view organization address endpoints" ON public.address_endpoints;
DROP POLICY IF EXISTS "Owners and admins can create address endpoints" ON public.address_endpoints;
DROP POLICY IF EXISTS "Owners and admins can update address endpoints" ON public.address_endpoints;
DROP POLICY IF EXISTS "Only owners can delete address endpoints" ON public.address_endpoints;

CREATE POLICY address_endpoints_select_member
    ON public.address_endpoints FOR SELECT
    TO authenticated
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY address_endpoints_insert_admin
    ON public.address_endpoints FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY address_endpoints_update_admin
    ON public.address_endpoints FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY address_endpoints_delete_admin
    ON public.address_endpoints FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

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
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY messages_insert_member
    ON public.messages FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY messages_update_admin
    ON public.messages FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY messages_delete_admin
    ON public.messages FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS deliveries_select_member ON public.deliveries;
DROP POLICY IF EXISTS "Users can view organization deliveries" ON public.deliveries;
DROP POLICY IF EXISTS "System can insert deliveries" ON public.deliveries;
DROP POLICY IF EXISTS "System can update deliveries" ON public.deliveries;

CREATE POLICY deliveries_select_member
    ON public.deliveries FOR SELECT
    TO authenticated
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

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
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY webhooks_insert_admin
    ON public.webhooks FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY webhooks_update_admin
    ON public.webhooks FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY webhooks_delete_admin
    ON public.webhooks FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS webhook_requests_select_member ON public.webhook_requests;
DROP POLICY IF EXISTS "Users can view organization webhook requests" ON public.webhook_requests;
DROP POLICY IF EXISTS "System can insert webhook requests" ON public.webhook_requests;

CREATE POLICY webhook_requests_select_member
    ON public.webhook_requests FOR SELECT
    TO authenticated
    USING (public.is_webhook_member(webhook_id) OR public.is_platform_admin());

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
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY track_domains_insert_admin
    ON public.track_domains FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY track_domains_update_admin
    ON public.track_domains FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY track_domains_delete_admin
    ON public.track_domains FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

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
    USING (public.is_server_member(server_id) OR public.is_platform_admin());

CREATE POLICY suppressions_insert_admin
    ON public.suppressions FOR INSERT
    TO authenticated
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY suppressions_update_admin
    ON public.suppressions FOR UPDATE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin())
    WITH CHECK (public.is_server_admin(server_id) OR public.is_platform_admin());

CREATE POLICY suppressions_delete_admin
    ON public.suppressions FOR DELETE
    TO authenticated
    USING (public.is_server_admin(server_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS statistics_select_member ON public.statistics;
DROP POLICY IF EXISTS "Users can view organization statistics" ON public.statistics;
DROP POLICY IF EXISTS "System can insert statistics" ON public.statistics;
DROP POLICY IF EXISTS "System can update statistics" ON public.statistics;

CREATE POLICY statistics_select_member
    ON public.statistics FOR SELECT
    TO authenticated
    USING (public.is_server_member(server_id) OR public.is_platform_admin());
