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
import { emailAccounts, outreachEmails, campaignLeads, leads, campaigns, outreachConversationMessages } from '../../db/schema'
import { eq, and, sql, gte } from 'drizzle-orm'
import { createLogger } from '../lib/logger'
import { buildSourceKey } from '../lib/unified-inbox/normalize'
import { sendXphereOutreachEvent } from '../lib/xphere-events'
import { shouldNotifyOutreachEvent } from '../lib/outreach-settings'
import { JOB_TIMEOUT_BUDGETS_MS, runWithLock } from '../lib/cron-lock'
import {
    consumeClassifiedEvents,
    createDrizzleInboundEventStore,
    type StoredProviderEvent,
} from '../lib/outreach-inbound'
import { scheduleAutonomousFollowUp } from '../lib/inbox-ai-automation-runtime'
import { ingestOutreachInboundExclusive } from '../lib/outreach-inbound-sources'
import { sqlTimestamp } from '../lib/sql-timestamp'
import {
    TERMINAL_CAMPAIGN_LEAD_STATUSES,
    UNDELIVERABLE_CAMPAIGN_LEAD_STATUSES,
} from '../lib/outreach-sequence-state'

const log = createLogger('outreach.replies')

/**
 * The status guards are built from the exhaustive map in outreach-sequence-state.ts rather
 * than from a literal list, so a status added there cannot be silently forgotten here.
 */
function terminalStatusList() {
    return sql.join(TERMINAL_CAMPAIGN_LEAD_STATUSES.map((status) => sql`${status}`), sql`, `)
}

function undeliverableStatusList() {
    return sql.join(UNDELIVERABLE_CAMPAIGN_LEAD_STATUSES.map((status) => sql`${status}`), sql`, `)
}

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

/**
 * Bounded because this text is persisted on campaign_leads and then handed to the follow-up
 * decider as prompt context: an unbounded reply (a quoted thread, a forwarded newsletter)
 * would otherwise grow the row and the prompt without limit.
 */
export const MAX_REPLY_CONTEXT_LENGTH = 20_000

/**
 * The id stored on campaign_leads.last_reply_message_id, which processFollowUps sends back
 * out as In-Reply-To. Unbracketed to match how outreach_emails.message_id is stored and
 * compared.
 */
export function normalizeInboundMessageId(messageId: string | null | undefined, fallback: string): string {
    const normalized = messageId?.replace(/[<>]/g, '').trim()
    return (normalized || fallback).slice(0, 500)
}

/**
 * Reply text for follow-up context, from whichever body the provider gave us.
 *
 * The HTML fallback is not a nicety: Graph returns exactly one body, and anything composed
 * in Outlook comes back as HTML with no text alternative. Without the fallback, an Outlook
 * reply reaches the agentic decider as an empty string and it answers a conversation it
 * cannot read — while an SMTP reply to the same campaign works fine. Exported so that
 * cross-provider parity is asserted on the real function rather than a copy of it.
 */
export function normalizeReplyText(text: string | null | undefined, html?: string | false | null): string {
    const source = text?.trim() || (typeof html === 'string'
        ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : '')
    return source.slice(0, MAX_REPLY_CONTEXT_LENGTH)
}

/**
 * Reply context text, preferring the durable Phase 21 normalized conversation message.
 *
 * Phase 21 materializes each staged event into an immutable outreach_conversation_messages
 * row; when that has already happened, its persisted body is the canonical reply context.
 * This read is a strict ENRICHMENT: it never gates or duplicates the Phase 19 reply side
 * effects (those key on processed_at), and if the Unified Inbox tables are not present yet
 * (migration 041 not applied) or the lookup fails for any reason, it falls back to the
 * event's own staged bodies so reply processing can never break. Read-only: it writes nothing.
 */
export async function resolveReplyContextText(event: StoredProviderEvent): Promise<string> {
    const fallback = normalizeReplyText(event.textBody, event.htmlBody)
    try {
        const sourceKey = buildSourceKey(event.provider, event.providerMessageId)
        const rows = await db
            .select({
                plainBody: outreachConversationMessages.plainBody,
                htmlBody: outreachConversationMessages.htmlBody,
            })
            .from(outreachConversationMessages)
            .where(and(
                eq(outreachConversationMessages.organizationId, event.organizationId),
                eq(outreachConversationMessages.emailAccountId, event.emailAccountId),
                eq(outreachConversationMessages.sourceKey, sourceKey),
            ))
            .limit(1)
        const persisted = rows[0]
        if (persisted && (persisted.plainBody || persisted.htmlBody)) {
            return normalizeReplyText(persisted.plainBody, persisted.htmlBody)
        }
    } catch {
        // The durable message is an enrichment, never a dependency. No body content is logged.
        log.debug({
            action: 'outreach.replies.reply_context_fallback',
            emailAccountId: event.emailAccountId,
        }, 'durable reply context unavailable; using staged event body')
    }
    return fallback
}

// P0-06 / audit-2026-07 — advisory lock prevents concurrent runs across Node instances.
// Uses runWithLock (cron-lock.ts) so acquire+release share one reserved connection; the
// previous db.execute-on-pool implementation leaked the lock across sessions (see audit H1).
// Inspect held locks: SELECT * FROM pg_locks WHERE locktype='advisory';
const REPLY_PROCESSOR_LOCK_NAME = 'outreach-replies-processor'

export async function runRepliesProcessorWithLock(): Promise<void> {
    // jobs/index.ts schedules this every 15 minutes. 2026-09-04 (Fase 1 TASK 2): previously ran on
    // cron-lock's 10-minute default; retuned to 305s — 5x the 55-61s normal latency measured in
    // production (see JOB_TIMEOUT_BUDGETS_MS in cron-lock.ts for the rule and the full table).
    await runWithLock(REPLY_PROCESSOR_LOCK_NAME, async () => {
        await processReplies()
    }, { timeoutMs: JOB_TIMEOUT_BUDGETS_MS.outreachRepliesProcessor })
}

export async function processReplies(): Promise<ProcessRepliesResult> {
    const result: ProcessRepliesResult = {
        processed: 0,
        replies: 0,
        errors: 0,
    }

    const store = createDrizzleInboundEventStore()

    // Stage first. Either job may be first on a tick, and neither may consume a
    // classification that was never staged. The shared ingestion lock means a colliding
    // bounce tick no longer runs the same provider scan a second time; null = the other
    // job is staging right now, and its events are durable, so consuming still proceeds.
    const ingested = await ingestOutreachInboundExclusive({ store })
    if (ingested) result.errors += ingested.errors

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

    const messageId = normalizeInboundMessageId(event.messageId, `event:${event.id}`)
    // Reply context comes from the durable Phase 21 normalized message when it has been
    // materialized, falling back to the staged event bodies otherwise. Full bodies are
    // staged now, so last_reply_text is populated for external accounts either way —
    // the old IMAP path fetched headers only and left it null.
    const replyText = await resolveReplyContextText(event)
    await markAsReplied(
        matched.outreachEmail.id,
        matched.outreachEmail.campaignLeadId,
        matched.outreachEmail.leadId,
        matched.outreachEmail.campaignId,
        matched.outreachEmail.emailAccountId,
        matched.outreachEmail.organizationId,
        { messageId, text: replyText },
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

    // Phase 23 (AI-03): schedule an AUDITED, LEASED autonomous follow-up decision from the persisted
    // inbound reply — but only when effective org+campaign autonomy is enabled (idempotent, never a
    // send). This replaces the retired direct-send `nextFollowUpAt` path; the compatibility columns
    // above are retained for rollout only and no longer feed a sender.
    await scheduleAutonomousFollowUp({
        organizationId: matched.outreachEmail.organizationId,
        emailAccountId: matched.outreachEmail.emailAccountId,
        campaignId: matched.outreachEmail.campaignId,
        campaignLeadId: matched.outreachEmail.campaignLeadId,
        leadId: matched.outreachEmail.leadId,
        provider: event.provider,
        providerMessageId: event.providerMessageId,
        triggerRef: messageId,
        hasInboundBody: replyText.trim().length > 0,
    })

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
    const terminalStatuses = terminalStatusList()
    const undeliverableStatuses = undeliverableStatusList()

    // Notification transport is gated on the resolved per-org policy AND on this being the
    // transition into 'replied', so a replayed reply for an already-replied lead never
    // re-notifies. The DB writes below are NOT gated — only the outbound notification is.
    const priorRows = await db
        .select({ status: campaignLeads.status })
        .from(campaignLeads)
        .where(and(eq(campaignLeads.id, campaignLeadId), eq(campaignLeads.campaignId, campaignId)))
        .limit(1)
    const wasAlreadyReplied = priorRows[0]?.status === 'replied'

    // W-2: this job and processBounces hold *different* advisory locks and run on the same
    // tick, so these writes interleave with markAsBounced's in nondeterministic order.
    // Everything below is therefore expressed as a guarded CASE evaluated by the database
    // against the current row, never as a read-then-write.
    await Promise.all([
        db.update(outreachEmails).set({ repliedAt: now }).where(and(
            eq(outreachEmails.id, outreachEmailId),
            eq(outreachEmails.emailAccountId, accountId),
            eq(outreachEmails.organizationId, organizationId),
        )),

        db
            .update(campaignLeads)
            .set({
                // A terminal status is never reverted (Phase 18). 'replied' is itself
                // terminal, so a second reply is a no-op here while still counted below;
                // 'bounced' stays bounced no matter which write lands last.
                status: sql`CASE WHEN ${campaignLeads.status} IN (${terminalStatuses}) THEN ${campaignLeads.status} ELSE 'replied' END`,
                nextScheduledAt: null,
                lastRepliedAt: now,
                lastReplyAt: now,
                lastReplyMessageId: inbound.messageId,
                lastReplyText: inbound.text,
                // Arming a follow-up for an undeliverable lead is how a bounced address
                // kept getting mailed: processFollowUps selects on next_follow_up_at alone.
                // NOTE: `now` is bound as an ISO string with an explicit cast. A raw Date
                // inside a sql template reaches postgres-js as an untyped parameter and
                // throws "must be of type string ... Received an instance of Date" —
                // drizzle only converts Date->string for direct column assignments. This
                // threw on every matched reply; no test caught it because they all mock db.
                nextFollowUpAt: sql`CASE
                    WHEN ${campaignLeads.status} IN (${undeliverableStatuses}) THEN ${campaignLeads.nextFollowUpAt}
                    WHEN EXISTS (
                        SELECT 1 FROM campaigns
                        WHERE campaigns.id = ${campaignId}
                          AND campaigns.organization_id = ${organizationId}
                          AND campaigns.agentic_followup_enabled = TRUE
                    ) THEN ${sqlTimestamp(now)}
                    ELSE NULL END`,
                totalReplies: sql`${campaignLeads.totalReplies} + 1`,
            })
            .where(and(eq(campaignLeads.id, campaignLeadId), eq(campaignLeads.campaignId, campaignId))),

        db
            .update(leads)
            .set({
                // Was ('replied','interested','not_interested') — bounced and unsubscribed
                // were missing, so a reply revived a dead lead. Derived from the exhaustive
                // map now, so a new status cannot be forgotten here.
                status: sql`CASE WHEN ${leads.status} IN (${terminalStatuses}) THEN ${leads.status} ELSE 'replied' END`,
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

    // Notify Xphere — light lookup for lead identity, not already in scope here. Emission is
    // gated by the organization's notifyOnReply policy (CONS-04); the DB writes above already
    // ran regardless of the notification preference.
    const lead = await db.query.leads.findFirst({
        where: eq(leads.id, leadId),
        columns: { email: true, customFields: true },
    })
    if (lead && !wasAlreadyReplied && await shouldNotifyOutreachEvent(organizationId, 'reply')) {
        await sendXphereOutreachEvent('replied', {
            email: lead.email,
            campaign_id: campaignId,
            lead_id: leadId,
            outreach_email_id: outreachEmailId,
            customFields: lead.customFields,
        }, organizationId)
    }

    log.info({
        action: 'outreach.followup.reply_context_persisted',
        campaignId,
        campaignLeadId,
        hasReplyText: inbound.text.length > 0,
    }, 'persisted inbound reply context before agentic scheduling')
}
