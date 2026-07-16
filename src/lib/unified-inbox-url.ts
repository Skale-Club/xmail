// ============================================================
// Unified Inbox — validated, shareable URL filter state (Phase 22 UIX-02)
// ============================================================
// The SERVER owns query semantics (locked decision #3). Every filter/search/cursor
// value the operator picks is serialized into the query string and sent verbatim to
// the Phase 21 list API — the client never downloads an organization mailbox and
// filters it in memory. This module is the single, schema-validated boundary that
// turns a raw `?a=b&c=d` string into a bounded `InboxUrlState` and back.
//
// Parsing is defensive: unknown params, invalid enums, non-UUIDs, and out-of-bounds
// search terms are DROPPED (never forwarded to a query that could 400 or poison the
// cursor). Serialization omits defaults and is deterministic so a shared link is stable.
//
// `organizationId` is deliberately NOT part of this state — it is never trusted from
// the URL. It always comes from `useOrganization` and is injected at request time.

import { z } from 'zod'

export interface InboxUrlState {
    /** Selected conversation id (drives the thread pane + mobile stage). Not a filter. */
    conversation?: string
    /** Bounded, trimmed keyword search (1–200 chars). */
    q?: string
    /** Only `true` is meaningful — absent means "any read state". */
    unread?: boolean
    status?: 'open' | 'closed'
    campaign?: string
    account?: string
    /** Repeated `label` params, deduped. Server currently filters by the first. */
    labels: string[]
    reminder?: 'active' | 'due'
    /** Only `true` is meaningful — absent means "hide archived" (the default view). */
    archived?: boolean
    /** Opaque, filter-bound keyset cursor. Reset whenever any filter changes. */
    cursor?: string
}

export const DEFAULT_INBOX_STATE: InboxUrlState = { labels: [] }

export type InboxQuickView = 'inbox' | 'unread' | 'needs_reply' | 'reminders' | 'archived'

// The filter fields that define the server query (everything except `conversation`,
// which is selection, and `cursor`, which is pagination position within a query).
const FILTER_KEYS = ['q', 'unread', 'status', 'campaign', 'account', 'labels', 'reminder', 'archived'] as const

// ------------------------------------------------------------
// Field validators (Zod). Each returns undefined for absent/invalid input.
// ------------------------------------------------------------

const zUuid = z.string().uuid()
const zStatus = z.enum(['open', 'closed'])
const zReminder = z.enum(['active', 'due'])
const zSearch = z.string().trim().min(1).max(200)
const zCursor = z.string().min(1).max(4096)

function pickUuid(value: string | null | undefined): string | undefined {
    const parsed = zUuid.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

// ------------------------------------------------------------
// Normalization — the single source of truth for "what a valid state looks like".
// parse() and mergeInboxState() both funnel through this so an invalid value can
// never survive, regardless of whether it came from the URL or a component patch.
// ------------------------------------------------------------

function normalizeState(raw: Partial<InboxUrlState>): InboxUrlState {
    const search = zSearch.safeParse(raw.q)
    const status = zStatus.safeParse(raw.status)
    const reminder = zReminder.safeParse(raw.reminder)
    const cursor = zCursor.safeParse(raw.cursor)

    const labels: string[] = []
    for (const candidate of raw.labels ?? []) {
        const valid = pickUuid(candidate)
        if (valid && !labels.includes(valid)) labels.push(valid)
    }

    return {
        conversation: pickUuid(raw.conversation),
        q: search.success ? search.data : undefined,
        unread: raw.unread === true ? true : undefined,
        status: status.success ? status.data : undefined,
        campaign: pickUuid(raw.campaign),
        account: pickUuid(raw.account),
        labels,
        reminder: reminder.success ? reminder.data : undefined,
        archived: raw.archived === true ? true : undefined,
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
    if (state.unread) params.set('unread', 'true')
    if (state.status) params.set('status', state.status)
    if (state.campaign) params.set('campaign', state.campaign)
    if (state.account) params.set('account', state.account)
    for (const label of [...state.labels].sort()) params.append('label', label)
    if (state.reminder) params.set('reminder', state.reminder)
    if (state.cursor) params.set('cursor', state.cursor)
    if (state.archived) params.set('archived', 'true')

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
        unread: normalized.unread ?? null,
        status: normalized.status ?? null,
        campaign: normalized.campaign ?? null,
        account: normalized.account ?? null,
        labels: [...normalized.labels].sort(),
        reminder: normalized.reminder ?? null,
        archived: normalized.archived ?? null,
    })
}

/**
 * Merge a patch onto the current state. If the patch changes any FILTER field, the
 * cursor is reset to the first page — a keyset cursor is only valid for the exact
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
    if (state.archived) return 'archived'
    if (state.reminder === 'active') return 'reminders'
    if (state.unread) return 'unread'
    if (state.status === 'open') return 'needs_reply'
    return 'inbox'
}

/** The orthogonal-param patch a rail quick-view applies (clearing sibling views). */
export function quickViewPatch(view: InboxQuickView): Partial<InboxUrlState> {
    const clear: Partial<InboxUrlState> = {
        unread: undefined,
        status: undefined,
        reminder: undefined,
        archived: undefined,
    }
    switch (view) {
        case 'unread':
            return { ...clear, unread: true }
        case 'needs_reply':
            return { ...clear, status: 'open' }
        case 'reminders':
            return { ...clear, reminder: 'active' }
        case 'archived':
            return { ...clear, archived: true }
        case 'inbox':
        default:
            return clear
    }
}

/** Count of active refinement filters (search/campaign/account/labels) — NOT views. */
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
    })
}
