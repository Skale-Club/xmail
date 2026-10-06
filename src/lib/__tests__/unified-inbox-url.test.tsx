import { describe, expect, it, vi } from 'vitest'

// The URL/query builders under test are pure; stub the network + supabase session modules the api
// file imports so it can load without environment variables.
vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(), apiRequest: vi.fn() }))
vi.mock('@/lib/api', () => ({ fetchWithAuth: vi.fn() }))

import {
    DEFAULT_INBOX_STATE,
    INBOX_QUICK_VIEWS,
    activeQuickView,
    buildInboxSearch,
    hasAnyFilter,
    listFilterSignature,
    mergeInboxState,
    parseInboxUrl,
    quickViewPatch,
} from '../unified-inbox-url'
import { toListQueryString } from '../unified-inbox-api'

const ORG = '11111111-1111-4111-8111-111111111111'
const CAMPAIGN = '22222222-2222-4222-8222-222222222222'

describe('unified inbox views', () => {
    it('exposes exactly the six quick views', () => {
        expect([...INBOX_QUICK_VIEWS]).toEqual(['inbox', 'needs_reply', 'awaiting', 'unread', 'reminders', 'archived'])
    })

    it('defaults to the inbox view and omits it from the URL', () => {
        expect(activeQuickView(DEFAULT_INBOX_STATE)).toBe('inbox')
        expect(buildInboxSearch(DEFAULT_INBOX_STATE)).toBe('')
        expect(hasAnyFilter(DEFAULT_INBOX_STATE)).toBe(false)
    })

    it.each(['needs_reply', 'awaiting', 'unread', 'reminders', 'archived'] as const)(
        'round-trips the %s view through the URL',
        (view) => {
            const state = mergeInboxState(DEFAULT_INBOX_STATE, quickViewPatch(view))
            expect(activeQuickView(state)).toBe(view)
            const url = buildInboxSearch(state)
            expect(url).toBe(`view=${view}`)
            expect(activeQuickView(parseInboxUrl(url))).toBe(view)
        },
    )

    it('selecting a view replaces the previous one and resets the cursor', () => {
        const archived = mergeInboxState({ labels: [], cursor: 'abc' }, quickViewPatch('archived'))
        expect(archived.cursor).toBeUndefined()
        const next = mergeInboxState(archived, quickViewPatch('needs_reply'))
        expect(activeQuickView(next)).toBe('needs_reply')
        expect(mergeInboxState(next, quickViewPatch('inbox')).view).toBeUndefined()
    })

    it('keeps refinement filters when the view changes', () => {
        const state = mergeInboxState({ labels: [], q: 'barber', campaign: CAMPAIGN }, quickViewPatch('awaiting'))
        expect(state.q).toBe('barber')
        expect(state.campaign).toBe(CAMPAIGN)
        expect(activeQuickView(state)).toBe('awaiting')
    })

    it('folds legacy composed URL params into the equivalent view', () => {
        expect(activeQuickView(parseInboxUrl('archived=true'))).toBe('archived')
        expect(activeQuickView(parseInboxUrl('reminder=active'))).toBe('reminders')
        expect(activeQuickView(parseInboxUrl('unread=true'))).toBe('unread')
        expect(activeQuickView(parseInboxUrl('status=open'))).toBe('needs_reply')
        // The legacy params never survive; the state is expressed as `view` alone.
        expect(buildInboxSearch(parseInboxUrl('status=open'))).toBe('view=needs_reply')
        // An explicit view wins over legacy params.
        expect(activeQuickView(parseInboxUrl('view=awaiting&archived=true'))).toBe('awaiting')
    })

    it('drops an invalid view instead of forwarding it', () => {
        expect(activeQuickView(parseInboxUrl('view=bogus'))).toBe('inbox')
    })

    it('includes the view in the filter signature', () => {
        expect(listFilterSignature({ labels: [], view: 'unread' })).not.toBe(listFilterSignature({ labels: [] }))
    })
})

describe('toListQueryString', () => {
    it('always sends the view and never composes legacy flags', () => {
        const qs = new URLSearchParams(toListQueryString(ORG, DEFAULT_INBOX_STATE, 25))
        expect(qs.get('view')).toBe('inbox')
        for (const legacy of ['archived', 'unread', 'reminderState']) expect(qs.has(legacy)).toBe(false)
        expect(qs.get('organizationId')).toBe(ORG)
    })

    it('sends the selected view and composes refinement filters on top', () => {
        const state = mergeInboxState({ labels: [], campaign: CAMPAIGN, q: 'chair' }, quickViewPatch('needs_reply'))
        const qs = new URLSearchParams(toListQueryString(ORG, state, 25))
        expect(qs.get('view')).toBe('needs_reply')
        expect(qs.get('campaignId')).toBe(CAMPAIGN)
        expect(qs.get('search')).toBe('chair')
        expect(qs.has('status')).toBe(false)
    })
})
