-- The Xcraper service contract requires every scrape to carry a niche slug. The daily
-- territory engine predated that contract and therefore had nowhere to persist the value;
-- every POST began failing with HTTP 400 once Xcraper made `niche` mandatory.
--
-- Existing production rows are the 32-entry barbershop seed from
-- scripts/seed-prospecting-territories.mjs. Backfill only that exact known query and fail
-- closed if any other legacy territory exists, rather than silently assigning it the wrong
-- niche. Future rows must provide a lowercase singular-English slug such as `barbershop` or
-- `nail_salon`.

ALTER TABLE public.prospecting_territories
    ADD COLUMN IF NOT EXISTS niche text;

UPDATE public.prospecting_territories
SET niche = 'barbershop'
WHERE niche IS NULL
  AND lower(btrim(query)) IN ('barbershop', 'barbershops');

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.prospecting_territories
        WHERE niche IS NULL
    ) THEN
        RAISE EXCEPTION 'Cannot require prospecting_territories.niche: legacy rows with an unknown niche remain';
    END IF;
END
$$;

ALTER TABLE public.prospecting_territories
    ALTER COLUMN niche SET NOT NULL;

ALTER TABLE public.prospecting_territories
    DROP CONSTRAINT IF EXISTS prospecting_territories_niche_check;

ALTER TABLE public.prospecting_territories
    ADD CONSTRAINT prospecting_territories_niche_check
    CHECK (niche ~ '^[a-z][a-z0-9_]*$');
