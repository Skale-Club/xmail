import React from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'

// useUnifiedInboxEvents connects with authenticated `fetch` — NEVER EventSource. It used to
// go through lib/api's fetchWithAuth; it now goes through lib/api-client's apiRequest (the
// mail area's refresh-on-401 client — see CLAUDE.md "Outreach Hermes Gateway" migration notes).
// Mock this so the near-real-time hook drives a controllable stream/failure.
const apiMocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }))

// The operator mutation hooks call apiFetch<T> through api-client. Mock the module so the
// REAL hooks (loaded via vi.importActual below) drive a fake network we fully control — no
// supabase session, no real fetch. ApiClientError mirrors the real class's status/details.
const apiClientMocks = vi.hoisted(() => {
    class ApiClientError extends Error {
        status: number
        details?: unknown
        code?: string
        constructor(message: string, opts: { status: number; details?: unknown; code?: string }) {
            super(message)
            this.name = 'ApiClientError'
            this.status = opts.status
            this.details = opts.details
            this.code = opts.code
        }
    }
    return { apiFetch: vi.fn(), ApiClientError }
})
vi.mock('@/lib/api-client', () => ({
    apiFetch: apiClientMocks.apiFetch,
    apiRequest: apiMocks.fetchWithAuth,
    ApiClientError: apiClientMocks.ApiClientError,
}))

vi.mock('@/lib/api', () => ({
    fetchWithAuth: apiMocks.fetchWithAuth,
    apiFetch: vi.fn(),
    ApiError: class ApiError extends Error {},
    isNetworkError: () => false,
    isAuthError: () => false,
    isTimeoutError: () => false,
}))

// EmailHtmlViewer renders email bodies into a sandboxed iframe and schedules resize
// setTimeouts on iframe `load`. Under jsdom those can fire after teardown ("window is
// not defined"). Any describe that renders a thread guards this by faking the timer
// functions (not Date) and clearing the fake queue before RTL unmounts.
function useThreadTimerGuard() {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    })
    afterEach(() => {
        vi.clearAllTimers()
        vi.useRealTimers()
    })
}
// Radix popovers/menus need a few DOM APIs jsdom does not implement.
beforeAll(() => {
    const g = globalThis as unknown as Record<string, unknown>
    if (!g.ResizeObserver) {
        g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    }
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
    if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
    if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
    if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
    if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
})

import {
    DEFAULT_INBOX_STATE,
    activeFilterCount,
    activeQuickView,
    buildInboxSearch,
    listFilterSignature,
    mergeInboxState,
    parseInboxUrl,
    quickViewPatch,
    type InboxUrlState,
} from '@/lib/unified-inbox-url'
import { inboxKeys, toListQueryString } from '@/lib/unified-inbox-api'
import { useUnifiedInboxEvents } from '@/hooks/useUnifiedInboxEvents'
import type {
    InboxConversationDetail,
    InboxConversationListItem,
    InboxMessage,
} from '@/lib/unified-inbox-api'
import { ConversationList, type ConversationListProps } from '@/components/outreach/inbox/ConversationList'
import { ConversationThread } from '@/components/outreach/inbox/ConversationThread'
import { BulkActionsBar, ConversationActions } from '@/components/outreach/inbox/ConversationActions'
import { ComposerUnavailable, ConversationComposer } from '@/components/outreach/inbox/ConversationComposer'
import { AiDraftAssistant } from '@/components/outreach/inbox/AiDraftAssistant'
import { AiAutomationHistory } from '@/components/outreach/inbox/AiAutomationHistory'
import { AiAutomationChip } from '@/components/outreach/inbox/AiAutomationChip'
import { InboxFilterRail } from '@/components/outreach/inbox/InboxFilterRail'
import { CampaignAiAutomationControl, OrgAiAutomationControl } from '@/components/outreach/inbox/AiAutonomyControls'
import { InboxSyncStatus } from '@/components/outreach/inbox/InboxSyncStatus'
import type {
    AiRunPublicDto,
    AiSuggestionResponse,
    CampaignAiAutomation,
    CreateSendCommandInput,
    InboxAccountOption,
    InboxLabel,
    InboxSendCommand,
    InboxSnippet,
    InboxUploadedAttachment,
    OrgAiAutomationSettings,
    SuppressionPreview,
    SuppressionResult,
    SuppressionScope,
} from '@/lib/unified-inbox-api'

// Fixed, syntactically valid UUIDs for deterministic assertions.
const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const CONV_1 = '33333333-3333-4333-8333-333333333333'
const CAMPAIGN_1 = '44444444-4444-4444-8444-444444444444'
const ACCOUNT_1 = '55555555-5555-4555-8555-555555555555'
const LABEL_1 = '66666666-6666-4666-8666-666666666666'
const LABEL_2 = '77777777-7777-4777-8777-777777777777'

// ============================================================
// Task 1 — validated URL state + typed API mapping
// ============================================================

describe('unified-inbox-url: parse + serialize round-trip', () => {
    it('round-trips a fully populated state through build → parse', () => {
        const state: InboxUrlState = {
            conversation: CONV_1,
            q: 'hello world',
            view: 'awaiting',
            status: 'closed',
            campaign: CAMPAIGN_1,
            account: ACCOUNT_1,
            labels: [LABEL_1, LABEL_2],
            cursor: 'opaque-cursor-token',
        }
        const parsed = parseInboxUrl(buildInboxSearch(state))
        // Legacy fields are always undefined after normalization; everything else round-trips.
        expect(parsed).toEqual({ ...state, unread: undefined, reminder: undefined, archived: undefined })
    })

    it('omits default/empty values from the serialized query', () => {
        expect(buildInboxSearch(DEFAULT_INBOX_STATE)).toBe('')
        expect(buildInboxSearch({ labels: [], conversation: CONV_1 })).toBe(`conversation=${CONV_1}`)
    })

    it('serializes deterministically regardless of field insertion order', () => {
        const a: InboxUrlState = { labels: [LABEL_2, LABEL_1], q: 'x', status: 'open', conversation: CONV_1 }
        const b: InboxUrlState = { conversation: CONV_1, status: 'open', q: 'x', labels: [LABEL_1, LABEL_2] }
        expect(buildInboxSearch(a)).toBe(buildInboxSearch(b))
    })
})

describe('unified-inbox-url: validation + bounding', () => {
    it('drops invalid enums, non-uuids, and unknown params', () => {
        const parsed = parseInboxUrl('status=weird&unread=maybe&campaign=not-a-uuid&account=nope&reminder=soon&archived=perhaps&junk=1')
        expect(parsed).toEqual(DEFAULT_INBOX_STATE)
    })

    it('trims and bounds the search term', () => {
        expect(parseInboxUrl('q=%20%20').q).toBeUndefined()
        expect(parseInboxUrl(`q=${'a'.repeat(201)}`).q).toBeUndefined()
        expect(parseInboxUrl('q=%20hi%20').q).toBe('hi')
    })

    it('parses repeated labels, dedupes, and drops invalid label ids', () => {
        const parsed = parseInboxUrl(`label=${LABEL_1}&label=${LABEL_2}&label=${LABEL_1}&label=bad`)
        expect(parsed.labels).toEqual([LABEL_1, LABEL_2])
    })

    it('only treats unread/archived=true as meaningful, folding them into the view', () => {
        expect(parseInboxUrl('unread=false').view).toBeUndefined()
        expect(parseInboxUrl('archived=false').view).toBeUndefined()
        expect(parseInboxUrl('unread=true').view).toBe('unread')
        expect(parseInboxUrl('archived=true').view).toBe('archived')
        // The legacy fields themselves never survive normalization.
        expect(parseInboxUrl('unread=true').unread).toBeUndefined()
        expect(parseInboxUrl('view=bogus').view).toBeUndefined()
        expect(parseInboxUrl('view=awaiting').view).toBe('awaiting')
    })
})

describe('unified-inbox-url: cursor reset semantics', () => {
    const base: InboxUrlState = { labels: [], cursor: 'page-2', view: 'needs_reply' }

    it('drops the cursor when a filter field changes', () => {
        expect(mergeInboxState(base, { status: 'closed' }).cursor).toBeUndefined()
        expect(mergeInboxState(base, { q: 'term' }).cursor).toBeUndefined()
        expect(mergeInboxState(base, { labels: [LABEL_1] }).cursor).toBeUndefined()
        expect(mergeInboxState(base, { view: 'unread' }).cursor).toBeUndefined()
    })

    it('keeps the cursor when only the selected conversation changes', () => {
        expect(mergeInboxState(base, { conversation: CONV_1 }).cursor).toBe('page-2')
    })

    it('keeps an explicitly-patched cursor (load-more)', () => {
        expect(mergeInboxState(base, { cursor: 'page-3' }).cursor).toBe('page-3')
    })

    it('drops the selected conversation and cursor on tenant change', () => {
        const cleared = mergeInboxState(base, { conversation: undefined, cursor: undefined })
        expect(cleared.conversation).toBeUndefined()
        expect(cleared.cursor).toBeUndefined()
        // filters (and the active view) preserved
        expect(cleared.view).toBe('needs_reply')
    })
})

describe('unified-inbox-url: quick views + active filter count', () => {
    it('derives the active quick view from the view param (and folds legacy params)', () => {
        expect(activeQuickView(DEFAULT_INBOX_STATE)).toBe('inbox')
        for (const view of ['needs_reply', 'awaiting', 'unread', 'reminders', 'archived'] as const) {
            expect(activeQuickView({ labels: [], view })).toBe(view)
        }
        expect(activeQuickView({ labels: [], unread: true })).toBe('unread')
        expect(activeQuickView({ labels: [], reminder: 'active' })).toBe('reminders')
        expect(activeQuickView({ labels: [], archived: true })).toBe('archived')
        expect(activeQuickView({ labels: [], status: 'open' })).toBe('needs_reply')
    })

    it('quickViewPatch replaces the previous view and resets the cursor', () => {
        const patched = mergeInboxState({ labels: [], view: 'unread', cursor: 'c' }, quickViewPatch('awaiting'))
        expect(patched.view).toBe('awaiting')
        expect(patched.cursor).toBeUndefined()
        expect(mergeInboxState(patched, quickViewPatch('inbox')).view).toBeUndefined()
    })

    it('counts only active, non-view filters (search, campaign, account, labels)', () => {
        expect(activeFilterCount(DEFAULT_INBOX_STATE)).toBe(0)
        expect(activeFilterCount({ labels: [LABEL_1, LABEL_2], q: 'x', campaign: CAMPAIGN_1 })).toBe(4)
    })
})

describe('unified-inbox-api: org-scoped query keys', () => {
    it('separates cache keys by organization', () => {
        expect(inboxKeys.unread(ORG_A)).not.toEqual(inboxKeys.unread(ORG_B))
        expect(inboxKeys.detail(ORG_A, CONV_1)).not.toEqual(inboxKeys.detail(ORG_B, CONV_1))
        expect(inboxKeys.list(ORG_A, 'sig')).not.toEqual(inboxKeys.list(ORG_B, 'sig'))
    })

    it('list keys ignore cursor and selected conversation but react to filters', () => {
        const withCursor: InboxUrlState = { labels: [], status: 'open', cursor: 'page-2', conversation: CONV_1 }
        const withoutCursor: InboxUrlState = { labels: [], status: 'open' }
        expect(listFilterSignature(withCursor)).toBe(listFilterSignature(withoutCursor))
        expect(listFilterSignature({ labels: [], status: 'open' }))
            .not.toBe(listFilterSignature({ labels: [], status: 'closed' }))
    })
})

describe('unified-inbox-api: server query mapping', () => {
    it('maps validated URL state to the Phase 21 conversation query', () => {
        const state: InboxUrlState = {
            labels: [LABEL_1, LABEL_2],
            q: 'reply',
            view: 'awaiting',
            status: 'open',
            campaign: CAMPAIGN_1,
            account: ACCOUNT_1,
            cursor: 'page-2',
        }
        const qs = new URLSearchParams(toListQueryString(ORG_A, state, 25))
        expect(qs.get('organizationId')).toBe(ORG_A)
        expect(qs.get('limit')).toBe('25')
        expect(qs.get('search')).toBe('reply')
        expect(qs.get('view')).toBe('awaiting')
        expect(qs.get('status')).toBe('open')
        expect(qs.get('campaignId')).toBe(CAMPAIGN_1)
        expect(qs.get('emailAccountId')).toBe(ACCOUNT_1)
        // The deprecated composed params are never sent any more.
        expect(qs.get('unread')).toBeNull()
        expect(qs.get('reminderState')).toBeNull()
        expect(qs.get('archived')).toBeNull()
        expect(qs.get('cursor')).toBe('page-2')
        // Server currently filters by a single label; the first selected label is sent.
        expect(qs.get('labelId')).toBe(LABEL_1)
    })

    it('defaults to the inbox view and omits inactive filters', () => {
        const qs = new URLSearchParams(toListQueryString(ORG_A, DEFAULT_INBOX_STATE, 25))
        expect(qs.get('organizationId')).toBe(ORG_A)
        expect(qs.get('view')).toBe('inbox')
        expect(qs.get('archived')).toBeNull()
        expect(qs.get('unread')).toBeNull()
        expect(qs.get('status')).toBeNull()
        expect(qs.get('labelId')).toBeNull()
        expect(qs.get('search')).toBeNull()
        expect(qs.get('cursor')).toBeNull()
    })
})

// ============================================================
// Task 3 — presentational list + thread rendering
// ============================================================

function makeConversation(overrides: Partial<InboxConversationListItem> = {}): InboxConversationListItem {
    return {
        id: CONV_1,
        emailAccountId: ACCOUNT_1,
        leadId: null,
        campaignId: null,
        campaignLeadId: null,
        status: 'open',
        subject: 'Re: Demo request',
        preview: 'Sounds great, let us book a time.',
        lastMessageAt: '2026-07-16T10:00:00.000Z',
        lastInboundAt: '2026-07-16T10:00:00.000Z',
        lastOutboundAt: null,
        archived: false,
        unread: true,
        participants: [{ address: 'lead@acme.example', name: 'Lead Person', role: 'from' }],
        labels: [],
        ...overrides,
    }
}

function renderList(overrides: Partial<ConversationListProps> = {}) {
    const props: ConversationListProps = {
        conversations: [],
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
        hasMore: false,
        isFetchingNextPage: false,
        onLoadMore: vi.fn(),
        selectedId: null,
        onSelect: vi.fn(),
        hasFilters: false,
        hasSearch: false,
        searchTerm: '',
        onClearFilters: vi.fn(),
        searchValue: '',
        onSearchChange: vi.fn(),
        accountEmailById: { [ACCOUNT_1]: 'rep@skale.club' },
        campaignNameById: { [CAMPAIGN_1]: 'Q3 Outbound' },
        ...overrides,
    }
    return { props, ...render(<ConversationList {...props} />) }
}

describe('ConversationList: async states', () => {
    afterEach(() => vi.clearAllMocks())

    it('shows fixed row skeletons and an accessible loading status while loading', () => {
        renderList({ isLoading: true })
        expect(screen.getByRole('status')).toHaveTextContent('Loading conversations')
        expect(screen.queryByRole('button', { name: /Conversation with/ })).not.toBeInTheDocument()
    })

    it('shows the global empty state with no filters or search', () => {
        renderList()
        expect(screen.getByText('No outreach replies yet')).toBeInTheDocument()
    })

    it('shows a filtered empty state with Clear filters', () => {
        const onClearFilters = vi.fn()
        renderList({ hasFilters: true, onClearFilters })
        expect(screen.getByText('No conversations match these filters')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
        expect(onClearFilters).toHaveBeenCalledOnce()
    })

    it('echoes a truncated search term in the search empty state', () => {
        renderList({ hasSearch: true, hasFilters: true, searchTerm: 'quarterly review' })
        expect(screen.getByText(/No conversations match “quarterly review”/)).toBeInTheDocument()
    })

    it('renders an inline retry on list failure and calls onRetry', () => {
        const onRetry = vi.fn()
        renderList({ isError: true, onRetry })
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(onRetry).toHaveBeenCalledOnce()
    })

    // W-6: a FAILED background list refetch (SSE/unread invalidation, a mutation onSettled) must
    // not replace the loaded/cached rows the operator was scrolling with the blanking error card.
    it('keeps cached rows visible when a background list refetch fails, showing a non-destructive indicator', () => {
        renderList({
            isError: true,
            conversations: [makeConversation({ id: CONV_1, subject: 'Still here' })],
        })
        // The loaded rows stay put — the operator does not lose their place.
        expect(screen.getByRole('button', { name: /Conversation with Lead Person/ })).toBeInTheDocument()
        expect(screen.getByText('Still here')).toBeInTheDocument()
        // A non-destructive refresh-failed indicator replaces the full blanking error card.
        expect(screen.getByText(/Couldn’t refresh — showing the last loaded list/)).toBeInTheDocument()
        expect(screen.queryByText(/Couldn’t load conversations/)).not.toBeInTheDocument()
    })
})

describe('ConversationList: rows + pagination', () => {
    afterEach(() => vi.clearAllMocks())

    it('renders exactly the conversations it is given without client-side filtering', () => {
        const conversations = [
            makeConversation({ id: CONV_1, subject: 'First' }),
            makeConversation({ id: CAMPAIGN_1, subject: 'Second', unread: false }),
        ]
        renderList({ conversations })
        expect(screen.getAllByRole('button', { name: /Conversation with/ })).toHaveLength(2)
        expect(screen.getByText('First')).toBeInTheDocument()
        expect(screen.getByText('Second')).toBeInTheDocument()
    })

    it('exposes unread state to assistive tech, the campaign and the receiving account (not the provider)', () => {
        renderList({
            conversations: [makeConversation({ campaignId: CAMPAIGN_1 })],
        })
        const row = screen.getByRole('button', { name: /Conversation with Lead Person/ })
        expect(within(row).getByText('Unread')).toBeInTheDocument()
        expect(within(row).getByText('Q3 Outbound')).toBeInTheDocument()
        expect(within(row).getByText('rep@skale.club')).toBeInTheDocument()
        expect(within(row).queryByText('native')).not.toBeInTheDocument()
    })

    it('shows how long a needs-reply conversation has been waiting', () => {
        const hourAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
        renderList({
            conversations: [makeConversation({ status: 'open', lastInboundAt: hourAgo, lastOutboundAt: null, lastMessageAt: hourAgo })],
        })
        expect(screen.getByText('Waiting 2h ago')).toBeInTheDocument()
    })

    it('does not show a waiting badge when we replied last or the conversation is closed', () => {
        const earlier = new Date(Date.now() - 5 * 3600 * 1000).toISOString()
        const later = new Date(Date.now() - 3600 * 1000).toISOString()
        renderList({
            conversations: [
                makeConversation({ id: CONV_1, lastInboundAt: earlier, lastOutboundAt: later }),
                makeConversation({ id: CAMPAIGN_1, status: 'closed', lastInboundAt: later, lastOutboundAt: null }),
            ],
        })
        expect(screen.queryByText(/^Waiting/)).not.toBeInTheDocument()
    })

    it('badges bounces and auto replies when the list item carries the classification', () => {
        renderList({
            conversations: [
                makeConversation({ id: CONV_1, lastInboundClassification: 'bounce' } as Partial<InboxConversationListItem>),
                makeConversation({ id: CAMPAIGN_1, lastInboundClassification: 'auto_reply' } as Partial<InboxConversationListItem>),
            ],
        })
        expect(screen.getByText('Bounce')).toBeInTheDocument()
        expect(screen.getByText('Auto reply')).toBeInTheDocument()
    })

    it('flags every row as having a reminder while the Reminders view is active', () => {
        renderList({ conversations: [makeConversation()], remindersView: true })
        expect(screen.getByText('Reminder due')).toBeInTheDocument()
    })

    it('offers hover quick actions that archive and toggle read without opening the row', () => {
        const onSelect = vi.fn()
        const onToggleArchive = vi.fn()
        const onToggleRead = vi.fn()
        renderList({ conversations: [makeConversation()], onSelect, onToggleArchive, onToggleRead })
        fireEvent.click(screen.getByRole('button', { name: /Archive: Lead Person/ }))
        expect(onToggleArchive).toHaveBeenCalledWith(CONV_1, true)
        fireEvent.click(screen.getByRole('button', { name: /Mark as read: Lead Person/ }))
        expect(onToggleRead).toHaveBeenCalledWith(CONV_1, true)
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('marks the keyboard cursor row', () => {
        renderList({ conversations: [makeConversation()], cursorId: CONV_1 })
        expect(screen.getByRole('button', { name: /Conversation with Lead Person/ })).toHaveAttribute('data-cursor', 'true')
    })

    it('selects a conversation on click', () => {
        const onSelect = vi.fn()
        renderList({ conversations: [makeConversation()], onSelect })
        fireEvent.click(screen.getByRole('button', { name: /Conversation with Lead Person/ }))
        expect(onSelect).toHaveBeenCalledWith(CONV_1)
    })

    it('retains prior rows and shows Load more, calling onLoadMore once', () => {
        const onLoadMore = vi.fn()
        const conversations = [makeConversation({ id: CONV_1 }), makeConversation({ id: CAMPAIGN_1 })]
        renderList({ conversations, hasMore: true, onLoadMore })
        expect(screen.getAllByRole('button', { name: /Conversation with/ })).toHaveLength(2)
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
        expect(onLoadMore).toHaveBeenCalledOnce()
    })

    it('disables Load more while the next page is fetching', () => {
        renderList({ conversations: [makeConversation()], hasMore: true, isFetchingNextPage: true })
        expect(screen.getByRole('button', { name: /Loading/ })).toBeDisabled()
    })
})

// --- Thread ------------------------------------------------

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
    return {
        id: 'msg-1',
        direction: 'inbound',
        provider: 'native',
        subject: 'Re: Demo request',
        internetMessageId: '<abc@acme.example>',
        inReplyTo: null,
        fromAddress: 'lead@acme.example',
        fromName: 'Lead Person',
        toAddresses: [{ address: 'rep@skale.club', name: 'Rep' }],
        ccAddresses: [],
        bccAddresses: [],
        plainBody: 'Sounds great.',
        htmlBody: '<p>Sounds great.</p>',
        headers: {},
        attachments: [],
        hasAttachments: false,
        classification: 'reply',
        matchStrategy: 'in_reply_to',
        sentAt: null,
        receivedAt: '2026-07-16T10:00:00.000Z',
        createdAt: '2026-07-16T10:00:00.000Z',
        ...overrides,
    }
}

function makeDetail(overrides: Partial<InboxConversationDetail> = {}): InboxConversationDetail {
    return {
        conversation: {
            id: CONV_1,
            emailAccountId: ACCOUNT_1,
            leadId: 'lead-1',
            campaignId: CAMPAIGN_1,
            campaignLeadId: null,
            status: 'open',
            subject: 'Re: Demo request',
            lastMessageAt: '2026-07-16T10:00:00.000Z',
            lastInboundAt: '2026-07-16T10:00:00.000Z',
            lastOutboundAt: '2026-07-16T09:00:00.000Z',
            archived: false,
            unread: true,
            labels: [],
        },
        participants: [{ address: 'lead@acme.example', name: 'Lead Person', role: 'from' }],
        messages: [makeMessage()],
        ...overrides,
    }
}

function renderThread(props: Partial<React.ComponentProps<typeof ConversationThread>> = {}) {
    const merged = {
        detail: makeDetail(),
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
        onBack: vi.fn(),
        onClose: vi.fn(),
        providerByAccount: { [ACCOUNT_1]: 'native' },
        accountEmailById: { [ACCOUNT_1]: 'rep@skale.club' },
        campaignNameById: { [CAMPAIGN_1]: 'Q3 Outbound' },
        ...props,
    }
    return { props: merged, ...render(<ConversationThread {...merged} />) }
}

describe('ConversationThread: async states + safety', () => {
    useThreadTimerGuard()
    afterEach(() => vi.clearAllMocks())

    it('shows a thread skeleton while loading', () => {
        renderThread({ isLoading: true, detail: undefined })
        expect(screen.getByText('Loading…')).toBeInTheDocument()
    })

    it('offers a thread-only retry on failure', () => {
        const onRetry = vi.fn()
        renderThread({ isError: true, detail: undefined, onRetry })
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(onRetry).toHaveBeenCalledOnce()
    })

    it('renders the subject, attribution, and campaign name', () => {
        renderThread()
        expect(screen.getByRole('heading', { name: 'Re: Demo request' })).toBeInTheDocument()
        expect(screen.getByText('Q3 Outbound')).toBeInTheDocument()
    })

    it('shows the account email (not the provider or a cut UUID) in the attribution strip', () => {
        renderThread()
        expect(screen.getByText('Account:').nextElementSibling).toHaveTextContent('rep@skale.club')
        expect(screen.getByText('Account:').nextElementSibling).not.toHaveTextContent(/native/i)
    })

    it('falls back to a plain label, never a cut UUID, when the account is unknown', () => {
        renderThread({ accountEmailById: {}, providerByAccount: {} })
        expect(screen.getByText('Unknown account')).toBeInTheDocument()
        expect(screen.queryByText(ACCOUNT_1.slice(0, 8))).not.toBeInTheDocument()
    })

    it('links the campaign and the lead to the campaign page', () => {
        renderThread()
        const href = `/outreach/campaigns/${CAMPAIGN_1}`
        expect(screen.getByRole('link', { name: 'Q3 Outbound' })).toHaveAttribute('href', href)
        expect(screen.getByRole('link', { name: 'View campaign' })).toHaveAttribute('href', href)
    })

    it('does not render campaign links without a campaign', () => {
        renderThread({
            detail: makeDetail({ conversation: { ...makeDetail().conversation, campaignId: null } }),
        })
        expect(screen.queryByRole('link', { name: 'View campaign' })).not.toBeInTheDocument()
    })

    it('badges messages classified as bounce or auto reply', () => {
        renderThread({
            detail: makeDetail({
                messages: [
                    makeMessage({ id: 'b1', fromName: 'Mailer Daemon', classification: 'bounce', receivedAt: '2026-07-16T08:00:00.000Z' }),
                    makeMessage({ id: 'a1', fromName: 'Out Of Office', classification: 'auto_reply', receivedAt: '2026-07-16T09:00:00.000Z' }),
                    makeMessage({ id: 'r1', fromName: 'Real Reply', classification: 'reply', receivedAt: '2026-07-16T10:00:00.000Z' }),
                ],
            }),
        })
        expect(within(screen.getByRole('button', { name: /Mailer Daemon/ })).getByText('Bounce')).toBeInTheDocument()
        expect(within(screen.getByRole('button', { name: /Out Of Office/ })).getByText('Auto reply')).toBeInTheDocument()
        expect(within(screen.getByRole('button', { name: /Real Reply/ })).queryByText('Bounce')).not.toBeInTheDocument()
    })

    it('moves focus to the thread heading when a conversation opens', () => {
        renderThread()
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Re: Demo request' }))
    })

    it('shows "Not linked" when attribution is unknown', () => {
        renderThread({
            detail: makeDetail({
                conversation: { ...makeDetail().conversation, campaignId: null, leadId: null },
            }),
            campaignNameById: {},
        })
        expect(screen.getAllByText('Not linked').length).toBeGreaterThanOrEqual(2)
    })

    it('isolates malformed HTML inside a non-script sandboxed iframe', () => {
        const evil = '<p>hi</p><script>window.__XSS_INBOX__ = 1</script><img src=x onerror="window.__XSS_INBOX2__=1">'
        const { container } = renderThread({
            detail: makeDetail({ messages: [makeMessage({ htmlBody: evil })] }),
        })
        const iframe = container.querySelector('iframe')
        expect(iframe).not.toBeNull()
        const sandbox = iframe?.getAttribute('sandbox') ?? ''
        expect(sandbox).not.toContain('allow-scripts')
        expect((window as unknown as Record<string, unknown>).__XSS_INBOX__).toBeUndefined()
    })

    it('calls onBack from the mobile Back control', () => {
        const onBack = vi.fn()
        renderThread({ onBack })
        fireEvent.click(screen.getByRole('button', { name: /Back/ }))
        expect(onBack).toHaveBeenCalledOnce()
    })
})

describe('ConversationThread: background refetch failure does not blank or destroy the composer (C-1)', () => {
    useThreadTimerGuard()
    afterEach(() => vi.clearAllMocks())

    it('keeps the thread + composer (and its typed draft) when a background detail refetch fails but cached data is retained', () => {
        const detail = makeDetail()
        // A REAL composer rendered as the thread footer — the same wiring the page uses. If the
        // parent unmounts on a background error, this composer (and its draft) is destroyed.
        const composerNode = (
            <ConversationComposer
                accounts={ACCOUNTS}
                defaultAccountId={ACCOUNT_1}
                replyToPreview={['lead@acme.example']}
                replyAllCcPreview={[]}
                subjectPreview="Re: Demo request"
                snippets={SNIPPETS}
                onSend={vi.fn(async () => makeCommand())}
                onUploadAttachment={vi.fn()}
                polledCommand={null}
            />
        )
        const baseProps = {
            detail,
            isLoading: false,
            isError: false,
            onRetry: vi.fn(),
            onBack: vi.fn(),
            onClose: vi.fn(),
            providerByAccount: { [ACCOUNT_1]: 'native' },
            campaignNameById: { [CAMPAIGN_1]: 'Q3 Outbound' },
            composer: composerNode,
        }
        const { rerender } = render(<ConversationThread {...baseProps} />)

        // Operator opens the composer and starts typing a reply.
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'half-written reply' } })

        // An SSE-triggered background detail refetch fails: React Query flips status to 'error' but
        // RETAINS the cached detail. The thread must NOT blank + unmount the composer.
        rerender(<ConversationThread {...baseProps} isError />)

        // The thread still renders from cached data and the draft survives (composer stayed mounted).
        expect(screen.getByRole('heading', { name: 'Re: Demo request' })).toBeInTheDocument()
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('half-written reply')
        // A NON-destructive refresh-failed indicator is shown — never the full-screen error card.
        expect(screen.getByText(/Couldn’t refresh/)).toBeInTheDocument()
        expect(screen.queryByText(/Couldn’t load this conversation/)).not.toBeInTheDocument()
    })
})

describe('ConversationThread: expansion', () => {
    useThreadTimerGuard()
    afterEach(() => vi.clearAllMocks())

    it('expands the latest message and collapses older ones, toggling by keyboard-operable buttons', () => {
        const detail = makeDetail({
            messages: [
                makeMessage({ id: 'm1', fromName: 'Older Sender', direction: 'inbound', receivedAt: '2026-07-16T08:00:00.000Z' }),
                makeMessage({ id: 'm2', fromName: 'Middle Sender', direction: 'outbound', sentAt: '2026-07-16T09:00:00.000Z', receivedAt: null }),
                makeMessage({ id: 'm3', fromName: 'Latest Sender', direction: 'inbound', receivedAt: '2026-07-16T10:00:00.000Z' }),
            ],
        })
        renderThread({ detail })
        // Latest message expands; the two older messages stay collapsed.
        const older = screen.getByRole('button', { name: /Older Sender/ })
        expect(older).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByRole('button', { name: /Latest Sender/ })).toHaveAttribute('aria-expanded', 'true')
        fireEvent.click(older)
        expect(screen.getByRole('button', { name: /Older Sender/ })).toHaveAttribute('aria-expanded', 'true')
    })
})

// ============================================================
// Task 3 — page coordinator: tenant isolation + selection/stage
// ============================================================

const hooks = vi.hoisted(() => {
    const makeListReturn = (conversations: InboxConversationListItem[], opts: Record<string, unknown> = {}) => ({
        data: { pages: [{ conversations, nextCursor: null, hasMore: false, count: conversations.length, syncStatus: [] }] },
        isLoading: false,
        isError: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: false,
        refetch: vi.fn(),
        fetchNextPage: vi.fn(),
        dataUpdatedAt: Date.now(),
        ...opts,
    })
    return {
        navigate: vi.fn(),
        state: {
            org: { id: '' } as { id: string } | null,
            search: '',
            list: makeListReturn([]),
            detail: { data: undefined as InboxConversationDetail | undefined, isLoading: false, isError: false, refetch: vi.fn() },
            labelAttachPending: false,
            readStateMutate: vi.fn(),
            archiveMutate: vi.fn(),
            accounts: { data: [] as Array<{ id: string; email: string; provider: string }>, isLoading: false },
        },
        makeListReturn,
    }
})

vi.mock('wouter', () => ({
    useLocation: () => ['/outreach/unified-inbox', hooks.navigate],
    useSearch: () => hooks.state.search,
    Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
        <a href={href} {...rest}>{children}</a>
    ),
}))

// The AI automation chip talks to the settings endpoints through react-query; the page tests render
// without a QueryClientProvider, so the container hook is stubbed (the chip itself is tested below).
vi.mock('@/components/outreach/inbox/useOrgAiAutomation', () => ({
    useOrgAiAutomation: () => ({
        settings: undefined,
        isLoading: false,
        isError: false,
        pause: vi.fn(),
        resume: vi.fn(),
        pending: false,
        error: null,
    }),
}))

vi.mock('@/hooks/useOrganization', () => ({
    useOrganization: () => ({
        currentOrganization: hooks.state.org,
        organizations: [],
        setCurrentOrganization: () => {},
        isLoading: false,
    }),
}))

vi.mock('@/components/outreach/OutreachLayout', () => ({
    OutreachLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const stubMutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false, isError: false, reset: vi.fn() })

vi.mock('@/hooks/useUnifiedInbox', () => ({
    useInboxConversations: () => hooks.state.list,
    useInboxConversation: () => hooks.state.detail,
    useInboxLabels: () => ({ data: [], isLoading: false }),
    useInboxCampaignOptions: () => ({ data: [] }),
    useInboxAccountOptions: () => hooks.state.accounts,
    useInboxUnreadCount: () => ({ data: 0 }),
    useInboxCounts: () => ({ data: undefined }),
    // Operator mutations are stubbed for the page/wiring tests; the REAL implementations are
    // exercised against a fake network in the "operator mutations" describe via importActual.
    useInboxReadState: () => ({ ...stubMutation(), mutate: hooks.state.readStateMutate }),
    useInboxArchive: () => ({ ...stubMutation(), mutate: hooks.state.archiveMutate }),
    useInboxStatus: () => stubMutation(),
    useInboxLabelAttach: () => ({ ...stubMutation(), isPending: hooks.state.labelAttachPending }),
    useInboxLabelDetach: () => stubMutation(),
    useCreateInboxLabel: () => stubMutation(),
    useInboxBulkAction: () => stubMutation(),
    useInboxConversationReminders: () => ({ data: [], isLoading: false }),
    useInboxReminderMutations: () => ({ create: stubMutation(), update: stubMutation(), remove: stubMutation() }),
    useInboxSuppression: () => ({ preview: vi.fn(), apply: vi.fn().mockResolvedValue(undefined), isApplying: false }),
    useInboxSnippets: () => ({ data: [] }),
    useInboxComposer: () => ({
        send: vi.fn().mockResolvedValue({ id: 'cmd-1', status: 'scheduled' }),
        cancel: vi.fn(),
        uploadAttachment: vi.fn(),
        removeAttachment: vi.fn(),
        polledCommand: null,
        reset: vi.fn(),
    }),
    // AI draft assistant hooks: default OFF so the page wiring tests never surface the affordance.
    useInboxAiSettings: () => ({ data: { draftAssistanceEnabled: false } }),
    useInboxAiRuns: () => ({ data: [] }),
    useInboxAiSuggestion: () => ({ request: vi.fn(), accept: vi.fn() }),
}))

// Imported AFTER the mocks so the page picks up the mocked modules.
import UnifiedInboxPage from '@/pages/outreach/UnifiedInboxPage'

describe('UnifiedInboxPage: tenant isolation + selection', () => {
    useThreadTimerGuard()
    afterEach(() => {
        vi.clearAllMocks()
        hooks.state.org = { id: '' }
        hooks.state.search = ''
        hooks.state.list = hooks.makeListReturn([])
        hooks.state.detail = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() }
        hooks.state.labelAttachPending = false
        hooks.state.readStateMutate = vi.fn()
        hooks.state.archiveMutate = vi.fn()
        hooks.state.accounts = { data: [], isLoading: false }
        window.localStorage.clear()
    })

    // Opening a conversation used to never mark it read — the only `readState.mutate` call was
    // the explicit "Mark read" button. The page now marks read once the opened conversation's
    // detail resolves unread, without disturbing the manual toggle.
    it('marks the opened conversation read once its detail resolves unread', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `conversation=${CONV_1}`
        hooks.state.detail = { data: makeDetail(), isLoading: false, isError: false, refetch: vi.fn() }
        render(<UnifiedInboxPage />)
        expect(hooks.state.readStateMutate).toHaveBeenCalledWith({ conversationId: CONV_1, read: true, upTo: '2026-07-16T10:00:00.000Z' })
        expect(hooks.state.readStateMutate).toHaveBeenCalledTimes(1)
    })

    it('does not mark read again on a re-render of the same open conversation', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `conversation=${CONV_1}`
        hooks.state.detail = { data: makeDetail(), isLoading: false, isError: false, refetch: vi.fn() }
        const view = render(<UnifiedInboxPage />)
        view.rerender(<UnifiedInboxPage />)
        expect(hooks.state.readStateMutate).toHaveBeenCalledTimes(1)
    })

    it('does not auto-mark read when the opened conversation is already read', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `conversation=${CONV_1}`
        hooks.state.detail = {
            data: makeDetail({ conversation: { ...makeDetail().conversation, unread: false } }),
            isLoading: false,
            isError: false,
            refetch: vi.fn(),
        }
        render(<UnifiedInboxPage />)
        expect(hooks.state.readStateMutate).not.toHaveBeenCalled()
    })

    it('prompts to pick an organization when none is selected', () => {
        hooks.state.org = null
        render(<UnifiedInboxPage />)
        expect(screen.getByText('Select an organization to open the inbox')).toBeInTheDocument()
    })

    it('navigates with a conversation param when a row is selected', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = ''
        hooks.state.list = hooks.makeListReturn([makeConversation()])
        render(<UnifiedInboxPage />)
        fireEvent.click(screen.getByRole('button', { name: /Conversation with Lead Person/ }))
        expect(hooks.navigate).toHaveBeenCalledWith(`/outreach/unified-inbox?conversation=${CONV_1}`)
    })

    it('clears the selected conversation when the organization changes', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `conversation=${CONV_1}`
        hooks.state.detail = { data: makeDetail(), isLoading: false, isError: false, refetch: vi.fn() }
        const view = render(<UnifiedInboxPage />)

        hooks.state.org = { id: ORG_B }
        view.rerender(<UnifiedInboxPage />)

        expect(hooks.navigate).toHaveBeenCalledWith('/outreach/unified-inbox', { replace: true })
    })

    it('returns to the list stage when Back is pressed in a thread', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `conversation=${CONV_1}`
        hooks.state.detail = { data: makeDetail(), isLoading: false, isError: false, refetch: vi.fn() }
        render(<UnifiedInboxPage />)
        fireEvent.click(screen.getByRole('button', { name: /Back/ }))
        expect(hooks.navigate).toHaveBeenCalledWith('/outreach/unified-inbox')
    })

    // W-5: on organization change the effect cleared only conversation + cursor, leaving the bulk
    // selection (org-A ids) and the campaign/account/label filter UUIDs (URL) intact — a stale
    // count and org-A ids POSTed under org B. The org switch must clear the bulk selection and drop
    // the previous org's filter UUIDs.
    it('clears bulk selection and drops the previous org filter UUIDs on organization change', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `campaign=${CAMPAIGN_1}`
        hooks.state.list = hooks.makeListReturn([makeConversation()])
        const view = render(<UnifiedInboxPage />)

        // Enter bulk mode and select a row under org A.
        fireEvent.click(screen.getByRole('button', { name: /Select conversations for bulk actions/ }))
        fireEvent.click(screen.getByRole('checkbox', { name: /Select conversation with Lead Person/ }))
        expect(screen.getByText('1 selected')).toBeInTheDocument()

        // Switch organizations.
        hooks.navigate.mockClear()
        hooks.state.org = { id: ORG_B }
        view.rerender(<UnifiedInboxPage />)

        // The previous org's campaign filter UUID is dropped from the URL...
        expect(hooks.navigate).toHaveBeenCalledWith('/outreach/unified-inbox', { replace: true })
        // ...and the org-A bulk selection is cleared (no stale count / org-A ids in a new-org POST).
        expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Select conversations for bulk actions/ })).toBeInTheDocument()
    })

    // W-4: label attach/detach were NOT in the shared `busy` gate, so an operator could fire a
    // label op concurrently with archive/read/status — and a failed label rollback (org-wide list
    // snapshot) could revert the other in-flight mutation's optimistic patch. Gating label ops with
    // the other single-conversation actions prevents the overlap.
    it('gates single-conversation actions while a label mutation is in flight', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `conversation=${CONV_1}`
        hooks.state.detail = { data: makeDetail(), isLoading: false, isError: false, refetch: vi.fn() }
        hooks.state.labelAttachPending = true
        render(<UnifiedInboxPage />)
        expect(screen.getByRole('button', { name: 'Mark read' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
    })

    // The sync effect used to re-apply the trimmed URL value to the input, eating a trailing space
    // while the operator was still typing a multi-word query.
    it('keeps a trailing space in the search box while the debounced URL update lands', () => {
        hooks.state.org = { id: ORG_A }
        const view = render(<UnifiedInboxPage />)
        const box = screen.getByRole('searchbox', { name: 'Search conversations' })
        fireEvent.change(box, { target: { value: 'quarterly ' } })
        act(() => { vi.advanceTimersByTime(350) })
        expect(hooks.navigate).toHaveBeenCalledWith(`/outreach/unified-inbox?q=quarterly`)
        // The URL now reports the trimmed term back.
        hooks.state.search = 'q=quarterly'
        view.rerender(<UnifiedInboxPage />)
        expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveValue('quarterly ')
    })

    it('syncs the search box when the URL changes externally (e.g. clear filters)', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = 'q=invoice'
        const view = render(<UnifiedInboxPage />)
        expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveValue('invoice')
        hooks.state.search = ''
        view.rerender(<UnifiedInboxPage />)
        expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveValue('')
    })

    it('clears the search with the clear button and with Escape', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = 'q=invoice'
        render(<UnifiedInboxPage />)
        fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
        expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveValue('')
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search conversations' }), { target: { value: 'again' } })
        fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search conversations' }), { key: 'Escape' })
        expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveValue('')
    })

    it('has no "Unified Inbox" title row at desktop width', () => {
        hooks.state.org = { id: ORG_A }
        render(<UnifiedInboxPage />)
        expect(screen.queryByRole('heading', { name: 'Unified Inbox' })).not.toBeInTheDocument()
    })

    it('collapses the filter rail and remembers it', () => {
        hooks.state.org = { id: ORG_A }
        const view = render(<UnifiedInboxPage />)
        expect(screen.getByRole('navigation', { name: 'Conversation filters' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Hide filters' }))
        expect(screen.queryByRole('navigation', { name: 'Conversation filters' })).not.toBeInTheDocument()
        expect(window.localStorage.getItem('xmail:inbox-rail-collapsed')).toBe('1')
        view.unmount()
        render(<UnifiedInboxPage />)
        expect(screen.getByRole('button', { name: 'Show filters' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Show filters' }))
        expect(screen.getByRole('navigation', { name: 'Conversation filters' })).toBeInTheDocument()
    })

    it('explains why the composer is unavailable when there are no sending accounts', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `conversation=${CONV_1}`
        hooks.state.detail = { data: makeDetail(), isLoading: false, isError: false, refetch: vi.fn() }
        hooks.state.accounts = { data: [], isLoading: false }
        render(<UnifiedInboxPage />)
        expect(screen.getByText(/no sending account is available/i)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
    })

    it('renders the composer, sending as the conversation account, when accounts exist', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `conversation=${CONV_1}`
        hooks.state.detail = { data: makeDetail(), isLoading: false, isError: false, refetch: vi.fn() }
        hooks.state.accounts = { data: [{ id: ACCOUNT_1, email: 'rep@skale.club', provider: 'native' }], isLoading: false }
        render(<UnifiedInboxPage />)
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        expect(screen.getByText(/Sending as/)).toHaveTextContent('Sending as rep@skale.club')
    })

    describe('keyboard shortcuts', () => {
        function setup() {
            hooks.state.org = { id: ORG_A }
            hooks.state.search = `conversation=${CONV_1}`
            hooks.state.list = hooks.makeListReturn([
                makeConversation({ id: CONV_1 }),
                makeConversation({ id: CAMPAIGN_1, subject: 'Second' }),
            ])
            hooks.state.detail = { data: makeDetail(), isLoading: false, isError: false, refetch: vi.fn() }
            hooks.state.accounts = { data: [{ id: ACCOUNT_1, email: 'rep@skale.club', provider: 'native' }], isLoading: false }
            return render(<UnifiedInboxPage />)
        }

        it('j moves the cursor and Enter opens the conversation under it', () => {
            setup()
            fireEvent.keyDown(document.body, { key: 'j' })
            const second = screen.getAllByRole('button', { name: /Conversation with/ })[1]
            expect(second).toHaveAttribute('data-cursor', 'true')
            hooks.navigate.mockClear()
            fireEvent.keyDown(document.body, { key: 'Enter' })
            expect(hooks.navigate).toHaveBeenCalledWith(expect.stringContaining(`conversation=${CAMPAIGN_1}`))
        })

        it('e archives and u toggles unread on the open conversation', () => {
            setup()
            fireEvent.keyDown(document.body, { key: 'e' })
            expect(hooks.state.archiveMutate).toHaveBeenCalledWith({ conversationId: CONV_1, archived: true })
            hooks.state.readStateMutate.mockClear()
            fireEvent.keyDown(document.body, { key: 'u' })
            // The fixture is unread, so toggling marks it read.
            expect(hooks.state.readStateMutate).toHaveBeenCalledWith({ conversationId: CONV_1, read: true })
        })

        it('r opens the reply composer and focuses its body', () => {
            setup()
            fireEvent.keyDown(document.body, { key: 'r' })
            expect(screen.getByRole('textbox', { name: 'Reply body' })).toBeInTheDocument()
            expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Reply body' }))
        })

        it('a and f open reply-all and forward', () => {
            setup()
            fireEvent.keyDown(document.body, { key: 'a' })
            expect(screen.getByRole('textbox', { name: 'Reply body' })).toBeInTheDocument()
            expect(screen.getByText('Reply all', { selector: 'p' })).toBeInTheDocument()
            fireEvent.keyDown(document.body, { key: 'f' })
            expect(screen.getByRole('textbox', { name: 'Forward recipients' })).toBeInTheDocument()
        })

        it('/ focuses the search box', () => {
            setup()
            fireEvent.keyDown(document.body, { key: '/' })
            expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search conversations' }))
        })

        it('? opens the shortcut help', () => {
            setup()
            fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
            expect(screen.getByText('Keyboard shortcuts', { selector: 'p' })).toBeInTheDocument()
        })

        it('ignores shortcuts while typing in a field', () => {
            setup()
            const box = screen.getByRole('searchbox', { name: 'Search conversations' })
            box.focus()
            fireEvent.keyDown(box, { key: 'e' })
            expect(hooks.state.archiveMutate).not.toHaveBeenCalled()
        })

        it('ignores shortcuts with a modifier key held', () => {
            setup()
            fireEvent.keyDown(document.body, { key: 'e', ctrlKey: true })
            expect(hooks.state.archiveMutate).not.toHaveBeenCalled()
        })
    })

    it('restores focus to the selected row when Back is pressed', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.search = `conversation=${CONV_1}`
        hooks.state.list = hooks.makeListReturn([makeConversation()])
        hooks.state.detail = { data: makeDetail(), isLoading: false, isError: false, refetch: vi.fn() }
        const view = render(<UnifiedInboxPage />)
        fireEvent.click(screen.getByRole('button', { name: /Back/ }))
        // The URL leaves the conversation selection; the page re-renders on the list stage.
        hooks.state.search = ''
        hooks.state.detail = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() }
        view.rerender(<UnifiedInboxPage />)
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Conversation with Lead Person/ }))
    })
})

describe('UnifiedInboxPage: filter sheet below xl', () => {
    const originalMatchMedia = window.matchMedia
    beforeEach(() => {
        window.matchMedia = ((query: string) => ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        })) as unknown as typeof window.matchMedia
        hooks.state.org = { id: ORG_A }
    })
    afterEach(() => {
        window.matchMedia = originalMatchMedia
        hooks.state.org = { id: '' }
        vi.clearAllMocks()
    })

    it('opens an accessible modal dialog, closes on Escape and restores focus to the trigger', async () => {
        render(<UnifiedInboxPage />)
        const trigger = screen.getByRole('button', { name: /Filters/ })
        fireEvent.click(trigger)
        const dialog = await screen.findByRole('dialog', { name: 'Filters' })
        expect(dialog).toHaveAttribute('aria-modal', 'true')
        fireEvent.keyDown(dialog, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Filters' })).not.toBeInTheDocument())
        expect(document.activeElement).toBe(trigger)
    })
})

// ============================================================
// Task 1 — operator mutations: optimistic patch + snapshot rollback (locked #4)
// ============================================================
// These exercise the REAL hooks (imported past the module mock) against the mocked apiFetch.
// A fresh QueryClient per test keeps caches isolated; seeded list/detail data has no observer,
// so the onSettled invalidation marks-stale without a refetch — assertions stay deterministic.

type RealInboxHooks = typeof import('@/hooks/useUnifiedInbox')

function makeWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    return { queryClient, wrapper }
}

function seedList(
    queryClient: QueryClient,
    organizationId: string,
    conversations: InboxConversationListItem[],
) {
    const sig = listFilterSignature(DEFAULT_INBOX_STATE)
    const key = inboxKeys.list(organizationId, sig)
    queryClient.setQueryData(key, {
        pages: [{ conversations, nextCursor: null, hasMore: false, count: conversations.length, syncStatus: [] }],
        pageParams: [null],
    })
    return key
}

function listConversations(queryClient: QueryClient, key: readonly unknown[]): InboxConversationListItem[] {
    const data = queryClient.getQueryData(key) as InfiniteData<{ conversations: InboxConversationListItem[] }> | undefined
    return data?.pages.flatMap((p) => p.conversations) ?? []
}

describe('operator mutations: optimistic + rollback', () => {
    let hooksModule: RealInboxHooks
    beforeAll(async () => {
        hooksModule = await vi.importActual<RealInboxHooks>('@/hooks/useUnifiedInbox')
    })
    beforeEach(() => {
        apiClientMocks.apiFetch.mockReset()
    })

    it('optimistically marks read and reconciles unread from the server response', async () => {
        const { queryClient, wrapper } = makeWrapper()
        const listKey = seedList(queryClient, ORG_A, [makeConversation({ unread: true })])
        const detailKey = inboxKeys.detail(ORG_A, CONV_1)
        queryClient.setQueryData(detailKey, makeDetail({
            conversation: { ...makeDetail().conversation, unread: true },
        }))
        apiClientMocks.apiFetch.mockResolvedValueOnce({ conversationId: CONV_1, read: true, unread: false })

        const { result } = renderHook(() => hooksModule.useInboxReadState(ORG_A), { wrapper })
        await act(async () => {
            await result.current.mutateAsync({ conversationId: CONV_1, read: true })
        })

        expect(listConversations(queryClient, listKey)[0].unread).toBe(false)
        expect((queryClient.getQueryData(detailKey) as InboxConversationDetail).conversation.unread).toBe(false)
        // read-state PATCH carries organizationId in the query string.
        expect(apiClientMocks.apiFetch.mock.calls[0][0]).toContain(`organizationId=${ORG_A}`)
    })

    it.each([403, 409, 500])('restores the EXACT prior list + thread state when the request fails with %s', async (status) => {
        const { queryClient, wrapper } = makeWrapper()
        const listKey = seedList(queryClient, ORG_A, [makeConversation({ unread: true })])
        const detailKey = inboxKeys.detail(ORG_A, CONV_1)
        const originalDetail = makeDetail({ conversation: { ...makeDetail().conversation, unread: true } })
        queryClient.setQueryData(detailKey, originalDetail)
        apiClientMocks.apiFetch.mockRejectedValueOnce(new apiClientMocks.ApiClientError('nope', { status }))

        const { result } = renderHook(() => hooksModule.useInboxReadState(ORG_A), { wrapper })
        await act(async () => {
            await result.current.mutateAsync({ conversationId: CONV_1, read: true }).catch(() => undefined)
        })
        await waitFor(() => expect(result.current.isError).toBe(true))

        // Prior state restored byte-for-byte: still unread in BOTH caches.
        expect(listConversations(queryClient, listKey)[0].unread).toBe(true)
        expect((queryClient.getQueryData(detailKey) as InboxConversationDetail).conversation.unread).toBe(true)
    })

    it('never touches another organization’s cache on rollback', async () => {
        const { queryClient, wrapper } = makeWrapper()
        const orgAKey = seedList(queryClient, ORG_A, [makeConversation({ unread: true })])
        const orgBKey = seedList(queryClient, ORG_B, [makeConversation({ unread: true })])
        apiClientMocks.apiFetch.mockRejectedValueOnce(new apiClientMocks.ApiClientError('nope', { status: 500 }))

        const { result } = renderHook(() => hooksModule.useInboxReadState(ORG_A), { wrapper })
        await act(async () => {
            await result.current.mutateAsync({ conversationId: CONV_1, read: true }).catch(() => undefined)
        })

        expect(listConversations(queryClient, orgAKey)[0].unread).toBe(true) // rolled back
        expect(listConversations(queryClient, orgBKey)[0].unread).toBe(true) // untouched throughout
    })

    it('composes sequential read then archive patches on the same conversation', async () => {
        const { queryClient, wrapper } = makeWrapper()
        const listKey = seedList(queryClient, ORG_A, [makeConversation({ unread: true, archived: false })])
        apiClientMocks.apiFetch
            .mockResolvedValueOnce({ conversationId: CONV_1, read: true, unread: false })
            .mockResolvedValueOnce({ conversation: { id: CONV_1, status: 'open', archived: true, updatedAt: '2026-07-16T11:00:00.000Z' } })

        const read = renderHook(() => hooksModule.useInboxReadState(ORG_A), { wrapper })
        await act(async () => { await read.result.current.mutateAsync({ conversationId: CONV_1, read: true }) })
        const archive = renderHook(() => hooksModule.useInboxArchive(ORG_A), { wrapper })
        await act(async () => { await archive.result.current.mutateAsync({ conversationId: CONV_1, archived: true }) })

        const conv = listConversations(queryClient, listKey)[0]
        expect(conv.unread).toBe(false)
        expect(conv.archived).toBe(true)
    })

    it('applies a bounded bulk read to only the selected loaded ids and reports partial results', async () => {
        const { queryClient, wrapper } = makeWrapper()
        const listKey = seedList(queryClient, ORG_A, [
            makeConversation({ id: CONV_1, unread: true }),
            makeConversation({ id: CAMPAIGN_1, unread: true }),
        ])
        apiClientMocks.apiFetch.mockResolvedValueOnce({ matched: 2, updated: 2, skipped: 0 })

        const { result } = renderHook(() => hooksModule.useInboxBulkAction(ORG_A), { wrapper })
        let outcome: { matched: number; updated: number; skipped: number } | undefined
        await act(async () => {
            outcome = await result.current.mutateAsync({ conversationIds: [CONV_1, CAMPAIGN_1], action: 'read' })
        })

        expect(outcome).toEqual({ matched: 2, updated: 2, skipped: 0 })
        expect(listConversations(queryClient, listKey).every((c) => c.unread === false)).toBe(true)
        // The bulk POST body carries exactly the two selected ids — never a filter-wide selector.
        const body = JSON.parse(apiClientMocks.apiFetch.mock.calls[0][1].body)
        expect(body.conversationIds).toEqual([CONV_1, CAMPAIGN_1])
    })

    it('rolls back a failed bulk action across every affected row', async () => {
        const { queryClient, wrapper } = makeWrapper()
        const listKey = seedList(queryClient, ORG_A, [
            makeConversation({ id: CONV_1, unread: true }),
            makeConversation({ id: CAMPAIGN_1, unread: true }),
        ])
        apiClientMocks.apiFetch.mockRejectedValueOnce(new apiClientMocks.ApiClientError('nope', { status: 500 }))

        const { result } = renderHook(() => hooksModule.useInboxBulkAction(ORG_A), { wrapper })
        await act(async () => {
            await result.current.mutateAsync({ conversationIds: [CONV_1, CAMPAIGN_1], action: 'read' }).catch(() => undefined)
        })

        expect(listConversations(queryClient, listKey).every((c) => c.unread === true)).toBe(true)
    })

    // W-3: the bulk mutation optimistically patches every selected conversation's DETAIL cache, so
    // a failed bulk action must restore the open thread's detail too — not just the list — or an
    // open selected thread's header shows a phantom optimistic state (misrepresenting a failure).
    it('restores the DETAIL cache of an open selected conversation when a bulk action fails', async () => {
        const { queryClient, wrapper } = makeWrapper()
        const listKey = seedList(queryClient, ORG_A, [
            makeConversation({ id: CONV_1, unread: true }),
            makeConversation({ id: CAMPAIGN_1, unread: true }),
        ])
        // Conversation X (CONV_1) is OPEN — its thread header shows unread=true.
        const detailKey = inboxKeys.detail(ORG_A, CONV_1)
        queryClient.setQueryData(detailKey, makeDetail({ conversation: { ...makeDetail().conversation, unread: true } }))
        apiClientMocks.apiFetch.mockRejectedValueOnce(new apiClientMocks.ApiClientError('nope', { status: 500 }))

        const { result } = renderHook(() => hooksModule.useInboxBulkAction(ORG_A), { wrapper })
        await act(async () => {
            await result.current.mutateAsync({ conversationIds: [CONV_1, CAMPAIGN_1], action: 'read' }).catch(() => undefined)
        })
        await waitFor(() => expect(result.current.isError).toBe(true))

        // The open thread's detail is restored (still unread) — never left optimistically read.
        expect((queryClient.getQueryData(detailKey) as InboxConversationDetail).conversation.unread).toBe(true)
        // And the list rollback still holds.
        expect(listConversations(queryClient, listKey).every((c) => c.unread === true)).toBe(true)
    })
})

// ============================================================
// Task 2 — accessible single actions + bounded bulk toolbar
// ============================================================

const LABEL_A: InboxLabel = { id: LABEL_1, name: 'Priority', color: null }
const LABEL_B: InboxLabel = { id: LABEL_2, name: 'Follow up', color: '#00ff00' }

function makeSummary(overrides: Partial<InboxConversationDetail['conversation']> = {}) {
    return { ...makeDetail().conversation, ...overrides }
}

function renderActions(overrides: Partial<React.ComponentProps<typeof ConversationActions>> = {}) {
    const props: React.ComponentProps<typeof ConversationActions> = {
        conversation: makeSummary({ labels: [] }),
        labels: [LABEL_A, LABEL_B],
        onToggleRead: vi.fn(),
        onToggleArchive: vi.fn(),
        onSetStatus: vi.fn(),
        onAttachLabel: vi.fn(),
        onDetachLabel: vi.fn(),
        onCreateReminder: vi.fn(),
        ...overrides,
    }
    return { props, ...render(<ConversationActions {...props} />) }
}

describe('ConversationActions: single accessible actions', () => {
    afterEach(() => vi.clearAllMocks())

    it('toggles read state using the current unread flag', () => {
        const onToggleRead = vi.fn()
        renderActions({ conversation: makeSummary({ unread: true, labels: [] }), onToggleRead })
        fireEvent.click(screen.getByRole('button', { name: 'Mark read' }))
        expect(onToggleRead).toHaveBeenCalledWith(true)
    })

    it('archives an unarchived conversation', () => {
        const onToggleArchive = vi.fn()
        renderActions({ conversation: makeSummary({ archived: false, labels: [] }), onToggleArchive })
        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        expect(onToggleArchive).toHaveBeenCalledWith(true)
    })

    it('attaches a not-yet-applied label as a named menu checkbox item', async () => {
        const user = userEvent.setup()
        const onAttachLabel = vi.fn()
        renderActions({ conversation: makeSummary({ labels: [] }), onAttachLabel })
        await user.click(screen.getByRole('button', { name: 'Labels' }))
        // A real menu: the checkbox items live under role="menu".
        const menu = await screen.findByRole('menu')
        const control = within(menu).getByRole('menuitemcheckbox', { name: /Priority/ })
        expect(control).toHaveAttribute('aria-checked', 'false')
        await user.click(control)
        expect(onAttachLabel).toHaveBeenCalledWith(LABEL_A)
        // Selecting keeps the menu open so several labels can be toggled in a row.
        expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('detaches an already-applied label', async () => {
        const user = userEvent.setup()
        const onDetachLabel = vi.fn()
        renderActions({ conversation: makeSummary({ labels: [LABEL_A] }), onDetachLabel })
        await user.click(screen.getByRole('button', { name: 'Labels' }))
        const control = await screen.findByRole('menuitemcheckbox', { name: /Priority/ })
        expect(control).toHaveAttribute('aria-checked', 'true')
        await user.click(control)
        expect(onDetachLabel).toHaveBeenCalledWith(LABEL_1)
    })

    it('closes the labels menu on Escape and on outside click (no stuck popovers)', async () => {
        const user = userEvent.setup()
        renderActions({ conversation: makeSummary({ labels: [] }) })
        await user.click(screen.getByRole('button', { name: 'Labels' }))
        await screen.findByRole('menu')
        await user.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
        await user.click(screen.getByRole('button', { name: 'Labels' }))
        await screen.findByRole('menu')
        fireEvent.pointerDown(document.body)
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    })

    it('opens the reminder form in a popover that closes on Escape', async () => {
        const user = userEvent.setup()
        renderActions({ conversation: makeSummary({ labels: [] }) })
        await user.click(screen.getByRole('button', { name: 'Remind me' }))
        expect(await screen.findByLabelText('Remind at')).toBeInTheDocument()
        await user.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByLabelText('Remind at')).not.toBeInTheDocument())
    })
})

function renderBulk(overrides: Partial<React.ComponentProps<typeof BulkActionsBar>> = {}) {
    const props: React.ComponentProps<typeof BulkActionsBar> = {
        selectedCount: 3,
        limit: 100,
        labels: [LABEL_A],
        onBulkReadState: vi.fn(),
        onBulkArchive: vi.fn(),
        onBulkAddLabel: vi.fn(),
        onSelectAllLoaded: vi.fn(),
        onClear: vi.fn(),
        onExit: vi.fn(),
        ...overrides,
    }
    return { props, ...render(<BulkActionsBar {...props} />) }
}

describe('BulkActionsBar: bounded + honest selection', () => {
    afterEach(() => vi.clearAllMocks())

    it('shows the REAL selected count, not a filter-wide claim', () => {
        renderBulk({ selectedCount: 3 })
        expect(screen.getByText('3 selected')).toBeInTheDocument()
        // Never implies unseen filter-wide selection.
        expect(screen.queryByText(/all .* matching/i)).not.toBeInTheDocument()
    })

    it('runs a bulk mark-read over the selected set', () => {
        const onBulkReadState = vi.fn()
        renderBulk({ onBulkReadState })
        fireEvent.click(screen.getByRole('button', { name: 'Mark read' }))
        expect(onBulkReadState).toHaveBeenCalledWith(true)
    })

    it('disables bulk actions when nothing is selected', () => {
        renderBulk({ selectedCount: 0 })
        expect(screen.getByRole('button', { name: 'Mark read' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
    })

    it('refuses to act and warns when the selection exceeds the server bulk ceiling', () => {
        renderBulk({ selectedCount: 101, limit: 100 })
        expect(screen.getByRole('alert')).toHaveTextContent('exceeds the 100-conversation limit')
        expect(screen.getByRole('button', { name: 'Mark read' })).toBeDisabled()
    })

    it('selects only the currently loaded rows', () => {
        const onSelectAllLoaded = vi.fn()
        renderBulk({ onSelectAllLoaded })
        fireEvent.click(screen.getByRole('button', { name: 'Select loaded' }))
        expect(onSelectAllLoaded).toHaveBeenCalledOnce()
    })
})

describe('UnifiedInboxPage: bulk selection is loaded-set bounded', () => {
    useThreadTimerGuard()
    afterEach(() => {
        vi.clearAllMocks()
        hooks.state.org = { id: '' }
        hooks.state.search = ''
        hooks.state.list = hooks.makeListReturn([])
        hooks.state.detail = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() }
    })

    it('enters bulk mode and reports the honest selected count as rows are checked', () => {
        hooks.state.org = { id: ORG_A }
        hooks.state.list = hooks.makeListReturn([makeConversation()])
        render(<UnifiedInboxPage />)

        fireEvent.click(screen.getByRole('button', { name: /Select conversations for bulk actions/ }))
        const checkbox = screen.getByRole('checkbox', { name: /Select conversation with Lead Person/ })
        fireEvent.click(checkbox)
        expect(screen.getByText('1 selected')).toBeInTheDocument()
    })
})

// ============================================================
// Task 3 — destructive suppression: server-authoritative confirmation gating
// ============================================================
// The block flow ALWAYS previews server-side, ALWAYS confirms, needs a SECOND confirm for a
// domain block, and refuses public/free-mail domains per the server response. Cancelling makes
// no apply call; a rejected apply keeps the dialog open with the selection intact.

const SENDER = 'lead@acme.example'

function makeSuppression(overrides: Partial<{
    preview: (email: string, scope: SuppressionScope) => Promise<SuppressionPreview>
    apply: (email: string, scope: SuppressionScope) => Promise<SuppressionResult>
}> = {}) {
    return {
        preview: vi.fn((email: string, scope: SuppressionScope): Promise<SuppressionPreview> =>
            Promise.resolve({ email, domain: email.split('@')[1], scope, isPublicDomain: false, alreadySuppressed: false, warnings: [] })),
        apply: vi.fn((email: string, scope: SuppressionScope): Promise<SuppressionResult> =>
            Promise.resolve({ suppressed: true, scope, email, domain: email.split('@')[1], alreadySuppressed: false })),
        ...overrides,
    }
}

async function openBlockMenu() {
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Block' }))
    return user
}

function renderActionsWithBlock(
    suppression: ReturnType<typeof makeSuppression>,
    counterpartyEmail = SENDER,
) {
    return render(
        <ConversationActions
            conversation={makeSummary({ labels: [] })}
            labels={[LABEL_A]}
            counterpartyEmail={counterpartyEmail}
            suppression={suppression}
            onToggleRead={vi.fn()}
            onToggleArchive={vi.fn()}
            onAttachLabel={vi.fn()}
            onDetachLabel={vi.fn()}
        />,
    )
}

describe('ConversationActions: suppression confirmation gating', () => {
    afterEach(() => vi.clearAllMocks())

    it('cancelling the block makes NO apply call', async () => {
        const suppression = makeSuppression()
        renderActionsWithBlock(suppression)
        await (await openBlockMenu()).click(await screen.findByRole('menuitem', { name: /Block sender \(/ }))
        // Confirm dialog appears only after the server preview resolves.
        await screen.findByRole('button', { name: 'Block sender' })
        expect(suppression.preview).toHaveBeenCalledWith(SENDER, 'sender')
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(suppression.apply).not.toHaveBeenCalled()
    })

    it('blocks a sender on explicit confirm (email scope)', async () => {
        const suppression = makeSuppression()
        renderActionsWithBlock(suppression)
        await (await openBlockMenu()).click(await screen.findByRole('menuitem', { name: /Block sender \(/ }))
        const confirm = await screen.findByRole('button', { name: 'Block sender' })
        fireEvent.click(confirm)
        await waitFor(() => expect(suppression.apply).toHaveBeenCalledWith(SENDER, 'sender'))
    })

    it('requires TWO confirms for a safe domain block', async () => {
        const suppression = makeSuppression()
        renderActionsWithBlock(suppression)
        await (await openBlockMenu()).click(await screen.findByRole('menuitem', { name: /Block domain \(acme.example\)/ }))
        // First confirm.
        const cont = await screen.findByRole('button', { name: 'Continue' })
        expect(suppression.apply).not.toHaveBeenCalled()
        fireEvent.click(cont)
        // Second, final confirm.
        const final = await screen.findByRole('button', { name: 'Block domain' })
        fireEvent.click(final)
        await waitFor(() => expect(suppression.apply).toHaveBeenCalledWith(SENDER, 'domain'))
    })

    it('refuses a domain block on a public/free-mail domain and never calls apply for it', async () => {
        const suppression = makeSuppression({
            preview: vi.fn((email: string, scope: SuppressionScope) =>
                Promise.resolve({ email, domain: 'gmail.com', scope, isPublicDomain: true, alreadySuppressed: false, warnings: [] })),
        })
        renderActionsWithBlock(suppression, 'someone@gmail.com')
        await (await openBlockMenu()).click(await screen.findByRole('menuitem', { name: /Block domain \(gmail.com\)/ }))
        await screen.findByText(/Domain block not allowed/)
        // Domain apply is never offered; only the safe sender scope.
        expect(screen.queryByRole('button', { name: 'Block domain' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Block this sender only' }))
        await waitFor(() => expect(suppression.apply).toHaveBeenCalledWith('someone@gmail.com', 'sender'))
        expect(suppression.apply).not.toHaveBeenCalledWith('someone@gmail.com', 'domain')
    })

    it('keeps the dialog open with the reason when the server denies the block (tenant/denial)', async () => {
        const suppression = makeSuppression({
            apply: vi.fn(() => Promise.reject(new apiClientMocks.ApiClientError('denied', { status: 403, details: { error: 'Write access denied' } }))),
        })
        renderActionsWithBlock(suppression)
        await (await openBlockMenu()).click(await screen.findByRole('menuitem', { name: /Block sender \(/ }))
        fireEvent.click(await screen.findByRole('button', { name: 'Block sender' }))
        await screen.findByText(/Could not block/)
        expect(suppression.apply).toHaveBeenCalledTimes(1)
        // A retry affordance remains; selection is untouched (no success notice).
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })

    it('treats a duplicate block as idempotent success', async () => {
        const suppression = makeSuppression({
            apply: vi.fn((email: string, scope: SuppressionScope) =>
                Promise.resolve({ suppressed: true, scope, email, domain: email.split('@')[1], alreadySuppressed: true })),
        })
        renderActionsWithBlock(suppression)
        await (await openBlockMenu()).click(await screen.findByRole('menuitem', { name: /Block sender \(/ }))
        fireEvent.click(await screen.findByRole('button', { name: 'Block sender' }))
        expect(await screen.findByText(/was already blocked/)).toBeInTheDocument()
    })
})

// ============================================================
// Task 3 — reply composer: durable commands, schedule, snippets, attachments,
// recoverable drafts, and visible command state (locked #5/#6/#7)
// ============================================================

const ACCOUNTS: InboxAccountOption[] = [
    { id: ACCOUNT_1, email: 'rep@skale.club', provider: 'native' },
    { id: '88888888-8888-4888-8888-888888888888', email: 'other@skale.club', provider: 'smtp' },
]
const SNIPPETS: InboxSnippet[] = [
    { id: 's1', name: 'Thanks', body: 'Thanks for the reply!', shortcut: null, createdAt: '', updatedAt: '' },
]

function makeCommand(overrides: Partial<InboxSendCommand> = {}): InboxSendCommand {
    return {
        id: 'cmd-1',
        conversationId: CONV_1,
        status: 'scheduled',
        mode: 'reply',
        scheduledAt: null,
        dueAt: '2026-07-16T12:00:00.000Z',
        attempts: 0,
        lastPolicyCode: null,
        lastError: null,
        idempotencyKey: 'idem',
        createdAt: '',
        updatedAt: '',
        ...overrides,
    }
}

function renderComposer(overrides: Partial<React.ComponentProps<typeof ConversationComposer>> = {}) {
    const props: React.ComponentProps<typeof ConversationComposer> = {
        accounts: ACCOUNTS,
        defaultAccountId: ACCOUNT_1,
        replyToPreview: ['lead@acme.example'],
        replyAllCcPreview: ['colleague@acme.example'],
        subjectPreview: 'Re: Demo request',
        snippets: SNIPPETS,
        onSend: vi.fn(async (_input: CreateSendCommandInput) => makeCommand()),
        onUploadAttachment: vi.fn(async (): Promise<InboxUploadedAttachment> => ({
            id: 'att-1', filename: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 2048, status: 'ready', createdAt: '',
        })),
        onRemoveAttachment: vi.fn(),
        onCancelCommand: vi.fn(),
        polledCommand: null,
        ...overrides,
    }
    return { props, ...render(<ConversationComposer {...props} />) }
}

describe('ConversationComposer: durable reply commands', () => {
    afterEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
    })

    it('is collapsed to a single "Reply…" bar with reply-all and forward, and never sends inline', () => {
        renderComposer()
        expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Reply all' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Forward' })).toBeInTheDocument()
        expect(screen.queryByRole('textbox', { name: 'Reply body' })).not.toBeInTheDocument()
    })

    it('has no From selector and shows the conversation account read-only', () => {
        renderComposer()
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        expect(screen.queryByRole('combobox', { name: 'From account' })).not.toBeInTheDocument()
        expect(screen.getByText(/Sending as/)).toHaveTextContent('Sending as rep@skale.club')
    })

    it('always sends from the conversation account, even when other accounts exist', async () => {
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand())
        renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'hello' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalled())
        expect(onSend.mock.calls[0][0].emailAccountId).toBe(ACCOUNT_1)
    })

    it('creates a durable reply command carrying a stable idempotency key (server resolves recipients)', async () => {
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand())
        renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'Sounds good.' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
        const input = onSend.mock.calls[0][0]
        expect(input.mode).toBe('reply')
        expect(input.bodyText).toBe('Sounds good.')
        expect(input.idempotencyKey).toMatch(/^inbox-ui:/)
        // The composer NEVER supplies recipients/threading for a reply — the server resolves them.
        expect(input).not.toHaveProperty('forwardTo')
        expect(input.scheduledAt).toBeNull()
    })

    it('blocks sending an empty reply body but lets a forward go without a note', async () => {
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand())
        renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled()
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: '   ' } })
        expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled()
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'ok' } })
        expect(screen.getByRole('button', { name: 'Send reply' })).toBeEnabled()
        // Switch to a forward with a valid recipient and an empty note.
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: '' } })
        fireEvent.click(screen.getByRole('button', { name: 'Close composer' }))
        fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Forward recipients' }), { target: { value: 'new@partner.example' } })
        expect(screen.getByRole('button', { name: /Send forward/ })).toBeEnabled()
    })

    it('shows resolved Cc for reply-all and a server-authoritative note', () => {
        renderComposer()
        fireEvent.click(screen.getByRole('button', { name: 'Reply all' }))
        expect(screen.getByText(/colleague@acme.example/)).toBeInTheDocument()
        expect(screen.getByText(/resolved by the server/i)).toBeInTheDocument()
    })

    it('requires valid forward recipients before it can send', async () => {
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand({ mode: 'forward' }))
        renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
        const sendBtn = screen.getByRole('button', { name: /Send forward/ })
        expect(sendBtn).toBeDisabled()
        fireEvent.change(screen.getByRole('textbox', { name: 'Forward recipients' }), { target: { value: 'not-an-email' } })
        expect(sendBtn).toBeDisabled()
        fireEvent.change(screen.getByRole('textbox', { name: 'Forward recipients' }), { target: { value: 'new@partner.example' } })
        expect(sendBtn).toBeEnabled()
        fireEvent.click(sendBtn)
        await waitFor(() => expect(onSend).toHaveBeenCalled())
        expect(onSend.mock.calls[0][0].forwardTo).toEqual([{ address: 'new@partner.example', name: null }])
    })

    it('does not submit twice while a create is in flight', async () => {
        let resolve!: (c: InboxSendCommand) => void
        const onSend = vi.fn(() => new Promise<InboxSendCommand>((r) => { resolve = r }))
        renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'hi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        // While pending, the button is disabled — a second click cannot create a duplicate command.
        const pending = await screen.findByRole('button', { name: /Sending/ })
        expect(pending).toBeDisabled()
        fireEvent.click(pending)
        expect(onSend).toHaveBeenCalledTimes(1)
        resolve(makeCommand())
        await waitFor(() => expect(screen.queryByRole('button', { name: /Sending/ })).not.toBeInTheDocument())
    })

    it('resets the form after a successful send and uses a fresh idempotency key for the next send', async () => {
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand())
        renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'first' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
        // Back to the collapsed bar with the previous command status visible.
        await screen.findByRole('button', { name: 'Reply' })
        expect(screen.queryByRole('textbox', { name: 'Reply body' })).not.toBeInTheDocument()
        expect(screen.getByText('Scheduled')).toBeInTheDocument()
        // Send the SAME text again: it is a new intent, so it must not be deduplicated into the old command.
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('')
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'first' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
        expect(onSend.mock.calls[1][0].idempotencyKey).not.toBe(onSend.mock.calls[0][0].idempotencyKey)
    })

    it('reuses the key for an identical retry but generates a fresh one after the text is edited', async () => {
        const onSend = vi.fn<(input: CreateSendCommandInput) => Promise<InboxSendCommand>>(async () => { throw new Error('network down') })
        renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        const body = screen.getByRole('textbox', { name: 'Reply body' })
        fireEvent.change(body, { target: { value: 'v1' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await screen.findByText('network down')
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
        expect(onSend.mock.calls[1][0].idempotencyKey).toBe(onSend.mock.calls[0][0].idempotencyKey)
        fireEvent.change(body, { target: { value: 'v2 edited' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(3))
        expect(onSend.mock.calls[2][0].idempotencyKey).not.toBe(onSend.mock.calls[1][0].idempotencyKey)
    })

    it('sends with Ctrl+Enter and Cmd+Enter, but not when the body is empty', async () => {
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand())
        renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        const body = screen.getByRole('textbox', { name: 'Reply body' })
        fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
        expect(onSend).not.toHaveBeenCalled()
        fireEvent.change(body, { target: { value: 'via keyboard' } })
        fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'via mac' } })
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'Reply body' }), { key: 'Enter', metaKey: true })
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    })

    it('Escape keeps the discard confirmation instead of dropping typed text', () => {
        renderComposer()
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        const body = screen.getByRole('textbox', { name: 'Reply body' })
        fireEvent.change(body, { target: { value: 'precious words' } })
        fireEvent.keyDown(body, { key: 'Escape' })
        expect(screen.getByRole('alertdialog', { name: 'Discard draft?' })).toBeInTheDocument()
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('precious words')
    })

    it('schedules a reply with an explicit time and shows the timezone', async () => {
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand({ status: 'scheduled' }))
        renderComposer({ onSend, organizationTimezone: 'America/Sao_Paulo' })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'later' } })
        fireEvent.click(screen.getByRole('button', { name: /Schedule for later/ }))
        expect(screen.getByText('America/Sao_Paulo')).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText('Scheduled time'), { target: { value: '2026-07-20T09:30' } })
        fireEvent.click(screen.getByRole('button', { name: 'Schedule reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalled())
        expect(onSend.mock.calls[0][0].scheduledAt).not.toBeNull()
    })

    it('inserts a snippet into the body', () => {
        renderComposer()
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Insert snippet' }), { target: { value: 's1' } })
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('Thanks for the reply!')
    })

    it('shows an upload error and preserves the typed body', async () => {
        const onUploadAttachment = vi.fn(async () => { throw new Error('attachment_too_large') })
        renderComposer({ onUploadAttachment })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'keep me' } })
        const file = new File([new Uint8Array(10)], 'big.pdf', { type: 'application/pdf' })
        fireEvent.change(screen.getByLabelText('Attach file'), { target: { files: [file] } })
        expect(await screen.findByText('attachment_too_large')).toBeInTheDocument()
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('keep me')
    })

    it('preserves the draft and shows the reason when the create fails', async () => {
        const onSend = vi.fn(async () => { throw new Error('Access denied') })
        renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'my draft' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        expect(await screen.findByText('Access denied')).toBeInTheDocument()
        // Draft is intact — nothing is cleared on failure.
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('my draft')
    })

    it('renders a recoverable policy denial from the polled command state', async () => {
        const onSend = vi.fn(async () => makeCommand({ id: 'cmd-9', status: 'scheduled' }))
        const { rerender } = renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'draft body' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalled())
        // The claimer defers the send; the polled command reports the recoverable code.
        rerender(<ConversationComposer
            accounts={ACCOUNTS}
            defaultAccountId={ACCOUNT_1}
            replyToPreview={['lead@acme.example']}
            replyAllCcPreview={[]}
            subjectPreview="Re: Demo request"
            snippets={SNIPPETS}
            onSend={onSend}
            onUploadAttachment={vi.fn()}
            polledCommand={makeCommand({ id: 'cmd-9', status: 'scheduled', lastPolicyCode: 'organization_disabled' })}
        />)
        expect(await screen.findByText(/Outreach is paused/)).toBeInTheDocument()
    })

    it('lets the operator reopen the text and resend when the command fails', async () => {
        const onSend = vi.fn(async () => makeCommand({ id: 'cmd-3', status: 'queued' }))
        const { rerender } = renderComposer({ onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'do not lose me' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalled())
        rerender(<ConversationComposer
            accounts={ACCOUNTS}
            defaultAccountId={ACCOUNT_1}
            replyToPreview={['lead@acme.example']}
            replyAllCcPreview={[]}
            subjectPreview="Re: Demo request"
            snippets={SNIPPETS}
            onSend={onSend}
            onUploadAttachment={vi.fn()}
            polledCommand={makeCommand({ id: 'cmd-3', status: 'failed', lastError: 'smtp rejected' })}
        />)
        expect(await screen.findByText('smtp rejected')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('do not lose me')
    })

    it('offers Cancel for a scheduled command and calls the handler', async () => {
        const onSend = vi.fn(async () => makeCommand({ id: 'cmd-7', status: 'scheduled' }))
        const onCancelCommand = vi.fn()
        renderComposer({ onSend, onCancelCommand, polledCommand: makeCommand({ id: 'cmd-7', status: 'scheduled' }) })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'x' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        const cancel = await screen.findByRole('button', { name: 'Cancel send' })
        fireEvent.click(cancel)
        await waitFor(() => expect(onCancelCommand).toHaveBeenCalledWith('cmd-7'))
    })

    it('asks for confirmation before discarding an unsaved draft', () => {
        renderComposer()
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'unsaved words' } })
        // The footer Cancel with dirty content prompts a discard confirmation, not a silent drop.
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(screen.getByRole('alertdialog', { name: 'Discard draft?' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('unsaved words')
    })
})

describe('ConversationComposer: per-conversation draft persistence', () => {
    beforeEach(() => {
        window.localStorage.clear()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })
    afterEach(() => {
        vi.clearAllTimers()
        vi.useRealTimers()
        vi.clearAllMocks()
        window.localStorage.clear()
    })

    const DRAFT_KEY = `xmail:inbox-draft:v1:${CONV_1}`

    it('saves the typed draft, shows "Draft saved" and restores it when the conversation is reopened', () => {
        const first = renderComposer({ conversationId: CONV_1 })
        fireEvent.click(screen.getByRole('button', { name: 'Reply all' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'half written' } })
        expect(screen.queryByText('Draft saved')).not.toBeInTheDocument()
        act(() => { vi.advanceTimersByTime(600) })
        expect(screen.getByText('Draft saved')).toBeInTheDocument()
        expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string)).toMatchObject({ mode: 'reply_all', body: 'half written' })

        // Switching conversation unmounts the composer; reopening restores mode + text.
        first.unmount()
        renderComposer({ conversationId: CONV_1 })
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('half written')
        expect(screen.getByText('Reply all', { selector: 'p' })).toBeInTheDocument()
    })

    it('flushes the draft on unmount even before the debounce fires', () => {
        const first = renderComposer({ conversationId: CONV_1 })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'fast switch' } })
        first.unmount()
        expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string)).toMatchObject({ body: 'fast switch' })
    })

    it('keeps drafts separate per conversation', () => {
        const first = renderComposer({ conversationId: CONV_1 })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'for one' } })
        first.unmount()
        renderComposer({ conversationId: CAMPAIGN_1 })
        expect(screen.queryByRole('textbox', { name: 'Reply body' })).not.toBeInTheDocument()
    })

    it('clears the stored draft on discard', () => {
        renderComposer({ conversationId: CONV_1 })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'bye' } })
        act(() => { vi.advanceTimersByTime(600) })
        expect(window.localStorage.getItem(DRAFT_KEY)).not.toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
        expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull()
    })

    it('clears the stored draft after a successful send', async () => {
        vi.useRealTimers()
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand())
        renderComposer({ conversationId: CONV_1, onSend })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'sent soon' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalled())
        await screen.findByRole('button', { name: 'Reply' })
        expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull()
    })

    it('survives a blocked localStorage', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
        const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
        renderComposer({ conversationId: CONV_1 })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'still works' } })
        act(() => { vi.advanceTimersByTime(600) })
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('still works')
        expect(screen.queryByText('Draft saved')).not.toBeInTheDocument()
        spy.mockRestore()
        getSpy.mockRestore()
    })
})

describe('ComposerUnavailable', () => {
    it('explains the missing-account case instead of hiding the composer', () => {
        render(<ComposerUnavailable reason="no_accounts" />)
        expect(screen.getByRole('status')).toHaveTextContent(/no sending account is available/i)
    })
})

// ============================================================
// Phase 23 AI-02 — AI draft assistant: request → preview → insert → separate send
// ============================================================
// The assistant renders only when enabled, previews a draft, and on explicit Insert copies the body
// into the composer's normal editable field + records acceptance — it NEVER sends and NEVER exposes
// secrets/hidden prompts. Sending remains the operator's separate Phase 22 action.

function makeAiRun(overrides: Partial<AiRunPublicDto> = {}): AiRunPublicDto {
    return {
        id: 'run-1',
        conversationId: CONV_1,
        campaignId: CAMPAIGN_1,
        triggerMessageId: null,
        runKind: 'draft',
        status: 'awaiting_approval',
        action: 'draft',
        promptVersion: 'inbox-draft@1',
        provider: 'xphere',
        model: 'kimi',
        outputSubject: 'Re: Demo request',
        outputBody: 'Thanks for the reply — here is the pricing.',
        outputOutcome: null,
        policyCode: null,
        errorCode: null,
        contextHash: 'abc123',
        actorUserId: null,
        approvedByUserId: null,
        approvedAt: null,
        sendCommandId: null,
        outreachEmailId: null,
        latencyMs: 120,
        promptTokens: 100,
        completionTokens: 30,
        totalTokens: 130,
        createdAt: '2026-07-16T10:00:00.000Z',
        updatedAt: '2026-07-16T10:00:00.000Z',
        ...overrides,
    }
}

function suggestedResponse(body = 'Thanks for the reply — here is the pricing.'): AiSuggestionResponse {
    const run = makeAiRun({ outputBody: body })
    return { enabled: true, suggestion: { runId: run.id, subject: run.outputSubject, body }, run }
}

function renderAssistant(overrides: Partial<React.ComponentProps<typeof AiDraftAssistant>> = {}) {
    const props: React.ComponentProps<typeof AiDraftAssistant> = {
        enabled: true,
        onRequest: vi.fn(async () => suggestedResponse()),
        onInsert: vi.fn(),
        onAccept: vi.fn(),
        ...overrides,
    }
    return { props, ...render(<AiDraftAssistant {...props} />) }
}

describe('AiDraftAssistant: gated, previewed, inserted — never sent', () => {
    afterEach(() => vi.clearAllMocks())

    it('shows a compact disabled state linking to Settings when draft assistance is disabled', () => {
        renderAssistant({ enabled: false })
        expect(screen.getByText(/AI suggestions off/)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'enable in Settings' })).toHaveAttribute('href', '/outreach/settings')
        expect(screen.queryByRole('button', { name: 'Suggest draft' })).not.toBeInTheDocument()
    })

    it('requests, previews the draft, and inserts + records acceptance on Insert (never sends)', async () => {
        const onRequest = vi.fn(async () => suggestedResponse('Here is the pricing you asked for.'))
        const onInsert = vi.fn()
        const onAccept = vi.fn()
        renderAssistant({ onRequest, onInsert, onAccept })

        fireEvent.click(screen.getByRole('button', { name: 'Suggest draft' }))
        await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))
        expect(await screen.findByLabelText('AI draft preview')).toHaveTextContent('Here is the pricing you asked for.')

        fireEvent.click(screen.getByRole('button', { name: 'Insert into reply' }))
        expect(onInsert).toHaveBeenCalledWith('Here is the pricing you asked for.', 'Re: Demo request')
        expect(onAccept).toHaveBeenCalledWith('run-1')
    })

    it('discards a previewed draft without inserting it', async () => {
        const onInsert = vi.fn()
        renderAssistant({ onInsert })
        fireEvent.click(screen.getByRole('button', { name: 'Suggest draft' }))
        await screen.findByLabelText('AI draft preview')
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
        expect(onInsert).not.toHaveBeenCalled()
        expect(screen.queryByLabelText('AI draft preview')).not.toBeInTheDocument()
        // Back to the request affordance.
        expect(screen.getByRole('button', { name: 'Suggest draft' })).toBeInTheDocument()
    })

    it('surfaces a recoverable failure inline with a retry and inserts nothing', async () => {
        const onInsert = vi.fn()
        const onRequest = vi.fn(async () => ({ enabled: true, suggestion: null, run: makeAiRun({ status: 'failed', action: null, outputBody: null, errorCode: 'decider_timeout' }) }))
        renderAssistant({ onRequest, onInsert })
        fireEvent.click(screen.getByRole('button', { name: 'Suggest draft' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/timed out/i)
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
        expect(onInsert).not.toHaveBeenCalled()
    })

    it('shows a no-reply outcome when the assistant declines to draft', async () => {
        const onRequest = vi.fn(async () => ({ enabled: true, suggestion: null, run: makeAiRun({ status: 'completed', action: 'escalate', outputBody: null, outputOutcome: 'needs_human' }) }))
        renderAssistant({ onRequest })
        fireEvent.click(screen.getByRole('button', { name: 'Suggest draft' }))
        expect(await screen.findByText(/did not suggest a reply/i)).toBeInTheDocument()
    })

    it('never renders secret/prompt/model-parameter fields from a run', () => {
        // A run object only ever carries the redacted DTO fields — assert none of the forbidden ones
        // are present as props and none leak into the rendered assistant.
        const run = makeAiRun()
        renderAssistant()
        expect(run).not.toHaveProperty('modelParameters')
        expect(run).not.toHaveProperty('leaseToken')
        expect(run).not.toHaveProperty('errorDetail')
        expect(run).not.toHaveProperty('idempotencyKey')
        expect(screen.queryByText(/system prompt/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/api[_-]?key/i)).not.toBeInTheDocument()
    })
})

describe('ConversationComposer + AiDraftAssistant: draft flows into the editable field, send stays separate', () => {
    afterEach(() => vi.clearAllMocks())

    function renderComposerWithAssistant(onRequest = vi.fn(async () => suggestedResponse('AI-written reply body'))) {
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand())
        const onInsertSpy = vi.fn()
        render(
            <ConversationComposer
                accounts={ACCOUNTS}
                defaultAccountId={ACCOUNT_1}
                replyToPreview={['lead@acme.example']}
                replyAllCcPreview={[]}
                subjectPreview="Re: Demo request"
                snippets={SNIPPETS}
                onSend={onSend}
                onUploadAttachment={vi.fn()}
                polledCommand={null}
                renderAiAssistant={(insertDraft) => (
                    <AiDraftAssistant
                        enabled
                        onRequest={onRequest}
                        onInsert={(body, subject) => { onInsertSpy(body, subject); insertDraft(body, subject) }}
                        onAccept={vi.fn()}
                    />
                )}
            />,
        )
        return { onSend }
    }

    it('inserts the suggested body into an empty reply field, then sends via the normal path', async () => {
        const { onSend } = renderComposerWithAssistant()
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        // Request + insert the AI draft.
        fireEvent.click(screen.getByRole('button', { name: 'Suggest draft' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Insert into reply' }))
        // The draft lands in the normal editable body — the operator can edit it.
        const bodyField = screen.getByRole('textbox', { name: 'Reply body' }) as HTMLTextAreaElement
        expect(bodyField).toHaveValue('AI-written reply body')
        fireEvent.change(bodyField, { target: { value: 'AI-written reply body, edited by me.' } })
        // Sending is the SEPARATE operator action (the assistant never sent).
        fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
        expect(onSend.mock.calls[0][0].bodyText).toBe('AI-written reply body, edited by me.')
    })

    it('asks before replacing an operator-typed draft, preserving it unless confirmed', async () => {
        renderComposerWithAssistant()
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        // Operator types first.
        const bodyField = screen.getByRole('textbox', { name: 'Reply body' })
        fireEvent.change(bodyField, { target: { value: 'my own words' } })
        // Requesting + inserting a suggestion must NOT silently overwrite it.
        fireEvent.click(screen.getByRole('button', { name: 'Suggest draft' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Insert into reply' }))
        expect(screen.getByRole('alertdialog', { name: 'Replace your draft?' })).toBeInTheDocument()
        // Keep mine → text preserved.
        fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('my own words')
        // Insert again and confirm the replace this time.
        fireEvent.click(screen.getByRole('button', { name: 'Suggest draft' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Insert into reply' }))
        fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('AI-written reply body')
    })
})

// ============================================================
// Phase 23 AI-05/AI-06 — redacted AI automation causal history
// ============================================================
// The history renders ONLY the redacted public DTO: kind/status, prompt version + model label, the
// trigger message REFERENCE + time, the decision, approval actor/time, policy code, and the
// command/send outcome or failure — never a secret, hidden prompt, model parameter, or raw body.

describe('AiAutomationHistory: redacted causal history', () => {
    afterEach(() => vi.clearAllMocks())

    it('renders decision, approval, and a confirmed send outcome in operator language', () => {
        const run = makeAiRun({
            runKind: 'autonomous',
            status: 'completed',
            action: 'draft',
            outputOutcome: 'interested',
            triggerMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            sendCommandId: 'cmd-77',
            outreachEmailId: 'email-77',
            approvedByUserId: 'user-1234',
            approvedAt: '2026-07-16T10:05:00.000Z',
        })
        render(<AiAutomationHistory runs={[run]} />)
        expect(screen.getByText('Automatic')).toBeInTheDocument()
        expect(screen.getByText('Completed')).toBeInTheDocument()
        expect(screen.getByText(/Drafted a reply/)).toBeInTheDocument()
        expect(screen.getByText(/Lead is interested/)).toBeInTheDocument()
        expect(screen.getByText(/Sent through the policy gate/)).toBeInTheDocument()
        expect(screen.getByText(/Approved by a person on/)).toBeInTheDocument()
    })

    it('keeps model, prompt version, trigger id and approver id under collapsed "Technical details"', () => {
        const run = makeAiRun({
            triggerMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            approvedByUserId: 'user-1234',
            approvedAt: '2026-07-16T10:05:00.000Z',
        })
        const { container } = render(<AiAutomationHistory runs={[run]} />)
        const details = container.querySelector('details') as HTMLDetailsElement
        expect(details).not.toBeNull()
        expect(details.open).toBe(false)
        expect(within(details).getByText('Technical details')).toBeInTheDocument()
        expect(within(details).getByText('inbox-draft@1')).toBeInTheDocument()
        expect(within(details).getByText('kimi')).toBeInTheDocument()
        expect(within(details).getByText('#aaaaaaaa')).toBeInTheDocument()
        expect(within(details).getByText('user-123')).toBeInTheDocument()
        // None of that technical detail leaks into the visible summary line.
        expect(screen.queryByText(/trigger #/)).not.toBeInTheDocument()
        expect(screen.queryByText(/Approved by user-/)).not.toBeInTheDocument()
    })

    it('translates a policy code and a failure code into sentences without leaking any secret', () => {
        const run = makeAiRun({
            runKind: 'autonomous',
            status: 'failed',
            action: null,
            outputBody: null,
            errorCode: 'decider_timeout',
            policyCode: 'recipient_suppressed',
        })
        const { container } = render(<AiAutomationHistory runs={[run]} />)
        expect(screen.getByText('Failed')).toBeInTheDocument()
        expect(screen.getByText(/The assistant timed out/)).toBeInTheDocument()
        // The raw code is only offered under technical details.
        const details = container.querySelector('details') as HTMLElement
        expect(within(details).getByText('decider_timeout')).toBeInTheDocument()
        expect(within(details).getByText('recipient_suppressed')).toBeInTheDocument()
        // The DTO carries no secret/hidden-prompt/model-parameter surface to leak.
        expect(run).not.toHaveProperty('modelParameters')
        expect(run).not.toHaveProperty('leaseToken')
        expect(run).not.toHaveProperty('errorDetail')
        expect(run).not.toHaveProperty('idempotencyKey')
        expect(screen.queryByText(/system prompt/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/bearer/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/api[_-]?key/i)).not.toBeInTheDocument()
    })

    it('uses one status vocabulary for every run status', () => {
        const statuses = ['pending', 'running', 'awaiting_approval', 'completed', 'failed', 'deferred', 'cancelled'] as const
        render(<AiAutomationHistory runs={statuses.map((status, i) => makeAiRun({ id: `r${i}`, status, approvedByUserId: null, approvedAt: null }))} />)
        for (const label of ['Queued', 'In progress', 'Draft ready for review', 'Completed', 'Failed', 'On hold', 'Cancelled']) {
            expect(screen.getByText(label)).toBeInTheDocument()
        }
    })

    it('renders an empty state with no runs', () => {
        render(<AiAutomationHistory runs={[]} />)
        expect(screen.getByText('No AI activity on this conversation yet.')).toBeInTheDocument()
    })
})

// ============================================================
// Inbox header chip: org AI automation state with a quick pause
// ============================================================

function makeChipSettings(overrides: Partial<OrgAiAutomationSettings> = {}): OrgAiAutomationSettings {
    return {
        draftAssistanceEnabled: false,
        autonomousEnabled: false,
        autonomyPaused: false,
        autonomyPausedAt: null,
        autonomyPausedReason: null,
        maxAutonomousFollowUps: 2,
        outreachEnabled: true,
        autonomyEffective: false,
        updatedAt: '2026-07-16T09:00:00.000Z',
        ...overrides,
    }
}

describe('AiAutomationChip: org AI automation state', () => {
    afterEach(() => vi.clearAllMocks())

    it('shows AI off by default', () => {
        render(<AiAutomationChip settings={makeChipSettings()} canManage onPause={vi.fn()} onResume={vi.fn()} />)
        expect(screen.getByRole('button', { name: 'AI status: AI off' })).toBeInTheDocument()
    })

    it('shows suggestions on, automation on, paused and blocked states with text, not colour alone', () => {
        const cases: Array<[Partial<OrgAiAutomationSettings>, string]> = [
            [{ draftAssistanceEnabled: true }, 'AI suggestions on'],
            [{ autonomousEnabled: true }, 'Automation on'],
            [{ autonomousEnabled: true, autonomyPaused: true }, 'Automation paused'],
            [{ autonomousEnabled: true, outreachEnabled: false }, 'Automation blocked'],
        ]
        for (const [overrides, label] of cases) {
            const view = render(<AiAutomationChip settings={makeChipSettings(overrides)} canManage onPause={vi.fn()} onResume={vi.fn()} />)
            expect(screen.getByRole('button', { name: `AI status: ${label}` })).toHaveTextContent(label)
            view.unmount()
        }
    })

    it('offers a one-click Pause automation when active (no confirmation) and passes the reason', async () => {
        const user = userEvent.setup()
        const onPause = vi.fn()
        render(<AiAutomationChip settings={makeChipSettings({ autonomousEnabled: true })} canManage onPause={onPause} onResume={vi.fn()} />)
        await user.click(screen.getByRole('button', { name: /AI status/ }))
        await user.type(await screen.findByLabelText('Pause reason (optional)'), 'checking replies')
        await user.click(screen.getByRole('button', { name: 'Pause automation' }))
        expect(onPause).toHaveBeenCalledWith('checking replies')
    })

    it('offers Resume when paused and hides the controls for viewers', async () => {
        const user = userEvent.setup()
        const onResume = vi.fn()
        const view = render(<AiAutomationChip settings={makeChipSettings({ autonomousEnabled: true, autonomyPaused: true })} canManage onPause={vi.fn()} onResume={onResume} />)
        await user.click(screen.getByRole('button', { name: /AI status/ }))
        await user.click(await screen.findByRole('button', { name: 'Resume automation' }))
        expect(onResume).toHaveBeenCalledOnce()
        view.unmount()

        render(<AiAutomationChip settings={makeChipSettings({ autonomousEnabled: true })} canManage={false} onPause={vi.fn()} onResume={vi.fn()} />)
        await user.click(screen.getByRole('button', { name: /AI status/ }))
        await screen.findByText(/read-only access/)
        expect(screen.queryByRole('button', { name: 'Pause automation' })).not.toBeInTheDocument()
    })

    it('links to the Settings page', async () => {
        const user = userEvent.setup()
        render(<AiAutomationChip settings={makeChipSettings()} canManage onPause={vi.fn()} onResume={vi.fn()} />)
        await user.click(screen.getByRole('button', { name: /AI status/ }))
        expect(await screen.findByRole('link', { name: 'Open AI settings' })).toHaveAttribute('href', '/outreach/settings')
    })
})

describe('InboxFilterRail: six quick views with counts', () => {
    afterEach(() => vi.clearAllMocks())

    function renderRail(overrides: Partial<React.ComponentProps<typeof InboxFilterRail>> = {}) {
        const props: React.ComponentProps<typeof InboxFilterRail> = {
            state: DEFAULT_INBOX_STATE,
            onPatch: vi.fn(),
            onClearFilters: vi.fn(),
            labels: [],
            campaigns: [],
            accounts: [],
            syncStatus: [],
            lastUpdatedAt: null,
            counts: { needsReply: 4, awaiting: 7, unread: 3, remindersDue: 2 },
            ...overrides,
        }
        return { props, ...render(<InboxFilterRail {...props} />) }
    }

    it('renders the six views in order with distinct icons', () => {
        renderRail()
        const labels = ['Inbox', 'Needs reply', 'Awaiting reply', 'Unread', 'Reminders', 'Archived']
        const found = labels.map((label) => screen.getByRole('button', { name: new RegExp(`^${label}`) }))
        expect(found).toHaveLength(6)
        const icons = found.map((button) => button.querySelector('svg')?.getAttribute('class') ?? '')
        expect(new Set(icons.map((c) => c.match(/lucide-[a-z-]+/)?.[0])).size).toBe(6)
    })

    it('shows the counts from the contract with accessible names', () => {
        renderRail()
        expect(screen.getByLabelText('4 need a reply')).toBeInTheDocument()
        expect(screen.getByLabelText('7 awaiting reply')).toBeInTheDocument()
        expect(screen.getByLabelText('3 unread')).toBeInTheDocument()
        expect(screen.getByLabelText('2 reminders due')).toBeInTheDocument()
    })

    it('falls back to the standalone unread counter when the counts are not available yet', () => {
        renderRail({ counts: undefined, unreadCount: 5 })
        expect(screen.getByLabelText('5 unread')).toBeInTheDocument()
        expect(screen.queryByLabelText(/need a reply/)).not.toBeInTheDocument()
    })

    it('patches the URL for a view and keeps the collapse toggle working', () => {
        const onPatch = vi.fn()
        const onToggleCollapsed = vi.fn()
        renderRail({ onPatch, onToggleCollapsed })
        fireEvent.click(screen.getByRole('button', { name: /^Archived/ }))
        expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ view: 'archived' }))
        fireEvent.click(screen.getByRole('button', { name: 'Hide filters' }))
        expect(onToggleCollapsed).toHaveBeenCalledOnce()
    })
})

// ============================================================
// Phase 23 AI-03/AI-06 — organization autonomy control (default-off / confirm / immediate pause / effective scope)
// ============================================================

function makeOrgSettings(overrides: Partial<OrgAiAutomationSettings> = {}): OrgAiAutomationSettings {
    return {
        draftAssistanceEnabled: false,
        autonomousEnabled: false,
        autonomyPaused: false,
        autonomyPausedAt: null,
        autonomyPausedReason: null,
        maxAutonomousFollowUps: 2,
        outreachEnabled: true,
        autonomyEffective: false,
        updatedAt: '2026-07-16T09:00:00.000Z',
        ...overrides,
    }
}

function renderOrgControl(overrides: Partial<React.ComponentProps<typeof OrgAiAutomationControl>> = {}) {
    const props: React.ComponentProps<typeof OrgAiAutomationControl> = {
        settings: makeOrgSettings(),
        canManage: true,
        onSetDraftAssistance: vi.fn(),
        onSetAutonomous: vi.fn(),
        onPause: vi.fn(),
        onResume: vi.fn(),
        ...overrides,
    }
    return { props, ...render(<OrgAiAutomationControl {...props} />) }
}

describe('OrgAiAutomationControl: default-off, confirm, immediate pause, effective scope', () => {
    afterEach(() => vi.clearAllMocks())

    it('defaults both controls OFF', () => {
        renderOrgControl()
        expect(screen.getByRole('switch', { name: 'Draft assistance' })).toHaveAttribute('aria-checked', 'false')
        expect(screen.getByRole('switch', { name: 'Autonomous sending' })).toHaveAttribute('aria-checked', 'false')
        expect(screen.getByText(/Autonomous sending is OFF/)).toBeInTheDocument()
    })

    it('enables draft assistance as a direct toggle (no confirmation)', () => {
        const onSetDraftAssistance = vi.fn()
        renderOrgControl({ onSetDraftAssistance })
        fireEvent.click(screen.getByRole('switch', { name: 'Draft assistance' }))
        expect(onSetDraftAssistance).toHaveBeenCalledWith(true)
    })

    it('requires an explicit confirmation to ENABLE autonomous sending', () => {
        const onSetAutonomous = vi.fn()
        renderOrgControl({ onSetAutonomous })
        fireEvent.click(screen.getByRole('switch', { name: 'Autonomous sending' }))
        // Not enabled yet — a confirmation dialog is shown first.
        expect(onSetAutonomous).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog')).toHaveTextContent('Enable autonomous sending?')
        fireEvent.click(screen.getByRole('button', { name: 'Enable autonomous sending' }))
        expect(onSetAutonomous).toHaveBeenCalledWith(true)
    })

    it('disables autonomous sending immediately (no confirmation)', () => {
        const onSetAutonomous = vi.fn()
        renderOrgControl({ settings: makeOrgSettings({ autonomousEnabled: true, autonomyEffective: true }), onSetAutonomous })
        fireEvent.click(screen.getByRole('switch', { name: 'Autonomous sending' }))
        expect(onSetAutonomous).toHaveBeenCalledWith(false)
    })

    it('pauses IMMEDIATELY with a single click (no confirmation)', () => {
        const onPause = vi.fn()
        renderOrgControl({ settings: makeOrgSettings({ autonomousEnabled: true, autonomyEffective: true }), onPause })
        fireEvent.click(screen.getByRole('button', { name: /Pause automation/ }))
        expect(onPause).toHaveBeenCalledTimes(1)
    })

    it('shows Resume when paused and calls onResume', () => {
        const onResume = vi.fn()
        renderOrgControl({ settings: makeOrgSettings({ autonomousEnabled: true, autonomyPaused: true, autonomyPausedAt: '2026-07-16T10:00:00.000Z' }), onResume })
        expect(screen.getByText(/Autonomous sending is PAUSED/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Resume automation/ }))
        expect(onResume).toHaveBeenCalledTimes(1)
    })

    it('displays the ACTIVE effective scope when on, unpaused, and outreach enabled', () => {
        renderOrgControl({ settings: makeOrgSettings({ autonomousEnabled: true, outreachEnabled: true, autonomyEffective: true }) })
        expect(screen.getByText(/Autonomous sending is ACTIVE/)).toBeInTheDocument()
    })

    it('displays a BLOCKED effective scope when outreach sending is disabled', () => {
        renderOrgControl({ settings: makeOrgSettings({ autonomousEnabled: true, outreachEnabled: false, autonomyEffective: false }) })
        expect(screen.getByText(/BLOCKED/)).toBeInTheDocument()
    })

    it('locks the controls for a viewer (canManage false)', () => {
        renderOrgControl({ canManage: false })
        expect(screen.getByRole('switch', { name: 'Autonomous sending' })).toBeDisabled()
        expect(screen.getByText(/read-only access/)).toBeInTheDocument()
    })
})

// ============================================================
// Phase 23 AI-03/AI-06 — campaign autonomy control (opt-in cannot override org; shows effective reason)
// ============================================================

function makeCampaignAutomation(overrides: Partial<CampaignAiAutomation> = {}): CampaignAiAutomation {
    return {
        campaignId: CAMPAIGN_1,
        campaignAiAutonomousEnabled: false,
        campaignStatus: 'active',
        campaignActive: true,
        orgAutonomousEnabled: true,
        orgAutonomyPaused: false,
        outreachEnabled: true,
        effective: { enabled: false, reason: 'campaign_disabled' },
        updatedAt: '2026-07-16T09:00:00.000Z',
        ...overrides,
    }
}

function renderCampaignControl(overrides: Partial<React.ComponentProps<typeof CampaignAiAutomationControl>> = {}) {
    const props: React.ComponentProps<typeof CampaignAiAutomationControl> = {
        automation: makeCampaignAutomation(),
        canManage: true,
        onSetEnabled: vi.fn(),
        ...overrides,
    }
    return { props, ...render(<CampaignAiAutomationControl {...props} />) }
}

describe('CampaignAiAutomationControl: opt-in cannot override org; shows effective reason', () => {
    afterEach(() => vi.clearAllMocks())

    it('defaults the campaign opt-in OFF', () => {
        renderCampaignControl()
        expect(screen.getByRole('switch', { name: /Autonomous AI replies for this campaign/ })).toHaveAttribute('aria-checked', 'false')
    })

    it('requires confirmation to enable the campaign opt-in', () => {
        const onSetEnabled = vi.fn()
        renderCampaignControl({ onSetEnabled })
        fireEvent.click(screen.getByRole('switch', { name: /Autonomous AI replies for this campaign/ }))
        expect(onSetEnabled).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog')).toHaveTextContent('Enable autonomous replies for this campaign?')
        fireEvent.click(screen.getByRole('button', { name: 'Enable for this campaign' }))
        expect(onSetEnabled).toHaveBeenCalledWith(true)
    })

    it('shows ACTIVE effective scope when the intersection is enabled', () => {
        renderCampaignControl({ automation: makeCampaignAutomation({ campaignAiAutonomousEnabled: true, effective: { enabled: true, reason: null } }) })
        expect(screen.getByText(/Autonomous replies are ACTIVE for this campaign/)).toBeInTheDocument()
    })

    it('cannot override org-off: shows the organization reason even when the campaign toggle is on', () => {
        renderCampaignControl({ automation: makeCampaignAutomation({ campaignAiAutonomousEnabled: true, orgAutonomousEnabled: false, effective: { enabled: false, reason: 'org_disabled' } }) })
        // The campaign flag is on, but effective is disabled BECAUSE the org is off.
        expect(screen.getByRole('switch', { name: /Autonomous AI replies for this campaign/ })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByText(/Organization-level autonomous sending is off/)).toBeInTheDocument()
        expect(screen.queryByText(/ACTIVE for this campaign/)).not.toBeInTheDocument()
    })

    it('shows the org-paused reason when the org kill switch is active', () => {
        renderCampaignControl({ automation: makeCampaignAutomation({ campaignAiAutonomousEnabled: true, orgAutonomyPaused: true, effective: { enabled: false, reason: 'org_paused' } }) })
        expect(screen.getByText(/Organization automation is paused/)).toBeInTheDocument()
    })
})

// ============================================================
// Task 2 — near-real-time channel: authenticated SSE + polling fallback (UIX-06, locked #9)
// ============================================================
// The stream is opened with bearer-authenticated `fetch` (never EventSource), carries only
// aggregate signals, converges the badge/list/open-thread via cache invalidation, and — on
// disconnect — falls back to BOUNDED list/unread polling (never per-thread) with a visible
// stale state, tearing everything down with AbortController on org switch / unmount.

const EVENTS_URL_FRAGMENT = '/api/outreach/unified-inbox/events'

/** A controllable SSE Response whose body reader yields the given raw frames, then optionally idles. */
function makeStreamResponse(frames: string[], opts: { keepOpen?: boolean } = {}) {
    const encoder = new TextEncoder()
    let index = 0
    return {
        ok: true,
        status: 200,
        body: {
            getReader() {
                return {
                    read() {
                        if (index < frames.length) {
                            return Promise.resolve({ done: false, value: encoder.encode(frames[index++]) })
                        }
                        // keepOpen models a healthy idle stream (never resolves → no reconnect churn).
                        if (opts.keepOpen) return new Promise<never>(() => {})
                        return Promise.resolve({ done: true, value: undefined })
                    },
                    cancel: () => Promise.resolve(),
                    releaseLock: () => {},
                }
            },
        },
    }
}

function sseFrame(payload: Record<string, unknown>): string {
    return `event: ${payload.kind}\ndata: ${JSON.stringify(payload)}\n\n`
}

function seedAggregateQueries(queryClient: QueryClient, organizationId: string) {
    const unreadKey = inboxKeys.unread(organizationId)
    const listKey = inboxKeys.list(organizationId, listFilterSignature(DEFAULT_INBOX_STATE))
    const detailKey = inboxKeys.detail(organizationId, CONV_1)
    queryClient.setQueryData(unreadKey, 3)
    queryClient.setQueryData(listKey, { pages: [{ conversations: [], nextCursor: null, hasMore: false, count: 0, syncStatus: [] }], pageParams: [null] })
    queryClient.setQueryData(detailKey, makeDetail())
    return { unreadKey, listKey, detailKey }
}
const isInvalidated = (queryClient: QueryClient, key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated === true

describe('useUnifiedInboxEvents: authenticated stream + convergence', () => {
    beforeEach(() => {
        apiMocks.fetchWithAuth.mockReset()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('connects with an authenticated fetch to the org-scoped events endpoint (never EventSource)', async () => {
        // If the hook ever reached for EventSource, constructing it would throw here.
        const evtSpy = vi.fn(() => { throw new Error('EventSource must not be used') })
        vi.stubGlobal('EventSource', evtSpy)
        apiMocks.fetchWithAuth.mockImplementation(() => new Promise(() => {})) // open, idle stream

        const { queryClient, wrapper } = makeWrapper()
        renderHook(() => useUnifiedInboxEvents(ORG_A), { wrapper })
        void queryClient

        await waitFor(() => expect(apiMocks.fetchWithAuth).toHaveBeenCalled())
        const [url, init] = apiMocks.fetchWithAuth.mock.calls[0]
        expect(url).toContain(EVENTS_URL_FRAGMENT)
        expect(url).toContain(`organizationId=${ORG_A}`)
        expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
        expect(evtSpy).not.toHaveBeenCalled()
        vi.unstubAllGlobals()
    })

    it('converges the badge, list, and OPEN thread on a conversation.updated signal', async () => {
        apiMocks.fetchWithAuth.mockResolvedValue(
            makeStreamResponse([sseFrame({ organizationId: ORG_A, kind: 'conversation.updated', conversationId: CONV_1, version: 5, at: '2026-07-16T10:00:00.000Z' })], { keepOpen: true }),
        )
        const { queryClient, wrapper } = makeWrapper()
        const { unreadKey, listKey, detailKey } = seedAggregateQueries(queryClient, ORG_A)

        renderHook(() => useUnifiedInboxEvents(ORG_A), { wrapper })

        await waitFor(() => expect(isInvalidated(queryClient, unreadKey)).toBe(true))
        expect(isInvalidated(queryClient, listKey)).toBe(true)
        // The detail namespace is invalidated so ONLY the open thread (the sole observer) refetches.
        expect(isInvalidated(queryClient, detailKey)).toBe(true)
    })

    it('falls back to BOUNDED unread/list polling with a visible stale state on disconnect', async () => {
        vi.useFakeTimers()
        apiMocks.fetchWithAuth.mockRejectedValue(new Error('network down'))
        const { queryClient, wrapper } = makeWrapper()
        const { unreadKey, listKey, detailKey } = seedAggregateQueries(queryClient, ORG_A)

        const { result } = renderHook(() => useUnifiedInboxEvents(ORG_A), { wrapper })

        // Flush the initial failed connect → the hook enters the reconnecting/stale state.
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        expect(result.current.status).toBe('reconnecting')
        expect(result.current.isStale).toBe(true)

        // Advance one bounded poll interval: unread + list refresh; the thread namespace is untouched.
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
        expect(isInvalidated(queryClient, unreadKey)).toBe(true)
        expect(isInvalidated(queryClient, listKey)).toBe(true)
        // Bounded fallback NEVER polls per-thread — the open thread stays readable, not refetched.
        expect(isInvalidated(queryClient, detailKey)).toBe(false)
    })

    it('aborts the stream and clears timers on unmount (teardown)', async () => {
        let capturedSignal: AbortSignal | undefined
        apiMocks.fetchWithAuth.mockImplementation((_url: string, init: RequestInit) => {
            capturedSignal = init.signal ?? undefined
            return new Promise(() => {}) // open, idle stream
        })
        const { wrapper } = makeWrapper()
        const { unmount } = renderHook(() => useUnifiedInboxEvents(ORG_A), { wrapper })

        await waitFor(() => expect(apiMocks.fetchWithAuth).toHaveBeenCalled())
        expect(capturedSignal?.aborted).toBe(false)
        unmount()
        expect(capturedSignal?.aborted).toBe(true)
    })

    it('is an inert no-op without an organization', () => {
        const { wrapper } = makeWrapper()
        const { result } = renderHook(() => useUnifiedInboxEvents(undefined), { wrapper })
        expect(result.current.status).toBe('idle')
        expect(apiMocks.fetchWithAuth).not.toHaveBeenCalled()
    })
})

describe('near-real-time convergence does not clobber an active composer or steal focus', () => {
    afterEach(() => vi.clearAllMocks())

    // An incoming event invalidates queries, which re-renders the workspace around the composer.
    // The composer holds its OWN local draft/focus, so a surrounding re-render (the observable
    // effect of an event) must never reset the typed reply or move focus away from it.
    function ComposerHarness() {
        const [tick, setTick] = React.useState(0)
        return (
            <div>
                <button onClick={() => setTick((t) => t + 1)}>simulate incoming event</button>
                <span data-testid="event-tick">{tick}</span>
                <ConversationComposer
                    accounts={ACCOUNTS}
                    defaultAccountId={ACCOUNT_1}
                    replyToPreview={['lead@acme.example']}
                    replyAllCcPreview={[]}
                    subjectPreview="Re: Demo request"
                    snippets={SNIPPETS}
                    onSend={vi.fn(async () => makeCommand())}
                    onUploadAttachment={vi.fn()}
                    polledCommand={null}
                />
            </div>
        )
    }

    it('preserves the typed reply body and keeps focus across an event-driven re-render', () => {
        render(<ComposerHarness />)
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        const body = screen.getByRole('textbox', { name: 'Reply body' }) as HTMLTextAreaElement
        fireEvent.change(body, { target: { value: 'half-written reply the operator is typing' } })
        body.focus()
        expect(document.activeElement).toBe(body)

        // Simulate an incoming near-real-time event forcing the surrounding tree to re-render.
        fireEvent.click(screen.getByRole('button', { name: 'simulate incoming event' }))
        expect(screen.getByTestId('event-tick')).toHaveTextContent('1')

        // The composer body and focus are untouched — the reply is not clobbered, focus not stolen.
        const bodyAfter = screen.getByRole('textbox', { name: 'Reply body' }) as HTMLTextAreaElement
        expect(bodyAfter).toHaveValue('half-written reply the operator is typing')
        expect(document.activeElement).toBe(bodyAfter)
    })
})

describe('InboxSyncStatus: visible degraded near-real-time state', () => {
    afterEach(() => vi.clearAllMocks())

    it('shows "Updates delayed" with a readable-conversations reassurance when the stream is lost', () => {
        render(<InboxSyncStatus syncStatus={[]} lastUpdatedAt={null} realtimeStatus="reconnecting" realtimeStale />)
        expect(screen.getByText('Updates delayed')).toBeInTheDocument()
        expect(screen.getByText(/Conversations remain readable/)).toBeInTheDocument()
    })

    it('shows a healthy live marker without hue-only signalling', () => {
        render(<InboxSyncStatus syncStatus={[]} lastUpdatedAt={null} realtimeStatus="live" />)
        expect(screen.getByText('Live')).toBeInTheDocument()
        expect(screen.queryByText('Updates delayed')).not.toBeInTheDocument()
    })
})
