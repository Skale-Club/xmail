-- Server-only, short-lived browser possession and CSRF challenges for the disabled pilot.
CREATE TABLE IF NOT EXISTS public.xmail_identity_browser_challenges (
    challenge_hash text PRIMARY KEY CHECK (challenge_hash ~ '^[a-f0-9]{64}$'),
    browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
    origin text NOT NULL,
    operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 1024),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS xmail_identity_browser_challenges_expiry_idx ON public.xmail_identity_browser_challenges(expires_at);
ALTER TABLE public.xmail_identity_browser_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xmail_identity_browser_challenges FROM PUBLIC;
DO $$
DECLARE client_role text;
BEGIN
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
            EXECUTE format('REVOKE ALL ON public.xmail_identity_browser_challenges FROM %I', client_role);
        END IF;
    END LOOP;
END $$;
