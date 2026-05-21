/**
 * Unsubscribe handling routes for outreach emails.
 *
 * Mounted at /o/u by src/server/index.ts (NOT under /api — public link in email bodies,
 * must not require auth or be subject to /api rate-limit).
 *
 * RFC 8058 GET-safety: GET /o/u/:token renders a confirmation page with NO database
 * writes. The actual unsubscribe action happens only on POST /o/u/:token. Email clients
 * (Gmail prefetch, Outlook Safelinks, anti-virus URL scanners) routinely GET URLs in
 * email bodies; performing the unsubscribe on GET would fire spurious unsubscribes
 * without recipient intent.
 */
import { Router, Response } from 'express'
import { db } from '../../../db'
import { campaigns, campaignLeads, leads, outreachEmails, suppressions } from '../../../db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { generateOutreachToken, verifyOutreachToken } from '../../lib/outreach-tokens'

const router = Router()

function generateUnsubscribeHtml(leadEmail: string, campaignName: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Unsubscribed</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.2);
            padding: 48px;
            max-width: 480px;
            width: 100%;
            text-align: center;
        }
        .icon {
            width: 80px;
            height: 80px;
            background: #10b981;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
        }
        .icon svg {
            width: 40px;
            height: 40px;
            stroke: white;
            stroke-width: 3;
            fill: none;
        }
        h1 {
            color: #1f2937;
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 16px;
        }
        p {
            color: #6b7280;
            font-size: 16px;
            line-height: 1.6;
            margin-bottom: 12px;
        }
        .email {
            background: #f3f4f6;
            padding: 12px 20px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 14px;
            color: #374151;
            margin: 20px 0;
            word-break: break-all;
        }
        .footer {
            margin-top: 32px;
            padding-top: 24px;
            border-top: 1px solid #e5e7eb;
            color: #9ca3af;
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">
            <svg viewBox="0 0 24 24">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        </div>
        <h1>You've Been Unsubscribed</h1>
        <p>You have been successfully removed from our mailing list.</p>
        <div class="email">${escapeHtml(leadEmail)}</div>
        <p>You will no longer receive emails from this campaign.</p>
        <div class="footer">
            <p>If this was a mistake, please contact the sender directly.</p>
        </div>
    </div>
</body>
</html>`
}

function generateErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Error</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.2);
            padding: 48px;
            max-width: 480px;
            width: 100%;
            text-align: center;
        }
        .icon {
            width: 80px;
            height: 80px;
            background: #ef4444;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
        }
        .icon svg {
            width: 40px;
            height: 40px;
            stroke: white;
            stroke-width: 3;
            fill: none;
        }
        h1 {
            color: #1f2937;
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 16px;
        }
        p {
            color: #6b7280;
            font-size: 16px;
            line-height: 1.6;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">
            <svg viewBox="0 0 24 24">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        </div>
        <h1>Error</h1>
        <p>${escapeHtml(message)}</p>
    </div>
</body>
</html>`
}

function generateConfirmHtml(leadEmail: string, campaignName: string, token: string): string {
    // Token interpolated into the form action; same-origin POST. No JS needed for the basic flow.
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confirm unsubscribe</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .container { background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.2);
            padding: 48px; max-width: 480px; width: 100%; text-align: center; }
        h1 { color: #1f2937; font-size: 26px; font-weight: 700; margin-bottom: 16px; }
        p { color: #6b7280; font-size: 16px; line-height: 1.6; margin-bottom: 12px; }
        .email { background: #f3f4f6; padding: 12px 20px; border-radius: 8px;
            font-family: monospace; font-size: 14px; color: #374151; margin: 20px 0; word-break: break-all; }
        button { background: #ef4444; color: white; border: 0; border-radius: 10px; padding: 14px 28px;
            font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 16px; }
        button:hover { background: #dc2626; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Unsubscribe from ${escapeHtml(campaignName)}?</h1>
        <p>You are about to unsubscribe the following address:</p>
        <div class="email">${escapeHtml(leadEmail)}</div>
        <p>Click the button below to confirm. You will not receive further emails from this campaign or any other campaign in this organization.</p>
        <form method="POST" action="/o/u/${encodeURIComponent(token)}">
            <button type="submit">Unsubscribe me</button>
        </form>
    </div>
</body>
</html>`
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

async function processUnsubscribe(leadId: string, campaignId: string): Promise<{ success: boolean; lead?: typeof leads.$inferSelect; error?: string }> {
    const lead = await db.query.leads.findFirst({
        where: eq(leads.id, leadId),
    })

    if (!lead) {
        return { success: false, error: 'Lead not found' }
    }

    if (lead.unsubscribedAt) {
        return { success: true, lead }
    }

    const now = new Date()

    await db.update(leads)
        .set({
            status: 'unsubscribed',
            unsubscribedAt: now,
            updatedAt: now,
        })
        .where(eq(leads.id, leadId))

    await db.update(campaignLeads)
        .set({
            status: 'unsubscribed',
            updatedAt: now,
        })
        .where(and(
            eq(campaignLeads.leadId, leadId),
            eq(campaignLeads.campaignId, campaignId)
        ))

    await db.update(campaigns)
        .set({
            totalUnsubscribes: sql`${campaigns.totalUnsubscribes} + 1`,
            updatedAt: now,
        })
        .where(eq(campaigns.id, campaignId))

    await db.update(outreachEmails)
        .set({
            unsubscribedAt: now,
            updatedAt: now,
        })
        .where(and(
            eq(outreachEmails.campaignId, campaignId),
            sql`${outreachEmails.campaignLeadId} IN (SELECT id FROM campaign_leads WHERE lead_id = ${leadId})`
        ))

    // Suppress the email address at the org level so any subsequent campaign in the SAME
    // org does not re-mail this address. Source='unsubscribe' per migration 020 CHECK.
    // ON CONFLICT DO NOTHING because we may already have a suppression from a prior bounce.
    const campaign = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaignId),
        columns: { organizationId: true },
    })
    if (campaign) {
        await db.insert(suppressions).values({
            organizationId: campaign.organizationId,
            emailAddress: lead.email.toLowerCase(),
            source: 'unsubscribe',
            reason: 'User clicked unsubscribe link',
        }).onConflictDoNothing()
    }

    return { success: true, lead }
}

// RFC 8058 GET-safety: read-only. Render the confirmation page. Do NOT mutate.
router.get('/:token', async (req, res: Response) => {
    const { token } = req.params

    const decoded = verifyOutreachToken(token, 'unsub')
    if (!decoded || !decoded.cid) {
        return res.status(400).send(generateErrorHtml('Invalid or expired unsubscribe link'))
    }

    const leadId = decoded.clid
    const campaignId = decoded.cid

    // Look up lead + campaign for personalization in the confirmation page — but DO NOT
    // mutate anything. Read-only is safe under RFC 8058 / URL prefetch.
    const lead = await db.query.leads.findFirst({
        where: eq(leads.id, leadId),
        columns: { email: true, unsubscribedAt: true },
    })
    if (!lead) {
        return res.status(404).send(generateErrorHtml('Unsubscribe link not found'))
    }

    const campaign = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaignId),
        columns: { name: true },
    })

    // If already unsubscribed, show the success page directly — still no DB writes.
    if (lead.unsubscribedAt) {
        return res.send(generateUnsubscribeHtml(lead.email, campaign?.name || 'our mailing list'))
    }

    // Render the confirmation page. The form POSTs back to the same /o/u/:token URL,
    // so the token is the only thing needed to perform the action.
    return res.send(generateConfirmHtml(lead.email, campaign?.name || 'our mailing list', token))
})

// POST performs the actual unsubscribe — RFC 8058 one-click compliant.
router.post('/:token', async (req, res: Response) => {
    const { token } = req.params

    const decoded = verifyOutreachToken(token, 'unsub')
    if (!decoded || !decoded.cid) {
        // JSON if the client wants JSON (fetch), HTML otherwise (form submit from browser).
        if ((req.headers.accept || '').includes('application/json')) {
            return res.status(400).json({ error: 'Invalid or expired unsubscribe token' })
        }
        return res.status(400).send(generateErrorHtml('Invalid or expired unsubscribe link'))
    }

    const leadId = decoded.clid
    const campaignId = decoded.cid

    const result = await processUnsubscribe(leadId, campaignId)

    if (!result.success) {
        if ((req.headers.accept || '').includes('application/json')) {
            return res.status(404).json({ error: result.error || 'Unable to process unsubscribe' })
        }
        return res.status(404).send(generateErrorHtml(result.error || 'Unable to process unsubscribe'))
    }

    // Gmail one-click POSTs without an Accept header; default to HTML success page,
    // but return JSON when the client explicitly asked for it.
    if ((req.headers.accept || '').includes('application/json')) {
        return res.json({
            success: true,
            message: 'Successfully unsubscribed',
            lead: {
                id: result.lead!.id,
                email: result.lead!.email,
                unsubscribedAt: result.lead!.unsubscribedAt,
            },
        })
    }

    const campaign = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaignId),
        columns: { name: true },
    })

    return res.send(generateUnsubscribeHtml(result.lead!.email, campaign?.name || 'our mailing list'))
})

router.get('/check/:leadId/:campaignId', async (req, res: Response) => {
    const { leadId, campaignId } = req.params

    const lead = await db.query.leads.findFirst({
        where: eq(leads.id, leadId),
        columns: {
            id: true,
            email: true,
            status: true,
            unsubscribedAt: true,
        },
    })

    if (!lead) {
        return res.status(404).json({ error: 'Lead not found' })
    }

    const campaignLead = await db.query.campaignLeads.findFirst({
        where: and(
            eq(campaignLeads.leadId, leadId),
            eq(campaignLeads.campaignId, campaignId)
        ),
        columns: {
            id: true,
            status: true,
        },
    })

    res.json({
        leadId: lead.id,
        campaignId,
        isUnsubscribed: lead.status === 'unsubscribed' || !!lead.unsubscribedAt,
        leadStatus: lead.status,
        unsubscribedAt: lead.unsubscribedAt,
        campaignLeadStatus: campaignLead?.status || null,
    })
})

export function generateUnsubscribeLink(leadId: string, campaignId: string, baseUrl: string): string {
    // NOTE: parameter is named `leadId` for back-compat with audit's fix sugerido, but the
    // token semantically uses campaignLeadId (per-campaign per-lead row) for unsubscribe.
    // The sender calls this with campaignLead.id (NOT lead.id) — see outreach-sender.ts edit.
    const token = generateOutreachToken({ kind: 'unsub', clid: leadId, cid: campaignId })
    return `${baseUrl.replace(/\/$/, '')}/o/u/${token}`
}

export default router
