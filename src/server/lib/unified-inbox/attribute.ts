/**
 * Tenant/account-scoped thread & outreach attribution (Phase 21 UIF-03).
 *
 * Resolution order, strongest signal first:
 *   1. In-Reply-To     — match a normalized conversation/outreach message id.
 *   2. References       — every token, reference-root first, same lookup.
 *   3. Provider thread  — only where the provider exposes a trustworthy thread id.
 *   4. Address heuristic — same org+account, known lead address, recent outbound, newest.
 *
 * Every query is scoped by BOTH organization_id AND email_account_id, so a lead address
 * shared across organizations or reused across accounts can never leak an attribution
 * across a tenant/account boundary. An address match that resolves to more than one lead
 * is ambiguous and is deliberately left UNATTRIBUTED rather than guessed. The match
 * strategy and a confidence tag are recorded for auditability of the matcher.
 */
import type { OutreachMessageMatchStrategy, OutreachProviderName } from '@/db/schema'
import type { UnifiedInboxSql } from './ingest'
import { deriveThreadKey, leadThreadKey, rfcThreadKey } from './normalize'
import { sqlTimestampValue } from '../sql-timestamp'

export type MatchConfidence = 'high' | 'medium' | 'low'

export interface AttributionInput {
    organizationId: string
    emailAccountId: string
    provider: OutreachProviderName
    /** Normalized (bracket-stripped) RFC ids. */
    internetMessageId: string | null
    inReplyTo: string | null
    references: string[]
    providerThreadId: string | null
    /** Normalized, lower-cased sender address. */
    fromAddress: string | null
    now: Date
    lookbackDays?: number
}

export interface AttributionOutcome {
    /** An existing conversation to attach to; null means find-or-create by threadKey. */
    conversationId: string | null
    threadKey: string
    providerThreadId: string | null
    matchStrategy: OutreachMessageMatchStrategy
    matchConfidence: MatchConfidence | null
    leadId: string | null
    campaignId: string | null
    campaignLeadId: string | null
    outreachEmailId: string | null
}

const DEFAULT_LOOKBACK_DAYS = 30

// Native mail and Microsoft Graph expose a trustworthy conversation/thread id; IMAP
// (provider 'smtp') does not, so it is never grouped on a provider thread id.
const TRUSTWORTHY_THREAD_PROVIDERS = new Set<OutreachProviderName>(['native', 'outlook'])

interface ConversationMatchRow {
    conversation_id: string
    lead_id: string | null
    campaign_id: string | null
    campaign_lead_id: string | null
}

interface OutreachEmailMatchRow {
    outreach_email_id: string
    campaign_id: string | null
    campaign_lead_id: string | null
    lead_id: string | null
}

interface HeuristicRow {
    lead_id: string
    outreach_email_id: string
    campaign_id: string | null
    campaign_lead_id: string | null
}

/**
 * Resolves conversation/outreach attribution for an inbound message. All lookups run on
 * the supplied (transaction) sql client so they share the materialization snapshot/locks.
 */
export async function attributeConversation(
    sql: UnifiedInboxSql,
    input: AttributionInput,
): Promise<AttributionOutcome> {
    const { organizationId: org, emailAccountId: account } = input

    // Reference root (oldest token) drives the thread key so every reply in a chain converges.
    const referenceRoot = input.references[0] ?? input.inReplyTo ?? null

    // Tiers 1 & 2: header-token matches. In-Reply-To first, then each References token.
    const headerTokens: Array<{ token: string; strategy: 'in_reply_to' | 'references' }> = []
    if (input.inReplyTo) headerTokens.push({ token: input.inReplyTo, strategy: 'in_reply_to' })
    for (const ref of input.references) headerTokens.push({ token: ref, strategy: 'references' })

    for (const { token, strategy } of headerTokens) {
        // 1a: an already-materialized message in this thread → reuse its conversation.
        const conversationRows = await sql<ConversationMatchRow>`
            SELECT m.conversation_id, c.lead_id, c.campaign_id, c.campaign_lead_id
            FROM outreach_conversation_messages m
            JOIN outreach_conversations c
              ON c.id = m.conversation_id AND c.organization_id = m.organization_id
            WHERE m.organization_id = ${org}
              AND m.email_account_id = ${account}
              AND LOWER(m.internet_message_id) = LOWER(${token})
            LIMIT 1
        `
        if (conversationRows[0]) {
            const row = conversationRows[0]
            return {
                conversationId: row.conversation_id,
                threadKey: '',
                providerThreadId: input.providerThreadId,
                matchStrategy: strategy,
                matchConfidence: 'high',
                leadId: row.lead_id,
                campaignId: row.campaign_id,
                campaignLeadId: row.campaign_lead_id,
                outreachEmailId: null,
            }
        }

        // 1b: the outbound outreach email this token points at (thread not yet materialized).
        const outreachRows = await sql<OutreachEmailMatchRow>`
            SELECT oe.id AS outreach_email_id, oe.campaign_id, oe.campaign_lead_id, cl.lead_id
            FROM outreach_emails oe
            JOIN campaign_leads cl ON cl.id = oe.campaign_lead_id
            WHERE oe.organization_id = ${org}
              AND oe.email_account_id = ${account}
              AND LOWER(oe.message_id) = LOWER(${token})
            LIMIT 1
        `
        if (outreachRows[0]) {
            const row = outreachRows[0]
            return {
                conversationId: null,
                threadKey: rfcThreadKey(referenceRoot ?? token),
                providerThreadId: input.providerThreadId,
                matchStrategy: strategy,
                matchConfidence: 'high',
                leadId: row.lead_id,
                campaignId: row.campaign_id,
                campaignLeadId: row.campaign_lead_id,
                outreachEmailId: row.outreach_email_id,
            }
        }
    }

    // Tier 3: trustworthy provider thread id.
    if (input.providerThreadId && TRUSTWORTHY_THREAD_PROVIDERS.has(input.provider)) {
        const threadRows = await sql<ConversationMatchRow & { conversation_id: string }>`
            SELECT id AS conversation_id, lead_id, campaign_id, campaign_lead_id
            FROM outreach_conversations
            WHERE organization_id = ${org}
              AND email_account_id = ${account}
              AND provider_thread_id = ${input.providerThreadId}
            LIMIT 1
        `
        if (threadRows[0]) {
            const row = threadRows[0]
            return {
                conversationId: row.conversation_id,
                threadKey: '',
                providerThreadId: input.providerThreadId,
                matchStrategy: 'provider_thread',
                matchConfidence: 'medium',
                leadId: row.lead_id,
                campaignId: row.campaign_id,
                campaignLeadId: row.campaign_lead_id,
                outreachEmailId: null,
            }
        }
    }

    // Tier 4: bounded address heuristic. Same org+account, known lead address, outbound
    // within the lookback window, newest first. Ambiguous (>1 distinct lead) stays unattributed.
    if (input.fromAddress) {
        const lookbackDays = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
        const cutoff = new Date(input.now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
        const heuristicRows = await sql<HeuristicRow>`
            SELECT cl.lead_id, oe.id AS outreach_email_id, oe.campaign_id, oe.campaign_lead_id
            FROM outreach_emails oe
            JOIN campaign_leads cl ON cl.id = oe.campaign_lead_id
            JOIN leads l ON l.id = cl.lead_id AND l.organization_id = oe.organization_id
            WHERE oe.organization_id = ${org}
              AND oe.email_account_id = ${account}
              AND LOWER(l.email) = LOWER(${input.fromAddress})
              AND oe.sent_at IS NOT NULL
              AND oe.sent_at >= ${sqlTimestampValue(cutoff)}
            ORDER BY oe.sent_at DESC
        `
        // A lead is unique per (organization, email), so recent outbound resolves ONE lead.
        // Ambiguity is at the thread level: a lead enrolled in more than one campaign has no
        // single outbound thread to attach the reply to, so it stays unattributed rather than
        // being guessed onto the newest campaign.
        const distinctCampaignLeads = new Set(heuristicRows.map((row) => row.campaign_lead_id))
        if (distinctCampaignLeads.size === 1 && heuristicRows[0]) {
            const row = heuristicRows[0]
            return {
                conversationId: null,
                threadKey: leadThreadKey(row.lead_id),
                providerThreadId: input.providerThreadId,
                matchStrategy: 'address_heuristic',
                matchConfidence: 'low',
                leadId: row.lead_id,
                campaignId: row.campaign_id,
                campaignLeadId: row.campaign_lead_id,
                outreachEmailId: row.outreach_email_id,
            }
        }
        // Ambiguous or empty → fall through to unattributed.
    }

    // Tier 5: unattributed. Thread by the reference root when threading exists so replies
    // still converge; otherwise a fresh generated key. NEVER attributed across a tenant.
    return {
        conversationId: null,
        threadKey: deriveThreadKey({
            references: input.references,
            inReplyTo: input.inReplyTo,
            internetMessageId: input.internetMessageId,
        }),
        providerThreadId: input.providerThreadId,
        matchStrategy: 'none',
        matchConfidence: null,
        leadId: null,
        campaignId: null,
        campaignLeadId: null,
        outreachEmailId: null,
    }
}
