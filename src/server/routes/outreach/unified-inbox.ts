import { Router, raw, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm'
import { db } from '../../../db'
import {
    campaigns,
    emailAccounts,
    leads,
    organizations,
    outreachAiRuns,
    outreachAiSettings,
    outreachConversationMessages,
    outreachConversations,
} from '../../../db/schema'
import { requireOutreachRead, requireOutreachWrite, type OutreachMembership } from '../../lib/outreach-access'
import { evaluateEffectiveAutonomy, type AutonomyDenyReason } from '../../lib/inbox-ai-automation'
import { createLogger } from '../../lib/logger'
import {
    type BuildInboxAiContextInput,
    type InboxAiContextMessage,
} from '../../lib/inbox-ai-context'
import {
    approveAiRun,
    createDrizzleAiRunStore,
    AiRunError,
    type AiRunRecord,
} from '../../lib/inbox-ai-audit'
import { requestAiDraftProposal } from '../../lib/outreach-followup'
import {
    createInMemoryRateLimiter,
    generateInboxAiSuggestion,
    isAiSuggestionToneGoal,
    toPublicAiRun,
    type InboxAiSuggestionSettings,
} from '../../lib/inbox-ai-suggestions'
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
import {
    createResolvedSendCommand,
    InboxCommandResolutionError,
} from '../../lib/inbox-command-dispatch'
import {
    InboxAttachmentError,
    MAX_ATTACHMENTS_PER_COMMAND,
    createInboxAttachment,
    deleteInboxAttachment,
    getAttachmentDownloadUrl,
} from '../../lib/inbox-attachments'
import {
    INBOX_SSE_HEADERS,
    INBOX_SSE_HEARTBEAT_MS,
    InboxEventCapacityError,
    formatInboxSseComment,
    formatInboxSseEvent,
    subscribeToInboxEvents,
} from '../../lib/inbox-events'

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
    if (error instanceof InboxOperatorError || error instanceof InboxCommandResolutionError || error instanceof InboxAttachmentError) {
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

// GET /events — organization-scoped near-real-time aggregate stream (Phase 22 UIX-06).
//
// Bearer auth is required, so the browser CANNOT use `EventSource` (it can't set an
// Authorization header). It connects with authenticated `fetch` + `ReadableStream` and closes
// with `AbortController` (locked decision #9). The stream carries ONLY small signals
// (conversation id/version, kind, unread aggregate, sync-health) — NEVER message bodies,
// subjects, or addresses. It is scoped by the SAME `requireOutreachRead` + organization
// predicate as every read endpoint, so it can never leak another org's activity. On client
// disconnect the subscriber is released and the heartbeat cleared — no leaked intervals/handles.
router.get('/events', async (req: Request, res: Response) => {
    const organizationId = await authorizeOrganization(req, res)
    if (!organizationId) return

    let unsubscribe: (() => void) | null = null
    try {
        unsubscribe = subscribeToInboxEvents(organizationId, (event) => {
            // A write after teardown throws; the error handler below cleans up idempotently.
            try {
                res.write(formatInboxSseEvent(event))
            } catch {
                cleanup()
            }
        })
    } catch (error) {
        if (error instanceof InboxEventCapacityError) {
            res.status(503).json({ error: 'inbox_event_capacity' })
            return
        }
        throw error
    }

    // Open the stream: SSE headers + an immediate comment so proxies flush and the client
    // observes a live connection (it switches out of the polling fallback on first bytes).
    res.status(200)
    for (const [key, value] of Object.entries(INBOX_SSE_HEADERS)) res.setHeader(key, value)
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    res.write(formatInboxSseComment('connected'))

    const heartbeat = setInterval(() => {
        try {
            res.write(formatInboxSseComment('ping'))
        } catch {
            cleanup()
        }
    }, INBOX_SSE_HEARTBEAT_MS)
    // Node keeps the process alive for an active timer; the heartbeat must not block shutdown.
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    let closed = false
    function cleanup(): void {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe?.()
        try {
            res.end()
        } catch {
            // Response already torn down — nothing to release.
        }
    }

    req.on('close', cleanup)
    req.on('aborted', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
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
// Recipients + threading headers are RESOLVED SERVER-SIDE from persisted messages — the client
// never supplies To/Cc/Bcc/In-Reply-To/References for reply modes (that would let it address or
// thread the mail arbitrarily). The ONLY recipients a client may name are forward recipients,
// which are still validated as emails here.
const sendCommandSchema = z.object({
    emailAccountId: z.string().uuid(),
    mode: z.enum(['reply', 'reply_all', 'forward']),
    sourceMessageId: z.string().uuid().nullish(),
    // Forward-only recipients; ignored for reply/reply_all (resolver derives those from the thread).
    forwardTo: z.array(recipientSchema).max(100).optional(),
    forwardCc: z.array(recipientSchema).max(100).optional(),
    subject: z.string().max(2000).nullish(),
    bodyText: z.string().max(500000).nullish(),
    bodyHtml: z.string().max(1000000).nullish(),
    attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_COMMAND).optional(),
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
        // Route hands off a DURABLE command; recipients + threading headers are resolved from the
        // persisted thread server-side. This path has no dispatch capability — the claimer
        // (processInboxCommands) later runs it through the single policy-gated executor.
        const { command, created } = await createResolvedSendCommand({
            organizationId: ctx.organizationId,
            conversationId: req.params.id,
            actorUserId: ctx.userId,
            emailAccountId: body.emailAccountId,
            mode: body.mode,
            sourceMessageId: body.sourceMessageId ?? null,
            forwardRecipients: body.forwardTo,
            forwardCc: body.forwardCc,
            subject: body.subject ?? null,
            bodyText: body.bodyText ?? null,
            bodyHtml: body.bodyHtml ?? null,
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

// --- Bounded attachments (locked #7) ---
// Upload streams the RAW bytes through the authenticated fetchWithAuth path (bounded by
// express.raw, never base64 JSON). The server validates filename/MIME/extension/size, stores
// the bytes under a SERVER-CHOSEN path in the single private bucket, and marks the row ready.
// A slightly-over-limit ceiling lets an oversize upload be rejected with a clean 413 rather than
// a truncated stream.
const ATTACHMENT_UPLOAD_BYTE_CEILING = 26 * 1024 * 1024

router.post(
    '/conversations/:id/attachments',
    raw({ type: () => true, limit: ATTACHMENT_UPLOAD_BYTE_CEILING }),
    async (req: Request, res: Response) => {
        try {
            const ctx = await authorizeWrite(req, res)
            if (!ctx) return
            if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
            const filenameHeader = req.headers['x-attachment-filename']
            const filename = typeof filenameHeader === 'string' ? decodeURIComponent(filenameHeader) : ''
            const mimeType = (req.headers['x-attachment-content-type'] as string | undefined)
                ?? (req.headers['content-type'] as string | undefined)
                ?? ''
            const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
            if (bytes.length === 0) return res.status(400).json({ error: 'attachment_empty' })
            const attachment = await createInboxAttachment({
                organizationId: ctx.organizationId,
                userId: ctx.userId,
                filename,
                mimeType,
                bytes,
            })
            res.status(201).json({ attachment })
        } catch (error) {
            handleOperatorError(error, res, 'uploading inbox attachment')
        }
    },
)

router.get('/attachments/:id/download', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'attachment_not_found' })
        const download = await getAttachmentDownloadUrl(organizationId, req.params.id)
        res.json(download)
    } catch (error) {
        handleOperatorError(error, res, 'downloading inbox attachment')
    }
})

router.delete('/attachments/:id', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'attachment_not_found' })
        await deleteInboxAttachment(ctx.organizationId, req.params.id)
        res.json({ success: true })
    } catch (error) {
        handleOperatorError(error, res, 'deleting inbox attachment')
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

// ============================================================
// AI draft suggestions (Phase 23 AI-02 / AI-05 / AI-06)
// ============================================================
// The on-demand, HUMAN-IN-THE-LOOP suggestion path. It is gated on the per-org, default-off
// draft_assistance_enabled setting, reasons ONLY over persisted conversation messages, creates a
// redacted audit run, and is STRUCTURALLY INCAPABLE OF SENDING (the suggestion service imports no
// dispatcher — locked #6). The operator later inserts + edits the draft and uses the SEPARATE
// Phase 22 send-command path. Reads use requireOutreachRead; the suggestion mutation +
// acceptance use requireOutreachWrite; every query carries the verified organization scope.

// Bounded per-user/org request rate for the (potentially expensive) external suggestion call.
const aiSuggestionRateLimiter = createInMemoryRateLimiter({ windowMs: 60_000, max: 12 })

const toneGoalSchema = z.string().trim().refine(isAiSuggestionToneGoal, 'invalid tone goal')
const aiSuggestionBodySchema = z.object({
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    toneGoal: toneGoalSchema.optional(),
})
const aiRunsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().datetime().optional(),
})

/** Load the org's draft-assistance flag only (null when no settings row exists → treated as OFF). */
async function loadOrgAiDraftSettings(organizationId: string): Promise<InboxAiSuggestionSettings | null> {
    const rows = await db
        .select({ draftAssistanceEnabled: outreachAiSettings.draftAssistanceEnabled })
        .from(outreachAiSettings)
        .where(eq(outreachAiSettings.organizationId, organizationId))
        .limit(1)
    const row = rows[0]
    return row ? { draftAssistanceEnabled: row.draftAssistanceEnabled } : null
}

/**
 * Load the deterministic context INPUTS for the org+conversation from persisted rows. Returns null
 * when the conversation does not belong to the organization (indistinguishable from missing — no
 * existence leak). Every query is organization-scoped; no header-only fields are read (locked #2).
 */
async function loadInboxAiContextInput(args: {
    organizationId: string
    conversationId: string
}): Promise<BuildInboxAiContextInput | null> {
    const { organizationId, conversationId } = args

    const convRows = await db
        .select({
            id: outreachConversations.id,
            emailAccountId: outreachConversations.emailAccountId,
            campaignId: outreachConversations.campaignId,
            leadId: outreachConversations.leadId,
        })
        .from(outreachConversations)
        .where(and(eq(outreachConversations.organizationId, organizationId), eq(outreachConversations.id, conversationId)))
        .limit(1)
    const conv = convRows[0]
    if (!conv) return null

    const acctRows = conv.emailAccountId
        ? await db
              .select({ email: emailAccounts.email, displayName: emailAccounts.displayName })
              .from(emailAccounts)
              .where(and(eq(emailAccounts.organizationId, organizationId), eq(emailAccounts.id, conv.emailAccountId)))
              .limit(1)
        : []
    const account = acctRows[0]

    const messageRows = await db
        .select({
            id: outreachConversationMessages.id,
            organizationId: outreachConversationMessages.organizationId,
            conversationId: outreachConversationMessages.conversationId,
            direction: outreachConversationMessages.direction,
            subject: outreachConversationMessages.subject,
            fromAddress: outreachConversationMessages.fromAddress,
            fromName: outreachConversationMessages.fromName,
            toAddresses: outreachConversationMessages.toAddresses,
            ccAddresses: outreachConversationMessages.ccAddresses,
            plainBody: outreachConversationMessages.plainBody,
            htmlBody: outreachConversationMessages.htmlBody,
            sentAt: outreachConversationMessages.sentAt,
            receivedAt: outreachConversationMessages.receivedAt,
            createdAt: outreachConversationMessages.createdAt,
        })
        .from(outreachConversationMessages)
        .where(and(
            eq(outreachConversationMessages.organizationId, organizationId),
            eq(outreachConversationMessages.conversationId, conversationId),
        ))
        .orderBy(
            sql`COALESCE(outreach_conversation_messages.received_at, outreach_conversation_messages.sent_at, outreach_conversation_messages.created_at) ASC`,
            asc(outreachConversationMessages.id),
        )

    // Stamp org/conversation from the actual DB ROW (not the request args) so buildInboxAiContext's
    // attribution_mismatch guard is a LIVE second line of defense (M-1): if the org-scoped query ever
    // returned a foreign row, the guard fails the build closed instead of trusting the caller's scope.
    const messages: InboxAiContextMessage[] = messageRows.map((m) => ({
        id: m.id,
        organizationId: m.organizationId,
        conversationId: m.conversationId,
        direction: m.direction,
        subject: m.subject,
        fromAddress: m.fromAddress,
        fromName: m.fromName,
        toAddresses: (m.toAddresses ?? []).map((a) => ({ address: a.address, name: a.name ?? null })),
        ccAddresses: (m.ccAddresses ?? []).map((a) => ({ address: a.address, name: a.name ?? null })),
        plainBody: m.plainBody,
        htmlBody: m.htmlBody,
        sentAt: m.sentAt,
        receivedAt: m.receivedAt,
        createdAt: m.createdAt,
    }))

    let campaign: { id: string; name: string | null } | null = null
    let campaignFromName: string | null = null
    if (conv.campaignId) {
        const campaignRows = await db
            .select({ id: campaigns.id, name: campaigns.name, fromName: campaigns.fromName })
            .from(campaigns)
            .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, conv.campaignId)))
            .limit(1)
        if (campaignRows[0]) {
            campaign = { id: campaignRows[0].id, name: campaignRows[0].name }
            campaignFromName = campaignRows[0].fromName
        }
    }

    let lead: { email: string | null; firstName: string | null; company: string | null } | null = null
    if (conv.leadId) {
        const leadRows = await db
            .select({ email: leads.email, firstName: leads.firstName, companyName: leads.companyName })
            .from(leads)
            .where(and(eq(leads.organizationId, organizationId), eq(leads.id, conv.leadId)))
            .limit(1)
        if (leadRows[0]) {
            lead = { email: leadRows[0].email, firstName: leadRows[0].firstName, company: leadRows[0].companyName }
        }
    }

    return {
        organizationId,
        conversationId,
        accountAddress: account?.email ?? '',
        messages,
        campaign,
        lead,
        sellerName: campaignFromName ?? account?.displayName ?? null,
    }
}

/**
 * Cursor-bounded, org-scoped AI-run history (raw rows; caller projects to the redacted DTO). Optional
 * conversation/campaign predicates narrow the scope. Every query carries the verified organization id,
 * so a foreign conversation/campaign id simply yields an empty page (never another tenant's runs).
 */
async function listAiRuns(filters: {
    organizationId: string
    conversationId?: string
    campaignId?: string
    limit: number
    cursor: string | null
}): Promise<AiRunRecord[]> {
    const conditions = [eq(outreachAiRuns.organizationId, filters.organizationId)]
    if (filters.conversationId) conditions.push(eq(outreachAiRuns.conversationId, filters.conversationId))
    if (filters.campaignId) conditions.push(eq(outreachAiRuns.campaignId, filters.campaignId))
    if (filters.cursor) conditions.push(lt(outreachAiRuns.createdAt, new Date(filters.cursor)))
    return db
        .select()
        .from(outreachAiRuns)
        .where(and(...conditions))
        .orderBy(desc(outreachAiRuns.createdAt), desc(outreachAiRuns.id))
        .limit(filters.limit)
}

// GET /ai-settings — the single safe flag the composer needs (never the kill switch / model profile).
router.get('/ai-settings', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        const settings = await loadOrgAiDraftSettings(organizationId)
        res.json({ draftAssistanceEnabled: settings?.draftAssistanceEnabled ?? false })
    } catch (error) {
        handleOperatorError(error, res, 'loading ai settings')
    }
})

// POST /conversations/:id/ai-suggestions — create (or idempotently replay) an editable draft
// suggestion + audit run. It NEVER dispatches: the response carries a suggestion/run only.
router.post('/conversations/:id/ai-suggestions', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
        const body = aiSuggestionBodySchema.parse(req.body ?? {})

        // Rate-limit per user/org before the potentially expensive external call.
        if (!aiSuggestionRateLimiter.take(`${ctx.organizationId}:${ctx.userId}`)) {
            return res.status(429).json({ error: 'ai_suggestion_rate_limited' })
        }

        const outcome = await generateInboxAiSuggestion(
            {
                store: createDrizzleAiRunStore(),
                loadSettings: loadOrgAiDraftSettings,
                loadContext: loadInboxAiContextInput,
                requestProposal: (input) => requestAiDraftProposal(input),
            },
            {
                organizationId: ctx.organizationId,
                conversationId: req.params.id,
                actorUserId: ctx.userId,
                idempotencyKey: body.idempotencyKey ?? randomUUID(),
                toneGoal: body.toneGoal ?? null,
            },
        )

        switch (outcome.status) {
            case 'not_enabled':
                return res.status(200).json({ enabled: false, suggestion: null, run: null })
            case 'not_found':
                return res.status(404).json({ error: 'conversation_not_found' })
            case 'in_progress':
                return res.status(409).json({ error: 'ai_suggestion_in_progress', enabled: true, suggestion: null, run: toPublicAiRun(outcome.run) })
            case 'suggested':
                return res.status(201).json({ enabled: true, suggestion: outcome.suggestion, run: toPublicAiRun(outcome.run) })
            case 'no_action':
            case 'failed':
                // A no-action / recoverable failure is an inspectable run, not a server error.
                return res.status(200).json({ enabled: true, suggestion: null, run: toPublicAiRun(outcome.run) })
        }
    } catch (error) {
        handleOperatorError(error, res, 'creating ai suggestion')
    }
})

/** Shared response shaper for a redacted, cursor-bounded AI-run page. */
function aiRunPage(runs: AiRunRecord[], limit: number): { runs: ReturnType<typeof toPublicAiRun>[]; nextCursor: string | null } {
    const nextCursor = runs.length === limit ? runs[runs.length - 1].createdAt.toISOString() : null
    return { runs: runs.map(toPublicAiRun), nextCursor }
}

// GET /conversations/:id/ai-runs — redacted, cursor-bounded causal history for a conversation.
router.get('/conversations/:id/ai-runs', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'conversation_not_found' })
        const { limit, cursor } = aiRunsQuerySchema.parse(req.query)
        const runs = await listAiRuns({ organizationId, conversationId: req.params.id, limit, cursor: cursor ?? null })
        res.json(aiRunPage(runs, limit))
    } catch (error) {
        handleOperatorError(error, res, 'listing conversation ai runs')
    }
})

// GET /ai-runs — redacted, cursor-bounded ORG-WIDE causal history (the transparency ledger).
router.get('/ai-runs', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        const { limit, cursor } = aiRunsQuerySchema.parse(req.query)
        const runs = await listAiRuns({ organizationId, limit, cursor: cursor ?? null })
        res.json(aiRunPage(runs, limit))
    } catch (error) {
        handleOperatorError(error, res, 'listing org ai runs')
    }
})

// GET /campaigns/:id/ai-runs — redacted, cursor-bounded campaign-scoped causal history.
router.get('/campaigns/:id/ai-runs', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'campaign_not_found' })
        const { limit, cursor } = aiRunsQuerySchema.parse(req.query)
        const runs = await listAiRuns({ organizationId, campaignId: req.params.id, limit, cursor: cursor ?? null })
        res.json(aiRunPage(runs, limit))
    } catch (error) {
        handleOperatorError(error, res, 'listing campaign ai runs')
    }
})

// GET /ai-runs/:id — redacted status for a single run (org-scoped; a foreign id is a 404).
router.get('/ai-runs/:id', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'ai_run_not_found' })
        const run = await createDrizzleAiRunStore().findById(organizationId, req.params.id)
        if (!run) return res.status(404).json({ error: 'ai_run_not_found' })
        res.json({ run: toPublicAiRun(run) })
    } catch (error) {
        handleOperatorError(error, res, 'fetching ai run')
    }
})

// POST /ai-runs/:id/accept — record explicit operator acceptance of a suggestion. This is an AUDIT
// action only: it records (approver, time) against an awaiting-approval run and does NOT send. The
// actual send remains the separate Phase 22 operator action.
router.post('/ai-runs/:id/accept', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'ai_run_not_found' })
        const run = await approveAiRun(createDrizzleAiRunStore(), {
            organizationId: ctx.organizationId,
            runId: req.params.id,
            approverUserId: ctx.userId,
        })
        res.json({ run: toPublicAiRun(run) })
    } catch (error) {
        if (error instanceof AiRunError) {
            if (error.code === 'not_found') return res.status(404).json({ error: 'ai_run_not_found' })
            return res.status(409).json({ error: error.code })
        }
        handleOperatorError(error, res, 'accepting ai suggestion')
    }
})

// ============================================================
// AI automation controls — transparent, default-off, confirmed, pausable (Phase 23 AI-03 / AI-06)
// ============================================================
// The organization AND campaign autonomy controls. Both flags default OFF; enabling autonomy is a
// deliberate client-confirmed action; the org kill switch pauses IMMEDIATELY; and every view reports
// the EFFECTIVE scope (org on AND campaign on AND unpaused AND outreach enabled — the intersection the
// autonomous processor re-evaluates at claim + dispatch). Reads use requireOutreachRead; mutations use
// requireOutreachWrite; every query carries the verified organization id. Enabling a stored bit never
// alone authorizes a send — the executor re-runs the full Phase 18 policy before any provider call.
//
// Audit actor: each control change emits a structured audit log line carrying the actor + organization
// (never message content or a secret), so an enable/disable/pause/resume is attributable without a
// schema change.

const aiControlsLog = createLogger('outreach.aiControls')

const orgAiSettingsPatchSchema = z.object({
    draftAssistanceEnabled: z.boolean().optional(),
    autonomousEnabled: z.boolean().optional(),
    // Optimistic-concurrency token from the last read; a stale value is a 409 conflict.
    expectedUpdatedAt: z.string().datetime().nullish(),
}).refine((b) => b.draftAssistanceEnabled !== undefined || b.autonomousEnabled !== undefined, {
    message: 'at least one flag is required',
})
const pauseBodySchema = z.object({ reason: z.string().trim().max(500).nullish() })
const campaignAiPatchSchema = z.object({
    aiAutonomousEnabled: z.boolean(),
    expectedUpdatedAt: z.string().datetime().nullish(),
})

interface OrgAiAutomationView {
    draftAssistanceEnabled: boolean
    autonomousEnabled: boolean
    autonomyPaused: boolean
    autonomyPausedAt: string | null
    autonomyPausedReason: string | null
    maxAutonomousFollowUps: number
    outreachEnabled: boolean
    autonomyEffective: boolean
    updatedAt: string | null
}

/** Load the org control view: both default-off flags, the immediate kill switch, and the effective scope. */
async function loadOrgAiAutomationView(organizationId: string): Promise<OrgAiAutomationView> {
    const [settings] = await db
        .select({
            draftAssistanceEnabled: outreachAiSettings.draftAssistanceEnabled,
            autonomousEnabled: outreachAiSettings.autonomousEnabled,
            autonomyPausedAt: outreachAiSettings.autonomyPausedAt,
            autonomyPausedReason: outreachAiSettings.autonomyPausedReason,
            maxAutonomousFollowUps: outreachAiSettings.maxAutonomousFollowUps,
            updatedAt: outreachAiSettings.updatedAt,
        })
        .from(outreachAiSettings)
        .where(eq(outreachAiSettings.organizationId, organizationId))
        .limit(1)
    const [org] = await db
        .select({ outreachEnabled: organizations.outreachEnabled })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)

    const outreachEnabled = org?.outreachEnabled ?? false
    const autonomousEnabled = settings?.autonomousEnabled ?? false
    const autonomyPausedAt = settings?.autonomyPausedAt ?? null
    const autonomyPaused = autonomyPausedAt != null
    return {
        draftAssistanceEnabled: settings?.draftAssistanceEnabled ?? false,
        autonomousEnabled,
        autonomyPaused,
        autonomyPausedAt: autonomyPausedAt ? autonomyPausedAt.toISOString() : null,
        autonomyPausedReason: settings?.autonomyPausedReason ?? null,
        maxAutonomousFollowUps: settings?.maxAutonomousFollowUps ?? 2,
        outreachEnabled,
        // Effective org scope: the org is "armed" only when autonomy is on, unpaused, AND outreach is
        // enabled. A campaign must ALSO opt in for a send to actually happen (see the campaign view).
        autonomyEffective: autonomousEnabled && !autonomyPaused && outreachEnabled,
        updatedAt: settings?.updatedAt ? settings.updatedAt.toISOString() : null,
    }
}

/** Column-name error for a detected optimistic-concurrency conflict. */
class AiSettingsConflict extends Error {}

/**
 * Upsert the org AI-settings row. When `expectedUpdatedAt` is provided AND a row exists, a mismatch is
 * a conflict (a concurrent edit). Pause/resume pass no expectation so the kill switch always applies.
 */
async function upsertOrgAiSettings(
    organizationId: string,
    patch: Partial<{ draftAssistanceEnabled: boolean; autonomousEnabled: boolean; autonomyPausedAt: Date | null; autonomyPausedReason: string | null }>,
    expectedUpdatedAt?: string | null,
): Promise<void> {
    const [existing] = await db
        .select({ updatedAt: outreachAiSettings.updatedAt })
        .from(outreachAiSettings)
        .where(eq(outreachAiSettings.organizationId, organizationId))
        .limit(1)
    if (existing && expectedUpdatedAt != null && existing.updatedAt.toISOString() !== expectedUpdatedAt) {
        throw new AiSettingsConflict('ai_settings_conflict')
    }
    const now = new Date()
    if (existing) {
        await db.update(outreachAiSettings).set({ ...patch, updatedAt: now }).where(eq(outreachAiSettings.organizationId, organizationId))
    } else {
        await db
            .insert(outreachAiSettings)
            .values({ organizationId, ...patch, updatedAt: now })
            .onConflictDoUpdate({ target: outreachAiSettings.organizationId, set: { ...patch, updatedAt: now } })
    }
}

// GET /ai-automation-settings — the full org control view (viewers may read; mutations need write).
router.get('/ai-automation-settings', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        res.json(await loadOrgAiAutomationView(organizationId))
    } catch (error) {
        handleOperatorError(error, res, 'loading ai automation settings')
    }
})

// PATCH /ai-automation-settings — set the draft/autonomous flags (optimistic-concurrency guarded).
router.patch('/ai-automation-settings', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        const body = orgAiSettingsPatchSchema.parse(req.body ?? {})
        const patch: Parameters<typeof upsertOrgAiSettings>[1] = {}
        if (body.draftAssistanceEnabled !== undefined) patch.draftAssistanceEnabled = body.draftAssistanceEnabled
        if (body.autonomousEnabled !== undefined) patch.autonomousEnabled = body.autonomousEnabled
        await upsertOrgAiSettings(ctx.organizationId, patch, body.expectedUpdatedAt ?? undefined)
        aiControlsLog.info({
            action: 'outreach.aiControls.org_settings_updated',
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            draftAssistanceEnabled: body.draftAssistanceEnabled ?? null,
            autonomousEnabled: body.autonomousEnabled ?? null,
        }, 'org AI automation flags updated')
        res.json(await loadOrgAiAutomationView(ctx.organizationId))
    } catch (error) {
        if (error instanceof AiSettingsConflict) return res.status(409).json({ error: 'ai_settings_conflict' })
        handleOperatorError(error, res, 'updating ai automation settings')
    }
})

// POST /ai-automation-settings/pause — IMMEDIATE org kill switch (always applies; no version check).
router.post('/ai-automation-settings/pause', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        const body = pauseBodySchema.parse(req.body ?? {})
        await upsertOrgAiSettings(ctx.organizationId, { autonomyPausedAt: new Date(), autonomyPausedReason: body.reason ?? null })
        aiControlsLog.warn({
            action: 'outreach.aiControls.org_paused',
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            hasReason: Boolean(body.reason),
        }, 'org AI automation paused (kill switch)')
        res.json(await loadOrgAiAutomationView(ctx.organizationId))
    } catch (error) {
        handleOperatorError(error, res, 'pausing ai automation')
    }
})

// POST /ai-automation-settings/resume — clear the org kill switch.
router.post('/ai-automation-settings/resume', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        await upsertOrgAiSettings(ctx.organizationId, { autonomyPausedAt: null, autonomyPausedReason: null })
        aiControlsLog.info({
            action: 'outreach.aiControls.org_resumed',
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
        }, 'org AI automation resumed')
        res.json(await loadOrgAiAutomationView(ctx.organizationId))
    } catch (error) {
        handleOperatorError(error, res, 'resuming ai automation')
    }
})

interface CampaignAiAutomationView {
    campaignId: string
    campaignAiAutonomousEnabled: boolean
    campaignStatus: string
    campaignActive: boolean
    orgAutonomousEnabled: boolean
    orgAutonomyPaused: boolean
    outreachEnabled: boolean
    effective: { enabled: boolean; reason: AutonomyDenyReason | null }
    updatedAt: string | null
}

/** Load the campaign control view + the computed EFFECTIVE autonomy (the full intersection). null → 404. */
async function loadCampaignAiAutomationView(organizationId: string, campaignId: string): Promise<CampaignAiAutomationView | null> {
    const [campaign] = await db
        .select({ id: campaigns.id, status: campaigns.status, aiAutonomousEnabled: campaigns.aiAutonomousEnabled, updatedAt: campaigns.updatedAt })
        .from(campaigns)
        .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, campaignId)))
        .limit(1)
    if (!campaign) return null

    const [settings] = await db
        .select({ autonomousEnabled: outreachAiSettings.autonomousEnabled, autonomyPausedAt: outreachAiSettings.autonomyPausedAt })
        .from(outreachAiSettings)
        .where(eq(outreachAiSettings.organizationId, organizationId))
        .limit(1)
    const [org] = await db
        .select({ outreachEnabled: organizations.outreachEnabled })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)

    const inputs = {
        orgAutonomousEnabled: settings?.autonomousEnabled ?? false,
        orgAutonomyPausedAt: settings?.autonomyPausedAt ?? null,
        campaignAiAutonomousEnabled: campaign.aiAutonomousEnabled,
        campaignActive: campaign.status === 'active',
        outreachEnabled: org?.outreachEnabled ?? false,
    }
    return {
        campaignId: campaign.id,
        campaignAiAutonomousEnabled: campaign.aiAutonomousEnabled,
        campaignStatus: campaign.status,
        campaignActive: inputs.campaignActive,
        orgAutonomousEnabled: inputs.orgAutonomousEnabled,
        orgAutonomyPaused: inputs.orgAutonomyPausedAt != null,
        outreachEnabled: inputs.outreachEnabled,
        // The intersection: a campaign flag can never override org-off / org-paused / outreach-off.
        effective: evaluateEffectiveAutonomy(inputs),
        updatedAt: campaign.updatedAt ? campaign.updatedAt.toISOString() : null,
    }
}

// GET /campaigns/:id/ai-automation — the campaign control view + effective scope.
router.get('/campaigns/:id/ai-automation', async (req: Request, res: Response) => {
    try {
        const organizationId = await authorizeOrganization(req, res)
        if (!organizationId) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'campaign_not_found' })
        const view = await loadCampaignAiAutomationView(organizationId, req.params.id)
        if (!view) return res.status(404).json({ error: 'campaign_not_found' })
        res.json(view)
    } catch (error) {
        handleOperatorError(error, res, 'loading campaign ai automation')
    }
})

// PATCH /campaigns/:id/ai-automation — set the campaign autonomy opt-in (optimistic-concurrency guarded).
router.patch('/campaigns/:id/ai-automation', async (req: Request, res: Response) => {
    try {
        const ctx = await authorizeWrite(req, res)
        if (!ctx) return
        if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: 'campaign_not_found' })
        const body = campaignAiPatchSchema.parse(req.body ?? {})
        const [campaign] = await db
            .select({ id: campaigns.id, updatedAt: campaigns.updatedAt })
            .from(campaigns)
            .where(and(eq(campaigns.organizationId, ctx.organizationId), eq(campaigns.id, req.params.id)))
            .limit(1)
        if (!campaign) return res.status(404).json({ error: 'campaign_not_found' })
        if (body.expectedUpdatedAt != null && campaign.updatedAt && campaign.updatedAt.toISOString() !== body.expectedUpdatedAt) {
            return res.status(409).json({ error: 'campaign_ai_conflict' })
        }
        await db
            .update(campaigns)
            .set({ aiAutonomousEnabled: body.aiAutonomousEnabled, updatedAt: new Date() })
            .where(and(eq(campaigns.organizationId, ctx.organizationId), eq(campaigns.id, req.params.id)))
        aiControlsLog.info({
            action: 'outreach.aiControls.campaign_autonomy_updated',
            organizationId: ctx.organizationId,
            campaignId: req.params.id,
            actorUserId: ctx.userId,
            aiAutonomousEnabled: body.aiAutonomousEnabled,
        }, 'campaign AI autonomy updated')
        const view = await loadCampaignAiAutomationView(ctx.organizationId, req.params.id)
        res.json(view)
    } catch (error) {
        handleOperatorError(error, res, 'updating campaign ai automation')
    }
})

export default router
