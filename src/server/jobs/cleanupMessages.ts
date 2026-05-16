/* eslint-disable no-constant-condition -- batch-cleanup uses while(true)+break pattern; each loop
   exits when no more rows are returned. Refactor to a generator is tracked in Phase 13 QUA-01. */
import { db } from '../../db'
import { messages, deliveries, outreachEmails, webhookRequests, mailMessages, mailFolders } from '../../db/schema'
import { lt, eq, and, or, inArray, isNull } from 'drizzle-orm'

let running = false

const RETENTION_DAYS = parseInt(process.env.MESSAGE_RETENTION_DAYS || '30')
const WEBHOOK_LOG_RETENTION_DAYS = parseInt(process.env.WEBHOOK_LOG_RETENTION_DAYS || '7')
const BATCH_SIZE = 500

export async function cleanupOldMessages(): Promise<void> {
    if (running) return
    running = true

    try {
        const cutoffDate = new Date()
        cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS)

        const webhookCutoff = new Date()
        webhookCutoff.setDate(webhookCutoff.getDate() - WEBHOOK_LOG_RETENTION_DAYS)

        const spamCutoff = new Date()
        spamCutoff.setDate(spamCutoff.getDate() - 30)

        // Clean old messages
        let totalDeleted = 0
        while (true) {
            const oldMessages = await db
                .select({ id: messages.id })
                .from(messages)
                .where(lt(messages.createdAt, cutoffDate))
                .limit(BATCH_SIZE)

            if (oldMessages.length === 0) break

            const messageIds = oldMessages.map((m) => m.id)

            for (const msgId of messageIds) {
                await db.delete(deliveries).where(eq(deliveries.messageId, msgId))
            }

            for (const msgId of messageIds) {
                await db.delete(messages).where(eq(messages.id, msgId))
            }

            totalDeleted += oldMessages.length
        }

        // Clean old outreach emails
        let outreachDeleted = 0
        while (true) {
            const oldOutreach = await db
                .select({ id: outreachEmails.id })
                .from(outreachEmails)
                .where(lt(outreachEmails.createdAt, cutoffDate))
                .limit(BATCH_SIZE)

            if (oldOutreach.length === 0) break

            for (const email of oldOutreach) {
                await db.delete(outreachEmails).where(eq(outreachEmails.id, email.id))
            }

            outreachDeleted += oldOutreach.length
        }

        // Soft-delete spam emails older than 30 days
        let spamDeleted = 0
        while (true) {
            const oldSpamMessages = await db
                .select({ id: mailMessages.id })
                .from(mailMessages)
                .innerJoin(mailFolders, eq(mailMessages.folderId, mailFolders.id))
                .where(and(
                    eq(mailFolders.type, 'spam'),
                    eq(mailMessages.isDeleted, false),
                    or(
                        lt(mailMessages.receivedAt, spamCutoff),
                        and(isNull(mailMessages.receivedAt), lt(mailMessages.createdAt, spamCutoff))
                    )
                ))
                .limit(BATCH_SIZE)

            if (oldSpamMessages.length === 0) break

            const spamIds = oldSpamMessages.map((message) => message.id)

            await db.update(mailMessages)
                .set({ isDeleted: true, updatedAt: new Date() })
                .where(inArray(mailMessages.id, spamIds))

            spamDeleted += oldSpamMessages.length
        }

        // Hard-delete trash emails older than 30 days
        let trashDeleted = 0
        while (true) {
            const oldTrashMessages = await db
                .select({ id: mailMessages.id })
                .from(mailMessages)
                .innerJoin(mailFolders, eq(mailMessages.folderId, mailFolders.id))
                .where(and(
                    eq(mailFolders.type, 'trash'),
                    or(
                        lt(mailMessages.receivedAt, spamCutoff),
                        and(isNull(mailMessages.receivedAt), lt(mailMessages.createdAt, spamCutoff))
                    )
                ))
                .limit(BATCH_SIZE)

            if (oldTrashMessages.length === 0) break

            const trashIds = oldTrashMessages.map((message) => message.id)

            await db.delete(mailMessages)
                .where(inArray(mailMessages.id, trashIds))

            trashDeleted += oldTrashMessages.length
        }

        // Clean old webhook request logs
        let webhookLogsDeleted = 0
        while (true) {
            const oldLogs = await db
                .select({ id: webhookRequests.id })
                .from(webhookRequests)
                .where(lt(webhookRequests.createdAt, webhookCutoff))
                .limit(BATCH_SIZE)

            if (oldLogs.length === 0) break

            for (const log of oldLogs) {
                await db.delete(webhookRequests).where(eq(webhookRequests.id, log.id))
            }

            webhookLogsDeleted += oldLogs.length
        }

        if (totalDeleted > 0 || outreachDeleted > 0 || spamDeleted > 0 || trashDeleted > 0 || webhookLogsDeleted > 0) {
            console.log(`[cleanup] Deleted ${totalDeleted} messages, ${outreachDeleted} outreach emails, ${spamDeleted} spam emails, ${trashDeleted} trash emails, ${webhookLogsDeleted} webhook logs (retention: ${RETENTION_DAYS}d, spam/trash: 30d)`)
        }
    } catch (err) {
        console.error('[cleanup] Error:', err)
    } finally {
        running = false
    }
}
