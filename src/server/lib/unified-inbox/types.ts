// ============================================================
// Unified Inbox — provider-neutral contracts (Phase 21 UIF-01)
// ============================================================
// These are pure TypeScript contracts. They declare NO database constraints:
// the running schema is supabase/migrations/041_unified_inbox_foundation.sql,
// mirrored for type-awareness in src/db/schema.ts. Ingestion (21-02) and the
// read APIs (21-03/04) consume these types so every provider — native mail,
// IMAP, and Microsoft Graph — normalizes into one shape before touching the DB.
//
// Provider identity and classification vocabulary is intentionally reused from
// the Phase 19 provider-event staging layer (src/db/schema.ts) so the inbox never
// invents a second, drifting set of provider/classification strings.

import type {
    OutreachConversationParticipantRole,
    OutreachConversationStatus,
    OutreachMessageDirection,
    OutreachMessageMatchStrategy,
    OutreachProviderAttachment,
    OutreachProviderEventClassification,
    OutreachProviderEventMaterializationStatus,
    OutreachProviderName,
} from '@/db/schema'

// The union types are owned by src/db/schema.ts (the Drizzle mirror of the SQL). We
// re-export them here so ingestion/API code has one import site for the inbox contracts.
export type {
    OutreachConversationParticipantRole,
    OutreachConversationStatus,
    OutreachMessageDirection,
    OutreachMessageMatchStrategy,
    OutreachProviderAttachment,
    OutreachProviderEventClassification,
    OutreachProviderEventMaterializationStatus,
    OutreachProviderName,
}

// ------------------------------------------------------------
// Canonical value sets (runtime lists for the CHECK domains)
// ------------------------------------------------------------
// These arrays are the runtime enumeration of the same vocabulary the migration 041
// CHECK constraints enforce. `satisfies` binds each array to the schema-owned union, so
// adding a value here without adding it to the SQL/schema (or vice versa) fails to
// compile instead of silently diverging.

/** A normalized message is either incoming to, or outgoing from, the account. */
export const OUTREACH_MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const satisfies readonly OutreachMessageDirection[]

/**
 * Conversation lifecycle for the read-only MVP. Archive/snooze/bulk actions are
 * Phase 22 and deliberately absent so the CHECK domain stays small.
 */
export const OUTREACH_CONVERSATION_STATUSES = ['open', 'closed'] as const satisfies readonly OutreachConversationStatus[]

/** Role a participant address plays on a conversation. */
export const OUTREACH_CONVERSATION_PARTICIPANT_ROLES = ['from', 'to', 'cc', 'bcc', 'reply_to'] as const satisfies readonly OutreachConversationParticipantRole[]

/**
 * How a message was threaded onto its conversation. Recorded for auditability of the
 * three-tier matcher; `outbound` marks a materialized outreach send, `none` an
 * unattributed inbound message that opened its own conversation.
 */
export const OUTREACH_MESSAGE_MATCH_STRATEGIES = [
    'in_reply_to',
    'references',
    'provider_thread',
    'address_heuristic',
    'outbound',
    'none',
] as const satisfies readonly OutreachMessageMatchStrategy[]

/**
 * Provider-event materialization lifecycle. This is INDEPENDENT from the Phase 19
 * `processed_at` field, which records reply/bounce classification side-effects. A
 * worker leases a `pending` (or stale `processing`) row, commits the normalized
 * message, then flips it to `materialized`; exhausted retries land on `failed`.
 */
export const OUTREACH_PROVIDER_EVENT_MATERIALIZATION_STATUSES = [
    'pending',
    'processing',
    'materialized',
    'failed',
] as const satisfies readonly OutreachProviderEventMaterializationStatus[]

// ------------------------------------------------------------
// Normalized ingestion input
// ------------------------------------------------------------

/** A single normalized address token. */
export interface NormalizedInboxAddress {
    /** Lower-cased, angle-bracket-stripped address. */
    address: string
    /** Display name if the provider supplied one. */
    name: string | null
}

/**
 * The provider-neutral message every ingestion source produces before persistence.
 * `sourceKey` is the immutable per-account dedupe identity (never the RFC Message-ID,
 * which is not globally unique): native `native:<mail_message_id>`, IMAP
 * `imap:<uidvalidity>:<uid>`, Graph `outlook:<immutable_id>`, outbound
 * `outreach-email:<outreach_email_id>`.
 */
export interface NormalizedInboxMessage {
    organizationId: string
    emailAccountId: string
    provider: OutreachProviderName
    direction: OutreachMessageDirection
    sourceKey: string
    /** Provider-native message id (the identity portion of `sourceKey`). */
    providerMessageId: string | null
    /** Provider thread/conversation id where the provider exposes one. */
    providerThreadId: string | null
    /** RFC 5322 Message-ID (indexed for threading, never a uniqueness key). */
    internetMessageId: string | null
    inReplyTo: string | null
    references: string[]
    subject: string | null
    normalizedSubject: string | null
    fromAddress: NormalizedInboxAddress | null
    toAddresses: NormalizedInboxAddress[]
    ccAddresses: NormalizedInboxAddress[]
    bccAddresses: NormalizedInboxAddress[]
    textBody: string | null
    htmlBody: string | null
    /** Safe header subset only — never credentials, tokens, or raw auth headers. */
    headers: Record<string, string>
    /** Attachment metadata only; binary bytes are deferred to Phase 22. */
    attachments: OutreachProviderAttachment[]
    classification: OutreachProviderEventClassification
    matchStrategy: OutreachMessageMatchStrategy | null
    sentAt: Date | null
    receivedAt: Date | null
}

// ------------------------------------------------------------
// Read-side view contracts
// ------------------------------------------------------------

/** Attribution a conversation carries, all within the same organization. */
export interface OutreachConversationAttribution {
    emailAccountId: string
    leadId: string | null
    campaignId: string | null
    campaignLeadId: string | null
}

/** A participant address/role on a conversation. */
export interface OutreachConversationParticipant {
    address: string
    name: string | null
    role: OutreachConversationParticipantRole
}

/**
 * Per-user read state. Absence of a row means unread whenever the conversation has an
 * incoming message (`lastInboundAt`). Presence with `lastReadAt >= lastInboundAt`
 * means read.
 */
export interface OutreachConversationReadState {
    conversationId: string
    userId: string
    lastReadMessageId: string | null
    lastReadAt: Date
}
