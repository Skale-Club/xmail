import { describe, expect, it } from 'vitest'
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

// Fixed, syntactically valid UUIDs for deterministic assertions.
const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const CONV_1 = '33333333-3333-4333-8333-333333333333'
const CAMPAIGN_1 = '44444444-4444-4444-8444-444444444444'
const ACCOUNT_1 = '55555555-5555-4555-8555-555555555555'
const LABEL_1 = '66666666-6666-4666-8666-666666666666'
const LABEL_2 = '77777777-7777-4777-8777-777777777777'

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
