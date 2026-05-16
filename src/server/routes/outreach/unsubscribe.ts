/**
 * Unsubscribe handling routes for outreach emails
 */
import { Router, Response } from 'express'
import { db } from '../../../db'
import { campaigns, campaignLeads, leads, outreachEmails } from '../../../db/schema'
import { eq, and, sql } from 'drizzle-orm'

const router = Router()

interface UnsubscribeToken {
    leadId: string
    campaignId: string
    timestamp: number
}

function encodeToken(data: UnsubscribeToken): string {
    const json = JSON.stringify(data)
    return Buffer.from(json).toString('base64url')
}

function decodeToken(token: string): UnsubscribeToken | null {
    try {
        const json = Buffer.from(token, 'base64url').toString('utf-8')
        return JSON.parse(json) as UnsubscribeToken
    } catch {
        return null
    }
}

function generateUnsubscribeHtml(leadEmail: string, _campaignName: string): string {
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
        <div class="email">${leadEmail}</div>
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
        <p>${message}</p>
    </div>
</body>
</html>`
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

    return { success: true, lead }
}

router.get('/:token', async (req, res: Response) => {
    const { token } = req.params

    const decoded = decodeToken(token)
    if (!decoded) {
        return res.status(400).send(generateErrorHtml('Invalid unsubscribe link'))
    }

    const { leadId, campaignId } = decoded

    const result = await processUnsubscribe(leadId, campaignId)

    if (!result.success) {
        return res.status(404).send(generateErrorHtml(result.error || 'Unable to process unsubscribe'))
    }

    const campaign = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaignId),
        columns: { name: true },
    })

    res.send(generateUnsubscribeHtml(result.lead!.email, campaign?.name || 'our mailing list'))
})

router.post('/:token', async (req, res: Response) => {
    const { token } = req.params

    const decoded = decodeToken(token)
    if (!decoded) {
        return res.status(400).json({ error: 'Invalid unsubscribe token' })
    }

    const { leadId, campaignId } = decoded

    const result = await processUnsubscribe(leadId, campaignId)

    if (!result.success) {
        return res.status(404).json({ error: result.error || 'Unable to process unsubscribe' })
    }

    res.json({
        success: true,
        message: 'Successfully unsubscribed',
        lead: {
            id: result.lead!.id,
            email: result.lead!.email,
            unsubscribedAt: result.lead!.unsubscribedAt,
        },
    })
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
    const token = encodeToken({
        leadId,
        campaignId,
        timestamp: Date.now(),
    })
    return `${baseUrl.replace(/\/$/, '')}/unsubscribe/${token}`
}

export default router
