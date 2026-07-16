import React from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'

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
    apiRequest: vi.fn(),
    ApiClientError: apiClientMocks.ApiClientError,
}))

// useUnifiedInboxEvents connects with authenticated `fetch` (fetchWithAuth) — NEVER EventSource.
// Mock the auth-fetch module so the near-real-time hook drives a controllable stream/failure.
const apiMocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }))
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
import { ConversationComposer } from '@/components/outreach/inbox/ConversationComposer'
import { AiDraftAssistant } from '@/components/outreach/inbox/AiDraftAssistant'
import { InboxSyncStatus } from '@/components/outreach/inbox/InboxSyncStatus'
import type {
    AiRunPublicDto,
    AiSuggestionResponse,
    CreateSendCommandInput,
    InboxAccountOption,
    InboxLabel,
    InboxSendCommand,
    InboxSnippet,
    InboxUploadedAttachment,
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
            unread: true,
            status: 'open',
            campaign: CAMPAIGN_1,
            account: ACCOUNT_1,
            labels: [LABEL_1, LABEL_2],
            reminder: 'active',
            archived: true,
            cursor: 'opaque-cursor-token',
        }
        const parsed = parseInboxUrl(buildInboxSearch(state))
        expect(parsed).toEqual(state)
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

    it('only treats unread/archived=true as meaningful', () => {
        expect(parseInboxUrl('unread=false').unread).toBeUndefined()
        expect(parseInboxUrl('archived=false').archived).toBeUndefined()
        expect(parseInboxUrl('unread=true').unread).toBe(true)
        expect(parseInboxUrl('archived=true').archived).toBe(true)
    })
})

describe('unified-inbox-url: cursor reset semantics', () => {
    const base: InboxUrlState = { labels: [], cursor: 'page-2', status: 'open' }

    it('drops the cursor when a filter field changes', () => {
        expect(mergeInboxState(base, { status: 'closed' }).cursor).toBeUndefined()
        expect(mergeInboxState(base, { q: 'term' }).cursor).toBeUndefined()
        expect(mergeInboxState(base, { labels: [LABEL_1] }).cursor).toBeUndefined()
        expect(mergeInboxState(base, { unread: true }).cursor).toBeUndefined()
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
        // filters preserved
        expect(cleared.status).toBe('open')
    })
})

describe('unified-inbox-url: quick views + active filter count', () => {
    it('derives the active quick view from orthogonal params', () => {
        expect(activeQuickView(DEFAULT_INBOX_STATE)).toBe('inbox')
        expect(activeQuickView({ labels: [], unread: true })).toBe('unread')
        expect(activeQuickView({ labels: [], reminder: 'active' })).toBe('reminders')
        expect(activeQuickView({ labels: [], archived: true })).toBe('archived')
        expect(activeQuickView({ labels: [], status: 'open' })).toBe('needs_reply')
    })

    it('quickViewPatch clears sibling view params', () => {
        const patched = mergeInboxState({ labels: [], unread: true, cursor: 'c' }, quickViewPatch('archived'))
        expect(patched.archived).toBe(true)
        expect(patched.unread).toBeUndefined()
        expect(patched.cursor).toBeUndefined()
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
            unread: true,
            status: 'open',
            campaign: CAMPAIGN_1,
            account: ACCOUNT_1,
            reminder: 'due',
            archived: true,
            cursor: 'page-2',
        }
        const qs = new URLSearchParams(toListQueryString(ORG_A, state, 25))
        expect(qs.get('organizationId')).toBe(ORG_A)
        expect(qs.get('limit')).toBe('25')
        expect(qs.get('search')).toBe('reply')
        expect(qs.get('unread')).toBe('true')
        expect(qs.get('status')).toBe('open')
        expect(qs.get('campaignId')).toBe(CAMPAIGN_1)
        expect(qs.get('emailAccountId')).toBe(ACCOUNT_1)
        expect(qs.get('reminderState')).toBe('due')
        expect(qs.get('archived')).toBe('true')
        expect(qs.get('cursor')).toBe('page-2')
        // Server currently filters by a single label; the first selected label is sent.
        expect(qs.get('labelId')).toBe(LABEL_1)
    })

    it('hides archived conversations by default and omits inactive filters', () => {
        const qs = new URLSearchParams(toListQueryString(ORG_A, DEFAULT_INBOX_STATE, 25))
        expect(qs.get('organizationId')).toBe(ORG_A)
        expect(qs.get('archived')).toBe('false')
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
        providerByAccount: { [ACCOUNT_1]: 'native' },
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

    it('exposes unread state to assistive tech and campaign/provider badges', () => {
        renderList({
            conversations: [makeConversation({ campaignId: CAMPAIGN_1 })],
        })
        const row = screen.getByRole('button', { name: /Conversation with Lead Person/ })
        expect(within(row).getByText('Unread')).toBeInTheDocument()
        expect(within(row).getByText('Q3 Outbound')).toBeInTheDocument()
        expect(within(row).getByText('native')).toBeInTheDocument()
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
        },
        makeListReturn,
    }
})

vi.mock('wouter', () => ({
    useLocation: () => ['/outreach/unified-inbox', hooks.navigate],
    useSearch: () => hooks.state.search,
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
    useInboxAccountOptions: () => ({ data: [] }),
    useInboxUnreadCount: () => ({ data: 0 }),
    // Operator mutations are stubbed for the page/wiring tests; the REAL implementations are
    // exercised against a fake network in the "operator mutations" describe via importActual.
    useInboxReadState: () => stubMutation(),
    useInboxArchive: () => stubMutation(),
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

    it('attaches a not-yet-applied label as a named checkbox control', () => {
        const onAttachLabel = vi.fn()
        renderActions({ conversation: makeSummary({ labels: [] }), onAttachLabel })
        const control = screen.getByRole('menuitemcheckbox', { name: /Priority/ })
        expect(control).toHaveAttribute('aria-checked', 'false')
        fireEvent.click(control)
        expect(onAttachLabel).toHaveBeenCalledWith(LABEL_A)
    })

    it('detaches an already-applied label', () => {
        const onDetachLabel = vi.fn()
        renderActions({ conversation: makeSummary({ labels: [LABEL_A] }), onDetachLabel })
        const control = screen.getByRole('menuitemcheckbox', { name: /Priority/ })
        expect(control).toHaveAttribute('aria-checked', 'true')
        fireEvent.click(control)
        expect(onDetachLabel).toHaveBeenCalledWith(LABEL_1)
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
        fireEvent.click(screen.getByRole('button', { name: /Block sender \(/ }))
        // Confirm dialog appears only after the server preview resolves.
        await screen.findByRole('button', { name: 'Block sender' })
        expect(suppression.preview).toHaveBeenCalledWith(SENDER, 'sender')
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(suppression.apply).not.toHaveBeenCalled()
    })

    it('blocks a sender on explicit confirm (email scope)', async () => {
        const suppression = makeSuppression()
        renderActionsWithBlock(suppression)
        fireEvent.click(screen.getByRole('button', { name: /Block sender \(/ }))
        const confirm = await screen.findByRole('button', { name: 'Block sender' })
        fireEvent.click(confirm)
        await waitFor(() => expect(suppression.apply).toHaveBeenCalledWith(SENDER, 'sender'))
    })

    it('requires TWO confirms for a safe domain block', async () => {
        const suppression = makeSuppression()
        renderActionsWithBlock(suppression)
        fireEvent.click(screen.getByRole('button', { name: /Block domain \(acme.example\)/ }))
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
        fireEvent.click(screen.getByRole('button', { name: /Block domain \(gmail.com\)/ }))
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
        fireEvent.click(screen.getByRole('button', { name: /Block sender \(/ }))
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
        fireEvent.click(screen.getByRole('button', { name: /Block sender \(/ }))
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
    afterEach(() => vi.clearAllMocks())

    it('is collapsed to mode buttons and never sends inline', () => {
        renderComposer()
        expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Reply all' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Forward' })).toBeInTheDocument()
        expect(screen.queryByRole('textbox', { name: 'Reply body' })).not.toBeInTheDocument()
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

    it('schedules a reply with an explicit time and shows the timezone', async () => {
        const onSend = vi.fn(async (_input: CreateSendCommandInput) => makeCommand({ status: 'scheduled' }))
        renderComposer({ onSend, organizationTimezone: 'America/Sao_Paulo' })
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'later' } })
        fireEvent.click(screen.getByRole('checkbox', { name: /Schedule for later/ }))
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

    it('renders a recoverable policy denial from the polled command state without clearing the draft', async () => {
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
        expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('draft body')
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
        history: [],
        ...overrides,
    }
    return { props, ...render(<AiDraftAssistant {...props} />) }
}

describe('AiDraftAssistant: gated, previewed, inserted — never sent', () => {
    afterEach(() => vi.clearAllMocks())

    it('renders nothing when draft assistance is disabled', () => {
        const { container } = renderAssistant({ enabled: false })
        expect(container).toBeEmptyDOMElement()
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
        // are present as props and none leak into the rendered history.
        const run = makeAiRun()
        renderAssistant({ history: [run] })
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
                        history={[]}
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
