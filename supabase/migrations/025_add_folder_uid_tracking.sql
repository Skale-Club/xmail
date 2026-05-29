-- Add per-folder UID tracking for RFC 3501 IMAP compliance.
--
-- uid_validity: monotonic tag that IMAP clients use to detect folder resets.
--               Once a folder's uid_validity changes, all cached UIDs in the
--               client are considered stale. We seed it with a unique epoch
--               value per folder so the first-time value is never "1".
--
-- uid_next:     predicted next UID for APPEND/new-message assignments.
--               The native SMTP and IMAP APPEND paths increment this after
--               each insert. Existing messages backfill from remote_uid MAX
--               per folder where present.

ALTER TABLE mail_folders
    ADD COLUMN IF NOT EXISTS uid_validity integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS uid_next integer NOT NULL DEFAULT 1;

-- Backfill uid_validity for existing rows: use extract(epoch from created_at)
-- so each folder gets a stable, unique value based on when it was created.
UPDATE mail_folders
SET uid_validity = GREATEST(1, CAST(EXTRACT(EPOCH FROM created_at) AS integer))
WHERE uid_validity = 1;

-- Backfill uid_next from existing messages' max remote_uid + 1.
UPDATE mail_folders f
SET uid_next = COALESCE(sub.max_uid, 0) + 1
FROM (
    SELECT folder_id, MAX(remote_uid) AS max_uid
    FROM mail_messages
    WHERE remote_uid IS NOT NULL
    GROUP BY folder_id
) sub
WHERE f.id = sub.folder_id
  AND f.uid_next <= COALESCE(sub.max_uid, 0);
