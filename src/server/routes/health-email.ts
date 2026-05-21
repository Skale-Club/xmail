/**
 * GET /api/health/email
 *
 * Platform-admin-only endpoint that exposes per-subsystem email health
 * metrics for external monitoring scripts.
 *
 * Checks:
 *   smtp_server  — TCP connect to localhost:587 (3s timeout)
 *   imap_server  — TCP connect to localhost:993 (3s timeout)
 *   queue        — stuck pending deliveries (older than 15 min)
 *   outreach     — minutes since last outreach_email was sent
 *   delivery     — failed deliveries in the last hour
 *
 * Auth: the parent /api JWT middleware in src/server/index.ts injects
 * `x-user-id`; this handler additionally gates on isPlatformAdmin so
 * non-admin authenticated users get 403 instead of 200.
 */

import net from 'net'
import { Router, Request, Response } from 'express'
import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { isPlatformAdmin } from '../lib/admin'
import { createLogger } from '../lib/logger'

// Defensive row-extraction that works for both postgres-js (plain array) and
// node-pg ({ rows: [...] }) drivers — mirrors the pattern in outreach-metrics.ts.
function rowsOf<T extends Record<string, unknown>>(result: unknown): T[] {
    if (Array.isArray(result)) return result as T[]
    const wrapped = result as { rows?: T[] }
    return wrapped?.rows ?? []
}

const router = Router()
const log = createLogger('health.email')

// ------------------------------------------------------------------
// TCP port probe
// ------------------------------------------------------------------

function probeTcpPort(host: string, port: number, timeoutMs = 3000): Promise<'ok' | 'error'> {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port })
        const timer = setTimeout(() => {
            socket.destroy()
            resolve('error')
        }, timeoutMs)

        socket.once('connect', () => {
            clearTimeout(timer)
            socket.destroy()
            resolve('ok')
        })

        socket.once('error', () => {
            clearTimeout(timer)
            socket.destroy()
            resolve('error')
        })
    })
}

// ------------------------------------------------------------------
// DB metric helpers
// ------------------------------------------------------------------

interface QueueMetrics {
    stuck_count: number
    oldest_pending_minutes: number
}

async function getQueueMetrics(): Promise<QueueMetrics> {
    const result = await db.execute(sql`
        SELECT
            COUNT(*)::int AS stuck_count,
            COALESCE(
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 60,
                0
            )::float AS oldest_pending_minutes
        FROM deliveries
        WHERE status = 'pending'
          AND created_at < NOW() - INTERVAL '15 minutes'
    `)
    const row = rowsOf<{ stuck_count: number; oldest_pending_minutes: number }>(result)[0]
    return {
        stuck_count: row?.stuck_count ?? 0,
        oldest_pending_minutes: Math.round((row?.oldest_pending_minutes ?? 0) * 10) / 10,
    }
}

interface OutreachMetrics {
    last_processed_minutes_ago: number | null
    status: 'ok' | 'stale' | 'stopped'
}

async function getOutreachMetrics(): Promise<OutreachMetrics> {
    const result = await db.execute(sql`
        SELECT sent_at
        FROM outreach_emails
        WHERE status = 'sent'
        ORDER BY sent_at DESC
        LIMIT 1
    `)
    const row = rowsOf<{ sent_at: Date | string | null }>(result)[0]
    if (!row?.sent_at) {
        return { last_processed_minutes_ago: null, status: 'stopped' }
    }
    const sentAt = new Date(row.sent_at)
    const minutesAgo = Math.round((Date.now() - sentAt.getTime()) / 60_000)
    let status: 'ok' | 'stale' | 'stopped'
    if (minutesAgo < 60) {
        status = 'ok'
    } else if (minutesAgo <= 180) {
        status = 'stale'
    } else {
        status = 'stopped'
    }
    return { last_processed_minutes_ago: minutesAgo, status }
}

interface DeliveryMetrics {
    failures_last_hour: number
    status: 'ok' | 'degraded' | 'critical'
}

async function getDeliveryMetrics(): Promise<DeliveryMetrics> {
    const result = await db.execute(sql`
        SELECT COUNT(*)::int AS failures
        FROM deliveries
        WHERE status = 'failed'
          AND created_at > NOW() - INTERVAL '1 hour'
    `)
    const row = rowsOf<{ failures: number }>(result)[0]
    const failures = row?.failures ?? 0
    let status: 'ok' | 'degraded' | 'critical'
    if (failures <= 5) {
        status = 'ok'
    } else if (failures <= 20) {
        status = 'degraded'
    } else {
        status = 'critical'
    }
    return { failures_last_hour: failures, status }
}

// ------------------------------------------------------------------
// Route handler
// ------------------------------------------------------------------

router.get('/', async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string | undefined
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' })
    }

    if (!(await isPlatformAdmin(userId))) {
        log.warn({ action: 'health.email.forbidden', userId }, 'non-admin attempted health/email endpoint')
        return res.status(403).json({ error: 'Forbidden — platform admin required' })
    }

    try {
        const [smtpStatus, imapStatus, queue, outreach, delivery] = await Promise.all([
            probeTcpPort('localhost', 587),
            probeTcpPort('localhost', 993),
            getQueueMetrics(),
            getOutreachMetrics(),
            getDeliveryMetrics(),
        ])

        return res.json({
            timestamp: new Date().toISOString(),
            smtp_server: smtpStatus,
            imap_server: imapStatus,
            queue,
            outreach,
            delivery,
        })
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        log.error({ action: 'health.email.error', error: { message: e.message, stack: e.stack } }, 'health/email threw')
        return res.status(500).json({
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? e.message : undefined,
        })
    }
})

export default router
