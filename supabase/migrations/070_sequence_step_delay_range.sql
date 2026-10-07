-- Variable delay between sequence steps.
--
-- `delay_hours` stays the fixed (or minimum) wait. `delay_hours_max`, when set, is the upper bound:
-- the scheduler picks a uniform random wait in [delay_hours, delay_hours_max] each time it schedules
-- the step (src/server/lib/outreach-sequence-state.ts, scheduleAfterDelay). NULL keeps the old
-- fixed-delay behaviour, so every existing row is unchanged.
--
-- Numbered 070: 069 is already taken by 069_user_trusted_image_domains.sql.

ALTER TABLE sequence_steps
    ADD COLUMN IF NOT EXISTS delay_hours_max integer NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'sequence_steps_delay_hours_max_valid'
          AND conrelid = 'sequence_steps'::regclass
    ) THEN
        ALTER TABLE sequence_steps
            ADD CONSTRAINT sequence_steps_delay_hours_max_valid
            CHECK (delay_hours_max IS NULL OR delay_hours_max >= delay_hours);
    END IF;
END $$;
