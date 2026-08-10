/**
 * Outbound `outreach_emails` → conversation-message materializer (Phase 21 UIF-05).
 *
 * Every durably sent outreach email becomes exactly ONE outbound `outreach_conversation_messages`
 * row with `source_key = outreach-email:<id>`. This module NEVER dispatches mail and NEVER
 * mutates the `outreach_emails` row it reads — it only writes the Unified Inbox tables — so it is
 * safe to call from the best-effort post-dispatch hook AND from the bounded backfill, and safe to
 * retry any number of times.
 *
 * Idempotency is DB-enforced: a `SELECT ... FOR UPDATE` on the `outreach_emails` row serializes
 * concurrent materializations of the same send, and the unique
 * (organization_id, email_account_id, source_key) message key collapses any replay onto one row.
 *
 * Threading is chosen so a later inbound reply converges on this conversation: the outbound
 * message stores its own `internet_message_id`, and its conversation thread key is rooted at the
 * outbound Message-ID (or the referenced root for a follow-up), which is exactly the key/id an
 * inbound reply's In-Reply-To / References resolve against. Nothing here logs bodies or addresses.
 */
import type { UnifiedInboxSql } from './ingest'
import type { OutreachProviderName } from '@/db/schema'
import { sqlTimestampValue } from '../sql-timestamp'
import {
    bodyPreview,
    generatedThreadKey,
    leadThreadKey,
    normalizeAddress,
    normalizeMessageId,
    normalizeReferences,
    normalizeSubject,
    normalizeSubjectRoot,
    rfcThreadKey,
} from './normalize'

async function defaultSqlClient(): Promise<UnifiedInboxSql> {
    const { queryClient } = await import('../../../db')
    return queryClient as unknown as UnifiedInboxSql
}

/** The provider-native source identity for a materialized outbound send. */
export function outboundSourceKey(outreachEmailId: string): string {
    return `outreach-email:${outreachEmailId}`
}

export interface MaterializeOutboundResult {
    /** `materialized` = first ingestion; `duplicate` = already materialized; `skipped` = not sent / missing. */
    status: 'materialized' | 'duplicate' | 'skipped'
    inserted: boolean
    conversationId: string | null
    conversationMessageId: string | null
}

export interface MaterializeOutboundDeps {
    sql?: UnifiedInboxSql
    now?: () => Date
    /** Optional organization scope (unused in the single-id load, reserved for symmetry with backfill). */
    organizationId?: string
}

interface OutreachEmailRow {
    id: string
    organization_id: string
    email_account_id: string
    campaign_id: string | null
    campaign_lead_id: string | null
    to_address: string
    subject: string
    plain_body: string | null
    html_body: string | null
    message_id: string | null
    in_reply_to: string | null
    message_references: string | null
    status: string
    sent_at: Date | null
}

const SKIPPED: MaterializeOutboundResult = {
    status: 'skipped',
    inserted: false,
    conversationId: null,
    conversationMessageId: null,
}

/**
 * Materializes one durably sent outreach email into an outbound conversation message. Runs in a
 * single transaction and returns only after commit. Safe to call repeatedly and concurrently for
 * the same email: the second caller resolves the same message and performs no side effect.
 */
export async function materializeOutboundEmail(
    outreachEmailId: string,
    deps: MaterializeOutboundDeps = {},
): Promise<MaterializeOutboundResult> {
    const sql = deps.sql ?? (await defaultSqlClient())

    return sql.begin(async (tx) => {
        // Lock the send row for the transaction so concurrent materializations serialize here.
        // This is a read lock only — the row is never mutated by this module.
        const emailRows = await tx<OutreachEmailRow>`
            SELECT id, organization_id, email_account_id, campaign_id, campaign_lead_id,
                   to_address, subject, plain_body, html_body, message_id, in_reply_to,
                   message_references, status, sent_at
            FROM outreach_emails
            WHERE id = ${outreachEmailId}
            FOR UPDATE
        `
        const email = emailRows[0]
        // Only durably successful sends are materialized: status 'sent' AND a committed sent_at.
        if (!email || email.status !== 'sent' || !email.sent_at) {
            return SKIPPED
        }

        const sourceKey = outboundSourceKey(email.id)

        // Replay short-circuit: the unique (org, account, source_key) is the idempotency point.
        const existingMessage = await tx<{ id: string; conversation_id: string }>`
            SELECT id, conversation_id FROM outreach_conversation_messages
            WHERE organization_id = ${email.organization_id}
              AND email_account_id = ${email.email_account_id}
              AND source_key = ${sourceKey}
            LIMIT 1
        `
        if (existingMessage[0]) {
            return {
                status: 'duplicate',
                inserted: false,
                conversationId: existingMessage[0].conversation_id,
                conversationMessageId: existingMessage[0].id,
            }
        }

        // Resolve the sending account (provider + address) and re-validate org ownership.
        const accountRows = await tx<{ organization_id: string; email: string; provider: OutreachProviderName }>`
            SELECT organization_id, email, provider FROM email_accounts WHERE id = ${email.email_account_id}
        `
        const account = accountRows[0]
        if (!account || account.organization_id !== email.organization_id) {
            throw new Error('outreach email account does not belong to its organization')
        }

        // Attribution: campaign/campaign_lead come straight from the send; the lead is the
        // campaign_lead's lead, or (for a campaign-less manual send) the org lead at this address.
        let leadId: string | null = null
        if (email.campaign_lead_id) {
            const clRows = await tx<{ lead_id: string }>`
                SELECT lead_id FROM campaign_leads WHERE id = ${email.campaign_lead_id}
            `
            leadId = clRows[0]?.lead_id ?? null
        } else {
            const leadRows = await tx<{ id: string }>`
                SELECT id FROM leads
                WHERE organization_id = ${email.organization_id}
                  AND LOWER(email) = LOWER(${email.to_address})
                LIMIT 1
            `
            leadId = leadRows[0]?.id ?? null
        }

        const internetMessageId = normalizeMessageId(email.message_id)
        const inReplyTo = normalizeMessageId(email.in_reply_to)
        const references = normalizeReferences(email.message_references)
        const referenceRoot = references[0] ?? inReplyTo ?? internetMessageId
        const fromAddress = normalizeAddress(account.email)
        const toAddress = normalizeAddress(email.to_address)
        const subject = normalizeSubject(email.subject)
        const preview = bodyPreview(email.plain_body, email.html_body)

        // Reuse an existing conversation whose thread this send belongs to (a follow-up whose
        // In-Reply-To / References point at an earlier materialized message in the chain).
        let conversationId: string | null = null
        for (const token of [inReplyTo, ...references].filter((t): t is string => Boolean(t))) {
            const match = await tx<{ conversation_id: string }>`
                SELECT conversation_id FROM outreach_conversation_messages
                WHERE organization_id = ${email.organization_id}
                  AND email_account_id = ${email.email_account_id}
                  AND LOWER(internet_message_id) = LOWER(${token})
                LIMIT 1
            `
            if (match[0]) {
                conversationId = match[0].conversation_id
                break
            }
        }

        // Otherwise thread by the reference root (so an inbound reply's In-Reply-To converges on
        // the same rfc:<root> key), else per-lead, else a fresh key.
        const threadKey = conversationId
            ? null
            : referenceRoot
                ? rfcThreadKey(referenceRoot)
                : leadId
                    ? leadThreadKey(leadId)
                    : generatedThreadKey()

        if (!conversationId) {
            const created = await tx<{ id: string }>`
                INSERT INTO outreach_conversations (
                    organization_id, email_account_id, thread_key, lead_id, campaign_id,
                    campaign_lead_id, normalized_subject, status
                ) VALUES (
                    ${email.organization_id}, ${email.email_account_id}, ${threadKey},
                    ${leadId}, ${email.campaign_id}, ${email.campaign_lead_id},
                    ${normalizeSubjectRoot(subject)}, 'open'
                )
                ON CONFLICT (organization_id, email_account_id, thread_key) DO NOTHING
                RETURNING id
            `
            if (created[0]) {
                conversationId = created[0].id
            } else {
                const existing = await tx<{ id: string }>`
                    SELECT id FROM outreach_conversations
                    WHERE organization_id = ${email.organization_id}
                      AND email_account_id = ${email.email_account_id}
                      AND thread_key = ${threadKey}
                    LIMIT 1
                `
                conversationId = existing[0].id
            }
        }

        const referencesText = references.length > 0 ? references.join(' ') : null
        const toAddressesJson = toAddress ? [{ address: toAddress, name: null }] : []

        const insertedRows = await tx<{ id: string }>`
            INSERT INTO outreach_conversation_messages (
                organization_id, conversation_id, email_account_id, outreach_email_id,
                direction, provider, provider_message_id, source_key,
                internet_message_id, in_reply_to, message_references, subject,
                from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to_addresses,
                plain_body, html_body, headers, attachments, has_attachments,
                classification, match_strategy, match_confidence, sent_at
            ) VALUES (
                ${email.organization_id}, ${conversationId}, ${email.email_account_id}, ${email.id},
                'outbound', ${account.provider}, ${internetMessageId}, ${sourceKey},
                ${internetMessageId}, ${inReplyTo}, ${referencesText}, ${subject},
                ${fromAddress}, NULL,
                ${JSON.stringify(toAddressesJson)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                ${email.plain_body}, ${email.html_body},
                '{}'::jsonb, '[]'::jsonb, FALSE,
                'other', 'outbound', NULL, ${sqlTimestampValue(email.sent_at)}
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
                WHERE organization_id = ${email.organization_id}
                  AND email_account_id = ${email.email_account_id}
                  AND source_key = ${sourceKey}
                LIMIT 1
            `
            conversationMessageId = existing[0].id
            inserted = false
        }

        if (inserted) {
            const participants: Array<{ address: string; role: string }> = []
            if (fromAddress) participants.push({ address: fromAddress, role: 'from' })
            if (toAddress) participants.push({ address: toAddress, role: 'to' })
            for (const participant of participants) {
                await tx`
                    INSERT INTO outreach_conversation_participants (organization_id, conversation_id, address, role)
                    VALUES (${email.organization_id}, ${conversationId}, ${participant.address}, ${participant.role})
                    ON CONFLICT (organization_id, conversation_id, address, role) DO NOTHING
                `
            }

            // Outbound summary: advance last_outbound_at / last_message_*, never last_inbound_at.
            await tx`
                UPDATE outreach_conversations c SET
                    last_message_at = GREATEST(COALESCE(c.last_message_at, mts.ts), mts.ts),
                    last_outbound_at = GREATEST(COALESCE(c.last_outbound_at, mts.ts), mts.ts),
                    last_message_id = CASE WHEN c.last_message_at IS NULL OR mts.ts >= c.last_message_at THEN mts.id ELSE c.last_message_id END,
                    latest_message_preview = CASE WHEN c.last_message_at IS NULL OR mts.ts >= c.last_message_at THEN ${preview} ELSE c.latest_message_preview END,
                    updated_at = now()
                FROM (
                    SELECT id, COALESCE(received_at, sent_at, created_at) AS ts
                    FROM outreach_conversation_messages WHERE id = ${conversationMessageId}
                ) mts
                WHERE c.id = ${conversationId} AND c.organization_id = ${email.organization_id}
            `
        }

        return {
            status: inserted ? 'materialized' : 'duplicate',
            inserted,
            conversationId,
            conversationMessageId,
        }
    })
}
