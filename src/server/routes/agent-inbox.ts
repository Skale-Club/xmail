import { Router } from 'express'
import { z } from 'zod'
import {
    INBOX_VIEWS,
    getConversationDetail,
    listConversations,
    type ConversationListFilters,
    type ConversationMessageDto,
} from '../lib/unified-inbox/queries'
import { ConversationCursorError } from '../lib/unified-inbox/cursor'
import { READ_SCOPE, ManageError, handleManageError, isUuid, requireScope } from '../lib/agent-manage'

/**
 * Hermes / Kai read-only window into the outreach unified inbox.
 *
 *   GET /inbox/conversations        outreach:read    recent threads (replies first), cursor-paginated
 *   GET /inbox/conversations/:id    outreach:read    one thread with its messages
 *
 * Read only, and it does not even mark anything as read: the unread flag is the human principal's
 * and stays untouched. There is no reply, forward, archive or label route here; answering a
 * prospect stays with the human or with the approval-based path. The organization comes from the
 * credential; the shared query layer already filters every statement by it, and a conversation id
 * from another organization is indistinguishable from one that does not exist (404).
 *
 * Prospect replies are text written by a third party. Responses carry `untrustedContent: true` so
 * the agent treats message bodies as data to read, never as instructions to follow.
 */

const router = Router()

const MAX_BODY_CHARS = 20_000

const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    cursor: z.string().min(1).max(4096).optional(),
    view: z.enum(INBOX_VIEWS).default('inbox'),
    status: z.enum(['open', 'closed']).optional(),
    campaignId: z.string().uuid().optional(),
    emailAccountId: z.string().uuid().optional(),
    search: z.string().trim().max(200).optional(),
})

function toMessageView(message: ConversationMessageDto) {
    const body = message.plainBody ?? ''
    return {
        id: message.id,
        direction: message.direction,
        classification: message.classification,
        subject: message.subject,
        fromAddress: message.fromAddress,
        fromName: message.fromName,
        toAddresses: message.toAddresses,
        ccAddresses: message.ccAddresses,
        // plain text only: HTML, raw headers and attachment contents are not handed to the agent.
        plainBody: body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body,
        bodyTruncated: body.length > MAX_BODY_CHARS,
        hasAttachments: message.hasAttachments,
        attachmentCount: message.attachments.length,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
    }
}

router.get('/inbox/conversations', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        const query = listQuerySchema.parse(req.query)
        const search = query.search && query.search.length > 0 ? query.search : null
        const filters: ConversationListFilters = {
            unread: false,
            status: query.status ?? null,
            campaignId: query.campaignId ?? null,
            emailAccountId: query.emailAccountId ?? null,
            search,
            labelId: null,
            reminderState: null,
            archived: null,
            view: query.view,
        }
        const result = await listConversations({
            organizationId: principal.organizationId,
            userId: principal.principalUserId,
            filters,
            limit: query.limit,
            cursor: query.cursor ?? null,
        })
        res.json({
            untrustedContent: true,
            view: query.view,
            conversations: result.conversations.map((conversation) => ({
                id: conversation.id,
                emailAccountId: conversation.emailAccountId,
                leadId: conversation.leadId,
                campaignId: conversation.campaignId,
                status: conversation.status,
                subject: conversation.subject,
                preview: conversation.preview,
                lastMessageAt: conversation.lastMessageAt,
                lastInboundAt: conversation.lastInboundAt,
                lastOutboundAt: conversation.lastOutboundAt,
                lastInboundClassification: conversation.lastInboundClassification,
                unread: conversation.unread,
                archived: conversation.archived,
                participants: conversation.participants,
                labels: conversation.labels,
            })),
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
        })
    } catch (error) {
        if (error instanceof ConversationCursorError) {
            return handleManageError(new ManageError(400, { error: 'Invalid or stale cursor' }), res, 'inbox list')
        }
        handleManageError(error, res, 'inbox list')
    }
})

router.get('/inbox/conversations/:id', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        if (!isUuid(req.params.id)) throw new ManageError(404, { error: 'Conversation not found' })
        const detail = await getConversationDetail({
            organizationId: principal.organizationId,
            conversationId: req.params.id,
            userId: principal.principalUserId,
        })
        if (!detail) throw new ManageError(404, { error: 'Conversation not found' })
        res.json({
            untrustedContent: true,
            conversation: detail.conversation,
            participants: detail.participants,
            messages: detail.messages.map(toMessageView),
        })
    } catch (error) {
        handleManageError(error, res, 'inbox thread')
    }
})

export default router
