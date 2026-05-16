-- ========================================================================
-- SUPERSEDED BY supabase/migrations/020_consolidate_rls.sql (Phase 13 QUA-03).
-- This migration's RLS effects are now reflected in 020. Kept on disk
-- for historical record only. Do NOT add new policies here.
-- ========================================================================

-- Enable Row Level Security for Outlook Mailboxes
-- Critical security fix: outlook_mailboxes table was added in 002_outlook_integration.sql without RLS policies

-- ============================================================================
-- OUTLOOK MAILBOXES
-- ============================================================================
ALTER TABLE IF EXISTS public.outlook_mailboxes ENABLE ROW LEVEL SECURITY;

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
