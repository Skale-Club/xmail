-- Microsite mailbox provisioning (owned microsites, decision D-015).
-- Additive and idempotent. Three server-only tables:
--   microsite_mail_domains          one row per provisioned microsite domain (siteRef, mailbox link)
--   mailbox_delegates               users allowed to open another user's native mailbox in webmail
--   microsite_provisioning_audit    append-only audit of every provisioning write (no secrets)
-- The application role bypasses RLS; RLS is enabled with no client policy and anon/authenticated
-- are revoked, so these tables are unreachable from any Supabase client key.

CREATE TABLE IF NOT EXISTS public.microsite_mail_domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain text NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    domain_id uuid REFERENCES public.domains(id) ON DELETE SET NULL,
    site_ref text NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 200),
    mailbox_id uuid REFERENCES public.mailboxes(id) ON DELETE SET NULL,
    mailbox_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- One row per domain: concurrent ensure calls converge on this unique index.
CREATE UNIQUE INDEX IF NOT EXISTS microsite_mail_domains_domain_unique
    ON public.microsite_mail_domains (domain);
CREATE INDEX IF NOT EXISTS microsite_mail_domains_org_idx
    ON public.microsite_mail_domains (organization_id);

CREATE TABLE IF NOT EXISTS public.mailbox_delegates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id uuid NOT NULL REFERENCES public.mailboxes(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_delegates_mailbox_user_unique
    ON public.mailbox_delegates (mailbox_id, user_id);
CREATE INDEX IF NOT EXISTS mailbox_delegates_user_idx
    ON public.mailbox_delegates (user_id);

CREATE TABLE IF NOT EXISTS public.microsite_provisioning_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action text NOT NULL,
    domain text NOT NULL,
    site_ref text,
    outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS microsite_provisioning_audit_domain_idx
    ON public.microsite_provisioning_audit (domain, created_at DESC);

DO $$
DECLARE
    tbl text;
    client_role text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['microsite_mail_domains', 'mailbox_delegates', 'microsite_provisioning_audit'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', tbl);
        FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
                EXECUTE format('REVOKE ALL ON public.%I FROM %I', tbl, client_role);
            END IF;
        END LOOP;
    END LOOP;
END $$;
