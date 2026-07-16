-- 040_outreach_product_consistency.sql
-- Phase 20 (CONS-01, CONS-07): one canonical sequence per campaign + reconciled step invariants.
--
-- A campaign historically could accumulate several sequences while enrollment, the processor,
-- and three UI surfaces all assumed sequences[0]. This migration collapses that ambiguity:
-- it merges every campaign's surplus sequences into the oldest (created_at, id) canonical row,
-- normalizes step order to one-based contiguous, and installs the database invariants that the
-- Zod payload and the Drizzle mirror also enforce.
--
-- History safety: no sequence_step row is ever deleted here — surplus steps are re-pointed to the
-- canonical sequence (their ids are preserved, so campaign_leads.current_step_id and
-- outreach_emails.sequence_step_id stay valid). Only verified-empty surplus sequences are removed.
-- When two sequences of one campaign carry the same step position the merge aborts with a
-- diagnostic instead of silently dropping content.
--
-- Idempotent where practical: guarded index/constraint creation, deterministic reparenting, and a
-- normalization that is a no-op once the data is already one-based.

BEGIN;

-- 1. Refuse to merge when two sequences of the same campaign share a step position; those rows
--    require a manual decision and must never be dropped automatically.
DO $$
DECLARE
    conflict_report text;
BEGIN
    SELECT string_agg(
        format('campaign %s step_order %s (%s colliding steps)', campaign_id, step_order, cnt), '; '
    )
    INTO conflict_report
    FROM (
        SELECT c.id AS campaign_id, ss.step_order, count(*) AS cnt
        FROM sequence_steps ss
        JOIN sequences s ON s.id = ss.sequence_id
        JOIN campaigns c ON c.id = s.campaign_id
        WHERE c.id IN (
            SELECT campaign_id FROM sequences GROUP BY campaign_id HAVING count(*) > 1
        )
        GROUP BY c.id, ss.step_order
        HAVING count(*) > 1
    ) conflicts;

    IF conflict_report IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot merge campaign sequences: conflicting step positions must be resolved manually: %',
            conflict_report;
    END IF;
END $$;

-- Reparent surplus sequence steps into the campaign's canonical (oldest) sequence, preserving ids.
WITH ranked AS (
    SELECT id,
        first_value(id) OVER (PARTITION BY campaign_id ORDER BY created_at, id) AS canonical_id
    FROM sequences
)
UPDATE sequence_steps ss
SET sequence_id = ranked.canonical_id
FROM ranked
WHERE ss.sequence_id = ranked.id
  AND ranked.id <> ranked.canonical_id;

-- Remove the now verified-empty surplus sequences.
WITH ranked AS (
    SELECT id,
        first_value(id) OVER (PARTITION BY campaign_id ORDER BY created_at, id) AS canonical_id
    FROM sequences
)
DELETE FROM sequences s
USING ranked
WHERE s.id = ranked.id
  AND ranked.id <> ranked.canonical_id
  AND NOT EXISTS (SELECT 1 FROM sequence_steps ss WHERE ss.sequence_id = s.id);

-- 2. Normalize step order to one-based contiguous within each canonical sequence. Two passes via a
--    negative staging value avoid transient collisions on sequence_step_order_unique. The one-based
--    check is dropped first so the negative staging is legal, then re-added in step 5.
ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_order_positive;

WITH ranked AS (
    SELECT id,
        row_number() OVER (PARTITION BY sequence_id ORDER BY step_order, id) AS rn
    FROM sequence_steps
)
UPDATE sequence_steps ss
SET step_order = -ranked.rn
FROM ranked
WHERE ss.id = ranked.id;

UPDATE sequence_steps
SET step_order = -step_order
WHERE step_order < 0;

-- Keep the denormalized lead pointer aligned with its (possibly renumbered) current step.
UPDATE campaign_leads cl
SET current_step_order = ss.step_order
FROM sequence_steps ss
WHERE cl.current_step_id = ss.id
  AND cl.current_step_order <> ss.step_order;

-- 3. Preflight content validity so a legacy violation reports actionable counts rather than a bare
--    check-constraint failure.
DO $$
DECLARE
    invalid_email integer;
    invalid_nonemail integer;
BEGIN
    SELECT count(*) INTO invalid_email
    FROM sequence_steps
    WHERE type = 'email'
      AND (subject IS NULL OR btrim(subject) = ''
           OR ((plain_body IS NULL OR btrim(plain_body) = '')
               AND (html_body IS NULL OR btrim(html_body) = '')));

    SELECT count(*) INTO invalid_nonemail
    FROM sequence_steps
    WHERE type <> 'email'
      AND (subject IS NOT NULL OR plain_body IS NOT NULL OR html_body IS NOT NULL
           OR subject_b IS NOT NULL OR plain_body_b IS NOT NULL OR html_body_b IS NOT NULL);

    IF invalid_email > 0 OR invalid_nonemail > 0 THEN
        RAISE EXCEPTION
            'Cannot enforce step content rules: % body-less email step(s) and % non-email step(s) carrying content must be repaired first',
            invalid_email, invalid_nonemail;
    END IF;
END $$;

-- 4. Enforce one sequence per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS sequences_campaign_id_unique ON sequences (campaign_id);

-- 5. Reconcile the sequence_steps invariants (mirrored in src/db/schema.ts and the Zod payload).
ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_order_positive;
ALTER TABLE sequence_steps
    ADD CONSTRAINT sequence_steps_order_positive CHECK (step_order >= 1);

ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_delay_hours_positive;
ALTER TABLE sequence_steps
    ADD CONSTRAINT sequence_steps_delay_hours_positive CHECK (delay_hours >= 0);

ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_ab_test_percentage_bounds;
ALTER TABLE sequence_steps
    ADD CONSTRAINT sequence_steps_ab_test_percentage_bounds
    CHECK (ab_test_percentage IS NULL OR (ab_test_percentage >= 0 AND ab_test_percentage <= 100));

ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_content_valid;
ALTER TABLE sequence_steps
    ADD CONSTRAINT sequence_steps_content_valid CHECK (
        (
            type = 'email'
            AND subject IS NOT NULL AND btrim(subject) <> ''
            AND (
                (plain_body IS NOT NULL AND btrim(plain_body) <> '')
                OR (html_body IS NOT NULL AND btrim(html_body) <> '')
            )
        )
        OR (
            type <> 'email'
            AND subject IS NULL AND plain_body IS NULL AND html_body IS NULL
            AND subject_b IS NULL AND plain_body_b IS NULL AND html_body_b IS NULL
        )
    );

COMMIT;

-- Production runbook (manual only):
-- psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/040_outreach_product_consistency.sql
