import { Router, Request, Response } from 'express'
import { db } from '../../db'
import { messages, organizations } from '../../db/schema'
import { eq, and, or, lt, isNull, sql } from 'drizzle-orm'
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

    // Async tracking with 60s dedup window (COR-03, audit H4)
    // COR-03 — see audit H4. Dedup gate is atomic; replay within 60s returns 0 rows from UPDATE.
    try {
        // Atomic dedup gate: write clicked_at = NOW() only if it was NULL or older than 60s.
        // The .returning() tells us whether THIS request was the "winning" first/refresh.
        // Postgres row-level locking serializes concurrent UPDATEs on the same row, so
        // only one competing request gets a returned row; replays get updated.length === 0.
        const updated = await db
            .update(messages)
            .set({ clickedAt: new Date(), updatedAt: new Date() })
            .where(
                and(
                    eq(messages.token, token),
                    or(
                        isNull(messages.clickedAt),
                        lt(messages.clickedAt, sql`NOW() - INTERVAL '60 seconds'`)
                    )
                )
            )
            .returning({
                id: messages.id,
                organizationId: messages.organizationId,
                subject: messages.subject,
                fromAddress: messages.fromAddress,
            })

        if (updated.length === 0) {
            // Replay within 60s — token matched a message but dedup window blocked the UPDATE.
            // (Or the token doesn't exist at all — indistinguishable here, but we silently no-op either way.)
            return
        }

        const message = updated[0]
        const trackClicks = true
        const privacyMode = false
        if (!trackClicks || privacyMode) return

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
