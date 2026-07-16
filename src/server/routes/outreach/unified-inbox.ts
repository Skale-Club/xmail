import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireOutreachRead, requireOutreachWrite, type OutreachMembership } from '../../lib/outreach-access'
import { ConversationCursorError } from '../../lib/unified-inbox/cursor'
import {
    getAccountSyncStatus,
    getConversationDetail,
    getUnreadCount,
    listConversations,
    setConversationReadState,
    type ConversationListFilters,
} from '../../lib/unified-inbox/queries'
import {
    InboxOperatorError,
    BULK_CONVERSATION_LIMIT,
    attachConversationLabel,
    bulkUpdateConversations,
    cancelInboxSendCommand,
    createInboxLabel,
    createInboxReminder,
    createInboxSendCommand,
    createInboxSnippet,
    deleteInboxLabel,
    deleteInboxReminder,
    deleteInboxSnippet,
    detachConversationLabel,
    getInboxSendCommand,
    getReminderDueSummary,
    listConversationReminders,
    listInboxLabels,
    listInboxSnippets,
    setConversationArchived,
    setConversationStatus,
    updateInboxLabel,
    updateInboxReminder,
    updateInboxSnippet,
    type BulkConversationAction,
} from '../../lib/inbox-operator'
import {
    applySuppression,
    previewSuppression,
    type SuppressionScope,
} from '../../lib/inbox-suppression'

// ============================================================
// Unified Inbox read API (Phase 21 UIF-04 / UIF-05)
// ============================================================
// The four locked read-side endpoints from 21-CONTEXT. Phase 21 is READ-ONLY apart
// from per-user read state; reply/forward/actions are Phase 22.
//
//   GET   /conversations                         list + filter + bounded search (opaque cursor)
//   GET   /conversations/:id                     full ordered thread + attribution/participants
//   GET   /unread-count                          org-scoped unread count for the current user
//   PATCH /conversations/:id/read-state          { read } — per-user, idempotent
//
// EVERY route resolves and authorizes the organization scope (requireOutreachRead)
// BEFORE any tenant data query. A conversation id that is not inside the authorized
// organization returns 404 — indistinguishable from a genuinely missing id — so
// existence never leaks across tenants. Viewers get the same read access as
// members/admins and may manage only their OWN read state.

const router = Router()

const uuid = z.string().uuid()

const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(4096).optional(),
    unread: z.enum(['true', 'false']).optional(),
    status: z.enum(['open', 'closed']).optional(),
    campaignId: z.string().uuid().optional(),
    emailAccountId: z.string().uuid().optional(),
    search: z.string().trim().max(200).optional(),
    // Phase 22 operator filters.
    labelId: z.string().uuid().optional(),
    reminderState: z.enum(['active', 'due']).optional(),
    archived: z.enum(['true', 'false']).optional(),
})

const readStateBodySchema = z.object({
    read: z.boolean(),
})

const recipientSchema = z.object({
    address: z.string().trim().email().max(320),
    name: z.string().trim().max(200).nullish(),
})

/** Maps a thrown InboxOperatorError (or Zod/cursor errors) to a response. Returns true if handled. */
function handleOperatorError(error: unknown, res: Response, context: string): void {
    if (error instanceof InboxOperatorError) {
        res.status(error.status).json({ error: error.code })
        return
    }
    if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation error', details: error.errors })
        return
    }
    console.error(`Error ${context}:`, error)
    res.status(500).json({ error: 'Internal server error' })
}

/**
 * Shared front door: authenticate, require an organization id (400 if absent/invalid),
 * then authorize read access to it (401/403). Returns the validated organization id, or
 * null when a response has already been written.
 */
async function authorizeOrganization(req: Request, res: Response): Promise<string | null> {
    const userId = req.headers['x-user-id'] as string | undefined
    if (!userId) {
        res.status(401).json({ error: 'Unauthorized' })
        return null
    }
    const organizationId = req.query.organizationId as string | undefined
    if (!organizationId || !uuid.safeParse(organizationId).success) {
        res.status(400).json({ error: 'organizationId is required' })
        return null
    }
    const membership = await requireOutreachRead(req, res, organizationId)
    if (!membership) return null
    return organizationId
}

interface WriteContext {
    organizationId: string
    userId: string
    membership: OutreachMembership
}

/**
 * Front door for mutations: authenticate, require + authorize an organization id, and require
 * WRITE access (org admin/member; viewers are read-only). Returns the write context or null
 * when a response has already been written.
 */
async function authorizeWrite(req: Request, res: Response): Promise<WriteContext | null> {
    const userId = req.headers['x-user-id'] as string | undefined
    if (!userId) {
        res.status(401).json({ error: 'Unauthorized' })
        return null
    }
    const organizationId = req.query.organizationId as string | undefined
    if (!organizationId || !uuid.safeParse(organizationId).success) {
        res.status(400).json({ error: 'organizationId is required' })
        return null
    }
    const membership = await requireOutreachWrite(req, res, organizationId)
    if (!membership) return null
    return { organizationId, userId, membership }
}

// GET /conversations — bounded, tenant-scoped, opaque-cursor list.
router.get('/conversations', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        const userId = req.headers['x-user-id'] as string

        const parsed = listQuerySchema.parse(req.query)
        const trimmedSearch = parsed.search?.trim()
        const filters: ConversationListFilters = {
            unread: parsed.unread === 'true',
            status: parsed.status ?? null,
            campaignId: parsed.campaignId ?? null,
            emailAccountId: parsed.emailAccountId ?? null,
            search: trimmedSearch && trimmedSearch.length > 0 ? trimmedSearch : null,
            labelId: parsed.labelId ?? null,
            reminderState: parsed.reminderState ?? null,
            archived: parsed.archived === undefined ? null : parsed.archived === 'true',
        }

        const result = await listConversations({
            organizationId,
            userId,
            filters,
            limit: parsed.limit,
            cursor: parsed.cursor ?? null,
        })

        // Sanitized per-account sync status (no cursor tokens / credentials) so the UI can
        // surface a degraded-sync badge alongside the list.
        const syncStatus = await getAccountSyncStatus(organizationId)

        res.json({
            conversations: result.conversations,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
            count: result.conversations.length,
            syncStatus,
        })
    } catch (error) {
        if (error instanceof ConversationCursorError) {
            return res.status(400).json({ error: 'Invalid or expired cursor' })
        }
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error listing unified inbox conversations:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// GET /unread-count — org-scoped unread count for the current user.
router.get('/unread-count', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        const userId = req.headers['x-user-id'] as string

        const unreadCount = await getUnreadCount({ organizationId, userId })
        res.json({ unreadCount })
    } catch (error) {
        console.error('Error counting unified inbox unread:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// GET /conversations/:id — full ordered thread with bodies, attribution, participants.
router.get('/conversations/:id', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        const userId = req.headers['x-user-id'] as string

        const conversationId = req.params.id
        // A malformed id can only be a not-found — never surface it as a different error class,
        // which would distinguish "invalid" from "belongs to another tenant".
        if (!uuid.safeParse(conversationId).success) {
            return res.status(404).json({ error: 'Conversation not found' })
        }

        const detail = await getConversationDetail({ organizationId, conversationId, userId })
        if (!detail) return res.status(404).json({ error: 'Conversation not found' })

        res.json(detail)
    } catch (error) {
        console.error('Error hydrating unified inbox conversation:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// PATCH /conversations/:id/read-state — { read } — per-user, idempotent.
router.patch('/conversations/:id/read-state', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        const userId = req.headers['x-user-id'] as string

        const conversationId = req.params.id
        if (!uuid.safeParse(conversationId).success) {
            return res.status(404).json({ error: 'Conversation not found' })
        }

        const { read } = readStateBodySchema.parse(req.body)

        const result = await setConversationReadState({ organizationId, conversationId, userId, read })
        if (!result.found) return res.status(404).json({ error: 'Conversation not found' })

        res.json({ conversationId, read, unread: result.unread })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error updating unified inbox read state:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ============================================================
// Operator workflows (Phase 22 UIX-04 / UIX-05)
// ============================================================
// All mutations use requireOutreachWrite; every service call carries the verified
// organizationId, so a conversation/label/reminder/snippet/command id from another tenant is
// indistinguishable from a missing one. Viewers keep read access (labels/snippets/reminders
// lists) but cannot mutate.

const labelBodySchema = z.object({
    name: z.string().trim().min(1).max(80),
    color: z.string().trim().max(32).nullish(),
})
const labelUpdateSchema = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    color: z.string().trim().max(32).nullish(),
})
const attachLabelSchema = z.object({ labelId: z.string().uuid() })
const statusBodySchema = z.object({ status: z.enum(['open', 'closed']) })
const archiveBodySchema = z.object({ archived: z.boolean() })
const bulkSchema = z.object({
    conversationIds: z.array(z.string().uuid()).min(1).max(BULK_CONVERSATION_LIMIT),
    action: z.enum(['read', 'unread', 'status', 'archive', 'unarchive', 'add_label', 'remove_label']),
    status: z.enum(['open', 'closed']).optional(),
    labelId: z.string().uuid().optional(),
})
const reminderBodySchema = z.object({
    remindAt: z.string().datetime(),
    note: z.string().trim().max(1000).nullish(),
})
const reminderUpdateSchema = z.object({
    remindAt: z.string().datetime().optional(),
    note: z.string().trim().max(1000).nullish(),
    status: z.enum(['scheduled', 'notified', 'cancelled', 'done']).optional(),
})
const snippetBodySchema = z.object({
    name: z.string().trim().min(1).max(120),
    body: z.string().max(20000),
    shortcut: z.string().trim().max(64).nullish(),
})
const snippetUpdateSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    body: z.string().max(20000).optional(),
    shortcut: z.string().trim().max(64).nullish(),
})
const suppressionSchema = z.object({
    email: z.string().trim().email().max(320),
    scope: z.enum(['sender', 'domain']),
})
const sendCommandSchema = z.object({
    emailAccountId: z.string().uuid(),
    mode: z.enum(['reply', 'reply_all', 'forward']),
    sourceMessageId: z.string().uuid().nullish(),
    to: z.array(recipientSchema).min(1).max(100),
    cc: z.array(recipientSchema).max(100).optional(),
    bcc: z.array(recipientSchema).max(100).optional(),
    subject: z.string().max(2000).nullish(),
    bodyText: z.string().max(500000).nullish(),
    bodyHtml: z.string().max(1000000).nullish(),
    inReplyTo: z.string().max(2000).nullish(),
    references: z.string().max(8000).nullish(),
    attachmentIds: z.array(z.string().uuid()).max(25).optional(),
    scheduledAt: z.string().datetime().nullish(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
})

// --- Labels ------------------------------------------------

router.get('/labels', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        res.json({ labels: await listInboxLabels(organizationId) })
    } catch (error) {
        handleOperatorError(error, res, 'listing inbox labels')
    }
})

router.post('/labels', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        const body = labelBodySchema.parse(req.body)
        const label = await createInboxLabel({ organizationId: ctx.organizationId, userId: ctx.userId, name: body.name, color: body.color ?? null })
        res.status(201).json({ label })
    } catch (error) {
        handleOperatorError(error, res, 'creating inbox label')
    }
})

router.patch('/labels/:id', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'label_not_found' })
        const body = labelUpdateSchema.parse(req.body)
        const label = await updateInboxLabel({ organizationId: ctx.organizationId, labelId: req.params.id, name: body.name, color: body.color })
        res.json({ label })
    } catch (error) {
        handleOperatorError(error, res, 'updating inbox label')
    }
})

router.delete('/labels/:id', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'label_not_found' })
        await deleteInboxLabel(ctx.organizationId, req.params.id)
        res.json({ success: true })
    } catch (error) {
        handleOperatorError(error, res, 'deleting inbox label')
    }
})

// --- Conversation labels (attach/detach) -------------------

router.post('/conversations/:id/labels', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
        const body = attachLabelSchema.parse(req.body)
        await attachConversationLabel({ organizationId: ctx.organizationId, conversationId: req.params.id, labelId: body.labelId, userId: ctx.userId })
        res.json({ success: true })
    } catch (error) {
        handleOperatorError(error, res, 'attaching conversation label')
    }
})

router.delete('/conversations/:id/labels/:labelId', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
        if (!uuid.safeParse(req.params.labelId).success) return res.status(404).json({ error: 'label_not_found' })
        await detachConversationLabel({ organizationId: ctx.organizationId, conversationId: req.params.id, labelId: req.params.labelId })
        res.json({ success: true })
    } catch (error) {
        handleOperatorError(error, res, 'detaching conversation label')
    }
})

// --- Conversation status / archive -------------------------

router.patch('/conversations/:id/status', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
        const body = statusBodySchema.parse(req.body)
        const conversation = await setConversationStatus({ organizationId: ctx.organizationId, conversationId: req.params.id, status: body.status })
        res.json({ conversation })
    } catch (error) {
        handleOperatorError(error, res, 'setting conversation status')
    }
})

router.patch('/conversations/:id/archive', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
        const body = archiveBodySchema.parse(req.body)
        const conversation = await setConversationArchived({ organizationId: ctx.organizationId, conversationId: req.params.id, userId: ctx.userId, archived: body.archived })
        res.json({ conversation })
    } catch (error) {
        handleOperatorError(error, res, 'archiving conversation')
    }
})

// --- Bounded bulk actions ----------------------------------

router.post('/conversations/bulk', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        const body = bulkSchema.parse(req.body)
        const result = await bulkUpdateConversations({
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            conversationIds: body.conversationIds,
            action: body.action as BulkConversationAction,
            status: body.status,
            labelId: body.labelId,
        })
        res.json(result)
    } catch (error) {
        handleOperatorError(error, res, 'bulk updating conversations')
    }
})

// --- Reminders ---------------------------------------------

router.get('/reminders', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        const userId = req.headers['x-user-id'] as string
        res.json(await getReminderDueSummary(organizationId, userId))
    } catch (error) {
        handleOperatorError(error, res, 'summarizing due reminders')
    }
})

router.get('/conversations/:id/reminders', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
        res.json({ reminders: await listConversationReminders(organizationId, req.params.id) })
    } catch (error) {
        handleOperatorError(error, res, 'listing conversation reminders')
    }
})

router.post('/conversations/:id/reminders', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
        const body = reminderBodySchema.parse(req.body)
        const reminder = await createInboxReminder({
            organizationId: ctx.organizationId,
            conversationId: req.params.id,
            userId: ctx.userId,
            remindAt: new Date(body.remindAt),
            note: body.note ?? null,
        })
        res.status(201).json({ reminder })
    } catch (error) {
        handleOperatorError(error, res, 'creating reminder')
    }
})

router.patch('/reminders/:id', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'reminder_not_found' })
        const body = reminderUpdateSchema.parse(req.body)
        const reminder = await updateInboxReminder({
            organizationId: ctx.organizationId,
            reminderId: req.params.id,
            actorUserId: ctx.userId,
            actorRole: ctx.membership.role,
            remindAt: body.remindAt ? new Date(body.remindAt) : undefined,
            note: body.note,
            status: body.status,
        })
        res.json({ reminder })
    } catch (error) {
        handleOperatorError(error, res, 'updating reminder')
    }
})

router.delete('/reminders/:id', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'reminder_not_found' })
        await deleteInboxReminder({
            organizationId: ctx.organizationId,
            reminderId: req.params.id,
            actorUserId: ctx.userId,
            actorRole: ctx.membership.role,
        })
        res.json({ success: true })
    } catch (error) {
        handleOperatorError(error, res, 'deleting reminder')
    }
})

// --- Snippets ----------------------------------------------

router.get('/snippets', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        res.json({ snippets: await listInboxSnippets(organizationId) })
    } catch (error) {
        handleOperatorError(error, res, 'listing snippets')
    }
})

router.post('/snippets', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        const body = snippetBodySchema.parse(req.body)
        const snippet = await createInboxSnippet({ organizationId: ctx.organizationId, userId: ctx.userId, name: body.name, body: body.body, shortcut: body.shortcut ?? null })
        res.status(201).json({ snippet })
    } catch (error) {
        handleOperatorError(error, res, 'creating snippet')
    }
})

router.patch('/snippets/:id', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'snippet_not_found' })
        const body = snippetUpdateSchema.parse(req.body)
        const snippet = await updateInboxSnippet({ organizationId: ctx.organizationId, snippetId: req.params.id, name: body.name, body: body.body, shortcut: body.shortcut })
        res.json({ snippet })
    } catch (error) {
        handleOperatorError(error, res, 'updating snippet')
    }
})

router.delete('/snippets/:id', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'snippet_not_found' })
        await deleteInboxSnippet(ctx.organizationId, req.params.id)
        res.json({ success: true })
    } catch (error) {
        handleOperatorError(error, res, 'deleting snippet')
    }
})

// --- Durable send commands (created here; claimed/dispatched by processInboxCommands) ---

router.post('/conversations/:id/send-commands', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
        const body = sendCommandSchema.parse(req.body)
        const { command, created } = await createInboxSendCommand({
            organizationId: ctx.organizationId,
            conversationId: req.params.id,
            actorUserId: ctx.userId,
            emailAccountId: body.emailAccountId,
            mode: body.mode,
            sourceMessageId: body.sourceMessageId ?? null,
            to: body.to,
            cc: body.cc,
            bcc: body.bcc,
            subject: body.subject ?? null,
            bodyText: body.bodyText ?? null,
            bodyHtml: body.bodyHtml ?? null,
            inReplyTo: body.inReplyTo ?? null,
            references: body.references ?? null,
            attachmentIds: body.attachmentIds,
            scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
            idempotencyKey: body.idempotencyKey,
        })
        res.status(created ? 201 : 200).json({ command })
    } catch (error) {
        handleOperatorError(error, res, 'creating send command')
    }
})

router.get('/send-commands/:id', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'command_not_found' })
        const command = await getInboxSendCommand(organizationId, req.params.id)
        if (!command) return res.status(404).json({ error: 'command_not_found' })
        res.json({ command })
    } catch (error) {
        handleOperatorError(error, res, 'fetching send command')
    }
})

router.post('/send-commands/:id/cancel', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'command_not_found' })
        const command = await cancelInboxSendCommand(ctx.organizationId, req.params.id)
        res.json({ command })
    } catch (error) {
        handleOperatorError(error, res, 'cancelling send command')
    }
})

// --- Sender / domain suppression (destructive; server-authoritative — locked #8) ---
// The server classifies the target (public/free-mail domain, already-suppressed) and executes
// the block org-scoped. A domain block on a public/free-mail provider is refused (400).

router.post('/suppressions/preview', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        const body = suppressionSchema.parse(req.body)
        const preview = await previewSuppression(ctx.organizationId, body.email, body.scope as SuppressionScope)
        res.json(preview)
    } catch (error) {
        handleOperatorError(error, res, 'previewing suppression')
    }
})

router.post('/suppressions', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        const body = suppressionSchema.parse(req.body)
        const result = await applySuppression(ctx.organizationId, body.email, body.scope as SuppressionScope)
        res.json(result)
    } catch (error) {
        handleOperatorError(error, res, 'applying suppression')
    }
})

export default router
