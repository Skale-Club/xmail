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
import type {
    InboxConversationDetail,
    InboxConversationListItem,
    InboxMessage,
} from '@/lib/unified-inbox-api'
import { ConversationList, type ConversationListProps } from '@/components/outreach/inbox/ConversationList'
import { ConversationThread } from '@/components/outreach/inbox/ConversationThread'
import { BulkActionsBar, ConversationActions } from '@/components/outreach/inbox/ConversationActions'
import type { InboxLabel } from '@/lib/unified-inbox-api'

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
    useInboxLabelAttach: () => stubMutation(),
    useInboxLabelDetach: () => stubMutation(),
    useCreateInboxLabel: () => stubMutation(),
    useInboxBulkAction: () => stubMutation(),
    useInboxConversationReminders: () => ({ data: [], isLoading: false }),
    useInboxReminderMutations: () => ({ create: stubMutation(), update: stubMutation(), remove: stubMutation() }),
    useInboxSuppression: () => ({ preview: vi.fn(), apply: vi.fn().mockResolvedValue(undefined), isApplying: false }),
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
