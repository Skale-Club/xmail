import { db } from '../../db'
import { mailFolders, mailMessages } from '../../db/schema'
import { eq, and, sql } from 'drizzle-orm'

/**
 * Atomically allocate the next UID for a folder.
 * Returns the UID just consumed (i.e. uid_next - 1 after increment).
 * Safe against concurrent APPEND/SMTP-store races.
 */
export async function allocateNextUid(folderId: string): Promise<number> {
    const rows = await db.update(mailFolders)
        .set({ uidNext: sql`${mailFolders.uidNext} + 1`, updatedAt: new Date() })
        .where(eq(mailFolders.id, folderId))
        .returning({ newUidNext: mailFolders.uidNext })
    if (!rows[0]) throw new Error(`Folder ${folderId} not found`)
    return rows[0].newUidNext - 1
}

/**
 * Recompute total_count / unread_count from current mail_messages state.
 * Cheap enough to call after every mutation; avoids drift.
 */
export async function recomputeFolderCounts(folderId: string): Promise<void> {
    const rows = await db.select({
        total: sql<number>`count(*)::int`,
        unread: sql<number>`count(*) filter (where is_read = false)::int`,
    }).from(mailMessages)
      .where(and(
          eq(mailMessages.folderId, folderId),
          eq(mailMessages.isDeleted, false),
      ))
    const { total = 0, unread = 0 } = rows[0] ?? {}
    await db.update(mailFolders)
        .set({ totalCount: total, unreadCount: unread, updatedAt: new Date() })
        .where(eq(mailFolders.id, folderId))
}
