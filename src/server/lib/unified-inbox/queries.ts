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
import { escapeLikePattern } from './like'
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
    /**
     * Server-owned queue semantics (see {@link INBOX_VIEWS}). When set it REPLACES the legacy
     * `unread` / `archived` / `reminderState` filters (the route zeroes those out); the explicit
     * filters (`status`, campaign, account, label, search) keep composing on top of it.
     */
    view: InboxView | null
}

/**
 * The six operator queues. The server owns their meaning so the client never composes
 * `status=open` or archive flags itself and every surface (list, counts, badge) agrees.
 *
 *   inbox       not archived, and the other side has written at least once. A cold send nobody has
 *               answered is NOT an inbox conversation (it only shows up through search, a campaign
 *               filter, or by opening the campaign).
 *   needs_reply open, not archived, and a real reply (classification 'reply') arrived after our
 *               last outbound. Bounces and auto-replies never put a conversation here.
 *   awaiting    not archived, they have written, and our last outbound is newer than their last
 *               inbound: we answered, the ball is in their court.
 *   unread      not archived and unread for the calling user.
 *   reminders   the calling user has an ACTIVE reminder on it: scheduled OR already notified but
 *               not done/cancelled. Includes archived conversations (archiving does not cancel a
 *               reminder you set on purpose).
 *   archived    archived only.
 */
export const INBOX_VIEWS = ['inbox', 'needs_reply', 'awaiting', 'unread', 'reminders', 'archived'] as const
export type InboxView = (typeof INBOX_VIEWS)[number]

export interface InboxCounts {
    needsReply: number
    awaiting: number
    unread: number
    /**
     * Conversations with an ACTIVE reminder: exactly the rows the `reminders` view lists (scheduled
     * or notified, future ones included). Use THIS one for the Reminders rail entry so the number
     * and the list always agree.
     */
    remindersActive: number
    /**
     * Conversations that want attention now: a reminder that is scheduled and past due, or notified
     * and not yet dismissed (same predicate as the per-item `reminderDue` flag). A subset of
     * `remindersActive`.
     */
    remindersDue: number
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
    /** Classification of the MOST RECENT inbound message (null when there is none). */
    lastInboundClassification: OutreachProviderEventClassification | null
    /**
     * The calling user has a reminder here that wants attention now: scheduled and past due, or
     * already notified and not yet done/cancelled. Same predicate as the `remindersDue` counter.
     */
    reminderDue: boolean
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
    lastInboundClassification: OutreachProviderEventClassification | null
    reminderDue: boolean
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

/**
 * The calling user has a reminder on the conversation in the given state.
 *
 * `active` = scheduled OR notified (finished ones are `done` / `cancelled`). processInboxCommands
 * flips a reminder to `notified` the moment it fires, and a notified reminder is exactly the one
 * the operator still has to act on, so filtering on `scheduled` alone made the Reminders view
 * empty itself at the instant it mattered.
 *
 * `due` = wants attention now: scheduled with remind_at <= now(), or notified (it already fired
 * and nobody dismissed it). This is the predicate behind the `remindersDue` counter and the
 * per-item `reminderDue` flag.
 */
/** @internal exported for the SQL-shape tests */
export function reminderPredicate(userId: string, state: 'active' | 'due'): SQL {
    const stateClause = state === 'due'
        ? sql`AND (r.status = 'notified' OR (r.status = 'scheduled' AND r.remind_at <= now()))`
        : sql`AND r.status IN ('scheduled', 'notified')`
    return sql`EXISTS (
        SELECT 1 FROM inbox_reminders r
        WHERE r.organization_id = outreach_conversations.organization_id
          AND r.conversation_id = outreach_conversations.id
          AND r.user_id = ${userId}::uuid
          ${stateClause}
    )`
}

/**
 * Classification of the latest inbound message, as a correlated scalar subquery so the list stays
 * ONE query (no N+1). Ordered like the thread (effective timestamp, then id).
 */
/** @internal exported for the SQL-shape tests */
export const LAST_INBOUND_CLASSIFICATION: SQL = sql`(
    SELECT m.classification FROM outreach_conversation_messages m
    WHERE m.organization_id = outreach_conversations.organization_id
      AND m.conversation_id = outreach_conversations.id
      AND m.direction = 'inbound'
    ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC, m.id DESC
    LIMIT 1
)`

const NOT_ARCHIVED: SQL = sql`outreach_conversations.archived_at IS NULL`
const HAS_INBOUND: SQL = sql`outreach_conversations.last_inbound_at IS NOT NULL`

/**
 * Sort/cursor key. `last_message_at` is nullable in the schema, and a NULL sorts FIRST under
 * `DESC` in Postgres and never satisfies a `<` comparison, so a keyset walk would either bury those
 * rows forever or loop on them. `created_at` is NOT NULL, so COALESCE onto it gives every row a
 * total, stable position. ORDER BY, the cursor predicate and the minted cursor all use THIS
 * expression so they cannot drift apart (see idx_outreach_conversations_activity).
 */
const ACTIVITY_AT: SQL = sql`COALESCE(outreach_conversations.last_message_at, outreach_conversations.created_at)`

/**
 * They wrote, we haven't answered, and what they wrote is a real reply. EXISTS (rather than "the
 * last inbound message is a reply") on purpose: an out-of-office landing AFTER a genuine reply
 * would otherwise hide a person who is still waiting on us. The cheap column comparison is kept
 * alongside the EXISTS so the planner can discard most rows before touching messages.
 */
const NEEDS_REPLY: SQL = sql`(
    outreach_conversations.status = 'open'
    AND outreach_conversations.archived_at IS NULL
    AND outreach_conversations.last_inbound_at IS NOT NULL
    AND outreach_conversations.last_inbound_at > COALESCE(outreach_conversations.last_outbound_at, '-infinity'::timestamp)
    AND EXISTS (
        SELECT 1 FROM outreach_conversation_messages m
        WHERE m.organization_id = outreach_conversations.organization_id
          AND m.conversation_id = outreach_conversations.id
          AND m.direction = 'inbound'
          AND m.classification = 'reply'
          AND COALESCE(m.received_at, m.sent_at, m.created_at)
              > COALESCE(outreach_conversations.last_outbound_at, '-infinity'::timestamp)
    )
)`

const AWAITING: SQL = sql`(
    outreach_conversations.archived_at IS NULL
    AND outreach_conversations.last_inbound_at IS NOT NULL
    AND outreach_conversations.last_outbound_at IS NOT NULL
    AND outreach_conversations.last_outbound_at > outreach_conversations.last_inbound_at
)`

/**
 * The SQL conditions a quick view contributes. `scopedLookup` is true when the operator is looking
 * something up on purpose (a search term or a campaign filter): the Inbox view then drops its
 * "has inbound" requirement so a cold send is findable, which is the one place it is allowed to
 * appear. It is deliberately NOT triggered by the account or label filters, which describe a
 * mailbox/bucket rather than a lookup, and would otherwise flood the Inbox with thousands of
 * unanswered cold sends from one sender.
 */
export function viewConditions(view: InboxView, userId: string, scopedLookup: boolean): SQL[] {
    switch (view) {
        case 'inbox':
            return scopedLookup ? [NOT_ARCHIVED] : [NOT_ARCHIVED, HAS_INBOUND]
        case 'needs_reply':
            return [NEEDS_REPLY]
        case 'awaiting':
            return [AWAITING]
        case 'unread':
            return [NOT_ARCHIVED, sql`(${unreadPredicate(userId)})`]
        case 'reminders':
            return [reminderPredicate(userId, 'active')]
        case 'archived':
            return [sql`outreach_conversations.archived_at IS NOT NULL`]
    }
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
        view: filters.view,
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
    const trimmedSearch = filters.search?.trim()
    if (filters.view) {
        // A view owns read/archive/reminder semantics; legacy flags are ignored when one is set.
        conditions.push(...viewConditions(filters.view, userId, Boolean(trimmedSearch) || Boolean(filters.campaignId)))
    } else {
        if (filters.unread) conditions.push(sql`(${unreadPredicate(userId)})`)
        if (filters.archived === true) conditions.push(sql`outreach_conversations.archived_at IS NOT NULL`)
        if (filters.archived === false) conditions.push(sql`outreach_conversations.archived_at IS NULL`)
        if (filters.reminderState) conditions.push(reminderPredicate(userId, filters.reminderState))
    }
    if (filters.labelId) conditions.push(labelPredicate(filters.labelId))

    if (trimmedSearch) {
        conditions.push(searchPredicate(`%${escapeLikePattern(trimmedSearch)}%`))
    }

    // A cursor is only valid for the exact filter set it was minted under. decode throws a
    // ConversationCursorError on tamper/mismatch, which the route maps to a 400.
    if (params.cursor) {
        const position = decodeConversationCursor(params.cursor, cursorFiltersOf(organizationId, filters))
        conditions.push(sql`(
            ${ACTIVITY_AT} < ${position.lastMessageAt}::timestamp
            OR (${ACTIVITY_AT} = ${position.lastMessageAt}::timestamp
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
            cursorTs: sql<string | null>`(${ACTIVITY_AT})::text`,
            unread: sql<boolean>`(${unreadPredicate(userId)})`,
            lastInboundClassification: sql<OutreachProviderEventClassification | null>`${LAST_INBOUND_CLASSIFICATION}`,
            reminderDue: sql<boolean>`(${reminderPredicate(userId, 'due')})`,
        })
        .from(outreachConversations)
        .where(and(...conditions))
        .orderBy(sql`${ACTIVITY_AT} DESC`, desc(outreachConversations.id))
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
        lastInboundClassification: row.lastInboundClassification ?? null,
        reminderDue: Boolean(row.reminderDue),
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
            lastInboundClassification: sql<OutreachProviderEventClassification | null>`${LAST_INBOUND_CLASSIFICATION}`,
            reminderDue: sql<boolean>`(${reminderPredicate(userId, 'due')})`,
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
            lastInboundClassification: summary.lastInboundClassification ?? null,
            reminderDue: Boolean(summary.reminderDue),
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

/**
 * Org-scoped unread count for the navigation badge. Uses the SAME predicate as the Unread view
 * (not archived, has inbound, no read row at/after the last inbound) so the badge can never show a
 * number the list then fails to produce.
 */
export async function getUnreadCount(params: { organizationId: string; userId: string }): Promise<number> {
    const rows = await db
        .select({ count: sql<string>`count(*)` })
        .from(outreachConversations)
        .where(and(
            eq(outreachConversations.organizationId, params.organizationId),
            NOT_ARCHIVED,
            sql`(${unreadPredicate(params.userId)})`,
        ))
    return Number(rows[0]?.count ?? 0)
}

/**
 * The four rail counters in one round trip, built from the exact predicates the list views use
 * (NEEDS_REPLY / AWAITING / unread / active-and-due reminder), tenant-scoped first like every other
 * query here.
 */
export async function getInboxCounts(params: { organizationId: string; userId: string }): Promise<InboxCounts> {
    const rows = await db
        .select({
            needsReply: sql<string>`count(*) FILTER (WHERE ${NEEDS_REPLY})`,
            awaiting: sql<string>`count(*) FILTER (WHERE ${AWAITING})`,
            unread: sql<string>`count(*) FILTER (WHERE ${NOT_ARCHIVED} AND (${unreadPredicate(params.userId)}))`,
            remindersActive: sql<string>`count(*) FILTER (WHERE ${reminderPredicate(params.userId, 'active')})`,
            remindersDue: sql<string>`count(*) FILTER (WHERE ${reminderPredicate(params.userId, 'due')})`,
        })
        .from(outreachConversations)
        .where(eq(outreachConversations.organizationId, params.organizationId))
    const row = rows[0]
    return {
        needsReply: Number(row?.needsReply ?? 0),
        awaiting: Number(row?.awaiting ?? 0),
        unread: Number(row?.unread ?? 0),
        remindersActive: Number(row?.remindersActive ?? 0),
        remindersDue: Number(row?.remindersDue ?? 0),
    }
}

// ------------------------------------------------------------
// Read state (per user, idempotent)
// ------------------------------------------------------------

export async function setConversationReadState(params: {
    organizationId: string
    conversationId: string
    userId: string
    read: boolean
    /**
     * The `lastMessageAt` of the conversation as the client RENDERED it. Marking read covers up to
     * that point and no further: a message that landed between the client's fetch and this call
     * stays unread instead of being silently swallowed by a blind "read up to now".
     */
    upTo?: Date | null
}): Promise<ReadStateResult> {
    const { organizationId, conversationId, userId, read } = params

    const convRows = await db
        .select({ id: outreachConversations.id })
        .from(outreachConversations)
        .where(and(
            eq(outreachConversations.organizationId, organizationId),
            eq(outreachConversations.id, conversationId),
        ))
        .limit(1)

    if (!convRows[0]) return { found: false, unread: false }

    if (read) {
        // Read watermark = LEAST(server last_message_at, client upTo). JSON carries milliseconds
        // but the column can hold microseconds, so upTo is widened by one millisecond before the
        // comparison; otherwise a message the client genuinely saw at .123456 would be "newer"
        // than its own .123 echo and the conversation would stay unread forever. The widening
        // cannot swallow a later message in practice (it would have to land in the same ms).
        // Computed in SQL so no timestamp is round-tripped through a JS Date.
        const upTo = params.upTo && !Number.isNaN(params.upTo.getTime()) ? params.upTo.toISOString() : null
        // Idempotent: GREATEST never moves the watermark backward, and the unique
        // (org, conversation, user) key means a second call updates the same single row.
        // Provider time is used for the watermark (last_inbound_at is provider time too, so the
        // two stay comparable); ingestion time would require a second timestamp on every message.
        await db.execute(sql`
            INSERT INTO outreach_conversation_reads
                (organization_id, conversation_id, user_id, last_read_message_id, last_read_at)
            SELECT c.organization_id, c.id, ${userId}::uuid,
                (
                    SELECT m.id FROM outreach_conversation_messages m
                    WHERE m.organization_id = c.organization_id
                      AND m.conversation_id = c.id
                      AND COALESCE(m.received_at, m.sent_at, m.created_at) <= w.ts
                    ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC, m.id DESC
                    LIMIT 1
                ),
                w.ts
            FROM outreach_conversations c
            CROSS JOIN LATERAL (
                SELECT CASE
                    WHEN ${upTo}::timestamp IS NULL THEN COALESCE(c.last_message_at, now())
                    ELSE LEAST(
                        COALESCE(c.last_message_at, now()),
                        ${upTo}::timestamp + interval '1 millisecond'
                    )
                END AS ts
            ) w
            WHERE c.organization_id = ${organizationId}::uuid AND c.id = ${conversationId}::uuid
            ON CONFLICT (organization_id, conversation_id, user_id) DO UPDATE SET
                last_read_message_id = CASE
                    WHEN excluded.last_read_at >= outreach_conversation_reads.last_read_at
                        THEN excluded.last_read_message_id
                    ELSE outreach_conversation_reads.last_read_message_id
                END,
                last_read_at = GREATEST(outreach_conversation_reads.last_read_at, excluded.last_read_at),
                updated_at = now()
        `)
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

const SYNC_STATUS_TTL_MS = 15_000
const syncStatusCache = new Map<string, { at: number; value: AccountSyncStatusDto[] }>()

/** Test seam: drop the short-lived per-organization sync-status cache. */
export function clearAccountSyncStatusCache(): void {
    syncStatusCache.clear()
}

/**
 * Sync health changes on the scale of ingestion ticks (minutes), but the list endpoint is hit on
 * every page, filter change and SSE-triggered refetch. A 15s per-organization cache keeps the
 * degraded badge fresh enough without re-reading the cursor table on each of those.
 */
export async function getAccountSyncStatusCached(
    organizationId: string,
    now: number = Date.now(),
): Promise<AccountSyncStatusDto[]> {
    const hit = syncStatusCache.get(organizationId)
    if (hit && now - hit.at < SYNC_STATUS_TTL_MS) return hit.value
    const value = await getAccountSyncStatus(organizationId)
    syncStatusCache.set(organizationId, { at: now, value })
    return value
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
