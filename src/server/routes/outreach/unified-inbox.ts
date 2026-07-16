import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireOutreachRead } from '../../lib/outreach-access'
import { ConversationCursorError } from '../../lib/unified-inbox/cursor'
import {
    getAccountSyncStatus,
    getConversationDetail,
    getUnreadCount,
    listConversations,
    setConversationReadState,
    type ConversationListFilters,
} from '../../lib/unified-inbox/queries'

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
})

const readStateBodySchema = z.object({
    read: z.boolean(),
})

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

export default router
