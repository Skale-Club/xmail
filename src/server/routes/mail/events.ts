import { Router, Request, Response } from 'express'
import { checkUserMailboxAccess } from './mailboxes'
import {
    MailboxEventCapacityError,
    formatMailboxSseComment,
    formatMailboxSseEvent,
    subscribeToMailboxEvents,
} from '../../lib/mailbox-events'
import { INBOX_SSE_HEADERS, INBOX_SSE_HEARTBEAT_MS } from '../../lib/inbox-events'

const router = Router()

// GET /:mailboxId/events — near-real-time change stream for ONE mailbox (webmail push).
//
// Bearer auth is required, so the browser cannot use `EventSource`; it connects with
// authenticated `fetch` + `ReadableStream` (see src/hooks/useMailboxEvents.ts). Authorization is
// the same JS-side check as every other mailbox route: the owner, or a platform admin. The stream
// carries ONLY signals (mailbox id, folder id, kind, timestamp) — never a subject, sender or body;
// the client reacts by re-reading through the normal authorized API. On disconnect the subscriber
// is released and the heartbeat cleared, so nothing leaks.
router.get('/:mailboxId/events', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        let closed = false
        let heartbeat: ReturnType<typeof setInterval> | null = null
        let unsubscribe: (() => void) | null = null

        const cleanup = (): void => {
            if (closed) return
            closed = true
            if (heartbeat) clearInterval(heartbeat)
            unsubscribe?.()
            try {
                res.end()
            } catch {
                // Response already torn down — nothing to release.
            }
        }

        try {
            unsubscribe = subscribeToMailboxEvents(mailbox.id, (event) => {
                // A write after teardown throws; cleanup is idempotent.
                try {
                    res.write(formatMailboxSseEvent(event))
                } catch {
                    cleanup()
                }
            }, userId)
        } catch (error) {
            if (error instanceof MailboxEventCapacityError) {
                // 429: this user holds too many streams. 503: the server as a whole is full.
                return res.status(error.scope === 'user' ? 429 : 503).json({ error: 'mailbox_event_capacity' })
            }
            throw error
        }

        // Open the stream: SSE headers + an immediate comment so proxies flush and the client
        // observes a live connection on the first bytes.
        res.status(200)
        for (const [key, value] of Object.entries(INBOX_SSE_HEADERS)) res.setHeader(key, value)
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
        res.write(formatMailboxSseComment('connected'))

        heartbeat = setInterval(() => {
            try {
                res.write(formatMailboxSseComment('ping'))
            } catch {
                cleanup()
            }
        }, INBOX_SSE_HEARTBEAT_MS)
        // An active timer keeps Node alive; the heartbeat must not block shutdown.
        if (typeof heartbeat.unref === 'function') heartbeat.unref()

        req.on('close', cleanup)
        req.on('aborted', cleanup)
        res.on('close', cleanup)
        res.on('error', cleanup)
    } catch (error) {
        console.error('Error opening mailbox event stream:', error)
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
        else res.end()
    }
})

export default router
