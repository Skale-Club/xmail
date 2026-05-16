-- ========================================================================
-- SUPERSEDED BY supabase/migrations/020_consolidate_rls.sql (Phase 13 QUA-03).
-- This migration's RLS effects are now reflected in 020. Kept on disk
-- for historical record only. Do NOT add new policies here.
-- (Table-create statements remain authoritative; only the RLS portions
--  at the bottom of this file are superseded.)
-- ========================================================================

-- User Mailboxes and Messages Tables for Webmail
-- This enables the webmail interface for users

-- Mailboxes table
CREATE TABLE IF NOT EXISTS mailboxes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email text NOT NULL,
    display_name text,
    smtp_host text NOT NULL,
    smtp_port integer NOT NULL DEFAULT 587,
    smtp_username text NOT NULL,
    smtp_password_encrypted text NOT NULL,
    smtp_secure boolean NOT NULL DEFAULT true,
    imap_host text NOT NULL,
    imap_port integer NOT NULL DEFAULT 993,
    imap_username text NOT NULL,
    imap_password_encrypted text NOT NULL,
    imap_secure boolean NOT NULL DEFAULT true,
    is_default boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    last_sync_at timestamp,
    sync_error text,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mailboxes_user_id_idx ON mailboxes (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_user_default_idx ON mailboxes (user_id) WHERE is_default = true;

-- Mail Folders table
CREATE TABLE IF NOT EXISTS mail_folders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    remote_id text NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'custom',
    unread_count integer NOT NULL DEFAULT 0,
    total_count integer NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_folders_mailbox_id_idx ON mail_folders (mailbox_id);
CREATE UNIQUE INDEX IF NOT EXISTS mail_folder_mailbox_remote_unique ON mail_folders (mailbox_id, remote_id);

-- Mail Messages table
CREATE TABLE IF NOT EXISTS mail_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    folder_id uuid NOT NULL REFERENCES mail_folders(id) ON DELETE CASCADE,
    message_id text,
    in_reply_to text,
    "references" text,
    subject text,
    from_address text,
    from_name text,
    to_addresses jsonb DEFAULT '[]'::jsonb,
    cc_addresses jsonb DEFAULT '[]'::jsonb,
    bcc_addresses jsonb DEFAULT '[]'::jsonb,
    plain_body text,
    html_body text,
    headers jsonb DEFAULT '{}'::jsonb,
    attachments jsonb DEFAULT '[]'::jsonb,
    has_attachments boolean NOT NULL DEFAULT false,
    is_read boolean NOT NULL DEFAULT false,
    is_starred boolean NOT NULL DEFAULT false,
    is_deleted boolean NOT NULL DEFAULT false,
    is_draft boolean NOT NULL DEFAULT false,
    remote_uid integer,
    remote_date timestamp,
    size integer DEFAULT 0,
    received_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_messages_mailbox_id_idx ON mail_messages (mailbox_id);
CREATE INDEX IF NOT EXISTS mail_messages_folder_id_idx ON mail_messages (folder_id);
CREATE INDEX IF NOT EXISTS mail_messages_received_at_idx ON mail_messages (received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mail_message_mailbox_uid_unique ON mail_messages (mailbox_id, remote_uid) WHERE remote_uid IS NOT NULL;

-- RLS Policies for Mail tables
ALTER TABLE IF EXISTS mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS mail_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS mail_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mailboxes_select_owner ON mailboxes;
DROP POLICY IF EXISTS mailboxes_insert_owner ON mailboxes;
DROP POLICY IF EXISTS mailboxes_update_owner ON mailboxes;
DROP POLICY IF EXISTS mailboxes_delete_owner ON mailboxes;

CREATE POLICY mailboxes_select_owner
    ON mailboxes FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY mailboxes_insert_owner
    ON mailboxes FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY mailboxes_update_owner
    ON mailboxes FOR UPDATE
    TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY mailboxes_delete_owner
    ON mailboxes FOR DELETE
    TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS mail_folders_select_owner ON mail_folders;
DROP POLICY IF EXISTS mail_folders_insert_owner ON mail_folders;
DROP POLICY IF EXISTS mail_folders_delete_owner ON mail_folders;

CREATE POLICY mail_folders_select_owner
    ON mail_folders FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM mailboxes 
            WHERE mailboxes.id = mail_folders.mailbox_id 
            AND mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_folders_insert_owner
    ON mail_folders FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM mailboxes 
            WHERE mailboxes.id = mailbox_id 
            AND mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_folders_delete_owner
    ON mail_folders FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM mailboxes 
            WHERE mailboxes.id = mail_folders.mailbox_id 
            AND mailboxes.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS mail_messages_select_owner ON mail_messages;
DROP POLICY IF EXISTS mail_messages_insert_owner ON mail_messages;
DROP POLICY IF EXISTS mail_messages_update_owner ON mail_messages;
DROP POLICY IF EXISTS mail_messages_delete_owner ON mail_messages;

CREATE POLICY mail_messages_select_owner
    ON mail_messages FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM mailboxes 
            WHERE mailboxes.id = mail_messages.mailbox_id 
            AND mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_messages_insert_owner
    ON mail_messages FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM mailboxes 
            WHERE mailboxes.id = mailbox_id 
            AND mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_messages_update_owner
    ON mail_messages FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM mailboxes 
            WHERE mailboxes.id = mail_messages.mailbox_id 
            AND mailboxes.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM mailboxes 
            WHERE mailboxes.id = mailbox_id 
            AND mailboxes.user_id = auth.uid()
        )
    );

CREATE POLICY mail_messages_delete_owner
    ON mail_messages FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM mailboxes 
            WHERE mailboxes.id = mail_messages.mailbox_id 
            AND mailboxes.user_id = auth.uid()
        )
    );
