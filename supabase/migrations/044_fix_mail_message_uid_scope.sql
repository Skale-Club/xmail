-- IMAP UIDs are unique inside one folder (UIDVALIDITY scope), not across a mailbox.
-- The original bootstrap created the obsolete mailbox-wide index. Besides rejecting
-- valid COPY/MOVE operations, that made ON CONFLICT DO NOTHING hide message loss.
-- Production already has the folder-scoped index; this migration makes rebuilds and
-- test databases match it and removes the obsolete constraint wherever it remains.

BEGIN;

DROP INDEX IF EXISTS mail_message_mailbox_uid_unique;

CREATE UNIQUE INDEX IF NOT EXISTS mail_message_folder_uid_unique
    ON mail_messages (folder_id, remote_uid);

COMMIT;
