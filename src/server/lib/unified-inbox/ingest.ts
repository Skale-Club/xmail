/**
 * Provider-neutral event → conversation materializer (Phase 21 UIF-02).
 *
 * ONE transaction turns a staged Phase 19 `outreach_provider_events` row into a durable,
 * deduplicated `outreach_conversation_messages` record with attribution, participants, and
 * an updated conversation summary — then flips the event's OWN materialization lifecycle to
 * `materialized`. That lifecycle (materialization_status/lease/attempts/error/materialized_at/
 * conversation_message_id) is DELIBERATELY INDEPENDENT from Phase 19's `processed_at`, which
 * records reply/bounce classification side effects. This module NEVER reads, writes, or
 * claims on `processed_at`, and NEVER re-invokes reply/bounce/auto-reply counters,
 * notifications, or follow-up scheduling — Phase 19 owns those first-processing effects.
 *
 * Idempotency is enforced by the database, not by hope: the message's unique
 * (organization_id, email_account_id, source_key) key collapses any provider replay onto one
 * row, and the `SELECT ... FOR UPDATE` on the event plus the `materialized` short-circuit
 * serialize concurrent materializations so a replay or a stale-lease double-claim produces
 * the same message id and no repeated side effect. Nothing here logs bodies, headers, or
 * addresses.
 */
import type {
    OutreachProviderEventClassification,
    OutreachProviderName,
} from '@/db/schema'
import { attributeConversation, type MatchConfidence } from './attribute'
import type { OutreachMessageMatchStrategy } from './types'
import { sqlTimestampValue } from '../sql-timestamp'
import {
    bodyPreview,
    buildSourceKey,
    normalizeAddress,
    normalizeAddressEntry,
    normalizeAddressList,
    normalizeMessageId,
    normalizeReferences,
    normalizeSubject,
    normalizeSubjectRoot,
    sanitizeHeaders,
} from './normalize'

// ------------------------------------------------------------
// SQL client contract
// ------------------------------------------------------------

/**
 * Minimal structural view of the postgres-js client the materializer needs: a tagged
 * template that resolves to rows, plus a `begin` transaction. Injected in tests; defaults to
 * the application query client. Kept local so ingestion does not depend on drizzle internals.
 */
export interface UnifiedInboxSql {
    <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
    begin<T>(fn: (tx: UnifiedInboxSql) => Promise<T>): Promise<T>
}

async function defaultSqlClient(): Promise<UnifiedInboxSql> {
    const { queryClient } = await import('../../../db')
    return queryClient as unknown as UnifiedInboxSql
}

// ------------------------------------------------------------
// Result contract
// ------------------------------------------------------------

export interface MaterializeAttribution {
    matchStrategy: OutreachMessageMatchStrategy
    matchConfidence: MatchConfidence | null
    leadId: string | null
    campaignId: string | null
    campaignLeadId: string | null
    outreachEmailId: string | null
}

export interface MaterializeResult {
    /** `materialized` = first ingestion; `duplicate` = message already existed; `skipped` = event gone. */
    status: 'materialized' | 'duplicate' | 'skipped'
    inserted: boolean
    /** The owning organization (available post-commit for org-scoped near-real-time fanout). */
    organizationId: string | null
    conversationId: string | null
    conversationMessageId: string | null
    classification: OutreachProviderEventClassification
    attribution: MaterializeAttribution
}

export interface MaterializeProviderEventDeps {
    sql?: UnifiedInboxSql
    now?: () => Date
    lookbackDays?: number
}

interface ProviderEventRow {
    id: string
    organization_id: string
    email_account_id: string
    provider: OutreachProviderName
    provider_message_id: string
    message_id: string | null
    in_reply_to: string | null
    message_references: string | null
    classification: OutreachProviderEventClassification
    from_address: string | null
    to_addresses: string[] | null
    cc_addresses: string[] | null
    subject: string | null
    text_body: string | null
    html_body: string | null
    headers: Record<string, string> | null
    attachments: unknown[] | null
    received_at: Date
    materialization_status: string
    conversation_message_id: string | null
}

// Depending on the connection's type parsers, postgres-js may hand back jsonb columns as
// already-parsed values OR as raw strings. Normalize both so ingestion is parser-agnostic.
function asJsonArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            return Array.isArray(parsed) ? parsed : []
        } catch {
            return []
        }
    }
    return []
}

function asStringArray(value: unknown): string[] {
    return asJsonArray(value).filter((item): item is string => typeof item === 'string')
}

function asJsonObject(value: unknown): Record<string, string> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, string>
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
        } catch {
            return {}
        }
    }
    return {}
}

const EMPTY_ATTRIBUTION: MaterializeAttribution = {
    matchStrategy: 'none',
    matchConfidence: null,
    leadId: null,
    campaignId: null,
    campaignLeadId: null,
    outreachEmailId: null,
}

/**
 * Materializes one staged provider event into a durable conversation message. Runs in a
 * single transaction and returns only after commit. Safe to call repeatedly and concurrently
 * for the same event: the second caller resolves the same message and performs no side effect.
 */
export async function materializeProviderEvent(
    eventId: string,
    deps: MaterializeProviderEventDeps = {},
): Promise<MaterializeResult> {
    const sql = deps.sql ?? (await defaultSqlClient())
    const now = deps.now ?? (() => new Date())

    return sql.begin(async (tx) => {
        // Lock the event for the duration; concurrent materializers serialize here.
        const eventRows = await tx<ProviderEventRow>`
            SELECT id, organization_id, email_account_id, provider, provider_message_id,
                   message_id, in_reply_to, message_references, classification, from_address,
                   to_addresses, cc_addresses, subject, text_body, html_body, headers,
                   attachments, received_at, materialization_status, conversation_message_id
            FROM outreach_provider_events
            WHERE id = ${eventId}
            FOR UPDATE
        `
        const event = eventRows[0]
        if (!event) {
            return {
                status: 'skipped',
                inserted: false,
                organizationId: null,
                conversationId: null,
                conversationMessageId: null,
                classification: 'other',
                attribution: EMPTY_ATTRIBUTION,
            }
        }

        // Already materialized (replay, or a serialized loser of a concurrent claim): resolve
        // the existing message and do nothing else.
        if (event.materialization_status === 'materialized' && event.conversation_message_id) {
            const existing = await tx<{ conversation_id: string; match_strategy: string | null; match_confidence: string | null; outreach_email_id: string | null }>`
                SELECT conversation_id, match_strategy, match_confidence, outreach_email_id
                FROM outreach_conversation_messages
                WHERE id = ${event.conversation_message_id}
            `
            return {
                status: 'duplicate',
                inserted: false,
                organizationId: event.organization_id,
                conversationId: existing[0]?.conversation_id ?? null,
                conversationMessageId: event.conversation_message_id,
                classification: event.classification,
                attribution: EMPTY_ATTRIBUTION,
            }
        }

        // Validate the account still belongs to the event's organization before any lookup.
        const accountRows = await tx<{ organization_id: string }>`
            SELECT organization_id FROM email_accounts WHERE id = ${event.email_account_id}
        `
        if (!accountRows[0] || accountRows[0].organization_id !== event.organization_id) {
            throw new Error('provider event account does not belong to its organization')
        }

        // Normalize once, in the shared module, before any lookup or persistence.
        const internetMessageId = normalizeMessageId(event.message_id)
        const inReplyTo = normalizeMessageId(event.in_reply_to)
        const references = normalizeReferences(event.message_references)
        const fromEntry = normalizeAddressEntry(event.from_address)
        const fromAddress = fromEntry?.address ?? normalizeAddress(event.from_address)
        const toAddresses = normalizeAddressList(asStringArray(event.to_addresses))
        const ccAddresses = normalizeAddressList(asStringArray(event.cc_addresses))
        const subject = normalizeSubject(event.subject)
        const preview = bodyPreview(event.text_body, event.html_body)
        const sourceKey = buildSourceKey(event.provider, event.provider_message_id)
        const attachments = asJsonArray(event.attachments)
        const hasAttachments = attachments.length > 0
        const safeHeaders = sanitizeHeaders(asJsonObject(event.headers))

        const attribution = await attributeConversation(tx, {
            organizationId: event.organization_id,
            emailAccountId: event.email_account_id,
            provider: event.provider,
            internetMessageId,
            inReplyTo,
            references,
            providerThreadId: null,
            fromAddress,
            now: now(),
            lookbackDays: deps.lookbackDays,
        })

        // Find or create the conversation.
        let conversationId = attribution.conversationId
        if (!conversationId) {
            const created = await tx<{ id: string }>`
                INSERT INTO outreach_conversations (
                    organization_id, email_account_id, thread_key, lead_id, campaign_id,
                    campaign_lead_id, provider_thread_id, normalized_subject, status
                ) VALUES (
                    ${event.organization_id}, ${event.email_account_id}, ${attribution.threadKey},
                    ${attribution.leadId}, ${attribution.campaignId}, ${attribution.campaignLeadId},
                    ${attribution.providerThreadId}, ${normalizeSubjectRoot(subject)}, 'open'
                )
                ON CONFLICT (organization_id, email_account_id, thread_key) DO NOTHING
                RETURNING id
            `
            if (created[0]) {
                conversationId = created[0].id
            } else {
                const existing = await tx<{ id: string }>`
                    SELECT id FROM outreach_conversations
                    WHERE organization_id = ${event.organization_id}
                      AND email_account_id = ${event.email_account_id}
                      AND thread_key = ${attribution.threadKey}
                    LIMIT 1
                `
                conversationId = existing[0].id
            }
        }

        // Insert the immutable message. The unique source key makes this the idempotency point.
        const referencesText = references.length > 0 ? references.join(' ') : null
        const insertedRows = await tx<{ id: string }>`
            INSERT INTO outreach_conversation_messages (
                organization_id, conversation_id, email_account_id, outreach_email_id,
                direction, provider, provider_message_id, source_key,
                internet_message_id, in_reply_to, message_references, subject,
                from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to_addresses,
                plain_body, html_body, headers, attachments, has_attachments,
                classification, match_strategy, match_confidence, received_at
            ) VALUES (
                ${event.organization_id}, ${conversationId}, ${event.email_account_id}, ${attribution.outreachEmailId},
                'inbound', ${event.provider}, ${event.provider_message_id}, ${sourceKey},
                ${internetMessageId}, ${inReplyTo}, ${referencesText}, ${subject},
                ${fromAddress}, ${fromEntry?.name ?? null},
                ${JSON.stringify(toAddresses)}::jsonb, ${JSON.stringify(ccAddresses)}::jsonb, '[]'::jsonb, '[]'::jsonb,
                ${event.text_body}, ${event.html_body},
                ${JSON.stringify(safeHeaders)}::jsonb, ${JSON.stringify(attachments)}::jsonb, ${hasAttachments},
                ${event.classification}, ${attribution.matchStrategy}, ${attribution.matchConfidence}, ${sqlTimestampValue(event.received_at)}
            )
            ON CONFLICT (organization_id, email_account_id, source_key) DO NOTHING
            RETURNING id
        `

        let conversationMessageId: string
        let inserted: boolean
        if (insertedRows[0]) {
            conversationMessageId = insertedRows[0].id
            inserted = true
        } else {
            const existing = await tx<{ id: string }>`
                SELECT id FROM outreach_conversation_messages
                WHERE organization_id = ${event.organization_id}
                  AND email_account_id = ${event.email_account_id}
                  AND source_key = ${sourceKey}
                LIMIT 1
            `
            conversationMessageId = existing[0].id
            inserted = false
        }

        // Participants and conversation summary only advance on a genuinely new message.
        if (inserted) {
            const participants: Array<{ address: string; name: string | null; role: string }> = []
            if (fromAddress) participants.push({ address: fromAddress, name: fromEntry?.name ?? null, role: 'from' })
            for (const to of toAddresses) participants.push({ address: to.address, name: to.name, role: 'to' })
            for (const cc of ccAddresses) participants.push({ address: cc.address, name: cc.name, role: 'cc' })
            for (const participant of participants) {
                await tx`
                    INSERT INTO outreach_conversation_participants (organization_id, conversation_id, address, name, role)
                    VALUES (${event.organization_id}, ${conversationId}, ${participant.address}, ${participant.name}, ${participant.role})
                    ON CONFLICT (organization_id, conversation_id, address, role) DO NOTHING
                `
            }

            // Summary from the message's own timestamp (subquery avoids re-binding a Date).
            await tx`
                UPDATE outreach_conversations c SET
                    last_message_at = GREATEST(COALESCE(c.last_message_at, mts.ts), mts.ts),
                    last_inbound_at = GREATEST(COALESCE(c.last_inbound_at, mts.ts), mts.ts),
                    last_message_id = CASE WHEN c.last_message_at IS NULL OR mts.ts >= c.last_message_at THEN mts.id ELSE c.last_message_id END,
                    latest_message_preview = CASE WHEN c.last_message_at IS NULL OR mts.ts >= c.last_message_at THEN ${preview} ELSE c.latest_message_preview END,
                    updated_at = now()
                FROM (
                    SELECT id, COALESCE(received_at, sent_at, created_at) AS ts
                    FROM outreach_conversation_messages WHERE id = ${conversationMessageId}
                ) mts
                WHERE c.id = ${conversationId} AND c.organization_id = ${event.organization_id}
            `
        }

        // Complete the materialization lifecycle: the message link + timestamp are committed
        // in the SAME transaction, so there is no window where the event is `materialized`
        // without its message. processed_at is never touched.
        await tx`
            UPDATE outreach_provider_events SET
                materialization_status = 'materialized',
                materialized_at = ${sqlTimestampValue(now())},
                conversation_message_id = ${conversationMessageId},
                materialization_lease_token = NULL,
                materialization_lease_expires_at = NULL,
                materialization_error = NULL,
                updated_at = now()
            WHERE id = ${eventId}
        `

        return {
            status: inserted ? 'materialized' : 'duplicate',
            inserted,
            organizationId: event.organization_id,
            conversationId,
            conversationMessageId,
            classification: event.classification,
            attribution: {
                matchStrategy: attribution.matchStrategy,
                matchConfidence: attribution.matchConfidence,
                leadId: attribution.leadId,
                campaignId: attribution.campaignId,
                campaignLeadId: attribution.campaignLeadId,
                outreachEmailId: attribution.outreachEmailId,
            },
        }
    })
}
