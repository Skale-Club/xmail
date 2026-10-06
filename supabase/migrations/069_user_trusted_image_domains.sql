-- "Always show images from <domain>" in the webmail, remembered per USER (not per organization or
-- mailbox): the choice follows the person across devices and mailboxes. `domain` is the sender's
-- registrable domain (public-suffix aware, lowercased) so one decision covers news.example.com
-- and info@example.com alike. Validation lives in src/lib/sender-domain.ts + the route.
--
-- No CREATE INDEX CONCURRENTLY, no BEGIN/COMMIT — the runner wraps the file in a transaction.

CREATE TABLE IF NOT EXISTS public.user_trusted_image_domains (
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    domain text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, domain)
);

-- RLS is defense-in-depth only (CLAUDE.md Authentication Flow): the app role bypasses it and
-- the real scoping is `user_id = x-user-id` in src/server/routes/mail/trusted-image-domains.ts.
-- Own-rows-only policy so a direct PostgREST session cannot read or edit someone else's list.
ALTER TABLE public.user_trusted_image_domains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_trusted_image_domains_own ON public.user_trusted_image_domains;
CREATE POLICY user_trusted_image_domains_own ON public.user_trusted_image_domains
    FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
