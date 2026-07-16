// ============================================================
// Unified Inbox operator services (Phase 22 UIX-04 / UIX-05)
// ============================================================
// Durable, organization-scoped operator mutations: labels, archive/status, reminders,
// snippets, bounded bulk actions, and durable send-command creation. EVERY function takes an
// already-authorized `organizationId` (the route ran requireOutreachRead/Write) and puts
// `organization_id = <organizationId>` at the head of every query/mutation. No conversation,
// label, reminder, snippet, or command id is ever trusted without its organization predicate,
// so a resource in another tenant is indistinguishable from a missing one.
//
// Errors are thrown as InboxOperatorError with an HTTP status + stable code; the route maps
// them. Services never write the response.

import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
    inboxConversationLabels,
    inboxLabels,
    inboxReminders,
    inboxSendCommands,
    inboxSnippets,
    outreachConversations,
    outreachConversationReads,
    type InboxReminderStatus,
    type InboxRecipient,
    type InboxSendCommandMode,
} from '../../db/schema'

// The hard server-side ceiling on a single bulk action. A request may never mutate more than
// this many conversations, and it can only ever touch ids that belong to the organization.
export const BULK_CONVERSATION_LIMIT = 100

export class InboxOperatorError extends Error {
    status: number
    code: string
    constructor(status: number, code: string, message?: string) {
        super(message ?? code)
        this.name = 'InboxOperatorError'
        this.status = status
        this.code = code
    }
}

const notFound = (code = 'not_found') => new InboxOperatorError(404, code, 'Not found')
const conflict = (code = 'conflict') => new InboxOperatorError(409, code, 'Conflict')
const forbidden = (code = 'forbidden') => new InboxOperatorError(403, code, 'Forbidden')
const badRequest = (code = 'bad_request') => new InboxOperatorError(400, code, 'Bad request')

function isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
}

// ------------------------------------------------------------
// DTOs
// ------------------------------------------------------------

export interface InboxLabelDto {
    id: string
    name: string
    color: string | null
    createdAt: Date
    updatedAt: Date
}

export interface InboxReminderDto {
    id: string
    conversationId: string
    userId: string
    remindAt: Date
    note: string | null
    status: InboxReminderStatus
    notifiedAt: Date | null
    createdAt: Date
    updatedAt: Date
}

export interface InboxSnippetDto {
    id: string
    name: string
    body: string
    shortcut: string | null
    createdAt: Date
    updatedAt: Date
}

export interface InboxSendCommandDto {
    id: string
    conversationId: string
    status: string
    mode: InboxSendCommandMode
    scheduledAt: Date | null
    dueAt: Date
    attempts: number
    idempotencyKey: string
    createdAt: Date
    updatedAt: Date
}

export interface ConversationStateDto {
    id: string
    status: string
    archived: boolean
    updatedAt: Date
}

export interface BulkUpdateResult {
    matched: number
    updated: number
    skipped: number
}

// ------------------------------------------------------------
// Shared org-scoping guards
// ------------------------------------------------------------

async function conversationInOrg(organizationId: string, conversationId: string): Promise<boolean> {
    const rows = await db
        .select({ id: outreachConversations.id })
        .from(outreachConversations)
        .where(and(
            eq(outreachConversations.organizationId, organizationId),
            eq(outreachConversations.id, conversationId),
        ))
        .limit(1)
    return rows.length === 1
}

async function labelInOrg(organizationId: string, labelId: string): Promise<boolean> {
    const rows = await db
        .select({ id: inboxLabels.id })
        .from(inboxLabels)
        .where(and(eq(inboxLabels.organizationId, organizationId), eq(inboxLabels.id, labelId)))
        .limit(1)
    return rows.length === 1
}

// ------------------------------------------------------------
// Labels
// ------------------------------------------------------------

function toLabelDto(row: typeof inboxLabels.$inferSelect): InboxLabelDto {
    return { id: row.id, name: row.name, color: row.color, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

export async function listInboxLabels(organizationId: string): Promise<InboxLabelDto[]> {
    const rows = await db
        .select()
        .from(inboxLabels)
        .where(eq(inboxLabels.organizationId, organizationId))
        .orderBy(asc(inboxLabels.name))
    return rows.map(toLabelDto)
}

export async function createInboxLabel(input: {
    organizationId: string
    userId: string
    name: string
    color?: string | null
}): Promise<InboxLabelDto> {
    const name = input.name.trim()
    if (!name) throw badRequest('label_name_required')
    try {
        const [row] = await db
            .insert(inboxLabels)
            .values({
                organizationId: input.organizationId,
                name,
                color: input.color ?? null,
                createdByUserId: input.userId,
            })
            .returning()
        return toLabelDto(row)
    } catch (error) {
        if (isUniqueViolation(error)) throw conflict('label_name_taken')
        throw error
    }
}

export async function updateInboxLabel(input: {
    organizationId: string
    labelId: string
    name?: string
    color?: string | null
}): Promise<InboxLabelDto> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (input.name !== undefined) {
        const name = input.name.trim()
        if (!name) throw badRequest('label_name_required')
        set.name = name
    }
    if (input.color !== undefined) set.color = input.color
    try {
        const rows = await db
            .update(inboxLabels)
            .set(set)
            .where(and(eq(inboxLabels.organizationId, input.organizationId), eq(inboxLabels.id, input.labelId)))
            .returning()
        if (rows.length === 0) throw notFound('label_not_found')
        return toLabelDto(rows[0])
    } catch (error) {
        if (isUniqueViolation(error)) throw conflict('label_name_taken')
        throw error
    }
}

export async function deleteInboxLabel(organizationId: string, labelId: string): Promise<void> {
    const rows = await db
        .delete(inboxLabels)
        .where(and(eq(inboxLabels.organizationId, organizationId), eq(inboxLabels.id, labelId)))
        .returning({ id: inboxLabels.id })
    if (rows.length === 0) throw notFound('label_not_found')
}

/** Idempotent attach: attaching a label already present is a no-op success. */
export async function attachConversationLabel(input: {
    organizationId: string
    conversationId: string
    labelId: string
    userId: string
}): Promise<void> {
    if (!(await conversationInOrg(input.organizationId, input.conversationId))) throw notFound('conversation_not_found')
    if (!(await labelInOrg(input.organizationId, input.labelId))) throw notFound('label_not_found')
    await db
        .insert(inboxConversationLabels)
        .values({
            organizationId: input.organizationId,
            conversationId: input.conversationId,
            labelId: input.labelId,
            createdByUserId: input.userId,
        })
        .onConflictDoNothing()
}

/** Idempotent detach: detaching a label that is not present is a no-op success. */
export async function detachConversationLabel(input: {
    organizationId: string
    conversationId: string
    labelId: string
}): Promise<void> {
    if (!(await conversationInOrg(input.organizationId, input.conversationId))) throw notFound('conversation_not_found')
    await db
        .delete(inboxConversationLabels)
        .where(and(
            eq(inboxConversationLabels.organizationId, input.organizationId),
            eq(inboxConversationLabels.conversationId, input.conversationId),
            eq(inboxConversationLabels.labelId, input.labelId),
        ))
}

// ------------------------------------------------------------
// Conversation status / archive (explicit, single-conversation)
// ------------------------------------------------------------

async function conversationStateDto(organizationId: string, conversationId: string): Promise<ConversationStateDto | null> {
    const rows = await db
        .select({
            id: outreachConversations.id,
            status: outreachConversations.status,
            archivedAt: outreachConversations.archivedAt,
            updatedAt: outreachConversations.updatedAt,
        })
        .from(outreachConversations)
        .where(and(eq(outreachConversations.organizationId, organizationId), eq(outreachConversations.id, conversationId)))
        .limit(1)
    const row = rows[0]
    if (!row) return null
    return { id: row.id, status: row.status, archived: row.archivedAt != null, updatedAt: row.updatedAt }
}

export async function setConversationStatus(input: {
    organizationId: string
    conversationId: string
    status: 'open' | 'closed'
}): Promise<ConversationStateDto> {
    const rows = await db
        .update(outreachConversations)
        .set({ status: input.status, updatedAt: new Date() })
        .where(and(eq(outreachConversations.organizationId, input.organizationId), eq(outreachConversations.id, input.conversationId)))
        .returning({ id: outreachConversations.id })
    if (rows.length === 0) throw notFound('conversation_not_found')
    return (await conversationStateDto(input.organizationId, input.conversationId))!
}

export async function setConversationArchived(input: {
    organizationId: string
    conversationId: string
    userId: string
    archived: boolean
}): Promise<ConversationStateDto> {
    const rows = await db
        .update(outreachConversations)
        .set({
            archivedAt: input.archived ? new Date() : null,
            archivedByUserId: input.archived ? input.userId : null,
            updatedAt: new Date(),
        })
        .where(and(eq(outreachConversations.organizationId, input.organizationId), eq(outreachConversations.id, input.conversationId)))
        .returning({ id: outreachConversations.id })
    if (rows.length === 0) throw notFound('conversation_not_found')
    return (await conversationStateDto(input.organizationId, input.conversationId))!
}

// ------------------------------------------------------------
// Bounded, transactional bulk actions
// ------------------------------------------------------------

export type BulkConversationAction =
    | 'read'
    | 'unread'
    | 'status'
    | 'archive'
    | 'unarchive'
    | 'add_label'
    | 'remove_label'

export interface BulkUpdateInput {
    organizationId: string
    userId: string
    conversationIds: string[]
    action: BulkConversationAction
    status?: 'open' | 'closed'
    labelId?: string
}

/**
 * Bounded, transactional bulk update. Rejects >100 ids, an empty list, and duplicate ids. It
 * NEVER broadens to the whole organization: it first resolves which of the requested ids
 * actually belong to the org (matched), and every mutation is keyed on that matched set. Ids
 * in another tenant simply do not match and are reported as skipped.
 */
export async function bulkUpdateConversations(input: BulkUpdateInput): Promise<BulkUpdateResult> {
    const { organizationId, userId, conversationIds, action } = input

    if (conversationIds.length === 0) throw badRequest('bulk_empty')
    if (conversationIds.length > BULK_CONVERSATION_LIMIT) throw badRequest('bulk_too_many')
    if (new Set(conversationIds).size !== conversationIds.length) throw badRequest('bulk_duplicate_ids')

    if (action === 'status' && input.status !== 'open' && input.status !== 'closed') throw badRequest('bulk_status_required')
    if ((action === 'add_label' || action === 'remove_label') && !input.labelId) throw badRequest('bulk_label_required')

    return db.transaction(async (tx) => {
        // Resolve the matched set under the org predicate — the ONLY ids any mutation may touch.
        const matchedRows = await tx
            .select({ id: outreachConversations.id })
            .from(outreachConversations)
            .where(and(
                eq(outreachConversations.organizationId, organizationId),
                inArray(outreachConversations.id, conversationIds),
            ))
        const matchedIds = matchedRows.map((r) => r.id)
        const matched = matchedIds.length
        const skipped = conversationIds.length - matched
        if (matched === 0) return { matched, updated: 0, skipped }

        let updated = 0
        switch (action) {
            case 'read': {
                // Watermark each matched conversation to its last_message_at for this user.
                const convs = await tx
                    .select({
                        id: outreachConversations.id,
                        lastMessageId: outreachConversations.lastMessageId,
                        lastMessageAt: outreachConversations.lastMessageAt,
                    })
                    .from(outreachConversations)
                    .where(and(
                        eq(outreachConversations.organizationId, organizationId),
                        inArray(outreachConversations.id, matchedIds),
                    ))
                const now = new Date()
                const res = await tx
                    .insert(outreachConversationReads)
                    .values(convs.map((c) => ({
                        organizationId,
                        conversationId: c.id,
                        userId,
                        lastReadMessageId: c.lastMessageId ?? null,
                        lastReadAt: c.lastMessageAt ?? now,
                    })))
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
                    .returning({ id: outreachConversationReads.id })
                updated = res.length
                break
            }
            case 'unread': {
                const res = await tx
                    .delete(outreachConversationReads)
                    .where(and(
                        eq(outreachConversationReads.organizationId, organizationId),
                        eq(outreachConversationReads.userId, userId),
                        inArray(outreachConversationReads.conversationId, matchedIds),
                    ))
                    .returning({ id: outreachConversationReads.id })
                updated = res.length
                break
            }
            case 'status': {
                const res = await tx
                    .update(outreachConversations)
                    .set({ status: input.status!, updatedAt: new Date() })
                    .where(and(
                        eq(outreachConversations.organizationId, organizationId),
                        inArray(outreachConversations.id, matchedIds),
                    ))
                    .returning({ id: outreachConversations.id })
                updated = res.length
                break
            }
            case 'archive':
            case 'unarchive': {
                const archiving = action === 'archive'
                const res = await tx
                    .update(outreachConversations)
                    .set({
                        archivedAt: archiving ? new Date() : null,
                        archivedByUserId: archiving ? userId : null,
                        updatedAt: new Date(),
                    })
                    .where(and(
                        eq(outreachConversations.organizationId, organizationId),
                        inArray(outreachConversations.id, matchedIds),
                        archiving
                            ? sql`${outreachConversations.archivedAt} IS NULL`
                            : sql`${outreachConversations.archivedAt} IS NOT NULL`,
                    ))
                    .returning({ id: outreachConversations.id })
                updated = res.length
                break
            }
            case 'add_label': {
                // The label must belong to the org; a cross-tenant label id is rejected outright.
                const labelRows = await tx
                    .select({ id: inboxLabels.id })
                    .from(inboxLabels)
                    .where(and(eq(inboxLabels.organizationId, organizationId), eq(inboxLabels.id, input.labelId!)))
                    .limit(1)
                if (labelRows.length === 0) throw notFound('label_not_found')
                const res = await tx
                    .insert(inboxConversationLabels)
                    .values(matchedIds.map((id) => ({
                        organizationId,
                        conversationId: id,
                        labelId: input.labelId!,
                        createdByUserId: userId,
                    })))
                    .onConflictDoNothing()
                    .returning({ id: inboxConversationLabels.id })
                updated = res.length
                break
            }
            case 'remove_label': {
                const res = await tx
                    .delete(inboxConversationLabels)
                    .where(and(
                        eq(inboxConversationLabels.organizationId, organizationId),
                        eq(inboxConversationLabels.labelId, input.labelId!),
                        inArray(inboxConversationLabels.conversationId, matchedIds),
                    ))
                    .returning({ id: inboxConversationLabels.id })
                updated = res.length
                break
            }
        }

        return { matched, updated, skipped }
    })
}

// ------------------------------------------------------------
// Reminders
// ------------------------------------------------------------

function toReminderDto(row: typeof inboxReminders.$inferSelect): InboxReminderDto {
    return {
        id: row.id,
        conversationId: row.conversationId,
        userId: row.userId,
        remindAt: row.remindAt,
        note: row.note,
        status: row.status,
        notifiedAt: row.notifiedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    }
}

export async function listConversationReminders(organizationId: string, conversationId: string): Promise<InboxReminderDto[]> {
    if (!(await conversationInOrg(organizationId, conversationId))) throw notFound('conversation_not_found')
    const rows = await db
        .select()
        .from(inboxReminders)
        .where(and(eq(inboxReminders.organizationId, organizationId), eq(inboxReminders.conversationId, conversationId)))
        .orderBy(asc(inboxReminders.remindAt))
    return rows.map(toReminderDto)
}

export async function createInboxReminder(input: {
    organizationId: string
    conversationId: string
    userId: string
    remindAt: Date
    note?: string | null
}): Promise<InboxReminderDto> {
    if (Number.isNaN(input.remindAt.getTime())) throw badRequest('reminder_time_invalid')
    if (!(await conversationInOrg(input.organizationId, input.conversationId))) throw notFound('conversation_not_found')
    const [row] = await db
        .insert(inboxReminders)
        .values({
            organizationId: input.organizationId,
            conversationId: input.conversationId,
            userId: input.userId,
            remindAt: input.remindAt,
            note: input.note ?? null,
            status: 'scheduled',
        })
        .returning()
    return toReminderDto(row)
}

export async function updateInboxReminder(input: {
    organizationId: string
    reminderId: string
    actorUserId: string
    actorRole: string
    remindAt?: Date
    note?: string | null
    status?: InboxReminderStatus
}): Promise<InboxReminderDto> {
    const existing = await db
        .select()
        .from(inboxReminders)
        .where(and(eq(inboxReminders.organizationId, input.organizationId), eq(inboxReminders.id, input.reminderId)))
        .limit(1)
    const reminder = existing[0]
    if (!reminder) throw notFound('reminder_not_found')
    // Only the creator or an organization admin may edit another user's reminder.
    if (reminder.userId !== input.actorUserId && input.actorRole !== 'admin') throw forbidden('reminder_not_owner')

    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (input.remindAt !== undefined) {
        if (Number.isNaN(input.remindAt.getTime())) throw badRequest('reminder_time_invalid')
        set.remindAt = input.remindAt
        // Rescheduling a notified/done reminder revives it as scheduled unless a status is given.
        if (input.status === undefined) set.status = 'scheduled'
    }
    if (input.note !== undefined) set.note = input.note
    if (input.status !== undefined) {
        set.status = input.status
        if (input.status !== 'notified') set.notifiedAt = null
    }
    const [row] = await db
        .update(inboxReminders)
        .set(set)
        .where(and(eq(inboxReminders.organizationId, input.organizationId), eq(inboxReminders.id, input.reminderId)))
        .returning()
    return toReminderDto(row)
}

export async function deleteInboxReminder(input: {
    organizationId: string
    reminderId: string
    actorUserId: string
    actorRole: string
}): Promise<void> {
    const existing = await db
        .select({ id: inboxReminders.id, userId: inboxReminders.userId })
        .from(inboxReminders)
        .where(and(eq(inboxReminders.organizationId, input.organizationId), eq(inboxReminders.id, input.reminderId)))
        .limit(1)
    const reminder = existing[0]
    if (!reminder) throw notFound('reminder_not_found')
    if (reminder.userId !== input.actorUserId && input.actorRole !== 'admin') throw forbidden('reminder_not_owner')
    await db
        .delete(inboxReminders)
        .where(and(eq(inboxReminders.organizationId, input.organizationId), eq(inboxReminders.id, input.reminderId)))
}

export interface ReminderDueSummary {
    dueCount: number
    upcomingCount: number
    due: InboxReminderDto[]
}

/** The calling user's due (remind_at <= now) and upcoming scheduled reminders. */
export async function getReminderDueSummary(organizationId: string, userId: string, now = new Date()): Promise<ReminderDueSummary> {
    const rows = await db
        .select()
        .from(inboxReminders)
        .where(and(
            eq(inboxReminders.organizationId, organizationId),
            eq(inboxReminders.userId, userId),
            eq(inboxReminders.status, 'scheduled'),
        ))
        .orderBy(asc(inboxReminders.remindAt))
    const due = rows.filter((r) => r.remindAt.getTime() <= now.getTime())
    return {
        dueCount: due.length,
        upcomingCount: rows.length - due.length,
        due: due.map(toReminderDto),
    }
}

// ------------------------------------------------------------
// Snippets
// ------------------------------------------------------------

// Snippet bodies are plain/rich text only — never scriptable HTML. Reject <script>, inline
// event handlers, and javascript:/data: URLs so a stored snippet can't inject script when
// rendered.
const SCRIPTABLE_PATTERNS = [
    /<\s*script\b/i,
    /<\s*\/\s*script\s*>/i,
    /<\s*iframe\b/i,
    /\bon[a-z]+\s*=/i,
    /javascript\s*:/i,
    /data\s*:\s*text\/html/i,
]

function assertSafeSnippetBody(body: string): void {
    if (SCRIPTABLE_PATTERNS.some((re) => re.test(body))) throw badRequest('snippet_scriptable_html')
}

function toSnippetDto(row: typeof inboxSnippets.$inferSelect): InboxSnippetDto {
    return {
        id: row.id,
        name: row.name,
        body: row.body,
        shortcut: row.shortcut,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    }
}

export async function listInboxSnippets(organizationId: string): Promise<InboxSnippetDto[]> {
    const rows = await db
        .select()
        .from(inboxSnippets)
        .where(eq(inboxSnippets.organizationId, organizationId))
        .orderBy(asc(inboxSnippets.name))
    return rows.map(toSnippetDto)
}

export async function createInboxSnippet(input: {
    organizationId: string
    userId: string
    name: string
    body: string
    shortcut?: string | null
}): Promise<InboxSnippetDto> {
    const name = input.name.trim()
    if (!name) throw badRequest('snippet_name_required')
    assertSafeSnippetBody(input.body)
    try {
        const [row] = await db
            .insert(inboxSnippets)
            .values({
                organizationId: input.organizationId,
                createdByUserId: input.userId,
                name,
                body: input.body,
                shortcut: input.shortcut ?? null,
            })
            .returning()
        return toSnippetDto(row)
    } catch (error) {
        if (isUniqueViolation(error)) throw conflict('snippet_name_taken')
        throw error
    }
}

export async function updateInboxSnippet(input: {
    organizationId: string
    snippetId: string
    name?: string
    body?: string
    shortcut?: string | null
}): Promise<InboxSnippetDto> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (input.name !== undefined) {
        const name = input.name.trim()
        if (!name) throw badRequest('snippet_name_required')
        set.name = name
    }
    if (input.body !== undefined) {
        assertSafeSnippetBody(input.body)
        set.body = input.body
    }
    if (input.shortcut !== undefined) set.shortcut = input.shortcut
    try {
        const rows = await db
            .update(inboxSnippets)
            .set(set)
            .where(and(eq(inboxSnippets.organizationId, input.organizationId), eq(inboxSnippets.id, input.snippetId)))
            .returning()
        if (rows.length === 0) throw notFound('snippet_not_found')
        return toSnippetDto(rows[0])
    } catch (error) {
        if (isUniqueViolation(error)) throw conflict('snippet_name_taken')
        throw error
    }
}

export async function deleteInboxSnippet(organizationId: string, snippetId: string): Promise<void> {
    const rows = await db
        .delete(inboxSnippets)
        .where(and(eq(inboxSnippets.organizationId, organizationId), eq(inboxSnippets.id, snippetId)))
        .returning({ id: inboxSnippets.id })
    if (rows.length === 0) throw notFound('snippet_not_found')
}

// ------------------------------------------------------------
// Durable send commands
// ------------------------------------------------------------

function toSendCommandDto(row: typeof inboxSendCommands.$inferSelect): InboxSendCommandDto {
    return {
        id: row.id,
        conversationId: row.conversationId,
        status: row.status,
        mode: row.mode,
        scheduledAt: row.scheduledAt,
        dueAt: row.dueAt,
        attempts: row.attempts,
        idempotencyKey: row.idempotencyKey,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    }
}

function normalizeRecipients(list: InboxRecipient[] | undefined): InboxRecipient[] {
    return (list ?? [])
        .map((r) => ({ address: r.address.trim().toLowerCase(), name: r.name?.trim() || null }))
        .filter((r) => r.address.length > 0)
}

/**
 * Create a durable reply/forward send command. Recipients/headers are snapshotted; the command
 * is claimed and dispatched by processInboxCommands (Task 3). Idempotent per
 * (organization, idempotencyKey): a duplicate submit returns the existing command instead of
 * creating a second one. The composite FKs guarantee the conversation/account belong to the org.
 */
export async function createInboxSendCommand(input: {
    organizationId: string
    conversationId: string
    actorUserId: string
    emailAccountId: string
    mode: InboxSendCommandMode
    sourceMessageId?: string | null
    to: InboxRecipient[]
    cc?: InboxRecipient[]
    bcc?: InboxRecipient[]
    subject?: string | null
    bodyText?: string | null
    bodyHtml?: string | null
    inReplyTo?: string | null
    references?: string | null
    attachmentIds?: string[]
    scheduledAt?: Date | null
    idempotencyKey?: string
    now?: Date
}): Promise<{ command: InboxSendCommandDto; created: boolean }> {
    const now = input.now ?? new Date()

    if (!(await conversationInOrg(input.organizationId, input.conversationId))) throw notFound('conversation_not_found')

    const to = normalizeRecipients(input.to)
    if (to.length === 0) throw badRequest('recipients_required')
    const cc = normalizeRecipients(input.cc)
    const bcc = normalizeRecipients(input.bcc)

    if (input.scheduledAt && Number.isNaN(input.scheduledAt.getTime())) throw badRequest('scheduled_time_invalid')
    const dueAt = input.scheduledAt ?? now
    const idempotencyKey = input.idempotencyKey?.trim() || `inbox-cmd:${randomUUID()}`

    try {
        const inserted = await db
            .insert(inboxSendCommands)
            .values({
                organizationId: input.organizationId,
                conversationId: input.conversationId,
                actorUserId: input.actorUserId,
                emailAccountId: input.emailAccountId,
                sourceMessageId: input.sourceMessageId ?? null,
                mode: input.mode,
                toRecipients: to,
                ccRecipients: cc,
                bccRecipients: bcc,
                subject: input.subject ?? null,
                bodyText: input.bodyText ?? null,
                bodyHtml: input.bodyHtml ?? null,
                inReplyTo: input.inReplyTo ?? null,
                messageReferences: input.references ?? null,
                attachmentIds: input.attachmentIds ?? [],
                status: 'scheduled',
                scheduledAt: input.scheduledAt ?? null,
                dueAt,
                idempotencyKey,
            })
            .onConflictDoNothing({ target: [inboxSendCommands.organizationId, inboxSendCommands.idempotencyKey] })
            .returning()
        if (inserted.length > 0) return { command: toSendCommandDto(inserted[0]), created: true }
    } catch (error) {
        // A cross-tenant conversation/account is blocked by the composite FK (23503).
        if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503') {
            throw badRequest('command_tenant_mismatch')
        }
        throw error
    }

    // Idempotent replay: the command already exists for this key.
    const existing = await db
        .select()
        .from(inboxSendCommands)
        .where(and(
            eq(inboxSendCommands.organizationId, input.organizationId),
            eq(inboxSendCommands.idempotencyKey, idempotencyKey),
        ))
        .limit(1)
    if (existing.length === 0) throw new InboxOperatorError(500, 'command_persist_failed')
    return { command: toSendCommandDto(existing[0]), created: false }
}

/** Cancel a not-yet-sent command. Terminal or in-flight (leased 'sending') commands cannot be cancelled. */
export async function cancelInboxSendCommand(organizationId: string, commandId: string): Promise<InboxSendCommandDto> {
    const cancelled = await db
        .update(inboxSendCommands)
        .set({ status: 'cancelled', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
        .where(and(
            eq(inboxSendCommands.organizationId, organizationId),
            eq(inboxSendCommands.id, commandId),
            inArray(inboxSendCommands.status, ['draft', 'scheduled', 'queued']),
        ))
        .returning()
    if (cancelled.length > 0) return toSendCommandDto(cancelled[0])

    // Distinguish missing from not-cancellable.
    const existing = await db
        .select()
        .from(inboxSendCommands)
        .where(and(eq(inboxSendCommands.organizationId, organizationId), eq(inboxSendCommands.id, commandId)))
        .limit(1)
    if (existing.length === 0) throw notFound('command_not_found')
    throw conflict('command_not_cancellable')
}

export async function getInboxSendCommand(organizationId: string, commandId: string): Promise<InboxSendCommandDto | null> {
    const rows = await db
        .select()
        .from(inboxSendCommands)
        .where(and(eq(inboxSendCommands.organizationId, organizationId), eq(inboxSendCommands.id, commandId)))
        .limit(1)
    return rows[0] ? toSendCommandDto(rows[0]) : null
}
