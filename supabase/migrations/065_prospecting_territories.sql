-- Fase 36 (docs/prospecting-engine-plan.md "Fase 36 -- Fila de territorios com orcamento
-- diario"). Evidence: on 2026-09-08 three scrapes were run by hand, cities picked from
-- memory, nothing stopping the same city from being scraped twice. This table is the queue
-- that replaces that judgment call; runDailyProspecting.ts (src/server/jobs/) reads the
-- highest-priority 'queued' row per organization and never re-targets a (query, location)
-- pair the UNIQUE constraint has already seen for that organization.
--
-- SCHEMA NOTE (kept in sync with the job that writes it -- see runDailyProspecting.ts): a
-- fresh scrape only ever gets a `searchId` back from Xcraper's POST /scrape -- there is no
-- prospecting_runs row yet at that point (Xphere only creates one, via POST /external-runs,
-- once the scrape has actually finished and pushed leads -- see prospecting.ts). So the two
-- run-identity columns below are deliberately NOT a single FK:
--   - last_external_run_id (text): the Xcraper searchId, written the moment the POST
--     succeeds. This is the SAME string prospecting_runs.idempotency_key ends up holding once
--     Xphere registers the run (provider='xcraper') -- see prospecting.ts's POST
--     /external-runs. runDailyProspecting.ts's reconciliation step (run at the START of every
--     daily tick, never by polling) joins on exactly this pair of columns to detect that a
--     'running' territory's run has landed.
--   - last_run_id (uuid, FK to prospecting_runs): filled in by that same reconciliation step
--     once the join above succeeds, at which point the territory also moves to 'done'. NULL
--     for the entire 'running' window, and NULL forever for a territory that never got past
--     'queued'.
--
-- Idempotent (ADD COLUMN/CREATE ... IF NOT EXISTS throughout); no CREATE INDEX CONCURRENTLY
-- (would fail inside this transaction, per CLAUDE.md "Schema & Migration Workflow").

BEGIN;

CREATE TABLE IF NOT EXISTS public.prospecting_territories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    query text NOT NULL,
    location text NOT NULL,
    template text NOT NULL,
    -- Lower number = higher priority (runs first). Matches the seed list's own ordering
    -- (distance from the pilot's base, weighted by population) -- see
    -- scripts/seed-prospecting-territories.mjs.
    priority integer NOT NULL DEFAULT 100,
    status text NOT NULL DEFAULT 'queued',
    max_results integer NOT NULL,
    -- See the module header comment above for why these two are separate, not one FK.
    last_run_id uuid REFERENCES public.prospecting_runs(id) ON DELETE SET NULL,
    last_external_run_id text,
    last_attempted_at timestamp,
    notes text,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    -- This is the constraint that actually stops the engine (or a human) from scraping the
    -- same city twice for the same organization -- see the module header comment.
    CONSTRAINT prospecting_territories_org_query_location_unique
        UNIQUE (organization_id, query, location),
    CONSTRAINT prospecting_territories_template_check
        CHECK (template IN ('standard', 'enriched')),
    CONSTRAINT prospecting_territories_status_check
        CHECK (status IN ('queued', 'running', 'done', 'paused')),
    CONSTRAINT prospecting_territories_max_results_check
        CHECK (max_results > 0),
    CONSTRAINT prospecting_territories_priority_check
        CHECK (priority > 0),
    CONSTRAINT prospecting_territories_query_location_nonempty
        CHECK (length(btrim(query)) > 0 AND length(btrim(location)) > 0)
);

-- The engine's own hot query: highest-priority queued territory for one organization.
CREATE INDEX IF NOT EXISTS idx_prospecting_territories_org_status_priority
    ON public.prospecting_territories (organization_id, status, priority);

-- The daily reconciliation join (last_external_run_id -> prospecting_runs.idempotency_key)
-- scans 'running' rows with a pending external id; partial index keeps it cheap once most
-- territories have moved on to 'done'.
CREATE INDEX IF NOT EXISTS idx_prospecting_territories_running_external
    ON public.prospecting_territories (organization_id, last_external_run_id)
    WHERE status = 'running' AND last_external_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prospecting_territories_last_run
    ON public.prospecting_territories (last_run_id) WHERE last_run_id IS NOT NULL;

-- RLS is defense-in-depth only (CLAUDE.md Authentication Flow) -- the app's DATABASE_URL role
-- bypasses it; the real authorization check is src/server/lib/access.ts /
-- outreach-access.ts. Same SELECT-only shape migration 046/047 used for the rest of the
-- prospecting pipeline: writes go through the app role, never through an authenticated
-- Supabase session.
ALTER TABLE public.prospecting_territories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prospecting_territories_select ON public.prospecting_territories;
CREATE POLICY prospecting_territories_select ON public.prospecting_territories FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
