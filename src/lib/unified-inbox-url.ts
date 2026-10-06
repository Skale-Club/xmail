// ============================================================
// Unified Inbox â€” validated, shareable URL filter state (Phase 22 UIX-02)
// ============================================================
// The SERVER owns query semantics (locked decision #3). Every filter/search/cursor
// value the operator picks is serialized into the query string and sent verbatim to
// the Phase 21 list API â€” the client never downloads an organization mailbox and
// filters it in memory. This module is the single, schema-validated boundary that
// turns a raw `?a=b&c=d` string into a bounded `InboxUrlState` and back.
//
// Parsing is defensive: unknown params, invalid enums, non-UUIDs, and out-of-bounds
// search terms are DROPPED (never forwarded to a query that could 400 or poison the
// cursor). Serialization omits defaults and is deterministic so a shared link is stable.
//
// `organizationId` is deliberately NOT part of this state â€” it is never trusted from
// the URL. It always comes from `useOrganization` and is injected at request time.

import { z } from 'zod'

export interface InboxUrlState {
    /** Selected conversation id (drives the thread pane + mobile stage). Not a filter. */
    conversation?: string
    /** Bounded, trimmed keyword search (1â€“200 chars). */
    q?: string
    /**
     * The active quick view. Absent means the default `inbox`. The SERVER owns what each view
     * means (queue semantics live in unified-inbox/queries.ts), so this is the only thing the
     * client sends for read/archive/reminder/reply state.
     */
    view?: InboxQuickView
    /** @deprecated Legacy URL param; folded into `view` on parse. Always undefined after normalization. */
    unread?: boolean
    /** Explicit open/closed filter. Composes with any view; quick views no longer set it. */
    status?: 'open' | 'closed'
    campaign?: string
    account?: string
    /** Repeated `label` params, deduped. Server currently filters by the first. */
    labels: string[]
    /** @deprecated Legacy URL param; folded into `view` on parse. Always undefined after normalization. */
    reminder?: 'active' | 'due'
    /** @deprecated Legacy URL param; folded into `view` on parse. Always undefined after normalization. */
    archived?: boolean
    /** Opaque, filter-bound keyset cursor. Reset whenever any filter changes. */
    cursor?: string
}

export const DEFAULT_INBOX_STATE: InboxUrlState = { labels: [] }

export type InboxQuickView = 'inbox' | 'needs_reply' | 'awaiting' | 'unread' | 'reminders' | 'archived'

export const INBOX_QUICK_VIEWS: readonly InboxQuickView[] = [
    'inbox',
    'needs_reply',
    'awaiting',
    'unread',
    'reminders',
    'archived',
]

// The filter fields that define the server query (everything except `conversation`,
// which is selection, and `cursor`, which is pagination position within a query).
// `view` is tracked separately (see hasAnyFilter): the default `inbox` is not a filter.
const FILTER_KEYS = ['q', 'status', 'campaign', 'account', 'labels'] as const

// ------------------------------------------------------------
// Field validators (Zod). Each returns undefined for absent/invalid input.
// ------------------------------------------------------------

const zUuid = z.string().uuid()
const zStatus = z.enum(['open', 'closed'])
const zReminder = z.enum(['active', 'due'])
const zView = z.enum(['inbox', 'needs_reply', 'awaiting', 'unread', 'reminders', 'archived'])
const zSearch = z.string().trim().min(1).max(200)
const zCursor = z.string().min(1).max(4096)

function pickUuid(value: string | null | undefined): string | undefined {
    const parsed = zUuid.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

// ------------------------------------------------------------
// Normalization â€” the single source of truth for "what a valid state looks like".
// parse() and mergeInboxState() both funnel through this so an invalid value can
// never survive, regardless of whether it came from the URL or a component patch.
// ------------------------------------------------------------

function normalizeState(raw: Partial<InboxUrlState>): InboxUrlState {
    const search = zSearch.safeParse(raw.q)
    const parsedStatus = zStatus.safeParse(raw.status)
    const reminder = zReminder.safeParse(raw.reminder)
    const cursor = zCursor.safeParse(raw.cursor)

    // Backward compatibility: links minted before views existed carry the composed legacy params
    // (`archived=true`, `reminder=active`, `unread=true`, `status=open` meant "needs reply").
    // They are folded into `view` so an old shared link still lands on the equivalent queue. An
    // explicit `view` always wins. The legacy params never survive normalization.
    const explicitView = zView.safeParse(raw.view)
    let view: InboxQuickView | undefined
    let status = parsedStatus.success ? parsedStatus.data : undefined
    if (explicitView.success) {
        view = explicitView.data
    } else if (raw.archived === true) {
        view = 'archived'
    } else if (reminder.success) {
        view = 'reminders'
    } else if (raw.unread === true) {
        view = 'unread'
    } else if (status === 'open') {
        view = 'needs_reply'
        status = undefined
    }
    // `inbox` is the default: never carried in state, so the URL and the filter signature stay minimal.
    if (view === 'inbox') view = undefined

    const labels: string[] = []
    for (const candidate of raw.labels ?? []) {
        const valid = pickUuid(candidate)
        if (valid && !labels.includes(valid)) labels.push(valid)
    }

    return {
        conversation: pickUuid(raw.conversation),
        q: search.success ? search.data : undefined,
        view,
        unread: undefined,
        status,
        campaign: pickUuid(raw.campaign),
        account: pickUuid(raw.account),
        labels,
        reminder: undefined,
        archived: undefined,
        cursor: cursor.success ? cursor.data : undefined,
    }
}

// ------------------------------------------------------------
// Parse
// ------------------------------------------------------------

/** Parse a raw query string (with or without a leading `?`) into a bounded state. */
export function parseInboxUrl(search: string): InboxUrlState {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    return normalizeState({
        conversation: params.get('conversation') ?? undefined,
        q: params.get('q') ?? undefined,
        view: (params.get('view') ?? undefined) as InboxUrlState['view'],
        unread: params.get('unread') === 'true' ? true : undefined,
        status: (params.get('status') ?? undefined) as InboxUrlState['status'],
        campaign: params.get('campaign') ?? undefined,
        account: params.get('account') ?? undefined,
        labels: params.getAll('label'),
        reminder: (params.get('reminder') ?? undefined) as InboxUrlState['reminder'],
        archived: params.get('archived') === 'true' ? true : undefined,
        cursor: params.get('cursor') ?? undefined,
    })
}

// ------------------------------------------------------------
// Serialize (deterministic, defaults omitted)
// ------------------------------------------------------------

/** Serialize a state to a query string (no leading `?`). Deterministic + minimal. */
export function buildInboxSearch(input: InboxUrlState): string {
    const state = normalizeState(input)
    const params = new URLSearchParams()

    if (state.conversation) params.set('conversation', state.conversation)
    if (state.q) params.set('q', state.q)
    if (state.view) params.set('view', state.view)
    if (state.status) params.set('status', state.status)
    if (state.campaign) params.set('campaign', state.campaign)
    if (state.account) params.set('account', state.account)
    for (const label of [...state.labels].sort()) params.append('label', label)
    if (state.cursor) params.set('cursor', state.cursor)

    return params.toString()
}

// ------------------------------------------------------------
// Merge (with cursor reset on filter change)
// ------------------------------------------------------------

/** Stable signature of the FILTER fields only (excludes conversation + cursor). */
export function listFilterSignature(state: InboxUrlState): string {
    const normalized = normalizeState(state)
    return JSON.stringify({
        q: normalized.q ?? null,
        view: normalized.view ?? 'inbox',
        status: normalized.status ?? null,
        campaign: normalized.campaign ?? null,
        account: normalized.account ?? null,
        labels: [...normalized.labels].sort(),
    })
}

/**
 * Merge a patch onto the current state. If the patch changes any FILTER field, the
 * cursor is reset to the first page â€” a keyset cursor is only valid for the exact
 * filter set it was minted under, so carrying it across a filter change would 400.
 * An explicit `cursor` in the patch (load-more) is always honored.
 */
export function mergeInboxState(current: InboxUrlState, patch: Partial<InboxUrlState>): InboxUrlState {
    const merged = normalizeState({ ...current, ...patch })
    const cursorExplicit = Object.prototype.hasOwnProperty.call(patch, 'cursor')
    if (!cursorExplicit && listFilterSignature(merged) !== listFilterSignature(current)) {
        merged.cursor = undefined
    }
    return merged
}

// ------------------------------------------------------------
// Quick views + active-filter count (for the filter rail)
// ------------------------------------------------------------

/** Which rail quick-view the current state represents (for active highlighting). */
export function activeQuickView(state: InboxUrlState): InboxQuickView {
    // normalizeState folds legacy params into `view`, so this also resolves old shared links.
    return normalizeState(state).view ?? 'inbox'
}

/**
 * The patch a rail quick-view applies. Selecting a view replaces the previous one; refinement
 * filters (search/campaign/account/labels) are left alone. The legacy composed params are cleared
 * explicitly so a stale one in the current state can never fight the new view.
 */
export function quickViewPatch(view: InboxQuickView): Partial<InboxUrlState> {
    return {
        view: view === 'inbox' ? undefined : view,
        unread: undefined,
        reminder: undefined,
        archived: undefined,
    }
}

/** Count of active refinement filters (search/campaign/account/labels) â€” NOT views. */
export function activeFilterCount(state: InboxUrlState): number {
    const normalized = normalizeState(state)
    let count = 0
    if (normalized.q) count += 1
    if (normalized.campaign) count += 1
    if (normalized.account) count += 1
    count += normalized.labels.length
    return count
}

/** Whether any of the tracked filter fields is active (used for empty-state copy). */
export function hasAnyFilter(state: InboxUrlState): boolean {
    const normalized = normalizeState(state)
    return FILTER_KEYS.some((key) => {
        const value = normalized[key]
        return Array.isArray(value) ? value.length > 0 : value != null
    }) || normalized.view != null
}
