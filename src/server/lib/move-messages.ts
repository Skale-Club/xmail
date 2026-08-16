import { db } from '../../db'
import { mailboxes, mailFolders, mailMessages } from '../../db/schema'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { recomputeFolderCounts } from './folder-counts'
import { emitFolderChange } from './mail-events'

/**
 * Whether this mailbox owns its UID namespace.
 *
 * For a native mailbox, `remote_uid` is *ours*: we hand it out and our IMAP
 * server serves it. For a mirrored mailbox (external IMAP/Outlook), it is the
 * remote server's UID and doubles as the dedup key in mail-sync.ts — rewriting
 * it would make every sync re-import the message. So mirrored mailboxes keep
 * the old move semantics: folder_id changes, UID does not.
 */
async function ownsUidNamespace(mailboxId: string): Promise<boolean> {
    const mailbox = await db.query.mailboxes.findFirst({
        where: eq(mailboxes.id, mailboxId),
        columns: { isNative: true },
    })
    return mailbox?.isNative === true
}

/**
 * Moves messages between folders while keeping IMAP UIDs coherent.
 *
 * `mail_messages.remote_uid` is what IMAP clients treat as the permanent,
 * folder-scoped message identifier (RFC 3501 §2.3.1.1): unique inside the
 * folder, ascending, and always below that folder's UIDNEXT. Every route used
 * to move mail by setting `folder_id` alone, which carries the *source*
 * folder's UID into the destination. Three things break when that happens:
 *
 *   - The destination advertises a UIDNEXT below UIDs it already holds, so a
 *     client's UID cache silently targets the wrong row.
 *   - The UID eventually collides with `mail_message_folder_uid_unique`. The MX
 *     path inserts with ON CONFLICT DO NOTHING, so inbound mail is dropped
 *     without a trace.
 *   - Rows created by the native send/draft paths had no UID at all, and
 *     `UID EXPUNGE` skips UID-less rows — which is why a message dragged into
 *     Trash could never be deleted from Thunderbird.
 *
 * So every folder change goes through here, and every message leaves with a UID
 * freshly allocated from the destination folder.
 */
export async function moveMessagesToFolder(
    messageIds: string[],
    destinationFolderId: string,
): Promise<string[]> {
    if (messageIds.length === 0) return []

    const pending = await db.query.mailMessages.findMany({
        where: inArray(mailMessages.id, messageIds),
        columns: { id: true, mailboxId: true, folderId: true },
        // Allocate UIDs in arrival order so the destination keeps the same
        // relative ordering the source had.
        orderBy: [asc(mailMessages.receivedAt), asc(mailMessages.createdAt)],
    })

    const moving = pending.filter(message => message.folderId !== destinationFolderId)
    if (moving.length === 0) return []

    const sourceFolderIds = [...new Set(moving.map(message => message.folderId))]
    const mailboxId = moving[0].mailboxId

    // Tenant guard: callers resolve the destination themselves, so refuse a batch
    // that spans mailboxes or targets a folder outside the messages' own mailbox.
    if (moving.some(message => message.mailboxId !== mailboxId)) {
        throw new Error('moveMessagesToFolder: messages span multiple mailboxes')
    }
    const destination = await db.query.mailFolders.findFirst({
        where: and(eq(mailFolders.id, destinationFolderId), eq(mailFolders.mailboxId, mailboxId)),
        columns: { id: true },
    })
    if (!destination) {
        throw new Error(`moveMessagesToFolder: folder ${destinationFolderId} does not belong to mailbox ${mailboxId}`)
    }

    if (await ownsUidNamespace(mailboxId)) {
        await db.transaction(async (tx) => {
            // One UID block for the whole batch: uid_next jumps by N and we hand
            // out the range it just skipped. Atomic against concurrent APPEND/MX.
            const [allocated] = await tx.update(mailFolders)
                .set({ uidNext: sql`${mailFolders.uidNext} + ${moving.length}`, updatedAt: new Date() })
                .where(eq(mailFolders.id, destinationFolderId))
                .returning({ next: mailFolders.uidNext })
            if (!allocated) throw new Error(`Destination folder ${destinationFolderId} not found`)

            const firstUid = allocated.next - moving.length
            const now = new Date()

            for (let index = 0; index < moving.length; index++) {
                await tx.update(mailMessages)
                    .set({ folderId: destinationFolderId, remoteUid: firstUid + index, updatedAt: now })
                    .where(eq(mailMessages.id, moving[index].id))
            }
        })
    } else {
        await db.update(mailMessages)
            .set({ folderId: destinationFolderId, updatedAt: new Date() })
            .where(inArray(mailMessages.id, moving.map(message => message.id)))
    }

    await recomputeFolderCounts(destinationFolderId)
    emitFolderChange({ folderId: destinationFolderId, mailboxId, kind: 'new' })

    for (const folderId of sourceFolderIds) {
        await recomputeFolderCounts(folderId)
        emitFolderChange({ folderId, mailboxId, kind: 'expunge' })
    }

    return moving.map(message => message.id)
}

/**
 * Allocates a UID for a message the app creates directly in a folder (native
 * sends, drafts) rather than one arriving over SMTP/MX. Kept here so those paths
 * cannot forget it the way they did before — a UID-less row is unreachable by
 * `UID EXPUNGE` and becomes undeletable once it lands in Trash.
 *
 * Returns null for mirrored mailboxes, whose UIDs belong to the remote server.
 */
export async function allocateUidForNewMessage(
    mailboxId: string,
    folderId: string,
): Promise<number | null> {
    if (!await ownsUidNamespace(mailboxId)) return null

    const [allocated] = await db.update(mailFolders)
        .set({ uidNext: sql`${mailFolders.uidNext} + 1`, updatedAt: new Date() })
        .where(eq(mailFolders.id, folderId))
        .returning({ next: mailFolders.uidNext })
    if (!allocated) throw new Error(`Folder ${folderId} not found`)
    return allocated.next - 1
}

/**
 * Permanently removes messages and refreshes the counters of the folders they
 * came from. Mirrors `moveMessagesToFolder` so callers never leave a folder's
 * total_count/unread_count stale after a hard delete.
 */
export async function deleteMessagesPermanently(
    messageIds: string[],
    mailboxId: string,
): Promise<number> {
    if (messageIds.length === 0) return 0

    const doomed = await db.query.mailMessages.findMany({
        where: and(inArray(mailMessages.id, messageIds), eq(mailMessages.mailboxId, mailboxId)),
        columns: { id: true, folderId: true },
    })
    if (doomed.length === 0) return 0

    await db.delete(mailMessages).where(inArray(mailMessages.id, doomed.map(message => message.id)))

    for (const folderId of [...new Set(doomed.map(message => message.folderId))]) {
        await recomputeFolderCounts(folderId)
        emitFolderChange({ folderId, mailboxId, kind: 'expunge' })
    }

    return doomed.length
}
