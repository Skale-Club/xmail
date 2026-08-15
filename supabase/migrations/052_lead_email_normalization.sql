-- Phase 31 follow-up: guarantee leads.email is always lowercase at the DB layer.
--
-- leads.email is normalized in two different places by two different paths, and one of
-- them was implicit. The human path (src/server/routes/outreach/leads.ts) lowercases in
-- its Zod schema. The agent/prospecting import path inserted candidate.email verbatim --
-- which was SAFE ONLY BECAUSE the Apollo provider happens to lowercase upstream
-- (src/server/lib/prospecting/apollo.ts, in normalizePerson). No duplicate has ever been
-- created by this; verified in production: 2 leads, 0 mixed-case, 0 case-only duplicates.
--
-- So this is not a bug fix, it is the removal of a load-bearing coincidence.
-- lead_org_email_unique on leads (organization_id, email) is case-SENSITIVE, so the day a
-- second provider is added that does not normalize, 'John.Smith@shop.com' would silently
-- fail to match an existing 'john.smith@shop.com', creating a duplicate lead for one human
-- and making prospect_candidates.imported_as report 'created' when the truth is 'existing'
-- -- defeating the exact column added to keep attribution honest. The accompanying code
-- change normalizes explicitly at the import boundary instead of inheriting it.
--
-- We use a CHECK constraint here rather than a new unique index. With both write paths now
-- normalizing (see email-normalization.ts), the existing plain (organization_id, email)
-- unique index is already effectively case-insensitive, and a CHECK keeps
-- ON CONFLICT (organization_id, email) working unchanged — swapping in a lower(email)
-- expression index would break every existing onConflictDoNothing target in the codebase.

BEGIN;

-- Safe no-op in production today (0 rows affected, verified), but required so this
-- migration is safe to run against any other environment that may already hold
-- mixed-case rows.
UPDATE public.leads SET email = lower(email) WHERE email <> lower(email);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_email_lowercase') THEN
        ALTER TABLE public.leads ADD CONSTRAINT leads_email_lowercase CHECK (email = lower(email));
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
