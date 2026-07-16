/**
 * Process Replies to Outreach Emails
 *
 * Phase 19 (PROV-04): this job no longer scans inboxes. Ingestion happens once, in
 * outreach-inbound.ts, which stages every inbound message as a durable
 * outreach_provider_events row with exactly one classification. This job now:
 * - Claims unprocessed events classified 'reply' (and tags 'auto_reply' events)
 * - Matches them to sent outreach emails via Message-ID / In-Reply-To / from-address
 * - Updates outreach_emails.repliedAt
 * - Updates campaign_leads.status to 'replied' (stops sequence)
 * - Updates leads.status and leads.lastRepliedAt
 * - Increments campaign and account reply stats
 *
 * Why the change: this job used to read unread mail and mark it \Seen/isRead. A DSN
 * carries In-Reply-To pointing at the original outreach email, so a bounce could be
 * matched here as a reply and marked read — after which processBounces, which only
 * looked at unread mail, never saw it. The classification order (DSN before reply)
 * now lives at ingestion, and the two jobs consume disjoint classifications.
 */

import { db } from '../../db'
import { emailAccounts, outreachEmails, campaignLeads, leads, campaigns } from '../../db/schema'
import { eq, and, sql, gte } from 'drizzle-orm'
import { createLogger } from '../lib/logger'
import { sendXphereOutreachEvent } from '../lib/xphere-events'
import { runWithLock } from '../lib/cron-lock'
import {
    consumeClassifiedEvents,
    createDrizzleInboundEventStore,
    type StoredProviderEvent,
} from '../lib/outreach-inbound'
import { ingestOutreachInbound } from '../lib/outreach-inbound-sources'

const log = createLogger('outreach.replies')

interface ProcessRepliesResult {
    /** Reply-classified events claimed this tick. */
    processed: number
    replies: number
    errors: number
}

interface OutreachEmailWithRelations {
    id: string
    organizationId: string
    campaignLeadId: string
    campaignId: string
    emailAccountId: string
    leadId: string
}

const MAX_REPLY_CONTEXT_LENGTH = 20_000

function normalizeInboundMessageId(messageId: string | null | undefined, fallback: string): string {
    const normalized = messageId?.replace(/[<>]/g, '').trim()
    return (normalized || fallback).slice(0, 500)
}

function normalizeReplyText(text: string | null | undefined, html?: string | false | null): string {
    const source = text?.trim() || (typeof html === 'string'
        ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : '')
    return source.slice(0, MAX_REPLY_CONTEXT_LENGTH)
}

// P0-06 / audit-2026-07 — advisory lock prevents concurrent runs across Node instances.
// Uses runWithLock (cron-lock.ts) so acquire+release share one reserved connection; the
// previous db.execute-on-pool implementation leaked the lock across sessions (see audit H1).
// Inspect held locks: SELECT * FROM pg_locks WHERE locktype='advisory';
const REPLY_PROCESSOR_LOCK_NAME = 'outreach-replies-processor'

export async function runRepliesProcessorWithLock(): Promise<void> {
    await runWithLock(REPLY_PROCESSOR_LOCK_NAME, async () => {
        await processReplies()
    })
}

export async function processReplies(): Promise<ProcessRepliesResult> {
    const result: ProcessRepliesResult = {
        processed: 0,
        replies: 0,
        errors: 0,
    }

    const store = createDrizzleInboundEventStore()

    // Stage first. Either job may be first on a tick, and neither may consume a
    // classification that was never staged. Ingestion is cursor-driven and
    // deduplicated, so running it from both jobs stages nothing twice.
    const ingested = await ingestOutreachInbound({ store })
    result.errors += ingested.errors

    // Auto-replies are tagged but never stop the sequence — same behaviour as before,
    // except the decision was already made once at ingestion instead of being
    // re-derived here from raw headers.
    const auto = await consumeClassifiedEvents({
        store,
        classification: 'auto_reply',
        handle: handleAutoReplyEvent,
    })
    result.errors += auto.failed

    const replies = await consumeClassifiedEvents({
        store,
        classification: 'reply',
        handle: async (event) => {
            const matched = await handleReplyEvent(event)
            if (matched) result.replies++
        },
    })
    result.processed = replies.claimed
    result.errors += replies.failed

    return result
}

/**
 * A reply event is matched to its outreach email and stamped. The event was already
 * classified 'reply' at ingestion, so a DSN can never arrive here.
 */
async function handleReplyEvent(event: StoredProviderEvent): Promise<boolean> {
    const matched = await matchReplyToOutreach(
        {
            inReplyTo: event.inReplyTo,
            references: event.messageReferences,
            fromAddress: event.fromAddress,
        },
        event.emailAccountId,
    )

    if (!matched) {
        log.info({
            action: 'outreach.replies.match',
            decision: 'unmatched',
            emailAccountId: event.emailAccountId,
            provider: event.provider,
            hasInReplyTo: event.inReplyTo !== null,
            hasReferences: event.messageReferences !== null,
            hasFrom: event.fromAddress !== null,
        }, 'message did not match any outreach email')
        // The event stays in outreach_provider_events for Phase 21 rather than being
        // discarded; unmatched human mail is still real mail.
        return false
    }

    await markAsReplied(
        matched.outreachEmail.id,
        matched.outreachEmail.campaignLeadId,
        matched.outreachEmail.leadId,
        matched.outreachEmail.campaignId,
        matched.outreachEmail.emailAccountId,
        matched.outreachEmail.organizationId,
        {
            messageId: normalizeInboundMessageId(event.messageId, `event:${event.id}`),
            // Full bodies are staged now, so last_reply_text is finally populated for
            // external accounts — the old IMAP path fetched headers only and left it null.
            text: normalizeReplyText(event.textBody, event.htmlBody),
        },
    )

    log.info({
        action: 'outreach.replies.match',
        decision: 'replied',
        matchStrategy: matched.strategy,
        emailAccountId: event.emailAccountId,
        provider: event.provider,
        campaignId: matched.outreachEmail.campaignId,
        leadId: matched.outreachEmail.leadId,
        campaignLeadId: matched.outreachEmail.campaignLeadId,
    }, 'reply matched and marked')

    return true
}

async function handleAutoReplyEvent(event: StoredProviderEvent): Promise<void> {
    const matched = await matchReplyToOutreach(
        {
            inReplyTo: event.inReplyTo,
            references: event.messageReferences,
            fromAddress: event.fromAddress,
        },
        event.emailAccountId,
    )

    if (matched) {
        await markAsAutoReply(matched.outreachEmail.id)
        log.info({
            action: 'outreach.replies.match',
            decision: 'auto_reply',
            matchStrategy: matched.strategy,
            emailAccountId: event.emailAccountId,
            provider: event.provider,
            campaignId: matched.outreachEmail.campaignId,
            leadId: matched.outreachEmail.leadId,
            campaignLeadId: matched.outreachEmail.campaignLeadId,
        }, 'auto-reply matched to outreach email')
        return
    }

    log.info({
        action: 'outreach.replies.match',
        decision: 'auto_reply',
        matchStrategy: 'unmatched',
        emailAccountId: event.emailAccountId,
        provider: event.provider,
    }, 'auto-reply not matched')
}

function _extractFirstReference(references: string | null): string | null {
    if (!references) return null
    const refs = references.split(/\s+/).filter(Boolean)
    return refs.length > 0 ? refs[0] : null
}

// Phase 16 — AUTO-REPLY-FILTER. The OOO subject regex covers EN + PT + ES because
// SkaleClub's target users may run multi-lingual lead lists. Err on stricter side:
// false negatives (missing an OOO) are recoverable — the lead is just paused for the
// next step — whereas false positives (treating a real reply as OOO) lose conversion.
const OOO_SUBJECT_RE = /^(re:\s*)?(out of office|auto[- ]?reply|automatic reply|on vacation|out of the office|fora do escrit[oó]rio|aus[eê]ncia|ausente|fuera de la oficina)/i

export function isAutoReply(input: { raw: string }): {
    auto: boolean
    signal?: 'auto_submitted' | 'precedence' | 'x_auto_response' | 'subject_ooo'
} {
    const raw = input.raw

    const autoSubmitted = raw.match(/^Auto-Submitted:\s*(.+)$/im)?.[1]?.trim().toLowerCase()
    if (autoSubmitted === 'auto-replied' || autoSubmitted === 'auto-generated') {
        return { auto: true, signal: 'auto_submitted' }
    }

    const precedence = raw.match(/^Precedence:\s*(.+)$/im)?.[1]?.trim().toLowerCase()
    if (precedence === 'auto_reply' || precedence === 'bulk' || precedence === 'junk') {
        return { auto: true, signal: 'precedence' }
    }

    const xAutoResp = raw.match(/^X-Auto-Response-Suppress:\s*(.+)$/im)?.[1]?.trim().toLowerCase()
    if (xAutoResp === 'all') {
        return { auto: true, signal: 'x_auto_response' }
    }

    const subject = raw.match(/^Subject:\s*(.+)$/im)?.[1]?.trim()
    if (subject && OOO_SUBJECT_RE.test(subject)) {
        return { auto: true, signal: 'subject_ooo' }
    }

    return { auto: false }
}

// Phase 16 — REPLY-DETECT-V2. 3-tier matcher; tries in priority order.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export async function matchReplyToOutreach(
    headers: { inReplyTo: string | null; references: string | null; fromAddress: string | null },
    accountId: string,
    now: Date = new Date(),
): Promise<{ outreachEmail: OutreachEmailWithRelations; strategy: 'in_reply_to' | 'references' | 'from_address' } | null> {
    // Tier 1: In-Reply-To exact match.
    if (headers.inReplyTo) {
        const hit = await findOutreachEmailByMessageId(headers.inReplyTo, accountId)
        if (hit) return { outreachEmail: hit, strategy: 'in_reply_to' }
    }

    // Tier 2: References chain — split on whitespace, try each token.
    if (headers.references) {
        const tokens = headers.references.split(/\s+/).filter(Boolean)
        for (const tok of tokens) {
            const hit = await findOutreachEmailByMessageId(tok, accountId)
            if (hit) return { outreachEmail: hit, strategy: 'references' }
        }
    }

    // Tier 3: from-address heuristic. Co-conditions:
    //   - leads.email matches headers.fromAddress (case-insensitive via LOWER())
    //   - outreach_email exists for that lead on this emailAccountId
    //   - outreach_email.sentAt within the last 30 days
    // Returns the most-recent matching outreach_email so the right step is stamped.
    if (headers.fromAddress) {
        const cutoff = new Date(now.getTime() - THIRTY_DAYS_MS)
        const fromLower = headers.fromAddress.toLowerCase().trim()

        const rows = await db
            .select({
                id: outreachEmails.id,
                organizationId: outreachEmails.organizationId,
                campaignLeadId: outreachEmails.campaignLeadId,
                campaignId: outreachEmails.campaignId,
                emailAccountId: outreachEmails.emailAccountId,
                leadId: campaignLeads.leadId,
            })
            .from(outreachEmails)
            .innerJoin(campaignLeads, eq(outreachEmails.campaignLeadId, campaignLeads.id))
            .innerJoin(leads, eq(campaignLeads.leadId, leads.id))
            .where(
                and(
                    eq(outreachEmails.emailAccountId, accountId),
                    sql`LOWER(${leads.email}) = ${fromLower}`,
                    gte(outreachEmails.sentAt, cutoff),
                )
            )
            .orderBy(sql`${outreachEmails.sentAt} DESC NULLS LAST`)
            .limit(1)

        if (rows[0]) {
            const row = rows[0]
            if (row.campaignLeadId && row.campaignId) {
                return { outreachEmail: { ...row, campaignLeadId: row.campaignLeadId, campaignId: row.campaignId }, strategy: 'from_address' }
            }
        }
    }

    return null
}

// Phase 16 — auto-reply marker. Does NOT change campaign_leads.status (sequence keeps going).
async function markAsAutoReply(outreachEmailId: string): Promise<void> {
    await db.update(outreachEmails)
        .set({
            bounceReason: 'auto_reply',
            updatedAt: new Date(),
        })
        .where(eq(outreachEmails.id, outreachEmailId))
}

// P001/P002 — schedule an agentic follow-up decision for a matched reply, but only if the
// campaign opted in. Sets next_follow_up_at = now so processFollowUps picks it up next tick.
export async function findOutreachEmailByMessageId(
    messageId: string,
    accountId: string,
): Promise<OutreachEmailWithRelations | null> {
    const cleanMessageId = messageId.replace(/[<>]/g, '').trim()

    const result = await db
        .select({
            id: outreachEmails.id,
            organizationId: outreachEmails.organizationId,
            campaignLeadId: outreachEmails.campaignLeadId,
            campaignId: outreachEmails.campaignId,
            emailAccountId: outreachEmails.emailAccountId,
            leadId: campaignLeads.leadId,
        })
        .from(outreachEmails)
        .innerJoin(campaignLeads, eq(outreachEmails.campaignLeadId, campaignLeads.id))
        .innerJoin(emailAccounts, and(
            eq(emailAccounts.id, outreachEmails.emailAccountId),
            eq(emailAccounts.organizationId, outreachEmails.organizationId),
        ))
        .where(and(
            eq(outreachEmails.emailAccountId, accountId),
            sql`LOWER(${outreachEmails.messageId}) = LOWER(${cleanMessageId})`,
        ))
        .limit(1)

    const row = result[0]
    if (!row?.campaignLeadId || !row.campaignId) return null
    return { ...row, campaignLeadId: row.campaignLeadId, campaignId: row.campaignId }
}

export async function markAsReplied(
    outreachEmailId: string,
    campaignLeadId: string,
    leadId: string,
    campaignId: string,
    accountId: string,
    organizationId: string,
    inbound: { messageId: string; text: string },
): Promise<void> {
    const now = new Date()

    await Promise.all([
        db.update(outreachEmails).set({ repliedAt: now }).where(and(
            eq(outreachEmails.id, outreachEmailId),
            eq(outreachEmails.emailAccountId, accountId),
            eq(outreachEmails.organizationId, organizationId),
        )),

        db
            .update(campaignLeads)
            .set({
                status: 'replied',
                nextScheduledAt: null,
                lastRepliedAt: now,
                lastReplyAt: now,
                lastReplyMessageId: inbound.messageId,
                lastReplyText: inbound.text,
                nextFollowUpAt: sql`CASE WHEN EXISTS (
                    SELECT 1 FROM campaigns
                    WHERE campaigns.id = ${campaignId}
                      AND campaigns.organization_id = ${organizationId}
                      AND campaigns.agentic_followup_enabled = TRUE
                ) THEN ${now} ELSE NULL END`,
                totalReplies: sql`${campaignLeads.totalReplies} + 1`,
            })
            .where(and(eq(campaignLeads.id, campaignLeadId), eq(campaignLeads.campaignId, campaignId))),

        db
            .update(leads)
            .set({
                status: sql`CASE WHEN ${leads.status} IN ('replied', 'interested', 'not_interested') THEN ${leads.status} ELSE 'replied' END`,
                lastRepliedAt: now,
                totalReplies: sql`${leads.totalReplies} + 1`,
            })
            .where(eq(leads.id, leadId)),

        db
            .update(campaigns)
            .set({
                totalReplies: sql`${campaigns.totalReplies} + 1`,
            })
            .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId))),

        db
            .update(emailAccounts)
            .set({
                totalReplies: sql`${emailAccounts.totalReplies} + 1`,
            })
            .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.organizationId, organizationId))),
    ])

    // Notify Xphere — light lookup for lead identity, not already in scope here.
    const lead = await db.query.leads.findFirst({
        where: eq(leads.id, leadId),
        columns: { email: true, customFields: true },
    })
    if (lead) {
        sendXphereOutreachEvent('replied', {
            email: lead.email,
            campaign_id: campaignId,
            lead_id: leadId,
            customFields: lead.customFields,
        })
    }

    log.info({
        action: 'outreach.followup.reply_context_persisted',
        campaignId,
        campaignLeadId,
        hasReplyText: inbound.text.length > 0,
    }, 'persisted inbound reply context before agentic scheduling')
}
