import { createTransport } from 'nodemailer'
import { db } from '../../db'
import { deliveries, messages, organizations } from '../../db/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { incrementStat, fireWebhooks } from '../lib/tracking'

let running = false

const MAX_RETRIES = 3
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000] // 1min, 5min, 15min

export async function processQueue(): Promise<void> {
    if (running) return
    running = true

    try {
        const now = new Date().toISOString()
        const pendingDeliveries = await db.query.deliveries.findMany({
            where: eq(deliveries.status, 'pending'),
            limit: 50,
        })

        // Filter out deliveries still in retry delay
        const readyDeliveries = pendingDeliveries.filter((d) => {
            if (!d.details) return true
            try {
                const details = JSON.parse(d.details)
                if (details.nextAttempt && new Date(details.nextAttempt) > new Date(now)) {
                    return false // Still in retry delay
                }
            } catch { /* not JSON — ready to process */ }
            return true
        })

        if (readyDeliveries.length === 0) return

        // Batch-load all unique messages for these deliveries
        const messageIds = [...new Set(readyDeliveries.map((d) => d.messageId))]
        const allMessages = await db.query.messages.findMany({
            where: inArray(messages.id, messageIds),
        })
        const messagesMap = new Map(allMessages.map((m) => [m.id, m]))

        // Batch-load all unique organizations from the fetched messages
        const orgIds = [...new Set(allMessages.map((m) => m.organizationId))]
        const allOrgs = orgIds.length > 0 ? await db.query.organizations.findMany({
            where: inArray(organizations.id, orgIds),
        }) : []
        const orgsMap = new Map(allOrgs.map((o) => [o.id, o]))

        for (const delivery of readyDeliveries) {
            await processDelivery(delivery, messagesMap, orgsMap)
        }
    } catch (err) {
        console.error('[processQueue] Error:', err)
    } finally {
        running = false
    }
}

async function processDelivery(
    delivery: typeof deliveries.$inferSelect,
    messagesMap: Map<string, typeof messages.$inferSelect>,
    orgsMap: Map<string, typeof organizations.$inferSelect>,
): Promise<void> {
    try {
        const message = messagesMap.get(delivery.messageId)

        if (!message) {
            await db.update(deliveries)
                .set({ status: 'failed', details: 'Message not found' })
                .where(eq(deliveries.id, delivery.id))
            return
        }

        if (message.held) return

        const org = orgsMap.get(message.organizationId)

        if (!org) {
            await db.update(deliveries)
                .set({ status: 'failed', details: 'Organization not found' })
                .where(eq(deliveries.id, delivery.id))
            return
        }

        const host = process.env.SMTP_HOST
        const port = parseInt(process.env.SMTP_PORT || '587')
        const user = process.env.SMTP_USER
        const pass = process.env.SMTP_PASS

        if (!host) {
            console.warn('[processQueue] SMTP_HOST not configured, skipping delivery')
            return
        }

        const transporter = createTransport({
            host,
            port,
            secure: port === 465,
            auth: user && pass ? { user, pass } : undefined,
        })

        const fromAddress = message.fromAddress || process.env.SMTP_FROM || ''

        const attachments = (message.attachments as any[] || []).map((att) => ({
            filename: att.filename,
            content: Buffer.from(att.content, 'base64'),
            contentType: att.contentType,
        }))

        const result = await transporter.sendMail({
            from: fromAddress,
            to: delivery.rcptTo,
            subject: message.subject || '',
            text: message.plainBody || undefined,
            html: message.htmlBody || undefined,
            headers: message.headers as Record<string, string> || {},
            attachments: attachments.length > 0 ? attachments : undefined,
            messageId: message.messageId || undefined,
        })

        const now = new Date()

        await db.update(deliveries)
            .set({
                status: 'sent',
                sentAt: now,
                sentWithSsl: port === 465,
                output: result.messageId || null,
            })
            .where(eq(deliveries.id, delivery.id))

        const remaining = await db.query.deliveries.findMany({
            where: and(
                eq(deliveries.messageId, message.id),
                eq(deliveries.status, 'pending')
            ),
        })

        if (remaining.length === 0) {
            await db.update(messages)
                .set({ status: 'sent', sentAt: now, updatedAt: now })
                .where(eq(messages.id, message.id))

            await Promise.allSettled([
                incrementStat(message.organizationId, 'messagesSent'),
                fireWebhooks(message.organizationId, 'message_sent', {
                    messageId: message.id,
                    subject: message.subject,
                    from: message.fromAddress,
                    to: message.toAddresses,
                }),
            ])
        }
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[processQueue] Delivery ${delivery.id} failed:`, errorMsg)

        // Parse retry count from details
        let retryCount = 0
        try {
            const details = JSON.parse(delivery.details || '{}')
            retryCount = details.retryCount || 0
        } catch { /* first attempt */ }

        retryCount++

        if (retryCount <= MAX_RETRIES) {
            const delayMs = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)]
            const nextAttempt = new Date(Date.now() + delayMs)

            await db.update(deliveries)
                .set({
                    status: 'pending',
                    details: JSON.stringify({ retryCount, lastError: errorMsg, nextAttempt: nextAttempt.toISOString() }),
                })
                .where(eq(deliveries.id, delivery.id))

            console.log(`[processQueue] Delivery ${delivery.id} will retry (attempt ${retryCount}/${MAX_RETRIES}) after ${delayMs / 1000}s`)
        } else {
            await db.update(deliveries)
                .set({
                    status: 'bounced',
                    bouncedAt: new Date(),
                    details: errorMsg,
                })
                .where(eq(deliveries.id, delivery.id))

            console.log(`[processQueue] Delivery ${delivery.id} permanently failed after ${MAX_RETRIES} retries`)
        }
    }
}
