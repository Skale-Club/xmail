-- ========================================================================
-- SUPERSEDED BY supabase/migrations/020_consolidate_rls.sql (Phase 13 QUA-03).
-- This migration's RLS effects are now reflected in 020. Kept on disk
-- for historical record only. Do NOT add new policies here.
-- ========================================================================

-- Enable Row Level Security for Outreach Module tables
-- Critical security fix: These tables had no RLS policies, allowing any authenticated user to access any organization's data

-- ============================================================================
-- HELPER FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_outreach_org_member(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.organization_users
        WHERE organization_id = target_organization_id
          AND user_id = auth.uid()
    );
$$;

-- Helper function for campaign-based access (via campaign → organization)
CREATE OR REPLACE FUNCTION public.is_campaign_org_member(target_campaign_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.campaigns c
        JOIN public.organization_users ou ON ou.organization_id = c.organization_id
        WHERE c.id = target_campaign_id
          AND ou.user_id = auth.uid()
    );
$$;

-- Helper function for sequence-based access (via sequence → campaign → organization)
CREATE OR REPLACE FUNCTION public.is_sequence_org_member(target_sequence_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.sequences s
        JOIN public.campaigns c ON c.id = s.campaign_id
        JOIN public.organization_users ou ON ou.organization_id = c.organization_id
        WHERE s.id = target_sequence_id
          AND ou.user_id = auth.uid()
    );
$$;

-- Helper function for campaign_lead access (via campaign_lead → campaign → organization)
CREATE OR REPLACE FUNCTION public.is_campaign_lead_org_member(target_campaign_lead_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.campaign_leads cl
        JOIN public.campaigns c ON c.id = cl.campaign_id
        JOIN public.organization_users ou ON ou.organization_id = c.organization_id
        WHERE cl.id = target_campaign_lead_id
          AND ou.user_id = auth.uid()
    );
$$;

-- ============================================================================
-- EMAIL ACCOUNTS
-- ============================================================================
ALTER TABLE IF EXISTS public.email_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_accounts_select ON public.email_accounts;
DROP POLICY IF EXISTS email_accounts_insert ON public.email_accounts;
DROP POLICY IF EXISTS email_accounts_update ON public.email_accounts;
DROP POLICY IF EXISTS email_accounts_delete ON public.email_accounts;

CREATE POLICY email_accounts_select ON public.email_accounts FOR SELECT
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY email_accounts_insert ON public.email_accounts FOR INSERT
    TO authenticated
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY email_accounts_update ON public.email_accounts FOR UPDATE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY email_accounts_delete ON public.email_accounts FOR DELETE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

-- ============================================================================
-- LEAD LISTS
-- ============================================================================
ALTER TABLE IF EXISTS public.lead_lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_lists_select ON public.lead_lists;
DROP POLICY IF EXISTS lead_lists_insert ON public.lead_lists;
DROP POLICY IF EXISTS lead_lists_update ON public.lead_lists;
DROP POLICY IF EXISTS lead_lists_delete ON public.lead_lists;

CREATE POLICY lead_lists_select ON public.lead_lists FOR SELECT
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY lead_lists_insert ON public.lead_lists FOR INSERT
    TO authenticated
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY lead_lists_update ON public.lead_lists FOR UPDATE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY lead_lists_delete ON public.lead_lists FOR DELETE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

-- ============================================================================
-- LEADS
-- ============================================================================
ALTER TABLE IF EXISTS public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leads_select ON public.leads;
DROP POLICY IF EXISTS leads_insert ON public.leads;
DROP POLICY IF EXISTS leads_update ON public.leads;
DROP POLICY IF EXISTS leads_delete ON public.leads;

CREATE POLICY leads_select ON public.leads FOR SELECT
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY leads_insert ON public.leads FOR INSERT
    TO authenticated
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY leads_update ON public.leads FOR UPDATE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY leads_delete ON public.leads FOR DELETE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

-- ============================================================================
-- CAMPAIGNS
-- ============================================================================
ALTER TABLE IF EXISTS public.campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaigns_select ON public.campaigns;
DROP POLICY IF EXISTS campaigns_insert ON public.campaigns;
DROP POLICY IF EXISTS campaigns_update ON public.campaigns;
DROP POLICY IF EXISTS campaigns_delete ON public.campaigns;

CREATE POLICY campaigns_select ON public.campaigns FOR SELECT
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY campaigns_insert ON public.campaigns FOR INSERT
    TO authenticated
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY campaigns_update ON public.campaigns FOR UPDATE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY campaigns_delete ON public.campaigns FOR DELETE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

-- ============================================================================
-- SEQUENCES
-- ============================================================================
ALTER TABLE IF EXISTS public.sequences ENABLE ROW LEVEL SECURITY;

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

-- ============================================================================
-- SEQUENCE STEPS
-- ============================================================================
ALTER TABLE IF EXISTS public.sequence_steps ENABLE ROW LEVEL SECURITY;

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

-- ============================================================================
-- CAMPAIGN LEADS
-- ============================================================================
ALTER TABLE IF EXISTS public.campaign_leads ENABLE ROW LEVEL SECURITY;

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

-- ============================================================================
-- OUTREACH EMAILS
-- ============================================================================
ALTER TABLE IF EXISTS public.outreach_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outreach_emails_select ON public.outreach_emails;
DROP POLICY IF EXISTS outreach_emails_insert ON public.outreach_emails;
DROP POLICY IF EXISTS outreach_emails_update ON public.outreach_emails;

CREATE POLICY outreach_emails_select ON public.outreach_emails FOR SELECT
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_emails_insert ON public.outreach_emails FOR INSERT
    TO authenticated
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_emails_update ON public.outreach_emails FOR UPDATE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

-- ============================================================================
-- OUTREACH ANALYTICS
-- ============================================================================
ALTER TABLE IF EXISTS public.outreach_analytics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outreach_analytics_select ON public.outreach_analytics;
DROP POLICY IF EXISTS outreach_analytics_insert ON public.outreach_analytics;
DROP POLICY IF EXISTS outreach_analytics_update ON public.outreach_analytics;

CREATE POLICY outreach_analytics_select ON public.outreach_analytics FOR SELECT
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_analytics_insert ON public.outreach_analytics FOR INSERT
    TO authenticated
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY outreach_analytics_update ON public.outreach_analytics FOR UPDATE
    TO authenticated
    USING (public.is_outreach_org_member(organization_id) OR public.is_platform_admin())
    WITH CHECK (public.is_outreach_org_member(organization_id) OR public.is_platform_admin());
