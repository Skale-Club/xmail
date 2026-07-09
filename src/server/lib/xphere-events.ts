// Fire-and-forget outbound event notifications to Xphere (the CRM/orchestrator
// that drives outreach campaigns via the XMAIL_SERVICE_KEY machine auth — see
// src/server/index.ts). Xphere's receiver lives at POST {XPHERE_EVENTS_URL}
// (its route is /api/integrations/xmail/events) and matches `event` by
// substring (e.g. "opened" -> opened, "click.*" -> clicked), reading
// xphere_id/xphere_kind from `data` or `data.customFields` with an email
// fallback. This module never throws and never blocks the caller — a failed
// or slow delivery to Xphere must not affect outreach processing.

const REQUEST_TIMEOUT_MS = 5_000

/**
 * Notify Xphere of an outreach event (sent, delivered, opened, clicked,
 * replied, bounced, unsubscribed). No-op unless both XPHERE_EVENTS_URL and
 * XPHERE_EVENTS_API_KEY are configured (optional integration, fails closed).
 *
 * Intentionally NOT async/awaited by callers — this fires the request and
 * returns immediately so outreach processing never waits on Xphere.
 */
export function sendXphereOutreachEvent(event: string, data: Record<string, unknown>): void {
    const url = process.env.XPHERE_EVENTS_URL
    const apiKey = process.env.XPHERE_EVENTS_API_KEY

    if (!url || !apiKey) return

    fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ event, data }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((err) => {
        console.warn(`[xphere-events] Failed to deliver "${event}" event:`, err instanceof Error ? err.message : err)
    })
}
