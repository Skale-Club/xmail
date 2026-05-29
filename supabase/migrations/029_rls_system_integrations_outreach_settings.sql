-- Migration 029: RLS policies for system_integrations and outreach_settings
-- Both tables had RLS enabled (in 023 and 024) but no policies were created,
-- meaning Supabase client access was blocked for everyone.
-- The app uses DATABASE_URL (bypasses RLS) so this didn't affect runtime,
-- but it's inconsistent and blocks any future direct Supabase client access.

BEGIN;

-- ============================================================
-- system_integrations — platform-admin read/write, no user access
-- ============================================================

DROP POLICY IF EXISTS system_integrations_admin_all ON public.system_integrations;

CREATE POLICY system_integrations_admin_all
    ON public.system_integrations FOR ALL
    TO authenticated
    USING (public.is_platform_admin())
    WITH CHECK (public.is_platform_admin());

-- ============================================================
-- outreach_settings — org-member read, org-member write
-- (consistent with email_accounts and campaigns — outreach module
--  uses is_org_member rather than is_org_admin for mutations)
-- ============================================================

DROP POLICY IF EXISTS outreach_settings_select ON public.outreach_settings;
DROP POLICY IF EXISTS outreach_settings_insert ON public.outreach_settings;
DROP POLICY IF EXISTS outreach_settings_update ON public.outreach_settings;
DROP POLICY IF EXISTS outreach_settings_delete ON public.outreach_settings;

CREATE POLICY outreach_settings_select ON public.outreach_settings FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_settings_insert ON public.outreach_settings FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_settings_update ON public.outreach_settings FOR UPDATE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_settings_delete ON public.outreach_settings FOR DELETE
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
