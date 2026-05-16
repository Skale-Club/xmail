-- ========================================================================
-- SUPERSEDED BY supabase/migrations/020_consolidate_rls.sql (Phase 13 QUA-03).
-- This migration's RLS effects are now reflected in 020. Kept on disk
-- for historical record only. Do NOT add new policies here.
-- (Table-create + seed remain authoritative; only the RLS portions
--  at the bottom of this file are superseded.)
-- ========================================================================

CREATE TABLE IF NOT EXISTS system_branding (
    id text PRIMARY KEY DEFAULT 'default',
    company_name text NOT NULL DEFAULT '',
    application_name text NOT NULL DEFAULT 'Mail Platform',
    logo_storage text,
    favicon_storage text,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
);

INSERT INTO system_branding (id, company_name, application_name, logo_storage, favicon_storage)
VALUES ('default', '', 'Mail Platform', NULL, null)
ON CONFLICT (id) DO NOTHING;



-- Enable RLS
ALTER TABLE system_branding ENABLE ROW LEVEL SECURITY;

-- Allow public read access to branding settings
DROP POLICY IF EXISTS "Allow public read access to system_branding" ON system_branding;
CREATE POLICY "Allow public read access to system_branding"
ON system_branding FOR SELECT
USING (true);

-- Allow admin write access to branding settings
DROP POLICY IF EXISTS "Allow admin write access to system_branding" ON system_branding;
CREATE POLICY "Allow admin write access to system_branding"
ON system_branding FOR ALL
USING (
    EXISTS (
        SELECT 1 FROM users
        WHERE users.id = auth.uid()
        AND users.is_admin = true
    )
);
