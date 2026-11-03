-- Server-only identity pilot. Apply only after isolated restore/reconciliation.
-- No existing IDs, memberships, roles, mailbox password hashes or user data change.
CREATE TABLE IF NOT EXISTS public.xmail_identity_user_controls (
    user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    disabled_at timestamptz,
    sessions_valid_after timestamptz NOT NULL DEFAULT 'epoch'::timestamptz,
    review_source text NOT NULL CHECK (length(review_source) BETWEEN 1 AND 255),
    reviewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.xmail_identity_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'),
    subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 128 AND subject = btrim(subject)),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    proof_reference text NOT NULL CHECK (length(proof_reference) BETWEEN 1 AND 255),
    disabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS xmail_identity_project_subject_unique
    ON public.xmail_identity_bindings(project_id, subject);
CREATE INDEX IF NOT EXISTS xmail_identity_bindings_user_idx ON public.xmail_identity_bindings(user_id);

CREATE TABLE IF NOT EXISTS public.xmail_identity_owned_sessions (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    binding_id uuid NOT NULL REFERENCES public.xmail_identity_bindings(id) ON DELETE CASCADE,
    authenticated_at bigint NOT NULL CHECK (authenticated_at > 0),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '12 hours'),
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS xmail_identity_sessions_binding_idx ON public.xmail_identity_owned_sessions(binding_id);

ALTER TABLE public.xmail_identity_user_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xmail_identity_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xmail_identity_owned_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xmail_identity_user_controls, public.xmail_identity_bindings,
    public.xmail_identity_owned_sessions FROM PUBLIC;
DO $$
DECLARE client_role text;
BEGIN
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
            EXECUTE format('REVOKE ALL ON public.xmail_identity_user_controls, public.xmail_identity_bindings, public.xmail_identity_owned_sessions FROM %I', client_role);
        END IF;
    END LOOP;
END $$;

-- Deliberately no policy, binding backfill, control import or account creation.
-- A reviewed exact-ID ownership proof and ban inventory are prerequisites.
