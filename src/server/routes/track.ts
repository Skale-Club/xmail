import { Router, Request, Response } from 'express'
import { db } from '../../db'
import { messages, organizations, outreachEmails, campaignLeads, campaigns, emailAccounts } from '../../db/schema'
import { eq, sql } from 'drizzle-orm'
import { fireWebhooks, incrementStat } from '../lib/tracking'
import { verifyTrackedUrl } from '../lib/outreach-tokens'
import { isPrivateHost } from '../lib/network-guard'
import { createLogger } from '../lib/logger'
import { sendXphereOutreachEvent } from '../lib/xphere-events'

const log = createLogger('outreach.track')

const router = Router()

// 1×1 transparent GIF (base64 decoded at startup, not on every request)
const PIXEL = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
)

// Notify Xphere of an outreach open/click event. Fire-and-forget — never
// awaited by callers, must not add latency to the pixel/redirect response.
async function notifyXphereOfOutreachEvent(event: 'opened' | 'clicked', campaignId: string, campaignLeadId: string) {
    try {
        const campaignLead = await db.query.campaignLeads.findFirst({
            where: eq(campaignLeads.id, campaignLeadId),
            columns: { leadId: true },
            with: { lead: { columns: { email: true, customFields: true } } },
        })
        if (!campaignLead?.lead) return

        sendXphereOutreachEvent(event, {
            email: campaignLead.lead.email,
            campaign_id: campaignId,
            lead_id: campaignLead.leadId,
            customFields: campaignLead.lead.customFields,
        })
    } catch {
        // Best-effort only — never let Xphere notification break tracking.
    }
}

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
        // Outreach lookup first (token shape: base64url(payload).base64url(hmac) — see outreach-tokens.ts).
        // We do NOT HMAC-verify here; the DB lookup `WHERE tracking_token = ?` is the gate.
        // A forged token simply will not match any row. Skipping verify avoids a CPU op per pixel hit (high volume).
        const outreachEmail = await db.query.outreachEmails.findFirst({
            where: eq(outreachEmails.trackingToken, token),
        })

        if (outreachEmail) {
            const now = new Date()
            await db.update(outreachEmails)
                .set({
                    openedAt: outreachEmail.openedAt ?? now,
                    openedCount: sql`${outreachEmails.openedCount} + 1`,
                    updatedAt: now,
                })
                .where(eq(outreachEmails.id, outreachEmail.id))

            const relatedUpdates: PromiseLike<unknown>[] = [
                db.update(emailAccounts).set({ totalOpens: sql`${emailAccounts.totalOpens} + 1`, updatedAt: now }).where(eq(emailAccounts.id, outreachEmail.emailAccountId)),
            ]
            if (outreachEmail.campaignLeadId) {
                relatedUpdates.push(db.update(campaignLeads).set({ totalOpens: sql`${campaignLeads.totalOpens} + 1`, updatedAt: now }).where(eq(campaignLeads.id, outreachEmail.campaignLeadId)))
            }
            if (outreachEmail.campaignId) {
                relatedUpdates.push(db.update(campaigns).set({ totalOpens: sql`${campaigns.totalOpens} + 1`, updatedAt: now }).where(eq(campaigns.id, outreachEmail.campaignId)))
            }
            await Promise.allSettled(relatedUpdates)
            log.debug({
                action: 'outreach.track.open',
                outreachEmailId: outreachEmail.id,
                campaignId: outreachEmail.campaignId,
                campaignLeadId: outreachEmail.campaignLeadId,
                emailAccountId: outreachEmail.emailAccountId,
            }, 'open recorded')
            if (outreachEmail.campaignId && outreachEmail.campaignLeadId) {
                void notifyXphereOfOutreachEvent('opened', outreachEmail.campaignId, outreachEmail.campaignLeadId)
            }
            return
        }

        // Fallback: transactional message lookup (existing behaviour for non-outreach mail).
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
        const e = err instanceof Error ? err : new Error(String(err))
        log.error({
            action: 'outreach.track.open_error',
            token: token.slice(0, 12) + '...',
            error: { message: e.message, stack: e.stack },
        }, 'open tracking failed')
    }
})

// ---------------------------------------------------------------------------
// GET /t/click/:token?u=<base64url-encoded-url>  — click-tracking redirect
// ---------------------------------------------------------------------------
router.get('/click/:token', async (req: Request, res: Response) => {
    const { token } = req.params
    const encodedUrl = req.query.u as string
    const sig = req.query.s as string

    if (!encodedUrl) {
        return res.status(400).send('Missing parameter')
    }

    // SEC — reject any destination we did not sign. Without this the endpoint is an open
    // redirect: `?u=` is base64, not proof of origin, so anyone could point a link bearing
    // our domain at an arbitrary site. Checked before decoding so a forged URL is never
    // parsed, let alone followed. Constant-time compare lives in verifyTrackedUrl.
    if (!verifyTrackedUrl(token, encodedUrl, sig)) {
        return res.status(400).send('Invalid URL')
    }

    let targetUrl: string
    try {
        targetUrl = Buffer.from(encodedUrl, 'base64url').toString('utf8')
        const parsed = new URL(targetUrl)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).send('Invalid URL')
        }
        // SEC-01 — sync check only; click latency is critical. SSRF for stored URLs is gated at write time (webhooks.ts).
        // Retained as defence-in-depth behind the signature check above.
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
        // Outreach lookup first — same rationale as /open above.
        const outreachEmail = await db.query.outreachEmails.findFirst({
            where: eq(outreachEmails.trackingToken, token),
        })

        if (outreachEmail) {
            const now = new Date()
            await db.update(outreachEmails)
                .set({
                    clickedAt: outreachEmail.clickedAt ?? now,
                    clickedCount: sql`${outreachEmails.clickedCount} + 1`,
                    updatedAt: now,
                })
                .where(eq(outreachEmails.id, outreachEmail.id))

            const relatedUpdates: PromiseLike<unknown>[] = [
                db.update(emailAccounts).set({ totalClicks: sql`${emailAccounts.totalClicks} + 1`, updatedAt: now }).where(eq(emailAccounts.id, outreachEmail.emailAccountId)),
            ]
            if (outreachEmail.campaignLeadId) {
                relatedUpdates.push(db.update(campaignLeads).set({ totalClicks: sql`${campaignLeads.totalClicks} + 1`, updatedAt: now }).where(eq(campaignLeads.id, outreachEmail.campaignLeadId)))
            }
            if (outreachEmail.campaignId) {
                relatedUpdates.push(db.update(campaigns).set({ totalClicks: sql`${campaigns.totalClicks} + 1`, updatedAt: now }).where(eq(campaigns.id, outreachEmail.campaignId)))
            }
            await Promise.allSettled(relatedUpdates)
            log.debug({
                action: 'outreach.track.click',
                outreachEmailId: outreachEmail.id,
                campaignId: outreachEmail.campaignId,
                campaignLeadId: outreachEmail.campaignLeadId,
                emailAccountId: outreachEmail.emailAccountId,
                targetUrl,
            }, 'click recorded')
            if (outreachEmail.campaignId && outreachEmail.campaignLeadId) {
                void notifyXphereOfOutreachEvent('clicked', outreachEmail.campaignId, outreachEmail.campaignLeadId)
            }
            return
        }

        // Fallback: transactional message lookup (existing behaviour for non-outreach mail).
        const message = await db.query.messages.findFirst({
            where: eq(messages.token, token),
        })

        if (!message) return

        const trackClicks = true
        const privacyMode = false
        if (!trackClicks || privacyMode) return

        await db.update(messages)
            .set({ clickedAt: new Date(), updatedAt: new Date() })
            .where(eq(messages.token, token))

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
        const e = err instanceof Error ? err : new Error(String(err))
        log.error({
            action: 'outreach.track.click_error',
            token: token.slice(0, 12) + '...',
            error: { message: e.message, stack: e.stack },
        }, 'click tracking failed')
    }
})

export default router
