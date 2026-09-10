/**
 * Process Bounced Outreach Emails
 *
 * Phase 19 (PROV-04): this job no longer scans inboxes. It consumes durable
 * outreach_provider_events rows already classified 'bounce' at ingestion, then:
 * - Parses bounce messages (DSN - Delivery Status Notification), classifying hard vs soft
 * - HARD bounce: updates outreach_emails with bounce info, campaign_leads.status and
 *   leads.status to 'bounced', increments bounce stats, suppresses the address org-wide
 * - SOFT bounce (mailbox full, greylisted, rate-limited, ...): does NOT touch
 *   campaign_leads.status or leads.status — the mailbox may still recover. Records the bounce
 *   on the specific outreach_email and reschedules campaign_leads.next_scheduled_at with a
 *   backoff (4h / 24h / 72h). After `SOFT_BOUNCE_GIVE_UP_AFTER` (3) soft bounces on the same
 *   campaign_lead, gives up and applies the hard-bounce path instead — see `markAsSoftBounced`.
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
import { eq, and, ne, sql, desc, count } from 'drizzle-orm'
import { createLogger } from '../lib/logger'
import { sendXphereOutreachEvent } from '../lib/xphere-events'
import { shouldNotifyOutreachEvent } from '../lib/outreach-settings'
import { JOB_TIMEOUT_BUDGETS_MS, runWithLock } from '../lib/cron-lock'
import { sqlTimestamp } from '../lib/sql-timestamp'
import {
    consumeClassifiedEvents,
    createDrizzleInboundEventStore,
    type StoredProviderEvent,
} from '../lib/outreach-inbound'
import { ingestOutreachInboundExclusive } from '../lib/outreach-inbound-sources'
import { TERMINAL_CAMPAIGN_LEAD_STATUSES } from '../lib/outreach-sequence-state'

const log = createLogger('outreach.bounce')

/**
 * Soft-bounce backoff ladder (Task 3). `outreach-dispatch.ts` also has a backoff
 * (`calculateDispatchBackoff`), but that one is for TRANSPORT retries of a single send attempt
 * (seconds-to-minutes scale, capped at 1h) — a different problem from "give a maybe-temporarily
 * full mailbox real time to recover between sequence sends". Kept local to this job rather than
 * imported for that reason; hours, not minutes.
 */
export const SOFT_BOUNCE_BACKOFF_MS = [4, 24, 72].map((hours) => hours * 60 * 60_000)
/** After this many soft bounces on the same campaign_lead, stop believing it will recover. */
export const SOFT_BOUNCE_GIVE_UP_AFTER = SOFT_BOUNCE_BACKOFF_MS.length
/**
 * The marker prefix written into `outreach_emails.bounce_reason` for a soft bounce. It is both
 * the human-readable record AND the only piece of state the soft-bounce counter reads back —
 * there is no dedicated counter column (checked: neither `campaign_leads` nor `leads` has one),
 * so "how many times has this campaign_lead soft-bounced" is answered by counting rows whose
 * `bounce_reason` starts with this prefix, scoped to the campaign_lead.
 */
const SOFT_BOUNCE_MARKER_PREFIX = 'soft_bounce'

function softBounceMarker(occurrence: number, reason: string): string {
    return `${SOFT_BOUNCE_MARKER_PREFIX}(${occurrence}/${SOFT_BOUNCE_GIVE_UP_AFTER}): ${reason}`
}

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
 * Applies a bounce to one campaign_lead, routing to the hard or soft path (Task 3).
 *
 * `bounceType` defaults to `'hard'` — every call site that predates this parameter (including
 * the terminal-state race db-test, which calls this with a plain "mailbox full" reason and no
 * type argument) keeps its exact previous behaviour: an unqualified bounce is a hard bounce.
 * The two real callers below (`handleBounceEvent`, `processBounceFromWebhook`) both know their
 * classification already and pass it through explicitly.
 */
export async function markAsBounced(
    outreachEmailId: string,
    campaignLeadId: string,
    leadId: string,
    campaignId: string,
    accountId: string,
    organizationId: string,
    reason: string,
    bounceType: 'hard' | 'soft' = 'hard',
): Promise<boolean> {
    if (bounceType === 'soft') {
        return markAsSoftBounced(outreachEmailId, campaignLeadId, leadId, campaignId, accountId, organizationId, reason)
    }
    return applyHardBounce(outreachEmailId, campaignLeadId, leadId, campaignId, accountId, organizationId, reason)
}

/**
 * Applies a HARD bounce to one lead. Returns whether this call was the one that transitioned it
 * — false means another DSN got there first and every counter below was already applied.
 *
 * W-2: the caller used to decide that by reading campaign_leads.status and then writing,
 * with nothing between the two. processReplies holds a *different* advisory lock and runs
 * on the same tick, so the CAS in the campaign_leads UPDATE is the only honest gate.
 */
async function applyHardBounce(
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

/**
 * How many soft bounces this campaign_lead has already recorded, per `outreach_emails
 * .bounce_reason` markers written by a prior `markAsSoftBounced` call. There is no dedicated
 * counter column on `campaign_leads` or `leads` (checked both — see the module-level
 * `SOFT_BOUNCE_MARKER_PREFIX` doc comment), so the count is derived by querying the existing
 * per-message bounce records instead of maintaining new state.
 */
async function countPriorSoftBounces(campaignLeadId: string): Promise<number> {
    const [row] = await db
        .select({ value: count() })
        .from(outreachEmails)
        .where(and(
            eq(outreachEmails.campaignLeadId, campaignLeadId),
            sql`${outreachEmails.bounceReason} LIKE ${`${SOFT_BOUNCE_MARKER_PREFIX}(%`}`,
        ))
    return Number(row?.value ?? 0)
}

/** What to do with one incoming soft bounce, given how many the same campaign_lead already has. */
export type SoftBounceOutcome =
    | { type: 'reschedule'; occurrence: number; backoffMs: number; bounceReason: string }
    | { type: 'give_up'; hardBounceReason: string }

/**
 * The pure decision at the heart of soft-bounce handling — kept side-effect-free and exported so
 * the escalation policy (which occurrence gets which backoff, and exactly when to give up) is
 * unit-testable without a database, mirroring how outreach-delivery-policy.ts splits its pure
 * `evaluateOutreachDeliverySnapshot` from its I/O `loadOutreachDeliverySnapshot`.
 */
export function decideSoftBounceOutcome(priorSoftBounces: number, reason: string): SoftBounceOutcome {
    const occurrence = priorSoftBounces + 1
    if (occurrence > SOFT_BOUNCE_GIVE_UP_AFTER) {
        return {
            type: 'give_up',
            // "permanent failure" deliberately matches applyHardBounce's own hard-bounce phrase
            // detector so this transition suppresses the address org-wide exactly like any other
            // hard bounce — a mailbox that has soft-bounced this many times in a row is not
            // meaningfully different from one that hard-bounced outright.
            hardBounceReason: `permanent failure after ${SOFT_BOUNCE_GIVE_UP_AFTER} repeated soft bounces: ${reason}`,
        }
    }
    return {
        type: 'reschedule',
        occurrence,
        backoffMs: SOFT_BOUNCE_BACKOFF_MS[occurrence - 1],
        bounceReason: softBounceMarker(occurrence, reason),
    }
}

/**
 * Applies a SOFT bounce (mailbox full, greylisted, rate-limited, deferred, ...) to one
 * outreach_email. Deliberately does NOT touch `campaign_leads.status` or `leads.status` — the
 * whole point of the hard/soft distinction is that a soft-bounced mailbox may still recover, so
 * killing the lead on the first "mailbox full" would be exactly the bug this task fixes.
 *
 * Instead: record the bounce on this specific message, reschedule `campaign_leads
 * .next_scheduled_at` with an escalating backoff, and — once the same campaign_lead has racked
 * up `SOFT_BOUNCE_GIVE_UP_AFTER` soft bounces (`decideSoftBounceOutcome` above) — stop believing
 * it will recover and fall through to the hard-bounce path instead.
 *
 * Idempotency: unlike the hard path (which CASes on `campaign_leads.status`, since that is what
 * actually changes), nothing on `campaign_leads` is gated here in the reschedule branch. The gate
 * is instead `outreach_emails.status <> 'bounced'` on THIS SPECIFIC message: a replayed DSN for
 * the same already-recorded message returns false without recounting or rescheduling.
 */
async function markAsSoftBounced(
    outreachEmailId: string,
    campaignLeadId: string,
    leadId: string,
    campaignId: string,
    accountId: string,
    organizationId: string,
    reason: string,
): Promise<boolean> {
    const now = new Date()
    const outcome = decideSoftBounceOutcome(await countPriorSoftBounces(campaignLeadId), reason)

    if (outcome.type === 'give_up') {
        return applyHardBounce(
            outreachEmailId,
            campaignLeadId,
            leadId,
            campaignId,
            accountId,
            organizationId,
            outcome.hardBounceReason,
        )
    }

    const marked = await db.update(outreachEmails)
        .set({
            status: 'bounced',
            bouncedAt: now,
            bounceReason: outcome.bounceReason,
            updatedAt: now,
        })
        .where(and(
            eq(outreachEmails.id, outreachEmailId),
            eq(outreachEmails.emailAccountId, accountId),
            eq(outreachEmails.organizationId, organizationId),
            ne(outreachEmails.status, 'bounced'),
        ))
        .returning({ id: outreachEmails.id })

    if (marked.length === 0) return false // replayed DSN for a message already recorded

    const backoffAt = new Date(now.getTime() + outcome.backoffMs)
    // GREATEST(...) extends the schedule out to the backoff floor without ever pulling an
    // already-later next_scheduled_at (e.g. a long explicit delay step) in earlier.
    await db.update(campaignLeads)
        .set({
            nextScheduledAt: sql`GREATEST(COALESCE(${campaignLeads.nextScheduledAt}, ${sqlTimestamp(backoffAt)}), ${sqlTimestamp(backoffAt)})`,
            updatedAt: now,
        })
        .where(and(eq(campaignLeads.id, campaignLeadId), eq(campaignLeads.campaignId, campaignId)))

    log.info({
        action: 'outreach.bounce.soft_detected',
        outreachEmailId,
        campaignId,
        campaignLeadId,
        leadId,
        emailAccountId: accountId,
        organizationId,
        occurrence: outcome.occurrence,
        softBounceLimit: SOFT_BOUNCE_GIVE_UP_AFTER,
        backoffHours: outcome.backoffMs / (60 * 60_000),
        reason: reason.slice(0, 200),
    }, 'soft bounce recorded; rescheduled with backoff, lead status unchanged')

    return true
}

// P0-06 / audit-2026-07 — advisory lock prevents concurrent runs across Node instances.
// Uses runWithLock (cron-lock.ts) so acquire+release share one reserved connection; the
// previous db.execute-on-pool implementation leaked the lock across sessions (see audit H1).
// Inspect held locks: SELECT * FROM pg_locks WHERE locktype='advisory';
const BOUNCE_PROCESSOR_LOCK_NAME = 'outreach-bounces-processor'

export async function runBouncesProcessorWithLock(): Promise<void> {
    // jobs/index.ts schedules this every 30 minutes. 2026-09-04 (Fase 1 TASK 2): previously ran on
    // cron-lock's 10-minute default; retuned to the 30s floor — the 1.6s normal latency measured in
    // production is so far below any reasonable budget that 5x it would be too tight (see
    // JOB_TIMEOUT_BUDGETS_MS in cron-lock.ts for the rule and the full table).
    await runWithLock(BOUNCE_PROCESSOR_LOCK_NAME, async () => {
        await processBounces()
    }, { timeoutMs: JOB_TIMEOUT_BUDGETS_MS.outreachBouncesProcessor })
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
    // nothing. Returns false when an earlier DSN already bounced the lead (hard path) or
    // already recorded this exact message (soft path).
    return markAsBounced(
        outreachEmail.id,
        campaignLead.id,
        campaignLead.lead.id,
        outreachEmail.campaignId,
        event.emailAccountId,
        outreachEmail.organizationId,
        fullReason,
        bounceInfo.bounceType,
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

    // Same reasoning as the event path: the CAS inside markAsBounced (hard) / the
    // outreach_emails status guard (soft) is the idempotency gate. `bounceType` is passed
    // through as given by the calling provider webhook rather than re-derived from `reason`
    // text — it already carries a first-class classification, unlike the DSN text-parsing path.
    await markAsBounced(
        outreachEmail.id,
        campaignLead.id,
        campaignLead.lead.id,
        outreachEmail.campaignId,
        outreachEmail.emailAccountId,
        outreachEmail.organizationId,
        reason,
        bounceType,
    )
}
