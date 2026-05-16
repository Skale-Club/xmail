import { createHmac } from 'crypto'
import { db } from '../../db'
import { webhooks, webhookRequests, statistics, organizationUsers, userNotifications } from '../../db/schema'
import { eq, and, sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// HTML injection
// ---------------------------------------------------------------------------

const SKIP_PROTOCOLS = ['javascript:', 'mailto:', 'tel:', 'data:']

function shouldSkipUrl(url: string): boolean {
    const lower = url.toLowerCase().trim()

    if (SKIP_PROTOCOLS.some((p) => lower.startsWith(p))) return true
    if (lower.startsWith('#')) return true
    if (/\{\{.*?\}\}/.test(url)) return true

    return false
}

function encodeTrackingUrl(url: string, baseUrl: string, token: string): string {
    const encoded = Buffer.from(url).toString('base64url')
    return `${baseUrl}/t/click/${token}?u=${encoded}`
}

export function rewriteLinks(html: string, baseUrl: string, token: string): string {
    const hrefRegex = /href\s*=\s*(["'])([^"']*?)\1|href\s*=\s*([^\s>]+)/gi

    return html.replace(hrefRegex, (match, quote: string | undefined, quotedUrl: string | undefined, unquotedUrl: string | undefined) => {
        const url = quotedUrl ?? unquotedUrl

        if (!url) return match

        if (shouldSkipUrl(url)) return match

        const trimmed = url.trim()
        if (!/^https?:\/\//i.test(trimmed)) return match

        const trackingUrl = encodeTrackingUrl(trimmed, baseUrl, token)

        if (quote) {
            return `href=${quote}${trackingUrl}${quote}`
        }
        return `href="${trackingUrl}"`
    })
}

export function injectTrackingPixel(html: string, token: string, baseUrl: string): string {
    const pixel =
        `<img src="${baseUrl}/t/open/${token}" ` +
        `width="1" height="1" alt="" ` +
        `style="display:none!important;width:1px!important;height:1px!important" />`

    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, `${pixel}</body>`)
    }
    return html + pixel
}

export function injectTracking(
    html: string,
    token: string,
    baseUrl: string,
    trackOpens: boolean,
    trackClicks: boolean
): string {
    let result = html

    if (trackClicks) {
        result = rewriteLinks(result, baseUrl, token)
    }

    if (trackOpens) {
        result = injectTrackingPixel(result, token, baseUrl)
    }

    return result
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const STAT_COLUMNS = {
    messagesOpened:    'messages_opened',
    linksClicked:      'links_clicked',
    messagesSent:      'messages_sent',
    messagesDelivered: 'messages_delivered',
    messagesBounced:   'messages_bounced',
    messagesHeld:      'messages_held',
    messagesIncoming:  'messages_incoming',
} as const

export type StatField = keyof typeof STAT_COLUMNS

/**
 * Upserts one row per (organization_id, today) and increments the given counter.
 * Failures are swallowed — stats are best-effort.
 */
export async function incrementStat(organizationId: string, field: StatField): Promise<void> {
    const col = STAT_COLUMNS[field]
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    try {
        await db.execute(sql`
            INSERT INTO statistics (id, organization_id, date, ${sql.raw(col)})
            VALUES (gen_random_uuid(), ${organizationId}, ${today}, 1)
            ON CONFLICT (organization_id, date)
            DO UPDATE SET ${sql.raw(col)} = statistics.${sql.raw(col)} + 1
        `)
    } catch (err) {
        console.error('incrementStat error:', err)
    }
}

// ---------------------------------------------------------------------------
// Webhook dispatcher
// ---------------------------------------------------------------------------

// COR-02 — see audit M6. Retry transient webhook failures with exponential backoff.
// Sleep BEFORE attempt N: 0ms before attempt 1, 3s before 2, 9s before 3.
// Attempts fire at T=0s, ~3s, ~12s after fireWebhooks is invoked.
const BACKOFF_MS = [0, 3000, 9000]
const MAX_ATTEMPTS = 3
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type WebhookEvent =
    | 'message_sent'
    | 'message_delivered'
    | 'message_bounced'
    | 'message_held'
    | 'message_opened'
    | 'link_clicked'
    | 'domain_verified'
    | 'spam_alert'
    | 'test'

/**
 * Creates user notifications for organization members when server events occur.
 */
export async function createUserNotificationsForEvent(
    organizationId: string,
    event: WebhookEvent,
    data: Record<string, unknown>
): Promise<void> {
    try {
        const typeMap: Record<WebhookEvent, string> = {
            message_sent: 'bounce',
            message_delivered: 'bounce',
            message_bounced: 'bounce',
            message_held: 'held',
            message_opened: 'bounce',
            link_clicked: 'bounce',
            domain_verified: 'domain_verification_failed',
            spam_alert: 'spam_alert',
            test: 'bounce',
        }

        const titleMap: Record<WebhookEvent, string> = {
            message_sent: 'Email sent',
            message_delivered: 'Email delivered',
            message_bounced: 'Email bounced',
            message_held: 'Message held',
            message_opened: 'Email opened',
            link_clicked: 'Link clicked',
            domain_verified: 'Domain verified',
            spam_alert: 'Spam detected',
            test: 'Test event',
        }

        const messageMap: Record<WebhookEvent, string> = {
            message_sent: `Message sent to ${data.to || 'unknown recipient'}`,
            message_delivered: `Message delivered to ${data.to || 'unknown recipient'}`,
            message_bounced: `Message to ${data.to || 'unknown recipient'} bounced: ${data.reason || 'Unknown reason'}`,
            message_held: `Message from ${data.from || 'unknown sender'} is held: ${data.reason || 'Unknown reason'}`,
            message_opened: `Message to ${data.to || 'unknown recipient'} was opened`,
            link_clicked: `Link clicked in message to ${data.to || 'unknown recipient'}`,
            domain_verified: `Domain ${data.domain || 'unknown'} has been verified`,
            spam_alert: `Spam detected in message from ${data.from || 'unknown sender'}`,
            test: 'Test notification',
        }

        const type = typeMap[event]
        const title = titleMap[event]
        const message = messageMap[event]

        const memberships = await db.query.organizationUsers.findMany({
            where: eq(organizationUsers.organizationId, organizationId),
        })

        if (memberships.length === 0) return

        await db.insert(userNotifications).values(
            memberships.map((m) => ({
                userId: m.userId,
                type,
                title,
                message,
                metadata: data,
            }))
        )
    } catch (err) {
        console.error('createUserNotificationsForEvent error:', err)
    }
}

/**
 * Fires all active webhooks subscribed to the given event for an organization.
 * Signs the payload with HMAC-SHA256 when a secret is configured.
 * Logs every attempt to webhook_requests.
 * Errors are swallowed so tracking never blocks the response.
 */
export async function fireWebhooks(
    organizationId: string,
    event: WebhookEvent,
    data: Record<string, unknown>
): Promise<void> {
    // Create user notifications for critical events
    const notificationEvents: WebhookEvent[] = ['message_bounced', 'message_held', 'spam_alert']
    if (notificationEvents.includes(event)) {
        await createUserNotificationsForEvent(organizationId, event, data)
    }

    try {
        const allWebhooks = await db.query.webhooks.findMany({
            where: and(
                eq(webhooks.organizationId, organizationId),
                eq(webhooks.active, true)
            ),
        })

        const matching = allWebhooks.filter((wh) =>
            (wh.events as string[]).includes(event)
        )

        if (matching.length === 0) return

        const payload = {
            event,
            timestamp: new Date().toISOString(),
            organizationId,
            data,
        }

        await Promise.allSettled(
            matching.map(async (wh) => {
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'X-Webhook-Event': event,
                }

                if (wh.secret) {
                    const sig = createHmac('sha256', wh.secret)
                        .update(JSON.stringify(payload))
                        .digest('hex')
                    headers['X-Webhook-Signature'] = `sha256=${sig}`
                }

                // COR-02 — see audit M6/H2. Retry classification: 5xx + network/timeout = retry; 4xx = permanent; 2xx = success.
                for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                    if (BACKOFF_MS[attempt - 1] > 0) await sleep(BACKOFF_MS[attempt - 1])

                    try {
                        const response = await fetch(wh.url, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify(payload),
                            signal: AbortSignal.timeout(10_000),
                        })

                        const body = await response.text()

                        await db.insert(webhookRequests).values({
                            webhookId: wh.id,
                            event: event as any,
                            payload,
                            responseCode: response.status,
                            responseBody: body.substring(0, 5000),
                            success: response.ok,
                            attempts: attempt,
                        })

                        // Success (2xx) OR permanent failure (4xx) → stop. Only 5xx triggers retry.
                        if (response.ok || response.status < 500) return
                        // else: 5xx → loop continues (unless this was attempt MAX_ATTEMPTS)
                    } catch (err) {
                        // Network/timeout error — record and (if attempts remain) retry.
                        await db.insert(webhookRequests).values({
                            webhookId: wh.id,
                            event: event as any,
                            payload,
                            success: false,
                            error: err instanceof Error ? err.message : 'Request failed',
                            attempts: attempt,
                        })
                        // Loop continues unless this was the last attempt.
                    }
                }
            })
        )
    } catch (err) {
        console.error('fireWebhooks error:', err)
    }
}
