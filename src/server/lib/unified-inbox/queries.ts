// ============================================================
// Unified Inbox — tenant-first read projections (Phase 21 UIF-04 / UIF-05)
// ============================================================
// Every function here is ORGANIZATION-SCOPED FIRST: the caller has already been
// authorized for `organizationId` by the route (requireOutreachRead), and every
// query's leading predicate is `organization_id = <organizationId>`. No query
// parameter, cursor, or path id can widen that scope — a conversation id that
// belongs to another tenant simply does not match, so it is indistinguishable from
// a missing id (no existence leak).
//
// Read state is PER USER: unread is derived from `outreach_conversation_reads` rows
// keyed by `user_id`, and the read mutation only ever touches the calling user's row.
//
// List projections are deliberately LIGHTWEIGHT: they never select message bodies or
// any credential/token column. Full bodies and safe stored headers are returned only
// by the single-conversation detail hydrate.

import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { db } from '../../../db'
import {
    inboxConversationLabels,
    inboxLabels,
    outreachConversationMessages,
    outreachConversationParticipants,
    outreachConversationReads,
    outreachConversations,
    outreachProviderCursors,
} from '../../../db/schema'
import type {
    OutreachConversationAddress,
    OutreachConversationParticipantRole,
    OutreachConversationStatus,
    OutreachMessageDirection,
    OutreachMessageMatchStrategy,
    OutreachProviderAttachment,
    OutreachProviderEventClassification,
    OutreachProviderName,
} from '@/db/schema'
import {
    decodeConversationCursor,
    encodeConversationCursor,
    type ConversationCursorFilters,
} from './cursor'

// ------------------------------------------------------------
// Filter + pagination inputs
// ------------------------------------------------------------

export interface ConversationListFilters {
    unread: boolean
    status: OutreachConversationStatus | null
    campaignId: string | null
    emailAccountId: string | null
    search: string | null
    // Phase 22 operator filters (migration 042).
    labelId: string | null
    reminderState: 'active' | 'due' | null
    archived: boolean | null
}

export interface ListConversationsParams {
    organizationId: string
    userId: string
    filters: ConversationListFilters
    limit: number
    cursor: string | null
}

// ------------------------------------------------------------
// Response DTOs (explicit and stable for the Phase 22 UI)
// ------------------------------------------------------------

export interface ConversationParticipantDto {
    address: string
    name: string | null
    role: OutreachConversationParticipantRole
}

export interface ConversationLabelDto {
    id: string
    name: string
    color: string | null
}

export interface ConversationListItemDto {
    id: string
    emailAccountId: string
    leadId: string | null
    campaignId: string | null
    campaignLeadId: string | null
    status: OutreachConversationStatus
    subject: string | null
    preview: string | null
    lastMessageAt: Date | null
    lastInboundAt: Date | null
    lastOutboundAt: Date | null
    archived: boolean
    unread: boolean
    participants: ConversationParticipantDto[]
    labels: ConversationLabelDto[]
}

export interface ConversationListResult {
    conversations: ConversationListItemDto[]
    nextCursor: string | null
    hasMore: boolean
}

export interface ConversationMessageDto {
    id: string
    direction: OutreachMessageDirection
    provider: OutreachProviderName
    subject: string | null
    internetMessageId: string | null
    inReplyTo: string | null
    fromAddress: string | null
    fromName: string | null
    toAddresses: OutreachConversationAddress[]
    ccAddresses: OutreachConversationAddress[]
    bccAddresses: OutreachConversationAddress[]
    plainBody: string | null
    htmlBody: string | null
    headers: Record<string, string>
    attachments: OutreachProviderAttachment[]
    hasAttachments: boolean
    classification: OutreachProviderEventClassification
    matchStrategy: OutreachMessageMatchStrategy | null
    sentAt: Date | null
    receivedAt: Date | null
    createdAt: Date
}

export interface ConversationSummaryDto {
    id: string
    emailAccountId: string
    leadId: string | null
    campaignId: string | null
    campaignLeadId: string | null
    status: OutreachConversationStatus
    subject: string | null
    lastMessageAt: Date | null
    lastInboundAt: Date | null
    lastOutboundAt: Date | null
    archived: boolean
    unread: boolean
    labels: ConversationLabelDto[]
}

export interface ConversationDetailDto {
    conversation: ConversationSummaryDto
    participants: ConversationParticipantDto[]
    messages: ConversationMessageDto[]
}

export interface ReadStateResult {
    found: boolean
    unread: boolean
}

export interface AccountSyncStatusDto {
    emailAccountId: string
    provider: OutreachProviderName
    lastSuccessAt: Date | null
    degraded: boolean
    /** Coarse, sanitized category. Raw provider error text is NEVER returned. */
    errorCategory: string | null
}

// ------------------------------------------------------------
// Shared SQL fragments (correlated, org-safe, injection-safe)
// ------------------------------------------------------------

/** Unread = the conversation has an incoming message and this user has no read row at/after it. */
function unreadPredicate(userId: string): SQL {
    return sql`outreach_conversations.last_inbound_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM outreach_conversation_reads r
        WHERE r.organization_id = outreach_conversations.organization_id
          AND r.conversation_id = outreach_conversations.id
          AND r.user_id = ${userId}::uuid
          AND r.last_read_at >= outreach_conversations.last_inbound_at
    )`
}

/** Escape ILIKE wildcards so user input matches literally (Postgres default '\' escape char). */
function escapeLikePattern(input: string): string {
    return input.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** Bounded keyword match over subject, latest preview, and participant address/name. */
function searchPredicate(term: string): SQL {
    return sql`(
        outreach_conversations.normalized_subject ILIKE ${term}
        OR outreach_conversations.latest_message_preview ILIKE ${term}
        OR EXISTS (
            SELECT 1 FROM outreach_conversation_participants p
            WHERE p.organization_id = outreach_conversations.organization_id
              AND p.conversation_id = outreach_conversations.id
              AND (p.address ILIKE ${term} OR p.name ILIKE ${term})
        )
    )`
}

/** A conversation carries the label if a join row exists for it (tenant-scoped correlated). */
function labelPredicate(labelId: string): SQL {
    return sql`EXISTS (
        SELECT 1 FROM inbox_conversation_labels cl
        WHERE cl.organization_id = outreach_conversations.organization_id
          AND cl.conversation_id = outreach_conversations.id
          AND cl.label_id = ${labelId}::uuid
    )`
}

/** The calling user has a scheduled ('active') or due reminder on the conversation. */
function reminderPredicate(userId: string, state: 'active' | 'due'): SQL {
    const dueClause = state === 'due' ? sql`AND r.remind_at <= now()` : sql``
    return sql`EXISTS (
        SELECT 1 FROM inbox_reminders r
        WHERE r.organization_id = outreach_conversations.organization_id
          AND r.conversation_id = outreach_conversations.id
          AND r.user_id = ${userId}::uuid
          AND r.status = 'scheduled'
          ${dueClause}
    )`
}

function cursorFiltersOf(organizationId: string, filters: ConversationListFilters): ConversationCursorFilters {
    return {
        organizationId,
        unread: filters.unread,
        status: filters.status,
        campaignId: filters.campaignId,
        emailAccountId: filters.emailAccountId,
        search: filters.search,
        labelId: filters.labelId,
        reminderState: filters.reminderState,
        archived: filters.archived,
    }
}

async function labelsFor(
    organizationId: string,
    conversationIds: string[],
): Promise<Map<string, ConversationLabelDto[]>> {
    const byConversation = new Map<string, ConversationLabelDto[]>()
    if (conversationIds.length === 0) return byConversation
    const rows = await db
        .select({
            conversationId: inboxConversationLabels.conversationId,
            id: inboxLabels.id,
            name: inboxLabels.name,
            color: inboxLabels.color,
        })
        .from(inboxConversationLabels)
        .innerJoin(inboxLabels, and(
            eq(inboxLabels.id, inboxConversationLabels.labelId),
            eq(inboxLabels.organizationId, inboxConversationLabels.organizationId),
        ))
        .where(and(
            eq(inboxConversationLabels.organizationId, organizationId),
            inArray(inboxConversationLabels.conversationId, conversationIds),
        ))
        .orderBy(asc(inboxLabels.name))
    for (const row of rows) {
        const list = byConversation.get(row.conversationId) ?? []
        list.push({ id: row.id, name: row.name, color: row.color })
        byConversation.set(row.conversationId, list)
    }
    return byConversation
}

async function participantsFor(
    organizationId: string,
    conversationIds: string[],
): Promise<Map<string, ConversationParticipantDto[]>> {
    const byConversation = new Map<string, ConversationParticipantDto[]>()
    if (conversationIds.length === 0) return byConversation
    const rows = await db
        .select({
            conversationId: outreachConversationParticipants.conversationId,
            address: outreachConversationParticipants.address,
            name: outreachConversationParticipants.name,
            role: outreachConversationParticipants.role,
        })
        .from(outreachConversationParticipants)
        .where(and(
            eq(outreachConversationParticipants.organizationId, organizationId),
            inArray(outreachConversationParticipants.conversationId, conversationIds),
        ))
        .orderBy(asc(outreachConversationParticipants.role), asc(outreachConversationParticipants.address))
    for (const row of rows) {
        const list = byConversation.get(row.conversationId) ?? []
        list.push({ address: row.address, name: row.name, role: row.role })
        byConversation.set(row.conversationId, list)
    }
    return byConversation
}

// ------------------------------------------------------------
// List
// ------------------------------------------------------------

export async function listConversations(params: ListConversationsParams): Promise<ConversationListResult> {
    const { organizationId, userId, filters, limit } = params

    // Tenant scope first — nothing below can widen it.
    const conditions: SQL[] = [eq(outreachConversations.organizationId, organizationId)]
    if (filters.status) conditions.push(eq(outreachConversations.status, filters.status))
    if (filters.campaignId) conditions.push(eq(outreachConversations.campaignId, filters.campaignId))
    if (filters.emailAccountId) conditions.push(eq(outreachConversations.emailAccountId, filters.emailAccountId))
    if (filters.unread) conditions.push(sql`(${unreadPredicate(userId)})`)
    if (filters.archived === true) conditions.push(sql`outreach_conversations.archived_at IS NOT NULL`)
    if (filters.archived === false) conditions.push(sql`outreach_conversations.archived_at IS NULL`)
    if (filters.labelId) conditions.push(labelPredicate(filters.labelId))
    if (filters.reminderState) conditions.push(reminderPredicate(userId, filters.reminderState))

    const trimmedSearch = filters.search?.trim()
    if (trimmedSearch) {
        conditions.push(searchPredicate(`%${escapeLikePattern(trimmedSearch)}%`))
    }

    // A cursor is only valid for the exact filter set it was minted under. decode throws a
    // ConversationCursorError on tamper/mismatch, which the route maps to a 400.
    if (params.cursor) {
        const position = decodeConversationCursor(params.cursor, cursorFiltersOf(organizationId, filters))
        conditions.push(sql`(
            outreach_conversations.last_message_at < ${position.lastMessageAt}::timestamp
            OR (outreach_conversations.last_message_at = ${position.lastMessageAt}::timestamp
                AND outreach_conversations.id < ${position.id}::uuid)
        )`)
    }

    const rows = await db
        .select({
            id: outreachConversations.id,
            emailAccountId: outreachConversations.emailAccountId,
            leadId: outreachConversations.leadId,
            campaignId: outreachConversations.campaignId,
            campaignLeadId: outreachConversations.campaignLeadId,
            status: outreachConversations.status,
            subject: outreachConversations.normalizedSubject,
            preview: outreachConversations.latestMessagePreview,
            lastMessageAt: outreachConversations.lastMessageAt,
            lastInboundAt: outreachConversations.lastInboundAt,
            lastOutboundAt: outreachConversations.lastOutboundAt,
            archivedAt: outreachConversations.archivedAt,
            cursorTs: sql<string | null>`outreach_conversations.last_message_at::text`,
            unread: sql<boolean>`(${unreadPredicate(userId)})`,
        })
        .from(outreachConversations)
        .where(and(...conditions))
        .orderBy(desc(outreachConversations.lastMessageAt), desc(outreachConversations.id))
        .limit(limit + 1)

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows

    const pageIds = pageRows.map((row) => row.id)
    const [participantMap, labelMap] = await Promise.all([
        participantsFor(organizationId, pageIds),
        labelsFor(organizationId, pageIds),
    ])

    const conversations: ConversationListItemDto[] = pageRows.map((row) => ({
        id: row.id,
        emailAccountId: row.emailAccountId,
        leadId: row.leadId,
        campaignId: row.campaignId,
        campaignLeadId: row.campaignLeadId,
        status: row.status,
        subject: row.subject,
        preview: row.preview,
        lastMessageAt: row.lastMessageAt,
        lastInboundAt: row.lastInboundAt,
        lastOutboundAt: row.lastOutboundAt,
        archived: row.archivedAt != null,
        unread: Boolean(row.unread),
        participants: participantMap.get(row.id) ?? [],
        labels: labelMap.get(row.id) ?? [],
    }))

    let nextCursor: string | null = null
    const last = pageRows[pageRows.length - 1]
    if (hasMore && last && last.cursorTs) {
        nextCursor = encodeConversationCursor(
            { lastMessageAt: last.cursorTs, id: last.id },
            cursorFiltersOf(organizationId, filters),
        )
    }

    return { conversations, nextCursor, hasMore }
}

// ------------------------------------------------------------
// Detail
// ------------------------------------------------------------

export async function getConversationDetail(params: {
    organizationId: string
    conversationId: string
    userId: string
}): Promise<ConversationDetailDto | null> {
    const { organizationId, conversationId, userId } = params

    const summaryRows = await db
        .select({
            id: outreachConversations.id,
            emailAccountId: outreachConversations.emailAccountId,
            leadId: outreachConversations.leadId,
            campaignId: outreachConversations.campaignId,
            campaignLeadId: outreachConversations.campaignLeadId,
            status: outreachConversations.status,
            subject: outreachConversations.normalizedSubject,
            lastMessageAt: outreachConversations.lastMessageAt,
            lastInboundAt: outreachConversations.lastInboundAt,
            lastOutboundAt: outreachConversations.lastOutboundAt,
            archivedAt: outreachConversations.archivedAt,
            unread: sql<boolean>`(${unreadPredicate(userId)})`,
        })
        .from(outreachConversations)
        .where(and(
            eq(outreachConversations.organizationId, organizationId),
            eq(outreachConversations.id, conversationId),
        ))
        .limit(1)

    const summary = summaryRows[0]
    if (!summary) return null

    const messages = await db
        .select({
            id: outreachConversationMessages.id,
            direction: outreachConversationMessages.direction,
            provider: outreachConversationMessages.provider,
            subject: outreachConversationMessages.subject,
            internetMessageId: outreachConversationMessages.internetMessageId,
            inReplyTo: outreachConversationMessages.inReplyTo,
            fromAddress: outreachConversationMessages.fromAddress,
            fromName: outreachConversationMessages.fromName,
            toAddresses: outreachConversationMessages.toAddresses,
            ccAddresses: outreachConversationMessages.ccAddresses,
            bccAddresses: outreachConversationMessages.bccAddresses,
            plainBody: outreachConversationMessages.plainBody,
            htmlBody: outreachConversationMessages.htmlBody,
            headers: outreachConversationMessages.headers,
            attachments: outreachConversationMessages.attachments,
            hasAttachments: outreachConversationMessages.hasAttachments,
            classification: outreachConversationMessages.classification,
            matchStrategy: outreachConversationMessages.matchStrategy,
            sentAt: outreachConversationMessages.sentAt,
            receivedAt: outreachConversationMessages.receivedAt,
            createdAt: outreachConversationMessages.createdAt,
        })
        .from(outreachConversationMessages)
        .where(and(
            eq(outreachConversationMessages.organizationId, organizationId),
            eq(outreachConversationMessages.conversationId, conversationId),
        ))
        // Thread order matches migration 041's thread index: effective timestamp then id.
        .orderBy(
            sql`COALESCE(outreach_conversation_messages.received_at, outreach_conversation_messages.sent_at, outreach_conversation_messages.created_at) ASC`,
            asc(outreachConversationMessages.id),
        )

    const [participantMap, labelMap] = await Promise.all([
        participantsFor(organizationId, [conversationId]),
        labelsFor(organizationId, [conversationId]),
    ])

    return {
        conversation: {
            id: summary.id,
            emailAccountId: summary.emailAccountId,
            leadId: summary.leadId,
            campaignId: summary.campaignId,
            campaignLeadId: summary.campaignLeadId,
            status: summary.status,
            subject: summary.subject,
            lastMessageAt: summary.lastMessageAt,
            lastInboundAt: summary.lastInboundAt,
            lastOutboundAt: summary.lastOutboundAt,
            archived: summary.archivedAt != null,
            unread: Boolean(summary.unread),
            labels: labelMap.get(conversationId) ?? [],
        },
        participants: participantMap.get(conversationId) ?? [],
        messages: messages.map((message) => ({
            ...message,
            toAddresses: message.toAddresses ?? [],
            ccAddresses: message.ccAddresses ?? [],
            bccAddresses: message.bccAddresses ?? [],
            headers: message.headers ?? {},
            attachments: message.attachments ?? [],
        })),
    }
}

// ------------------------------------------------------------
// Unread count
// ------------------------------------------------------------

export async function getUnreadCount(params: { organizationId: string; userId: string }): Promise<number> {
    const rows = await db
        .select({ count: sql<string>`count(*)` })
        .from(outreachConversations)
        .where(and(
            eq(outreachConversations.organizationId, params.organizationId),
            sql`(${unreadPredicate(params.userId)})`,
        ))
    return Number(rows[0]?.count ?? 0)
}

// ------------------------------------------------------------
// Read state (per user, idempotent)
// ------------------------------------------------------------

export async function setConversationReadState(params: {
    organizationId: string
    conversationId: string
    userId: string
    read: boolean
}): Promise<ReadStateResult> {
    const { organizationId, conversationId, userId, read } = params

    const convRows = await db
        .select({
            id: outreachConversations.id,
            lastMessageId: outreachConversations.lastMessageId,
            lastMessageAt: outreachConversations.lastMessageAt,
        })
        .from(outreachConversations)
        .where(and(
            eq(outreachConversations.organizationId, organizationId),
            eq(outreachConversations.id, conversationId),
        ))
        .limit(1)

    const conv = convRows[0]
    if (!conv) return { found: false, unread: false }

    if (read) {
        // Mark read up to the latest message. Idempotent: GREATEST never moves the read
        // watermark backward, and the unique (org, conversation, user) key means a second
        // call updates the same single row rather than inserting a duplicate.
        const readAt = conv.lastMessageAt ?? new Date()
        await db
            .insert(outreachConversationReads)
            .values({
                organizationId,
                conversationId,
                userId,
                lastReadMessageId: conv.lastMessageId ?? null,
                lastReadAt: readAt,
            })
            .onConflictDoUpdate({
                target: [
                    outreachConversationReads.organizationId,
                    outreachConversationReads.conversationId,
                    outreachConversationReads.userId,
                ],
                set: {
                    lastReadMessageId: sql`excluded.last_read_message_id`,
                    lastReadAt: sql`GREATEST(outreach_conversation_reads.last_read_at, excluded.last_read_at)`,
                    updatedAt: sql`now()`,
                },
            })
    } else {
        // Mark unread: drop only THIS user's read row. Idempotent (deleting nothing is a no-op)
        // and never affects any other user's read state.
        await db
            .delete(outreachConversationReads)
            .where(and(
                eq(outreachConversationReads.organizationId, organizationId),
                eq(outreachConversationReads.conversationId, conversationId),
                eq(outreachConversationReads.userId, userId),
            ))
    }

    // Authoritative unread state after the mutation.
    const unreadRows = await db
        .select({ unread: sql<boolean>`(${unreadPredicate(userId)})` })
        .from(outreachConversations)
        .where(and(
            eq(outreachConversations.organizationId, organizationId),
            eq(outreachConversations.id, conversationId),
        ))
        .limit(1)

    return { found: true, unread: Boolean(unreadRows[0]?.unread) }
}

// ------------------------------------------------------------
// Per-account sync status (sanitized; no cursor tokens / credentials)
// ------------------------------------------------------------

function categorizeSyncError(rawError: string | null): string | null {
    if (!rawError) return null
    const text = rawError.toLowerCase()
    if (/(auth|unauthor|401|403|token|scope|credential|permission)/.test(text)) return 'auth'
    if (/(429|rate|throttl|quota)/.test(text)) return 'rate_limit'
    if (/(timeout|econn|refused|network|unreachable|dns|socket|reset)/.test(text)) return 'network'
    if (/(410|delta|cursor|invalid)/.test(text)) return 'provider_cursor'
    return 'provider'
}

export async function getAccountSyncStatus(organizationId: string): Promise<AccountSyncStatusDto[]> {
    const rows = await db
        .select({
            emailAccountId: outreachProviderCursors.emailAccountId,
            provider: outreachProviderCursors.provider,
            lastSuccessAt: outreachProviderCursors.lastSuccessAt,
            lastError: outreachProviderCursors.lastError,
            lastErrorAt: outreachProviderCursors.lastErrorAt,
            retryAt: outreachProviderCursors.retryAt,
        })
        .from(outreachProviderCursors)
        .where(eq(outreachProviderCursors.organizationId, organizationId))
        .orderBy(asc(outreachProviderCursors.emailAccountId))

    const now = Date.now()
    // Sanitize on the way out: expose only the fields the UI needs to show a degraded badge.
    // NEVER surface delta_cursor, uid state, lease tokens, or raw error text.
    return rows.map((row) => {
        const erroredAfterSuccess = row.lastErrorAt != null
            && (row.lastSuccessAt == null || row.lastErrorAt > row.lastSuccessAt)
        const retryPending = row.retryAt != null && row.retryAt.getTime() > now
        return {
            emailAccountId: row.emailAccountId,
            provider: row.provider,
            lastSuccessAt: row.lastSuccessAt,
            degraded: erroredAfterSuccess || retryPending,
            errorCategory: erroredAfterSuccess ? categorizeSyncError(row.lastError) : null,
        }
    })
}
