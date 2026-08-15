/**
 * Process Bounced Outreach Emails
 *
 * Phase 19 (PROV-04): this job no longer scans inboxes. It consumes durable
 * outreach_provider_events rows already classified 'bounce' at ingestion, then:
 * - Parses bounce messages (DSN - Delivery Status Notification)
 * - Updates outreach_emails with bounce info
 * - Updates campaign_leads.status to 'bounced'
 * - Updates leads.status to 'bounced'
 * - Increments bounce stats on campaigns and accounts
 * - Suppresses hard-bounced addresses org-wide
 *
 * Why the change: the old IMAP scan re-read every message from a bounce-sender on
 * every tick with no date/cursor bound, and the native scan only saw unread mail —
 * so a DSN that processReplies had already marked read was invisible here. Both jobs
 * now read the same one-time classification and cannot race.
 *
 * Also provides webhook endpoint support for services like SendGrid, Mailgun, etc.
 */

import { simpleParser } from 'mailparser'
import { db } from '../../db'
import { emailAccounts, outreachEmails, campaignLeads, leads, campaigns, suppressions } from '../../db/schema'
import { eq, and, ne, sql, desc } from 'drizzle-orm'
import { createLogger } from '../lib/logger'
import { sendXphereOutreachEvent } from '../lib/xphere-events'
import { shouldNotifyOutreachEvent } from '../lib/outreach-settings'
import { runWithLock } from '../lib/cron-lock'
import {
    consumeClassifiedEvents,
    createDrizzleInboundEventStore,
    type StoredProviderEvent,
} from '../lib/outreach-inbound'
import { ingestOutreachInboundExclusive } from '../lib/outreach-inbound-sources'
import { TERMINAL_CAMPAIGN_LEAD_STATUSES } from '../lib/outreach-sequence-state'

const log = createLogger('outreach.bounce')

interface BounceInfo {
    recipientEmail: string
    originalMessageId?: string
    bounceType: 'hard' | 'soft'
    reason: string
    diagnosticCode?: string
}

export function parseBounceMessage(message: Awaited<ReturnType<typeof simpleParser>>): BounceInfo {
    let recipientEmail = ''
    let originalMessageId: string | undefined
    let bounceType: 'hard' | 'soft' = 'hard'
    let reason = 'Unknown bounce reason'
    let diagnosticCode: string | undefined

    const textContent = (message.text || '').toLowerCase()
    const htmlContent = (message.html || '').toString().toLowerCase()
    const fullContent = `${textContent} ${htmlContent}`

    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
    const emails = fullContent.match(emailRegex) || []

    for (const email of emails) {
        if (!email.includes('mailer-daemon') && 
            !email.includes('postmaster') && 
            !email.includes('noreply') &&
            !email.includes('no-reply')) {
            recipientEmail = email
            break
        }
    }

    if (message.messageId) {
        originalMessageId = message.messageId
    }

    const messageIdMatch = fullContent.match(/message-id:\s*<([^>]+)>/i)
    if (messageIdMatch) {
        originalMessageId = messageIdMatch[1]
    }

    const hardBounceIndicators = [
        'user unknown',
        'no such user',
        'address not found',
        'recipient rejected',
        'mailbox unavailable',
        'does not exist',
        'invalid recipient',
        'recipient invalid',
        '550 ',
        '551 ',
        '553 ',
        'permanent failure',
        'permanent error'
    ]

    const softBounceIndicators = [
        'mailbox full',
        'quota exceeded',
        'over quota',
        'temporarily unavailable',
        'try again later',
        'deferred',
        'greylisted',
        'rate limit',
        'too many',
        '450 ',
        '451 ',
        '452 ',
        'temporary failure',
        'transient failure'
    ]

    for (const indicator of hardBounceIndicators) {
        if (fullContent.includes(indicator)) {
            bounceType = 'hard'
            reason = extractReason(fullContent, indicator)
            break
        }
    }

    if (bounceType === 'hard') {
        for (const indicator of softBounceIndicators) {
            if (fullContent.includes(indicator)) {
                bounceType = 'soft'
                reason = extractReason(fullContent, indicator)
                break
            }
        }
    }

    const codeMatch = fullContent.match(/(?:#|status:)\s*(\d\.\d\.\d)/i)
    if (codeMatch) {
        diagnosticCode = codeMatch[1]
    }

    const smtpCodeMatch = fullContent.match(/(\d{3})\s+[^\n]*/)
    if (smtpCodeMatch) {
        diagnosticCode = smtpCodeMatch[1]
    }

    return {
        recipientEmail,
        originalMessageId,
        bounceType,
        reason,
        diagnosticCode
    }
}

function extractReason(content: string, indicator: string): string {
    const index = content.indexOf(indicator)
    if (index === -1) return indicator

    const start = Math.max(0, index - 50)
    const end = Math.min(content.length, index + indicator.length + 100)
    const context = content.substring(start, end).trim()

    const sentenceMatch = context.match(/[^.!?]*[.!?]/)
    if (sentenceMatch) {
        return sentenceMatch[0].trim()
    }

    return indicator
}

export async function findOutreachEmailByRecipient(
    email: string, 
    accountId: string
): Promise<typeof outreachEmails.$inferSelect | null> {
    // P0-08: campaignLeadId is UUID — LOWER(uuid) raises `function lower(uuid) does not exist`.
    // We only need case-insensitive comparison on l.email (text); UUIDs compare natively.
    const result = await db.query.outreachEmails.findFirst({
        where: and(
            eq(outreachEmails.emailAccountId, accountId),
            sql`${outreachEmails.campaignLeadId} IN (
                SELECT cl.id FROM campaign_leads cl
                JOIN leads l ON cl.lead_id = l.id
                WHERE LOWER(l.email) = LOWER(${email})
            )`
        ),
        orderBy: [desc(outreachEmails.sentAt)],
        with: {
            campaignLead: {
                with: {
                    lead: true
                }
            }
        }
    })

    return result || null
}

export async function findBouncedOutreachEmailByMessageId(
    messageId: string,
    accountId: string,
    organizationId: string,
): Promise<typeof outreachEmails.$inferSelect | null> {
    const cleanMessageId = messageId.replace(/[<>]/g, '').trim()
    if (cleanMessageId.length < 8) return null

    const result = await db.query.outreachEmails.findFirst({
        where: and(
            eq(outreachEmails.emailAccountId, accountId),
            eq(outreachEmails.organizationId, organizationId),
            sql`LOWER(${outreachEmails.messageId}) = LOWER(${cleanMessageId})`,
        ),
        orderBy: [desc(outreachEmails.sentAt)]
    })

    return result || null
}

/**
 * Applies a bounce to one lead. Returns whether this call was the one that transitioned it
 * — false means another DSN got there first and every counter below was already applied.
 *
 * W-2: the caller used to decide that by reading campaign_leads.status and then writing,
 * with nothing between the two. processReplies holds a *different* advisory lock and runs
 * on the same tick, so the CAS in the campaign_leads UPDATE is the only honest gate.
 */
export async function markAsBounced(
    outreachEmailId: string,
    campaignLeadId: string,
    leadId: string,
    campaignId: string,
    accountId: string,
    organizationId: string,
    reason: string
): Promise<boolean> {
    const now = new Date()
    const terminalStatuses = sql.join(
        TERMINAL_CAMPAIGN_LEAD_STATUSES.map((status) => sql`${status}`),
        sql`, `,
    )

    // The gate, first: `status <> 'bounced'` is the compare-and-set. A second DSN for the
    // same lead blocks on the row lock, re-evaluates against the committed row, matches
    // nothing, and returns without double-counting anything.
    const transitioned = await db.update(campaignLeads)
        .set({
            // A terminal status is never reverted (Phase 18), so a lead that already
            // replied stays replied — the bounce is still recorded as bookkeeping below.
            status: sql`CASE WHEN ${campaignLeads.status} IN (${terminalStatuses}) THEN ${campaignLeads.status} ELSE 'bounced' END`,
            nextScheduledAt: null,
            // Both queues, not just the sequence. processFollowUps selects on
            // next_follow_up_at alone, so leaving it set mails the address that just
            // bounced — and a soft bounce writes no suppression row to catch it.
            nextFollowUpAt: null,
            updatedAt: now
        })
        .where(and(
            eq(campaignLeads.id, campaignLeadId),
            eq(campaignLeads.campaignId, campaignId),
            ne(campaignLeads.status, 'bounced'),
        ))
        .returning({ id: campaignLeads.id })

    if (transitioned.length === 0) return false

    await db.update(outreachEmails)
        .set({
            status: 'bounced',
            bouncedAt: now,
            bounceReason: reason,
            updatedAt: now
        })
        .where(and(
            eq(outreachEmails.id, outreachEmailId),
            eq(outreachEmails.emailAccountId, accountId),
            eq(outreachEmails.organizationId, organizationId),
        ))

    await db.update(leads)
        .set({
            status: sql`CASE WHEN ${leads.status} IN (${terminalStatuses}) THEN ${leads.status} ELSE 'bounced' END`,
            updatedAt: now
        })
        .where(eq(leads.id, leadId))

    await db.update(campaigns)
        .set({
            totalBounces: sql`${campaigns.totalBounces} + 1`,
            updatedAt: now
        })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)))

    await db.update(emailAccounts)
        .set({
            totalBounces: sql`${emailAccounts.totalBounces} + 1`,
            updatedAt: now
        })
        .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.organizationId, organizationId)))

    // Fetch once — used for both the hard-bounce suppression insert below and the
    // Xphere outbound notification.
    const lead = await db.query.leads.findFirst({
        where: eq(leads.id, leadId),
        columns: { email: true, customFields: true },
    })

    // P0-07: Hard bounces go into the org-level suppression list so we never re-mail them
    // from any future campaign in this org. The pattern matches the audit's heuristic
    // (audit P0-07, fix sugerido). Mirrors the unsubscribe-path insert in unsubscribe.ts
    // (Plan 14-05) that already covers source='unsubscribe'.
    const isHardBounce = /permanent|hard|550|551|553|user unknown|no such user|address not found|mailbox unavailable|does not exist|recipient rejected|invalid recipient/i.test(reason)
    if (isHardBounce && lead) {
        await db.insert(suppressions).values({
            organizationId,
            emailAddress: lead.email.toLowerCase(),
            source: 'bounce',
            reason: reason.slice(0, 500),  // cap to avoid pathological inputs
        }).onConflictDoNothing()
    }

    // Emission is gated on the org's notifyOnBounce policy (CONS-04). The CAS above already
    // guarantees this runs only on the transition into 'bounced', so a replayed DSN cannot
    // re-notify even when the policy is enabled.
    if (lead && await shouldNotifyOutreachEvent(organizationId, 'bounce')) {
        await sendXphereOutreachEvent('bounced', {
            email: lead.email,
            campaign_id: campaignId,
            lead_id: leadId,
            outreach_email_id: outreachEmailId,
            customFields: lead.customFields,
        }, organizationId)
    }

    log.info({
        action: 'outreach.bounce.detected',
        outreachEmailId,
        campaignId,
        leadId,
        emailAccountId: accountId,
        organizationId,
        reason: reason.slice(0, 200),
    }, 'marked as bounced')

    return true
}

// P0-06 / audit-2026-07 — advisory lock prevents concurrent runs across Node instances.
// Uses runWithLock (cron-lock.ts) so acquire+release share one reserved connection; the
// previous db.execute-on-pool implementation leaked the lock across sessions (see audit H1).
// Inspect held locks: SELECT * FROM pg_locks WHERE locktype='advisory';
const BOUNCE_PROCESSOR_LOCK_NAME = 'outreach-bounces-processor'

export async function runBouncesProcessorWithLock(): Promise<void> {
    await runWithLock(BOUNCE_PROCESSOR_LOCK_NAME, async () => {
        await processBounces()
    })
}

export async function processBounces(): Promise<{ processed: number; bounces: number; errors: number }> {
    const result = { processed: 0, bounces: 0, errors: 0 }

    const store = createDrizzleInboundEventStore()

    // Stage first — see the note in processReplies.ts. Ingestion is idempotent AND
    // advisory-locked, so whichever job wins a colliding tick stages once and the other
    // skips straight to consuming (null result).
    const ingested = await ingestOutreachInboundExclusive({ store })
    if (ingested) result.errors += ingested.errors

    const consumed = await consumeClassifiedEvents({
        store,
        classification: 'bounce',
        handle: async (event) => {
            const bounced = await handleBounceEvent(event)
            if (bounced) result.bounces++
        },
    })

    result.processed = consumed.claimed
    result.errors += consumed.failed

    return result
}

/**
 * Applies one already-classified bounce event. Reaching this function means the
 * ingestion classifier decided DSN before anything else looked at the message, so a
 * bounce can no longer be consumed as a reply.
 */
async function handleBounceEvent(event: StoredProviderEvent): Promise<boolean> {
    // parseBounceMessage only reads .text/.html/.messageId off a parsed-mail object.
    // The staged bodies carry the same content the old raw-source parse produced.
    const pseudoParsed = {
        text: event.textBody || '',
        html: event.htmlBody || false,
        messageId: event.messageId || undefined,
    } as unknown as Awaited<ReturnType<typeof simpleParser>>

    const bounceInfo = parseBounceMessage(pseudoParsed)

    if (!bounceInfo.recipientEmail) {
        log.warn({
            action: 'outreach.bounce.parse_failed_no_recipient',
            provider: event.provider,
            emailAccountId: event.emailAccountId,
        }, 'could not extract recipient from bounce')
        return false
    }

    let outreachEmail = bounceInfo.originalMessageId
        ? await findBouncedOutreachEmailByMessageId(
            bounceInfo.originalMessageId,
            event.emailAccountId,
            event.organizationId,
        )
        : null

    if (!outreachEmail) {
        outreachEmail = await findOutreachEmailByRecipient(bounceInfo.recipientEmail, event.emailAccountId)
    }

    if (!outreachEmail) {
        log.warn({
            action: 'outreach.bounce.unmatched',
            recipientEmail: bounceInfo.recipientEmail,
            emailAccountId: event.emailAccountId,
            provider: event.provider,
        }, 'no outreach email matched bounce recipient')
        return false
    }

    if (!outreachEmail.campaignLeadId || !outreachEmail.campaignId) {
        log.warn({
            action: 'outreach.bounce.non_campaign_match',
            outreachEmailId: outreachEmail.id,
            origin: outreachEmail.origin,
        }, 'bounce target has no campaign linkage')
        return false
    }

    const campaignLead = await db.query.campaignLeads.findFirst({
        where: eq(campaignLeads.id, outreachEmail.campaignLeadId),
        with: { lead: true },
    })

    if (!campaignLead?.lead) {
        log.warn({
            action: 'outreach.bounce.campaign_lead_missing',
            outreachEmailId: outreachEmail.id,
            provider: event.provider,
        }, 'campaign lead row missing for bounce target')
        return false
    }

    const fullReason = bounceInfo.diagnosticCode
        ? `${bounceInfo.reason} (${bounceInfo.diagnosticCode})`
        : bounceInfo.reason

    // Idempotence is markAsBounced's CAS, not a status read here: this function and
    // processReplies run concurrently, so a check at this distance from the write decides
    // nothing. Returns false when an earlier DSN already bounced the lead.
    return markAsBounced(
        outreachEmail.id,
        campaignLead.id,
        campaignLead.lead.id,
        outreachEmail.campaignId,
        event.emailAccountId,
        outreachEmail.organizationId,
        fullReason,
    )
}

export async function processBounceFromWebhook(data: {
    recipientEmail: string
    messageId?: string
    emailAccountId: string
    organizationId: string
    reason: string
    bounceType: 'hard' | 'soft'
}): Promise<void> {
    const { recipientEmail, messageId, emailAccountId, organizationId, reason, bounceType } = data

    let outreachEmail: typeof outreachEmails.$inferSelect | null = null

    if (messageId) {
        outreachEmail = await findBouncedOutreachEmailByMessageId(messageId, emailAccountId, organizationId)
    }

    if (!outreachEmail) {
        outreachEmail = await findOutreachEmailByRecipient(recipientEmail, emailAccountId)
        if (outreachEmail?.organizationId !== organizationId) outreachEmail = null
    }

    if (!outreachEmail) {
        log.warn({
            action: 'outreach.bounce.webhook_unmatched',
            recipientEmail,
        }, 'no outreach email matched webhook bounce')
        return
    }

    if (!outreachEmail.campaignLeadId || !outreachEmail.campaignId) {
        log.warn({
            action: 'outreach.bounce.webhook_non_campaign_match',
            outreachEmailId: outreachEmail.id,
            origin: outreachEmail.origin,
        }, 'webhook bounce target has no campaign linkage')
        return
    }

    const campaignLead = await db.query.campaignLeads.findFirst({
        where: eq(campaignLeads.id, outreachEmail.campaignLeadId),
        with: { lead: true }
    })

    if (!campaignLead?.lead) {
        log.warn({
            action: 'outreach.bounce.webhook_campaign_lead_missing',
            outreachEmailId: outreachEmail.id,
        }, 'campaign lead row missing for webhook bounce target')
        return
    }

    const fullReason = `${bounceType.toUpperCase()}: ${reason}`

    // Same reasoning as the event path: the CAS inside markAsBounced is the gate.
    await markAsBounced(
        outreachEmail.id,
        campaignLead.id,
        campaignLead.lead.id,
        outreachEmail.campaignId,
        outreachEmail.emailAccountId,
        outreachEmail.organizationId,
        fullReason
    )
}
