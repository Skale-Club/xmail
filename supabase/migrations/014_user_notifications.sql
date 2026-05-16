-- ========================================================================
-- SUPERSEDED BY supabase/migrations/020_consolidate_rls.sql (Phase 13 QUA-03).
-- This migration's RLS effects are now reflected in 020. Kept on disk
-- for historical record only. Do NOT add new policies here.
-- (Table-create + indexes remain authoritative; only the RLS portions
--  at the bottom of this file are superseded.)
-- ========================================================================

-- User Notifications table for Webmail
-- Stores notifications for users about server events (bounces, held, spam alerts)

CREATE TABLE IF NOT EXISTS user_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    read boolean NOT NULL DEFAULT false,
    created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_notifications_user_id_idx ON user_notifications (user_id);
CREATE INDEX IF NOT EXISTS user_notifications_user_id_read_idx ON user_notifications (user_id, read) WHERE read = false;
CREATE INDEX IF NOT EXISTS user_notifications_created_at_idx ON user_notifications (created_at DESC);

-- Enable RLS
ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see their own notifications
CREATE POLICY "Users can view own notifications" ON user_notifications
    FOR SELECT USING (auth.uid() = user_id);

-- RLS Policy: Users can only update their own notifications
CREATE POLICY "Users can update own notifications" ON user_notifications
    FOR UPDATE USING (auth.uid() = user_id);

-- RLS Policy: Users can only delete their own notifications
CREATE POLICY "Users can delete own notifications" ON user_notifications
    FOR DELETE USING (auth.uid() = user_id);
