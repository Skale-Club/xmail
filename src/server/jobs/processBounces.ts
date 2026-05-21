/**
 * Process Bounced Outreach Emails
 * 
 * This job processes bounced emails:
 * - Checks IMAP inboxes for bounce notification emails
 * - Parses bounce messages (DSN - Delivery Status Notification)
 * - Updates outreach_emails with bounce info
 * - Updates campaign_leads.status to 'bounced'
 * - Updates leads.status to 'bounced'
 * - Increments bounce stats on campaigns and accounts
 * 
 * Also provides webhook endpoint support for services like SendGrid, Mailgun, etc.
 */

import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { db } from '../../db'
import { emailAccounts, outreachEmails, campaignLeads, leads, campaigns, suppressions } from '../../db/schema'
import { eq, and, isNotNull, sql, desc } from 'drizzle-orm'
import { decryptSecret } from '../lib/crypto'
import { createLogger } from '../lib/logger'

const log = createLogger('outreach.bounce')

interface BounceInfo {
    recipientEmail: string
    originalMessageId?: string
    bounceType: 'hard' | 'soft'
    reason: string
    diagnosticCode?: string
}

const BOUNCE_SENDERS = [
    'mailer-daemon',
    'postmaster',
    'bounce@',
    'bounces@',
    'noreply@',
    'no-reply@'
]

const BOUNCE_SUBJECTS = [
    'undeliverable',
    'returned mail',
    'returned message',
    'bounce',
    'failure',
    'delivery failure',
    'delivery status',
    'delivery report',
    'mail delivery failed',
    'message bounced',
    'unable to deliver'
]

function isBounceEmail(from: string, subject: string): boolean {
    const fromLower = from.toLowerCase()
    const subjectLower = subject.toLowerCase()

    const isBounceSender = BOUNCE_SENDERS.some(sender => fromLower.includes(sender))
    const isBounceSubject = BOUNCE_SUBJECTS.some(s => subjectLower.includes(s))

    return isBounceSender || isBounceSubject
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

async function findOutreachEmailByMessageId(
    messageId: string
): Promise<typeof outreachEmails.$inferSelect | null> {
    const cleanMessageId = messageId.replace(/[<>]/g, '')
    
    const result = await db.query.outreachEmails.findFirst({
        where: sql`LOWER(${outreachEmails.messageId}) LIKE LOWER(${'%' + cleanMessageId + '%'})`,
        orderBy: [desc(outreachEmails.sentAt)]
    })

    return result || null
}

export async function markAsBounced(
    outreachEmailId: string,
    campaignLeadId: string,
    leadId: string,
    campaignId: string,
    accountId: string,
    organizationId: string,
    reason: string
): Promise<void> {
    const now = new Date()

    await db.update(outreachEmails)
        .set({
            status: 'bounced',
            bouncedAt: now,
            bounceReason: reason,
            updatedAt: now
        })
        .where(eq(outreachEmails.id, outreachEmailId))

    await db.update(campaignLeads)
        .set({
            status: 'bounced',
            nextScheduledAt: null,
            updatedAt: now
        })
        .where(eq(campaignLeads.id, campaignLeadId))

    await db.update(leads)
        .set({
            status: 'bounced',
            updatedAt: now
        })
        .where(eq(leads.id, leadId))

    await db.update(campaigns)
        .set({
            totalBounces: sql`${campaigns.totalBounces} + 1`,
            updatedAt: now
        })
        .where(eq(campaigns.id, campaignId))

    await db.update(emailAccounts)
        .set({
            totalBounces: sql`${emailAccounts.totalBounces} + 1`,
            updatedAt: now
        })
        .where(eq(emailAccounts.id, accountId))

    // P0-07: Hard bounces go into the org-level suppression list so we never re-mail them
    // from any future campaign in this org. The pattern matches the audit's heuristic
    // (audit P0-07, fix sugerido). Mirrors the unsubscribe-path insert in unsubscribe.ts
    // (Plan 14-05) that already covers source='unsubscribe'.
    const isHardBounce = /permanent|hard|550|551|553|user unknown|no such user|address not found|mailbox unavailable|does not exist|recipient rejected|invalid recipient/i.test(reason)
    if (isHardBounce) {
        const lead = await db.query.leads.findFirst({
            where: eq(leads.id, leadId),
            columns: { email: true },
        })
        if (lead) {
            await db.insert(suppressions).values({
                organizationId,
                emailAddress: lead.email.toLowerCase(),
                source: 'bounce',
                reason: reason.slice(0, 500),  // cap to avoid pathological inputs
            }).onConflictDoNothing()
        }
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
}

export async function processBounces(): Promise<{ processed: number; bounces: number; errors: number }> {
    const result = { processed: 0, bounces: 0, errors: 0 }

    const accounts = await db.query.emailAccounts.findMany({
        where: and(
            eq(emailAccounts.status, 'verified'),
            isNotNull(emailAccounts.imapHost),
            isNotNull(emailAccounts.imapUsername),
            isNotNull(emailAccounts.imapPassword)
        )
    })

    for (const account of accounts) {
        let client: ImapFlow | null = null

        try {
            const password = decryptSecret(account.imapPassword!)

            client = new ImapFlow({
                host: account.imapHost!,
                port: account.imapPort || 993,
                secure: account.imapSecure !== false,
                auth: {
                    user: account.imapUsername!,
                    pass: password
                },
                logger: false
            })

            await client.connect()

            const lock = await client.getMailboxLock('INBOX')
            
            try {
                const messages = await client.search({
                    or: [
                        { from: 'mailer-daemon' },
                        { from: 'postmaster' },
                        { from: 'bounce@' },
                        { from: 'bounces@' }
                    ]
                }, { uid: true })

                if (!messages) return { processed: 0, bounces: 0, errors: 0 };
                for (const uid of messages) {
                    try {
                        const message = await client.fetchOne(uid, { source: true })
                        if (!message || typeof message === "boolean" || !("source" in message)) continue

                        const parsed = await simpleParser((message as any).source)

                        if (!isBounceEmail((parsed as any).from?.text || '', (parsed as any).subject || '')) {
                            continue
                        }

                        result.processed++

                        const bounceInfo = parseBounceMessage(parsed as any)

                        if (!bounceInfo.recipientEmail) {
                            log.warn({ action: 'outreach.bounce.parse_failed_no_recipient' }, 'could not extract recipient from bounce')
                            continue
                        }

                        let outreachEmail = bounceInfo.originalMessageId
                            ? await findOutreachEmailByMessageId(bounceInfo.originalMessageId)
                            : null

                        if (!outreachEmail) {
                            outreachEmail = await findOutreachEmailByRecipient(
                                bounceInfo.recipientEmail,
                                account.id
                            )
                        }

                        if (!outreachEmail) {
                            log.warn({
                                action: 'outreach.bounce.unmatched',
                                recipientEmail: bounceInfo.recipientEmail,
                                emailAccountId: account.id,
                            }, 'no outreach email matched bounce recipient')
                            continue
                        }

                        const campaignLead = await db.query.campaignLeads.findFirst({
                            where: eq(campaignLeads.id, outreachEmail.campaignLeadId),
                            with: { lead: true }
                        })

                        if (!campaignLead?.lead) {
                            log.warn({
                                action: 'outreach.bounce.campaign_lead_missing',
                                outreachEmailId: outreachEmail.id,
                            }, 'campaign lead row missing for bounce target')
                            continue
                        }

                        if (campaignLead.status === 'bounced') {
                            continue
                        }

                        const fullReason = bounceInfo.diagnosticCode
                            ? `${bounceInfo.reason} (${bounceInfo.diagnosticCode})`
                            : bounceInfo.reason

                        await markAsBounced(
                            outreachEmail.id,
                            campaignLead.id,
                            campaignLead.lead.id,
                            outreachEmail.campaignId,
                            account.id,
                            outreachEmail.organizationId,
                            fullReason
                        )

                        result.bounces++

                        try {
                            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
                        } catch {
                            // Ignore flag errors
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error))
                        log.error({
                            action: 'outreach.bounce.message_error',
                            uid,
                            emailAccountId: account.id,
                            error: { message: err.message, stack: err.stack },
                        }, 'failed to process bounce message')
                        result.errors++
                    }
                }
            } finally {
                lock.release()
            }
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            log.error({
                action: 'outreach.bounce.account_error',
                emailAccountId: account.id,
                email: account.email,
                error: { message: err.message, stack: err.stack },
            }, 'account bounce-processing failed')
            result.errors++
        } finally {
            if (client) {
                try {
                    await client.logout()
                } catch {
                    // Ignore logout errors
                }
            }
        }
    }

    await db.update(emailAccounts)
        .set({ lastSyncAt: new Date() })
        .where(isNotNull(emailAccounts.imapHost))

    return result
}

export async function processBounceFromWebhook(data: {
    recipientEmail: string
    messageId?: string
    reason: string
    bounceType: 'hard' | 'soft'
}): Promise<void> {
    const { recipientEmail, messageId, reason, bounceType } = data

    let outreachEmail: typeof outreachEmails.$inferSelect | null = null

    if (messageId) {
        outreachEmail = await findOutreachEmailByMessageId(messageId)
    }

    if (!outreachEmail) {
        const allAccounts = await db.query.emailAccounts.findMany({
            where: eq(emailAccounts.status, 'verified')
        })

        for (const account of allAccounts) {
            outreachEmail = await findOutreachEmailByRecipient(recipientEmail, account.id)
            if (outreachEmail) break
        }
    }

    if (!outreachEmail) {
        log.warn({
            action: 'outreach.bounce.webhook_unmatched',
            recipientEmail,
        }, 'no outreach email matched webhook bounce')
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

    if (campaignLead.status === 'bounced') {
        return
    }

    const fullReason = `${bounceType.toUpperCase()}: ${reason}`

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
