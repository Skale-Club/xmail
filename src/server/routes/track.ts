import { Router, Request, Response } from 'express'
import { db } from '../../db'
import { messages, organizations } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { fireWebhooks, incrementStat } from '../lib/tracking'
import { isPrivateHost } from '../lib/network-guard'

const router = Router()

// 1×1 transparent GIF (base64 decoded at startup, not on every request)
const PIXEL = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
)

// ---------------------------------------------------------------------------
// GET /t/open/:token  — open-tracking pixel
// ---------------------------------------------------------------------------
router.get('/open/:token', async (req: Request, res: Response) => {
    // Send the pixel immediately so email clients don't wait
    res.set({
        'Content-Type': 'image/gif',
        'Content-Length': String(PIXEL.length),
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
    })
    res.end(PIXEL)

    // Async tracking — never blocks the response
    const { token } = req.params
    try {
        const message = await db.query.messages.findFirst({
            where: eq(messages.token, token),
        })

        if (!message || message.openedAt) return   // already recorded

        const organization = await db.query.organizations.findFirst({
            where: eq(organizations.id, message.organizationId),
        })

        const trackOpens = true
        const privacyMode = false
        if (!organization || !trackOpens || privacyMode) return

        const now = new Date()

        await db
            .update(messages)
            .set({ openedAt: now, updatedAt: now })
            .where(eq(messages.token, token))

        await Promise.allSettled([
            incrementStat(message.organizationId, 'messagesOpened'),
            fireWebhooks(message.organizationId, 'message_opened', {
                messageId: message.id,
                subject: message.subject,
                from: message.fromAddress,
                openedAt: now.toISOString(),
            }),
        ])
    } catch (err) {
        console.error('Open tracking error:', err)
    }
})

// ---------------------------------------------------------------------------
// GET /t/click/:token?u=<base64url-encoded-url>  — click-tracking redirect
// ---------------------------------------------------------------------------
router.get('/click/:token', async (req: Request, res: Response) => {
    const { token } = req.params
    const encodedUrl = req.query.u as string

    if (!encodedUrl) {
        return res.status(400).send('Missing parameter')
    }

    let targetUrl: string
    try {
        targetUrl = Buffer.from(encodedUrl, 'base64url').toString('utf8')
        const parsed = new URL(targetUrl)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).send('Invalid URL')
        }
        // SEC-01 — sync check only; click latency is critical. SSRF for stored URLs is gated at write time (webhooks.ts).
        if (isPrivateHost(parsed.hostname)) {
            return res.status(400).send('Invalid URL')
        }
    } catch {
        return res.status(400).send('Invalid URL')
    }

    // Redirect immediately
    res.redirect(302, targetUrl)

    // Async tracking
    try {
        const message = await db.query.messages.findFirst({
            where: eq(messages.token, token),
        })

        if (!message) return

        const organization = await db.query.organizations.findFirst({
            where: eq(organizations.id, message.organizationId),
        })

        const trackClicks = true
        const privacyMode = false
        if (!organization || !trackClicks || privacyMode) return

        await Promise.allSettled([
            incrementStat(message.organizationId, 'linksClicked'),
            fireWebhooks(message.organizationId, 'link_clicked', {
                messageId: message.id,
                subject: message.subject,
                url: targetUrl,
                clickedAt: new Date().toISOString(),
            }),
        ])
    } catch (err) {
        console.error('Click tracking error:', err)
    }
})

export default router
