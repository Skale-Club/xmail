/**
 * Outreach Email Sender
 *
 * Owns CONTENT: template interpolation, A/B variant selection, tracking injection,
 * unsubscribe URL minting, send windows, warm-up limits and pacing.
 *
 * It does NOT own transport. Since Phase 19 (PROV-03) every provider difference lives in
 * outreach-provider.ts, which composes the message once as MIME and hands the same bytes to
 * SMTP, the native relay, or Outlook Graph. This module used to branch on `account.provider`
 * and build a different message per branch — that is how Outlook lost its List-Unsubscribe
 * headers and its Message-ID.
 */

import { db } from '../../db'
import { campaigns, sequenceSteps, campaignLeads, leads, emailAccounts } from '../../db/schema'
import { eq, sql } from 'drizzle-orm'
import { interpolateTemplate, type LeadForTemplate } from './template-variables'
import { injectTracking } from './tracking'
import { generateUnsubscribeLink } from '../routes/outreach/unsubscribe'
import {
    normalizeProviderFailure,
    type ProviderAcceptance,
    type ProviderFailure,
} from './outreach-dispatch'
import {
    sendComposedOutreachMessage,
    type OutreachProviderDependencies,
    type OutreachUnsubscribeOptions,
} from './outreach-provider'

export { createSmtpTransporter } from './outreach-provider'

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
    /** Test seam forwarded to the provider adapter. Production callers omit it. */
    providerDependencies?: OutreachProviderDependencies
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

        // P0-03: List-Unsubscribe for Gmail/Yahoo bulk-sender compliance (RFC 8058 one-click).
        // Build the mailto fallback from the campaign's reply-to domain, else MAIL_DOMAIN env.
        // Since PROV-03 these reach EVERY provider, Outlook included — the composer, not the
        // transport, decides what headers a campaign carries.
        const replyToDomain = campaign.replyToEmail?.split('@')[1] || process.env.MAIL_DOMAIN || 'example.com'
        const unsubscribe: OutreachUnsubscribeOptions = {
            url: unsubscribeUrl,
            mailto: `unsubscribe@${replyToDomain}?subject=unsubscribe`,
            oneClick: true,
        }

        const result = await sendComposedOutreachMessage(account, {
            from: { address: account.email, name: campaign.fromName || account.displayName || null },
            to: [lead.email],
            subject,
            text,
            html,
            replyTo: campaign.replyToEmail || null,
            messageId: stableMessageId,
            unsubscribe,
        }, params.providerDependencies)

        if (!result.accepted) {
            const failure = result.failure ?? normalizeProviderFailure(new Error('Provider rejected the message'))
            return {
                success: false,
                acceptance: failure.acceptance,
                error: failure.message,
                failure,
            }
        }

        return {
            success: true,
            acceptance: 'accepted',
            messageId: result.messageId,
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
    /** Existing References chain from the inbound message; the parent id is appended to it. */
    references?: string | null
    /** Dispatcher-derived deterministic Message-ID, reused across retries of one attempt. */
    stableMessageId?: string
    /**
     * Unsubscribe metadata. Supplied for campaign-attached (agentic) follow-ups, which are
     * bulk marketing; omitted for one-to-one transactional sends, where a List-Unsubscribe
     * would advertise a list the recipient is not on.
     */
    unsubscribe?: OutreachUnsubscribeOptions | null
    /** Test seam forwarded to the provider adapter. Production callers omit it. */
    providerDependencies?: OutreachProviderDependencies
}

/**
 * Send a threaded reply in an existing conversation (agentic follow-up P002, and manual
 * one-to-one sends). Unlike sendOutreachEmail this carries no sequence-step template — the
 * body comes from the caller. Threading headers keep it in the same mail thread.
 *
 * Since PROV-03 this works for every provider, Outlook included: the message is composed once
 * and the adapter chooses the transport.
 */
export async function sendThreadedReply(params: ThreadedReplyParams): Promise<SendResult> {
    const { account, to, subject, text, html, fromName, replyTo, inReplyTo, references, stableMessageId } = params
    try {
        const result = await sendComposedOutreachMessage(account, {
            from: { address: account.email, name: fromName || account.displayName || null },
            to: [to],
            subject,
            text,
            html,
            replyTo: replyTo || null,
            messageId: stableMessageId,
            inReplyTo,
            references,
            unsubscribe: params.unsubscribe ?? null,
        }, params.providerDependencies)

        if (!result.accepted) {
            const failure = result.failure ?? normalizeProviderFailure(new Error('Provider rejected the reply'))
            return {
                success: false,
                acceptance: failure.acceptance,
                error: failure.message,
                failure,
            }
        }

        return {
            success: true,
            acceptance: 'accepted',
            messageId: result.messageId,
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
