-- Repair folder-scoped IMAP UIDs on mail_messages (native mailboxes only).
--
-- Two defects put mail_messages into a state IMAP clients cannot work with:
--
--   1. Every app-side folder change (webmail delete/archive/spam/restore/move and
--      the filter engine) updated folder_id alone, carrying the SOURCE folder's UID
--      into the destination. Destination folders therefore hold UIDs at or above
--      their own uid_next, which is exactly what UIDNEXT promises will not happen.
--   2. The native send and draft paths inserted rows with remote_uid = NULL, which
--      no client can address by UID at all — UID EXPUNGE skipped them outright.
--
-- Both land almost exclusively in Trash and Spam, and made messages there
-- impossible to delete from Thunderbird. Code fixes are in lib/move-messages.ts;
-- this repairs the rows already written.
--
-- Scope: native mailboxes only. On a mirrored mailbox (external IMAP/Outlook)
-- remote_uid is the REMOTE server's UID and is the dedup key mail-sync.ts matches
-- on; rewriting it there would make every sync re-import the whole folder.
--
-- No BEGIN/COMMIT and no temp tables on purpose: apply-pending-migrations.mjs
-- already wraps this file in a transaction, and against PgBouncer in transaction
-- mode an inner COMMIT would close that transaction early, dropping the ledger
-- insert out of it. The steps are ordered so each one only needs the state the
-- previous one left behind.

-- 1. FIRST, while the damage is still visible: tell clients their cached UID maps
--    for these folders are void (RFC 3501 §2.3.1.1). Steps 2 and 3 erase the very
--    evidence this predicate matches on, so it cannot run later.
UPDATE mail_folders f
SET uid_validity = GREATEST(f.uid_validity + 1, EXTRACT(EPOCH FROM now())::int),
    updated_at = now()
FROM mailboxes b
WHERE b.id = f.mailbox_id
  AND b.is_native = true
  AND (
        EXISTS (SELECT 1 FROM mail_messages m WHERE m.folder_id = f.id AND m.remote_uid IS NULL)
     OR EXISTS (SELECT 1 FROM mail_messages m WHERE m.folder_id = f.id AND m.remote_uid >= f.uid_next)
  );

-- 2. Give every UID-less row a UID above whatever its folder already holds, in
--    arrival order so the folder keeps its existing message ordering.
WITH native_folders AS (
    SELECT f.id
    FROM mail_folders f
    JOIN mailboxes b ON b.id = f.mailbox_id AND b.is_native = true
),
folder_ceiling AS (
    SELECT folder_id, COALESCE(MAX(remote_uid), 0) AS max_uid
    FROM mail_messages
    WHERE folder_id IN (SELECT id FROM native_folders)
    GROUP BY folder_id
),
numbered AS (
    SELECT m.id,
           c.max_uid + ROW_NUMBER() OVER (
               PARTITION BY m.folder_id
               ORDER BY m.received_at NULLS LAST, m.created_at, m.id
           ) AS new_uid
    FROM mail_messages m
    JOIN folder_ceiling c ON c.folder_id = m.folder_id
    WHERE m.remote_uid IS NULL
)
UPDATE mail_messages m
SET remote_uid = n.new_uid,
    updated_at = now()
FROM numbered n
WHERE m.id = n.id;

-- 3. Lift uid_next above the highest UID each folder actually holds, now that
--    step 2 has filled the gaps. Never lowered: UIDNEXT must not go backwards
--    even if the folder was since emptied.
UPDATE mail_folders f
SET uid_next = m.max_uid + 1,
    updated_at = now()
FROM (
    SELECT mm.folder_id, MAX(mm.remote_uid) AS max_uid
    FROM mail_messages mm
    JOIN mail_folders mf ON mf.id = mm.folder_id
    JOIN mailboxes b ON b.id = mf.mailbox_id AND b.is_native = true
    WHERE mm.remote_uid IS NOT NULL
    GROUP BY mm.folder_id
) m
WHERE m.folder_id = f.id
  AND f.uid_next <= m.max_uid;
