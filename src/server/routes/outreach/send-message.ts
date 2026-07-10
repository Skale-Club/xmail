import { Router, Request, Response } from 'express'
import { z } from 'zod'
import nodemailer from 'nodemailer'
import { db } from '../../../db'
import { emailAccounts, organizationUsers } from '../../../db/schema'
import { eq, and } from 'drizzle-orm'
import { isPlatformAdmin } from '../../lib/admin'
import { relayMessage, storeMessage, getNativeMailboxByEmail } from '../../lib/native-send'

const router = Router()

const sendMessageSchema = z.object({
    from: z.string().email('Invalid from address'),
    to: z.string().email('Invalid to address'),
    subject: z.string().min(1, 'Subject is required'),
    html: z.string().min(1, 'html is required'),
    text: z.string().optional(),
})

// Helper to check org membership (platform admins bypass membership check)
// Copied from campaigns.ts/leads.ts to keep this route's auth pattern identical.
async function checkOrgMembership(userId: string, organizationId: string) {
    const admin = await isPlatformAdmin(userId)
    if (admin) return { role: 'admin' as const }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organizationId),
            eq(organizationUsers.userId, userId)
        ),
    })
    return membership
}

function canWriteOutreach(membership: Awaited<ReturnType<typeof checkOrgMembership>>): boolean {
    return membership?.role === 'admin' || membership?.role === 'member'
}

// POST /api/outreach/send-message — one-to-one transactional send from a verified
// native outreach inbox. This is NOT campaign traffic: it deliberately does not
// touch dailySendLimit/warmup state, and does not inject open/click tracking.
router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const { from, to, subject, html, text } = sendMessageSchema.parse(req.body)

        // Resolve the sending account: must be a verified native inbox in this org.
        const account = await db.query.emailAccounts.findFirst({
            where: and(
                eq(emailAccounts.organizationId, organizationId),
                eq(emailAccounts.email, from),
                eq(emailAccounts.provider, 'native'),
                eq(emailAccounts.status, 'verified')
            ),
        })

        if (!account) {
            return res.status(400).json({ error: `No verified native sending inbox for ${from} in this organization` })
        }

        const nativeMailbox = await getNativeMailboxByEmail(from)
        if (!nativeMailbox) {
            return res.status(400).json({ error: 'Native mailbox not found for outreach account — was it deleted?' })
        }

        // Compose MIME exactly like sendOutreachEmail's native branch: buffer via
        // nodemailer's stream composer (never touches the network), then relay
        // through the platform's internal DKIM-signed relay.
        const fromAddress = account.displayName ? `"${account.displayName}" <${from}>` : from

        const composer = nodemailer.createTransport({ streamTransport: true, buffer: true })
        const composed = await composer.sendMail({
            from: fromAddress,
            to,
            subject,
            html,
            text,
        })
        const rawBuffer = composed.message as Buffer
        const messageId = composed.messageId as string

        await relayMessage(from, [to], rawBuffer)

        try {
            await storeMessage(nativeMailbox.id, 'sent', {
                messageId,
                subject,
                fromAddress: from,
                fromName: account.displayName || null,
                toAddresses: [{ address: to, name: null }],
                ccAddresses: [],
                bccAddresses: [],
                plainBody: text,
                htmlBody: html,
                hasAttachments: false,
                attachments: [],
            }, true)
        } catch (storeErr) {
            // Filing the Sent-folder copy is best-effort — the message was already
            // relayed successfully, so a filing failure should not fail the send.
            console.warn('[Outreach:SendMessage] Failed to file Sent copy:', storeErr instanceof Error ? storeErr.message : storeErr)
        }

        res.json({ success: true, messageId })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error sending transactional message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
