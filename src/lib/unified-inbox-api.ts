// ============================================================
// Unified Inbox — typed client contract for the Phase 21 read API (Phase 22 UIX-01/02)
// ============================================================
// These DTOs reproduce Phase 21's PUBLIC response contract (src/server/lib/unified-inbox/
// queries.ts) — NOT Drizzle row types. Timestamps arrive as ISO strings over JSON, so
// every `Date | null` server field is `string | null` here.
//
// Every request carries `organizationId` (resolved from useOrganization, never the URL),
// and every TanStack Query key begins `['outreach-inbox', organizationId, ...]` so a
// change of organization can never reuse another tenant's cached list/thread/count.

import { apiFetch } from './api-client'
import { fetchWithAuth } from './api'
import type { InboxUrlState } from './unified-inbox-url'

// ------------------------------------------------------------
// Provider-neutral enums (mirrors of the server contract; kept local to decouple the
// client bundle from the Drizzle schema module).
// ------------------------------------------------------------

export type InboxConversationStatus = 'open' | 'closed'
export type InboxMessageDirection = 'inbound' | 'outbound'
export type InboxProviderName = 'smtp' | 'outlook' | 'native'
export type InboxParticipantRole = 'from' | 'to' | 'cc' | 'bcc' | 'reply_to'
export type InboxMessageClassification = 'reply' | 'bounce' | 'auto_reply' | 'other'
export type InboxMatchStrategy =
    | 'in_reply_to'
    | 'references'
    | 'provider_thread'
    | 'address_heuristic'
    | 'outbound'
    | 'none'

export interface InboxAddress {
    address: string
    name: string | null
}

export interface InboxParticipant {
    address: string
    name: string | null
    role: InboxParticipantRole
}

export interface InboxLabel {
    id: string
    name: string
    color: string | null
}

export interface InboxAttachment {
    providerId: string | null
    name: string | null
    mimeType: string | null
    size: number | null
    inline: boolean
    contentId: string | null
}

export interface InboxConversationListItem {
    id: string
    emailAccountId: string
    leadId: string | null
    campaignId: string | null
    campaignLeadId: string | null
    status: InboxConversationStatus
    subject: string | null
    preview: string | null
    lastMessageAt: string | null
    lastInboundAt: string | null
    lastOutboundAt: string | null
    archived: boolean
    unread: boolean
    participants: InboxParticipant[]
    labels: InboxLabel[]
}

export interface InboxSyncStatusItem {
    emailAccountId: string
    provider: InboxProviderName
    lastSuccessAt: string | null
    degraded: boolean
    errorCategory: string | null
}

export interface InboxConversationListResponse {
    conversations: InboxConversationListItem[]
    nextCursor: string | null
    hasMore: boolean
    count: number
    syncStatus: InboxSyncStatusItem[]
}

export interface InboxConversationSummary {
    id: string
    emailAccountId: string
    leadId: string | null
    campaignId: string | null
    campaignLeadId: string | null
    status: InboxConversationStatus
    subject: string | null
    lastMessageAt: string | null
    lastInboundAt: string | null
    lastOutboundAt: string | null
    archived: boolean
    unread: boolean
    labels: InboxLabel[]
}

export interface InboxMessage {
    id: string
    direction: InboxMessageDirection
    provider: InboxProviderName
    subject: string | null
    internetMessageId: string | null
    inReplyTo: string | null
    fromAddress: string | null
    fromName: string | null
    toAddresses: InboxAddress[]
    ccAddresses: InboxAddress[]
    bccAddresses: InboxAddress[]
    plainBody: string | null
    htmlBody: string | null
    headers: Record<string, string>
    attachments: InboxAttachment[]
    hasAttachments: boolean
    classification: InboxMessageClassification
    matchStrategy: InboxMatchStrategy | null
    sentAt: string | null
    receivedAt: string | null
    createdAt: string
}

export interface InboxConversationDetail {
    conversation: InboxConversationSummary
    participants: InboxParticipant[]
    messages: InboxMessage[]
}

export interface InboxCampaignOption {
    id: string
    name: string
}

export interface InboxAccountOption {
    id: string
    email: string
    provider: string
}

// ------------------------------------------------------------
// Operator mutation DTOs (Phase 22 UIX-04 / UIX-05)
// ------------------------------------------------------------

/** Deterministic conversation state returned by archive/status mutations (server truth). */
export interface InboxConversationState {
    id: string
    status: InboxConversationStatus
    archived: boolean
    updatedAt: string
}

export type InboxReminderStatus = 'scheduled' | 'notified' | 'cancelled' | 'done'

export interface InboxReminder {
    id: string
    conversationId: string
    userId: string
    remindAt: string
    note: string | null
    status: InboxReminderStatus
    notifiedAt: string | null
    createdAt: string
    updatedAt: string
}

/** The seven bounded bulk actions the server accepts (mirrors inbox-operator BULK actions). */
export type BulkInboxAction =
    | 'read'
    | 'unread'
    | 'status'
    | 'archive'
    | 'unarchive'
    | 'add_label'
    | 'remove_label'

export interface BulkInboxInput {
    conversationIds: string[]
    action: BulkInboxAction
    status?: InboxConversationStatus
    labelId?: string
}

/** Honest matched/updated/skipped accounting — an empty/partial set can never widen to the org. */
export interface BulkInboxResult {
    matched: number
    updated: number
    skipped: number
}

export type SuppressionScope = 'sender' | 'domain'

/** Server preview of a destructive suppression — the client NEVER classifies domains itself. */
export interface SuppressionPreview {
    email: string
    domain: string
    scope: SuppressionScope
    /** Server-authoritative: a public/free-mail domain may not be blocked at domain scope. */
    isPublicDomain: boolean
    alreadySuppressed: boolean
    warnings: string[]
}

export interface SuppressionResult {
    suppressed: boolean
    scope: SuppressionScope
    email: string
    domain: string
    alreadySuppressed: boolean
}

/** The hard bulk ceiling, mirrored from the server's BULK_CONVERSATION_LIMIT. */
export const INBOX_BULK_LIMIT = 100

// ------------------------------------------------------------
// Org-scoped query keys — tenant separation is structural, not incidental.
// ------------------------------------------------------------

export const inboxKeys = {
    all: (organizationId: string | undefined) => ['outreach-inbox', organizationId] as const,
    list: (organizationId: string | undefined, filterSignature: string) =>
        ['outreach-inbox', organizationId, 'list', filterSignature] as const,
    detail: (organizationId: string | undefined, conversationId: string) =>
        ['outreach-inbox', organizationId, 'detail', conversationId] as const,
    unread: (organizationId: string | undefined) =>
        ['outreach-inbox', organizationId, 'unread-count'] as const,
    labels: (organizationId: string | undefined) =>
        ['outreach-inbox', organizationId, 'labels'] as const,
    campaigns: (organizationId: string | undefined) =>
        ['outreach-inbox', organizationId, 'campaign-index'] as const,
    accounts: (organizationId: string | undefined) =>
        ['outreach-inbox', organizationId, 'account-index'] as const,
    reminders: (organizationId: string | undefined, conversationId: string) =>
        ['outreach-inbox', organizationId, 'reminders', conversationId] as const,
    snippets: (organizationId: string | undefined) =>
        ['outreach-inbox', organizationId, 'snippets'] as const,
    sendCommand: (organizationId: string | undefined, commandId: string) =>
        ['outreach-inbox', organizationId, 'send-command', commandId] as const,
}

/** Predicate matcher for every list query of one organization (used by optimistic patch/rollback). */
export function isInboxListQueryKey(queryKey: readonly unknown[], organizationId: string | undefined): boolean {
    return (
        queryKey[0] === 'outreach-inbox' &&
        queryKey[1] === organizationId &&
        queryKey[2] === 'list'
    )
}

const INBOX_BASE = '/api/outreach/unified-inbox'

// ------------------------------------------------------------
// URL state → Phase 21 server query
// ------------------------------------------------------------

/**
 * Build the exact query string the Phase 21 `GET /conversations` endpoint expects from a
 * validated URL state. Archived conversations are HIDDEN by default (`archived=false`);
 * only the explicit Archived view sends `archived=true`. Inactive filters are omitted.
 * The server currently filters by a single label, so the first selected label is sent.
 */
export function toListQueryString(
    organizationId: string,
    state: InboxUrlState,
    limit: number,
    cursor?: string | null,
): string {
    const params = new URLSearchParams()
    params.set('organizationId', organizationId)
    params.set('limit', String(limit))
    // Default view hides archived; only the Archived quick-view opts into archived rows.
    params.set('archived', state.archived ? 'true' : 'false')
    if (state.q) params.set('search', state.q)
    if (state.unread) params.set('unread', 'true')
    if (state.status) params.set('status', state.status)
    if (state.campaign) params.set('campaignId', state.campaign)
    if (state.account) params.set('emailAccountId', state.account)
    if (state.reminder) params.set('reminderState', state.reminder)
    if (state.labels.length > 0) params.set('labelId', state.labels[0])
    const effectiveCursor = cursor ?? state.cursor
    if (effectiveCursor) params.set('cursor', effectiveCursor)
    return params.toString()
}

// ------------------------------------------------------------
// Fetchers (all authenticated via apiFetch<T>; never a raw unauthenticated fetch)
// ------------------------------------------------------------

export async function listInboxConversations(
    organizationId: string,
    state: InboxUrlState,
    limit: number,
    cursor: string | null,
): Promise<InboxConversationListResponse> {
    const qs = toListQueryString(organizationId, state, limit, cursor)
    return apiFetch<InboxConversationListResponse>(`${INBOX_BASE}/conversations?${qs}`)
}

export async function getInboxConversation(
    organizationId: string,
    conversationId: string,
): Promise<InboxConversationDetail> {
    return apiFetch<InboxConversationDetail>(
        `${INBOX_BASE}/conversations/${conversationId}?organizationId=${organizationId}`,
    )
}

export async function getInboxUnreadCount(organizationId: string): Promise<number> {
    const data = await apiFetch<{ unreadCount: number }>(
        `${INBOX_BASE}/unread-count?organizationId=${organizationId}`,
    )
    return data.unreadCount ?? 0
}

export async function listInboxLabels(organizationId: string): Promise<InboxLabel[]> {
    const data = await apiFetch<{ labels?: InboxLabel[] }>(`${INBOX_BASE}/labels?organizationId=${organizationId}`)
    return data.labels ?? []
}

export async function listInboxCampaignOptions(organizationId: string): Promise<InboxCampaignOption[]> {
    const data = await apiFetch<{ campaigns?: Array<{ id: string; name: string }> }>(
        `/api/outreach/campaigns?organizationId=${organizationId}&limit=100`,
    )
    return (data.campaigns ?? []).map((c) => ({ id: c.id, name: c.name }))
}

export async function listInboxAccountOptions(organizationId: string): Promise<InboxAccountOption[]> {
    const data = await apiFetch<{ emailAccounts?: Array<{ id: string; email: string; provider: string }> }>(
        `/api/outreach/email-accounts?organizationId=${organizationId}&page=1&limit=100`,
    )
    return (data.emailAccounts ?? []).map((a) => ({ id: a.id, email: a.email, provider: a.provider }))
}

// ------------------------------------------------------------
// Operator mutations (all authenticated via apiFetch<T>; org id in the query string, the
// same predicate every server route reads). JSON bodies are stringified so api-client sets
// the Content-Type. Every server response returns the updated conversation/version so the
// client can reconcile its optimistic patch to server truth.
// ------------------------------------------------------------

function withOrg(path: string, organizationId: string): string {
    return `${INBOX_BASE}${path}?organizationId=${encodeURIComponent(organizationId)}`
}

function jsonBody(method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
    return { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }
}

/** Explicit per-user read/unread. Returns the reconciled unread flag for the current user. */
export async function setInboxReadState(
    organizationId: string,
    conversationId: string,
    read: boolean,
): Promise<{ conversationId: string; read: boolean; unread: boolean }> {
    return apiFetch(withOrg(`/conversations/${conversationId}/read-state`, organizationId), jsonBody('PATCH', { read }))
}

export async function setInboxArchived(
    organizationId: string,
    conversationId: string,
    archived: boolean,
): Promise<InboxConversationState> {
    const data = await apiFetch<{ conversation: InboxConversationState }>(
        withOrg(`/conversations/${conversationId}/archive`, organizationId),
        jsonBody('PATCH', { archived }),
    )
    return data.conversation
}

export async function setInboxStatus(
    organizationId: string,
    conversationId: string,
    status: InboxConversationStatus,
): Promise<InboxConversationState> {
    const data = await apiFetch<{ conversation: InboxConversationState }>(
        withOrg(`/conversations/${conversationId}/status`, organizationId),
        jsonBody('PATCH', { status }),
    )
    return data.conversation
}

export async function attachInboxLabel(
    organizationId: string,
    conversationId: string,
    labelId: string,
): Promise<void> {
    await apiFetch(withOrg(`/conversations/${conversationId}/labels`, organizationId), jsonBody('POST', { labelId }))
}

export async function detachInboxLabel(
    organizationId: string,
    conversationId: string,
    labelId: string,
): Promise<void> {
    await apiFetch(withOrg(`/conversations/${conversationId}/labels/${labelId}`, organizationId), jsonBody('DELETE'))
}

export async function createInboxLabel(
    organizationId: string,
    name: string,
    color?: string | null,
): Promise<InboxLabel> {
    const data = await apiFetch<{ label: InboxLabel }>(
        withOrg('/labels', organizationId),
        jsonBody('POST', { name, color: color ?? null }),
    )
    return data.label
}

export async function listConversationReminders(
    organizationId: string,
    conversationId: string,
): Promise<InboxReminder[]> {
    const data = await apiFetch<{ reminders?: InboxReminder[] }>(
        withOrg(`/conversations/${conversationId}/reminders`, organizationId),
    )
    return data.reminders ?? []
}

export async function createInboxReminder(
    organizationId: string,
    conversationId: string,
    remindAt: string,
    note?: string | null,
): Promise<InboxReminder> {
    const data = await apiFetch<{ reminder: InboxReminder }>(
        withOrg(`/conversations/${conversationId}/reminders`, organizationId),
        jsonBody('POST', { remindAt, note: note ?? null }),
    )
    return data.reminder
}

export async function updateInboxReminder(
    organizationId: string,
    reminderId: string,
    patch: { remindAt?: string; note?: string | null; status?: InboxReminderStatus },
): Promise<InboxReminder> {
    const data = await apiFetch<{ reminder: InboxReminder }>(
        withOrg(`/reminders/${reminderId}`, organizationId),
        jsonBody('PATCH', patch),
    )
    return data.reminder
}

export async function deleteInboxReminder(organizationId: string, reminderId: string): Promise<void> {
    await apiFetch(withOrg(`/reminders/${reminderId}`, organizationId), jsonBody('DELETE'))
}

/** Bounded bulk update. The server rejects >100 ids; the client also caps selection at INBOX_BULK_LIMIT. */
export async function bulkUpdateInboxConversations(
    organizationId: string,
    input: BulkInboxInput,
): Promise<BulkInboxResult> {
    return apiFetch<BulkInboxResult>(withOrg('/conversations/bulk', organizationId), jsonBody('POST', input))
}

/** Server preview of a suppression — returns the exact target, public-domain classification, and warnings. */
export async function previewInboxSuppression(
    organizationId: string,
    email: string,
    scope: SuppressionScope,
): Promise<SuppressionPreview> {
    return apiFetch<SuppressionPreview>(withOrg('/suppressions/preview', organizationId), jsonBody('POST', { email, scope }))
}

/** Execute a suppression server-side. A public-domain block at domain scope is rejected with 400. */
export async function applyInboxSuppression(
    organizationId: string,
    email: string,
    scope: SuppressionScope,
): Promise<SuppressionResult> {
    return apiFetch<SuppressionResult>(withOrg('/suppressions', organizationId), jsonBody('POST', { email, scope }))
}

// ------------------------------------------------------------
// Reply/forward composer: durable send commands + bounded attachments + snippets (UIX-03/05)
// ------------------------------------------------------------
// Replies are NEVER sent from React (locked #5). The composer POSTs a durable command; the
// server resolves recipients + threading headers from the persisted thread and the claimer
// dispatches it through the shared policy gate. Attachments upload as raw bytes through the
// authenticated fetchWithAuth path — never base64 in JSON (locked #7).

export type InboxSendMode = 'reply' | 'reply_all' | 'forward'

export type InboxSendCommandStatus =
    | 'draft' | 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'held'

export interface InboxSendCommand {
    id: string
    conversationId: string
    status: InboxSendCommandStatus
    mode: InboxSendMode
    scheduledAt: string | null
    dueAt: string
    attempts: number
    lastPolicyCode: string | null
    lastError: string | null
    idempotencyKey: string
    createdAt: string
    updatedAt: string
}

/** A bounded, organization-owned uploaded attachment (metadata only; bytes live in private Storage). */
export interface InboxUploadedAttachment {
    id: string
    filename: string
    mimeType: string
    sizeBytes: number
    status: string
    createdAt: string
}

export interface InboxSnippet {
    id: string
    name: string
    body: string
    shortcut: string | null
    createdAt: string
    updatedAt: string
}

export interface CreateSendCommandInput {
    emailAccountId: string
    mode: InboxSendMode
    sourceMessageId?: string | null
    /** Forward-only recipients; ignored server-side for reply/reply_all. */
    forwardTo?: InboxAddress[]
    forwardCc?: InboxAddress[]
    subject?: string | null
    bodyText?: string | null
    bodyHtml?: string | null
    attachmentIds?: string[]
    scheduledAt?: string | null
    /** One stable key per user intent so a duplicate submit returns the same command. */
    idempotencyKey: string
}

export async function listInboxSnippets(organizationId: string): Promise<InboxSnippet[]> {
    const data = await apiFetch<{ snippets?: InboxSnippet[] }>(withOrg('/snippets', organizationId))
    return data.snippets ?? []
}

/** Create a durable reply/forward command. The server resolves recipients/headers; this never sends. */
export async function createInboxSendCommand(
    organizationId: string,
    conversationId: string,
    input: CreateSendCommandInput,
): Promise<InboxSendCommand> {
    const data = await apiFetch<{ command: InboxSendCommand }>(
        withOrg(`/conversations/${conversationId}/send-commands`, organizationId),
        jsonBody('POST', input),
    )
    return data.command
}

export async function getInboxSendCommand(organizationId: string, commandId: string): Promise<InboxSendCommand> {
    const data = await apiFetch<{ command: InboxSendCommand }>(withOrg(`/send-commands/${commandId}`, organizationId))
    return data.command
}

export async function cancelInboxSendCommand(organizationId: string, commandId: string): Promise<InboxSendCommand> {
    const data = await apiFetch<{ command: InboxSendCommand }>(
        withOrg(`/send-commands/${commandId}/cancel`, organizationId),
        jsonBody('POST'),
    )
    return data.command
}

/**
 * Upload one bounded attachment as RAW bytes through the authenticated fetchWithAuth path (never
 * base64 in JSON). The server validates filename/MIME/extension/size and stores it in the private
 * bucket under a server-chosen path. Content-Type is overridden to octet-stream so the app-level
 * JSON body parser passes the bytes through to the route's raw handler.
 */
export async function uploadInboxAttachment(
    organizationId: string,
    conversationId: string,
    file: File,
): Promise<InboxUploadedAttachment> {
    const url = withOrg(`/conversations/${conversationId}/attachments`, organizationId)
    const res = await fetchWithAuth(url, {
        method: 'POST',
        body: file,
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-Attachment-Filename': encodeURIComponent(file.name),
            'X-Attachment-Content-Type': file.type || 'application/octet-stream',
        },
    })
    if (!res.ok) {
        let code = `Upload failed (${res.status})`
        try {
            const payload = await res.json()
            if (payload && typeof payload.error === 'string') code = payload.error
        } catch { /* non-JSON error body */ }
        throw new Error(code)
    }
    const data = (await res.json()) as { attachment: InboxUploadedAttachment }
    return data.attachment
}

export async function deleteInboxAttachment(organizationId: string, attachmentId: string): Promise<void> {
    await apiFetch(withOrg(`/attachments/${attachmentId}`, organizationId), jsonBody('DELETE'))
}

export async function getInboxAttachmentDownloadUrl(
    organizationId: string,
    attachmentId: string,
): Promise<{ url: string; filename: string }> {
    return apiFetch<{ url: string; filename: string }>(withOrg(`/attachments/${attachmentId}/download`, organizationId))
}
