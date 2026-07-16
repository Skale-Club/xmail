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
