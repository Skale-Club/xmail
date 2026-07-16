/**
 * Outreach Email Sender
 * Handles sending outreach emails through SMTP or Outlook OAuth
 */

import nodemailer from 'nodemailer'
import { db } from '../../db'
import { campaigns, sequenceSteps, campaignLeads, leads, emailAccounts } from '../../db/schema'
import { eq, sql } from 'drizzle-orm'
import { decryptSecret } from './crypto'
import { interpolateTemplate, type LeadForTemplate } from './template-variables'
import { injectTracking } from './tracking'
import { sendMessageWithOutlook } from './outlook'
import { generateUnsubscribeLink } from '../routes/outreach/unsubscribe'
import { relayMessage, storeMessage, getNativeMailboxByEmail } from './native-send'
import {
    normalizeProviderFailure,
    type ProviderAcceptance,
    type ProviderFailure,
} from './outreach-dispatch'

interface SendOutreachEmailParams {
    account: typeof emailAccounts.$inferSelect
    lead: typeof leads.$inferSelect
    campaign: typeof campaigns.$inferSelect
    step: typeof sequenceSteps.$inferSelect
    campaignLeadId: string
    trackingToken: string
    trackOpens?: boolean
    trackClicks?: boolean
    trackingBaseUrl?: string
    abVariant?: 'a' | 'b'
    stableMessageId?: string
}

type SendResult =
    | {
        success: true
        acceptance: 'accepted'
        messageId?: string
        finalHtml?: string
        finalText?: string
        trackingToken?: string
    }
    | {
        success: false
        acceptance: Exclude<ProviderAcceptance, 'accepted'>
        failure: ProviderFailure
        error: string
        messageId?: undefined
        finalHtml?: undefined
        finalText?: undefined
        trackingToken?: undefined
    }

export function createSmtpTransporter(account: typeof emailAccounts.$inferSelect): nodemailer.Transporter {
    if (!account.smtpHost || !account.smtpPassword || !account.smtpUsername) {
        throw new Error('SMTP account missing required fields')
    }
    
    const decryptedPassword = decryptSecret(account.smtpPassword)

    return nodemailer.createTransport({
        host: account.smtpHost,
        port: account.smtpPort || 587,
        secure: account.smtpSecure ?? true,
        auth: {
            user: account.smtpUsername,
            pass: decryptedPassword,
        },
    })
}

export function isWithinSendWindow(campaign: typeof campaigns.$inferSelect, now: Date): boolean {
    const zoned = getZonedDateParts(now, campaign.timezone)
    const dayOfWeek = zoned.weekday
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6

    if (isWeekend && !campaign.sendOnWeekends) {
        return false
    }

    const currentTimeMinutes = zoned.hour * 60 + zoned.minute

    const parseTime = (timeStr: string): number => {
        const [hours, minutes] = timeStr.split(':').map(Number)
        return hours * 60 + (minutes || 0)
    }

    const startTimeMinutes = parseTime(campaign.sendStartTime)
    const endTimeMinutes = parseTime(campaign.sendEndTime)

    return currentTimeMinutes >= startTimeMinutes && currentTimeMinutes <= endTimeMinutes
}

function getZonedDateParts(date: Date, timeZone: string): { weekday: number; hour: number; minute: number } {
    let parts: Intl.DateTimeFormatPart[]
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone || 'UTC',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date)
    } catch {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'UTC',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date)
    }

    const value = (type: string) => parts.find(part => part.type === type)?.value
    const weekdays: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    }

    return {
        weekday: weekdays[value('weekday') || 'Sun'] ?? 0,
        hour: Number(value('hour') || 0),
        minute: Number(value('minute') || 0),
    }
}

export function getEffectiveDailySendLimit(account: typeof emailAccounts.$inferSelect): number {
    const fullLimit = Math.max(1, account.dailySendLimit)
    if (!account.warmupEnabled) return fullLimit

    const warmupDays = Math.max(1, account.warmupDays)
    const currentDay = Math.max(0, Math.min(account.warmupCurrentDay, warmupDays))
    if (currentDay >= warmupDays) return fullLimit

    const startLimit = Math.min(5, fullLimit)
    const progress = currentDay / warmupDays
    return Math.max(1, Math.min(fullLimit, Math.ceil(startLimit + (fullLimit - startLimit) * progress)))
}

export function canSendFromAccount(
    account: typeof emailAccounts.$inferSelect,
    now: Date = new Date()
): boolean {
    if (account.status !== 'verified') {
        return false
    }

    if (account.currentDailySent >= getEffectiveDailySendLimit(account)) {
        return false
    }

    // Phase 16 — INBOX-THROTTLE: per-inbox min-spacing enforcement.
    // lastSentAt is null on never-sent accounts (post-migration-021 default), in which
    // case the throttle is inapplicable. When set, require min*60s elapsed since the
    // last send before the next send can be claimed by processOutreachSequences.
    if (account.lastSentAt) {
        const minMs = account.minMinutesBetweenEmails * 60_000
        const earliestNextSend = account.lastSentAt.getTime() + minMs
        if (earliestNextSend > now.getTime()) {
            return false
        }
    }

    // P004 — human-rhythm macro-pacing (opt-in). During a "break" segment no sends leave this
    // inbox, so bursts of activity are separated by realistic gaps instead of a metronome.
    if (!isWithinSendRhythm(account, now)) {
        return false
    }

    return true
}

/** Deterministic [0,1) hash (xfnv1a) — same seed → same value, no shared state. */
function rhythmRand(seed: string): number {
    let h = 2166136261 >>> 0
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i)
        h = Math.imul(h, 16777619)
    }
    return ((h >>> 0) % 100000) / 100000
}

/**
 * P004 — human-rhythm macro-pacing. Opt-in via OUTREACH_HUMAN_RHYTHM=true (default off → always
 * true, no behaviour change). When on, each inbox's day is a deterministic sequence of burst
 * (45–65 min, sends allowed) and break (10–20 min, no sends) segments, seeded by the inbox id so
 * inboxes desync. Stateless: derivable from (accountId, UTC day, now) on any tick.
 */
export function isWithinSendRhythm(
    account: typeof emailAccounts.$inferSelect,
    now: Date = new Date()
): boolean {
    if (process.env.OUTREACH_HUMAN_RHYTHM !== 'true') return true

    const day = now.toISOString().slice(0, 10)
    const minutesIntoDay = now.getUTCHours() * 60 + now.getUTCMinutes()

    let cursor = 0
    for (let i = 0; i < 48; i++) {
        const burst = 45 + rhythmRand(`${account.id}:${day}:${i}:b`) * 20
        const brk = 10 + rhythmRand(`${account.id}:${day}:${i}:k`) * 10
        if (minutesIntoDay < cursor + burst) return true       // inside a burst
        if (minutesIntoDay < cursor + burst + brk) return false // inside a break
        cursor += burst + brk
    }
    return true
}

/**
 * Phase 16 — INBOX-THROTTLE: compute a jittered "next eligible send" timestamp.
 * Returns a Date in the future, offset by a uniform-random number of MINUTES in
 * [min, max). Used by processOutreachSequences (Plan 16-02) to spread out the
 * `nextScheduledAt` of pending leads on the same campaign/inbox so they do not
 * all become eligible at the same cron tick.
 *
 * Degenerate range (min === max) returns exactly `min` minutes in the future.
 * Caller is responsible for clamping min/max to sane values (schema defaults
 * are min=5, max=30 per email_accounts.minMinutesBetweenEmails column).
 */
export function applySendJitter(min: number, max: number, now: Date = new Date()): Date {
    const lo = Math.max(0, min)
    const hi = Math.max(lo, max)
    const minutes = lo + Math.random() * (hi - lo)
    return new Date(now.getTime() + minutes * 60_000)
}

export function getNextStepForLead(
    campaignLead: typeof campaignLeads.$inferSelect,
    steps: (typeof sequenceSteps.$inferSelect)[]
): (typeof sequenceSteps.$inferSelect) | null {
    const sortedSteps = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const nextStep = sortedSteps.find(step => step.stepOrder > campaignLead.currentStepOrder)
    return nextStep || null
}

export function calculateNextScheduledAt(step: typeof sequenceSteps.$inferSelect): Date {
    const nextDate = new Date()
    nextDate.setHours(nextDate.getHours() + step.delayHours)
    return nextDate
}

export async function sendOutreachEmail(params: SendOutreachEmailParams): Promise<SendResult> {
    const { account, lead, campaign, step, campaignLeadId, trackingToken, trackOpens, trackClicks, trackingBaseUrl, abVariant, stableMessageId } = params

    try {
        const subjectTemplate = abVariant === 'b' && step.subjectB ? step.subjectB : step.subject
        const htmlTemplate = abVariant === 'b' && step.htmlBodyB ? step.htmlBodyB : step.htmlBody
        const plainTemplate = abVariant === 'b' && step.plainBodyB ? step.plainBodyB : step.plainBody

        const baseUrl = trackingBaseUrl || process.env.FRONTEND_URL || 'http://localhost:9000'
        const unsubscribeUrl = generateUnsubscribeLink(campaignLeadId, campaign.id, baseUrl)
        // Phase 15.1 fix: trackingToken is now passed from the caller (processor) so the token
        // injected into the email HTML matches the one persisted in outreach_emails.tracking_token.
        // Previously the sender generated its own token (always different from the processor's claim
        // token), causing track.ts lookups to silently miss and opens/clicks to stay at 0%.

        const leadForTemplate: LeadForTemplate = {
            email: lead.email,
            firstName: lead.firstName,
            lastName: lead.lastName,
            companyName: lead.companyName,
            companySize: lead.companySize,
            industry: lead.industry,
            title: lead.title,
            website: lead.website,
            linkedinUrl: lead.linkedinUrl,
            phone: lead.phone,
            location: lead.location,
            customFields: lead.customFields as Record<string, any> | null,
        }

        // P0-03: {{unsubscribeUrl}} resolves via the template context (Plan 14-05 added support in template-variables.ts).
        const tplContext = { unsubscribeUrl }
        const subject = interpolateTemplate(subjectTemplate || '', leadForTemplate, tplContext)
        // audit-2026-07: HTML-escape lead-derived values in the HTML body only — subject and
        // plain-text renders must stay unescaped or they'd show literal entities.
        let html = htmlTemplate ? interpolateTemplate(htmlTemplate, leadForTemplate, tplContext, { escapeHtml: true }) : undefined
        const text = plainTemplate ? interpolateTemplate(plainTemplate, leadForTemplate, tplContext) : undefined

        if (html && (trackOpens || trackClicks)) {
            // Use the signed HMAC tracking token (NOT the raw campaignLeadId) so /t/open/:token
            // and /t/click/:token can lookup outreach_emails.tracking_token (see Plan 14-05 track.ts edit).
            html = injectTracking(html, trackingToken, baseUrl, trackOpens ?? false, trackClicks ?? false)
        }

        // P0-03: Inject List-Unsubscribe headers for Gmail/Yahoo bulk-sender compliance (RFC 8058 one-click).
        // Build the mailto fallback from the campaign's reply-to domain, else fall back to MAIL_DOMAIN env.
        const replyToDomain = campaign.replyToEmail?.split('@')[1] || process.env.MAIL_DOMAIN || 'example.com'
        const headers: Record<string, string> = {
            'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@${replyToDomain}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }

        if (account.provider === 'outlook' && account.outlookMailboxId) {
            // NOTE: sendMessageWithOutlook does not currently accept arbitrary headers (Graph API
            // limits header customization). List-Unsubscribe via Outlook is a known P1 limitation
            // documented in deferred ideas (phase 15). For SMTP accounts the headers go through.
            await sendMessageWithOutlook({
                organizationId: account.organizationId,
                mailboxId: account.outlookMailboxId,
                fromAddress: account.email,
                to: [lead.email],
                subject,
                htmlBody: html,
                plainBody: text,
            })

            return {
                success: true,
                acceptance: 'accepted',
                finalHtml: html,
                finalText: text,
                trackingToken,
            }
        }

        const fromName = campaign.fromName || account.displayName || ''
        const fromAddress = fromName ? `"${fromName}" <${account.email}>` : account.email

        const mailOptions: nodemailer.SendMailOptions = {
            from: fromAddress,
            to: lead.email,
            subject,
            html,
            text,
            replyTo: campaign.replyToEmail || undefined,
            headers,
            messageId: stableMessageId,
        }

        if (account.provider === 'native') {
            // No stored SMTP credentials — compose the same MIME content via nodemailer's
            // stream composer (buffered, never touches the network) to get a raw buffer +
            // an auto-generated Message-ID identical in shape to the one the SMTP path
            // relies on, then relay it through the platform's internal DKIM-signed relay
            // and file a copy in the account owner's native Sent folder. Reply/bounce
            // matching (processReplies.ts / processBounces.ts) key off this same
            // Message-ID, exactly as they do for the SMTP path's info.messageId.
            const nativeMailbox = await getNativeMailboxByEmail(account.email)
            if (!nativeMailbox) {
                return {
                    success: false,
                    acceptance: 'rejected',
                    error: 'Native mailbox not found for outreach account — was it deleted?',
                    failure: {
                        code: 'native_mailbox_missing',
                        classification: 'terminal',
                        acceptance: 'rejected',
                        retryable: false,
                        message: 'Native mailbox not found for outreach account',
                    },
                }
            }

            const composer = nodemailer.createTransport({ streamTransport: true, buffer: true })
            const composed = await composer.sendMail(mailOptions)
            const rawBuffer = composed.message as Buffer
            const generatedMessageId = composed.messageId as string

            await relayMessage(account.email, [lead.email], rawBuffer)

            try {
                await storeMessage(nativeMailbox.id, 'sent', {
                    messageId: generatedMessageId,
                    subject,
                    fromAddress: account.email,
                    fromName: account.displayName || null,
                    toAddresses: [{ address: lead.email, name: null }],
                    ccAddresses: [],
                    bccAddresses: [],
                    plainBody: text,
                    htmlBody: html,
                    hasAttachments: false,
                    attachments: [],
                }, true)
            } catch (storeErr) {
                // Filing the Sent-folder copy is best-effort — the message was already
                // relayed successfully, so a filing failure should not fail the send
                // (matches how the SMTP path never fails a send over IMAP-append issues).
                console.warn('[Outreach:Native] Failed to file Sent copy:', storeErr instanceof Error ? storeErr.message : storeErr)
            }

            return {
                success: true,
                acceptance: 'accepted',
                messageId: generatedMessageId,
                finalHtml: html,
                finalText: text,
                trackingToken,
            }
        }

        const transporter = createSmtpTransporter(account)
        const info = await transporter.sendMail(mailOptions)

        return {
            success: true,
            acceptance: 'accepted',
            messageId: info.messageId,
            finalHtml: html,
            finalText: text,
            trackingToken,
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error sending email'
        const normalized = normalizeProviderFailure(error)
        return {
            success: false,
            acceptance: normalized.acceptance,
            error: errorMessage,
            failure: normalized,
        }
    }
}

interface ThreadedReplyParams {
    account: typeof emailAccounts.$inferSelect
    to: string
    subject: string
    text: string
    html?: string
    fromName?: string | null
    replyTo?: string | null
    /** Message-ID this reply threads under (In-Reply-To + References). */
    inReplyTo?: string | null
}

/**
 * Agentic follow-up (P002) — send a threaded reply in an existing conversation.
 * Unlike sendOutreachEmail this carries no sequence-step template: the body comes from the
 * follow-up decider. Threading headers keep it in the same mail thread. SMTP only for now
 * (Outlook path parity is deferred, matching sendOutreachEmail's known limitation).
 */
export async function sendThreadedReply(params: ThreadedReplyParams): Promise<SendResult> {
    const { account, to, subject, text, html, fromName, replyTo, inReplyTo } = params
    try {
        const headers: Record<string, string> = {}
        if (inReplyTo) {
            const bracketed = inReplyTo.startsWith('<') ? inReplyTo : `<${inReplyTo}>`
            headers['In-Reply-To'] = bracketed
            headers['References'] = bracketed
        }

        const displayName = fromName || account.displayName || ''
        const fromAddress = displayName ? `"${displayName}" <${account.email}>` : account.email

        const mailOptions: nodemailer.SendMailOptions = {
            from: fromAddress,
            to,
            subject,
            text,
            html,
            replyTo: replyTo || undefined,
            headers,
        }

        if (account.provider === 'native') {
            // Mirrors the native branch of sendOutreachEmail: native accounts hold no SMTP
            // credentials, so compose the MIME buffer offline and hand it to the internal
            // DKIM-signing relay, then file the Sent copy. Reply/bounce matching keys off
            // this generated Message-ID exactly as it does for the SMTP path.
            const nativeMailbox = await getNativeMailboxByEmail(account.email)
            if (!nativeMailbox) {
                return {
                    success: false,
                    acceptance: 'rejected',
                    error: 'Native mailbox not found for outreach account — was it deleted?',
                    failure: {
                        code: 'native_mailbox_missing',
                        classification: 'terminal',
                        acceptance: 'rejected',
                        retryable: false,
                        message: 'Native mailbox not found for outreach account',
                    },
                }
            }

            const composer = nodemailer.createTransport({ streamTransport: true, buffer: true })
            const composed = await composer.sendMail(mailOptions)
            const rawBuffer = composed.message as Buffer
            const generatedMessageId = composed.messageId as string

            await relayMessage(account.email, [to], rawBuffer)

            try {
                await storeMessage(nativeMailbox.id, 'sent', {
                    messageId: generatedMessageId,
                    subject,
                    fromAddress: account.email,
                    fromName: account.displayName || null,
                    toAddresses: [{ address: to, name: null }],
                    ccAddresses: [],
                    bccAddresses: [],
                    plainBody: text,
                    htmlBody: html,
                    hasAttachments: false,
                    attachments: [],
                }, true)
            } catch (storeErr) {
                // Best-effort, as in sendOutreachEmail — the reply was already relayed.
                console.warn('[Outreach:Native] Failed to file Sent copy for threaded reply:', storeErr instanceof Error ? storeErr.message : storeErr)
            }

            return {
                success: true,
                acceptance: 'accepted',
                messageId: generatedMessageId,
                finalHtml: html,
                finalText: text,
            }
        }

        const transporter = createSmtpTransporter(account)
        const info = await transporter.sendMail(mailOptions)

        return {
            success: true,
            acceptance: 'accepted',
            messageId: info.messageId ? info.messageId.replace(/[<>]/g, '').trim() : undefined,
            finalHtml: html,
            finalText: text,
        }
    } catch (error) {
        const normalized = normalizeProviderFailure(error)
        return {
            success: false,
            acceptance: normalized.acceptance,
            error: error instanceof Error ? error.message : 'Unknown error sending reply',
            failure: normalized,
        }
    }
}

export async function updateCampaignLeadProgress(
    campaignLeadId: string,
    nextStep: typeof sequenceSteps.$inferSelect,
    nextScheduledAt: Date
): Promise<void> {
    await db.update(campaignLeads)
        .set({
            currentStepId: nextStep.id,
            currentStepOrder: nextStep.stepOrder,
            nextScheduledAt,
            status: 'contacted',
            lastContactedAt: new Date(),
            updatedAt: new Date(),
        })
        .where(eq(campaignLeads.id, campaignLeadId))
}

export async function updateLeadStatus(
    leadId: string,
    status: typeof leads.$inferSelect['status']
): Promise<void> {
    await db.update(leads)
        .set({
            status,
            updatedAt: new Date(),
        })
        .where(eq(leads.id, leadId))
}

export async function incrementAccountStats(
    accountId: string,
    field: 'totalSent' | 'totalOpens' | 'totalClicks' | 'totalReplies' | 'totalBounces' | 'currentDailySent'
): Promise<void> {
    const updateData: Record<string, any> = {
        updatedAt: new Date(),
    }

    if (field === 'currentDailySent') {
        updateData[field] = sql`${emailAccounts[field]} + 1`
        updateData.lastSentAt = new Date()
    } else if (field === 'totalSent') {
        updateData[field] = sql`${emailAccounts[field]} + 1`
        updateData.currentDailySent = sql`${emailAccounts.currentDailySent} + 1`
        updateData.lastSentAt = new Date()
    } else {
        updateData[field] = sql`${emailAccounts[field]} + 1`
    }

    await db.update(emailAccounts)
        .set(updateData)
        .where(eq(emailAccounts.id, accountId))
}

export async function incrementCampaignStats(
    campaignId: string,
    field: 'totalLeads' | 'leadsContacted' | 'totalOpens' | 'totalClicks' | 'totalReplies' | 'totalBounces' | 'totalUnsubscribes'
): Promise<void> {
    await db.update(campaigns)
        .set({
            [field]: sql`${campaigns[field]} + 1`,
            updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaignId))
}

export type { SendOutreachEmailParams, SendResult }
