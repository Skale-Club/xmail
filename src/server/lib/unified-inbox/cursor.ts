// ============================================================
// Unified Inbox — opaque, filter-bound keyset cursor (Phase 21 UIF-04)
// ============================================================
// The conversation list is keyset-paginated over (last_message_at DESC, id DESC).
// Offset pagination is unusable here because conversations reorder as new messages
// arrive, so a cursor carries the exact keyset position instead of a page number.
//
// Two security-relevant properties:
//   1. OPAQUE — the wire form is base64url with no plaintext filter values. Clients
//      cannot read or hand-craft a position; they only echo back what we minted.
//   2. FILTER-BOUND — a cursor embeds a fingerprint (hash) of the filter set it was
//      minted under. Replaying it against a different filter set (including a
//      different organization) is rejected. This prevents a client from carrying a
//      keyset position from one query into another, which could otherwise skip or
//      duplicate rows or probe across a filter boundary.
//
// The cursor is NOT a capability token: tenant authorization is enforced separately
// by the route (requireOutreachRead) and by the org-scoped WHERE clause. The
// fingerprint only guarantees a cursor is used with the query that produced it.

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { OutreachConversationStatus } from '@/db/schema'

/** Current cursor envelope version. Bumped if the payload shape ever changes. */
const CURSOR_VERSION = 1

/** Reused UUID validator (same shape the routes enforce with `z.string().uuid()`). */
const uuidSchema = z.string().uuid()

/**
 * The canonical filter set a conversation list query runs under. Every field that
 * changes which rows (or in which order) the query returns MUST be part of this set
 * so the fingerprint invalidates a mismatched replay.
 */
export interface ConversationCursorFilters {
    organizationId: string
    unread: boolean
    status: OutreachConversationStatus | null
    campaignId: string | null
    emailAccountId: string | null
    search: string | null
}

/**
 * A keyset position: the ordering key of the last row on the previous page. The
 * `lastMessageAt` is the lossless Postgres text rendering (microsecond precision)
 * so the next-page predicate compares at full precision; `id` is the unique
 * tie-breaker that keeps pagination stable across equal timestamps.
 */
export interface ConversationCursorPosition {
    lastMessageAt: string
    id: string
}

/** Thrown when a cursor is malformed, tampered, wrong-versioned, or filter-mismatched. */
export class ConversationCursorError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ConversationCursorError'
    }
}

interface CursorEnvelope {
    /** version */
    v: number
    /** filter fingerprint */
    f: string
    /** lastMessageAt (lossless text) */
    t: string
    /** id */
    i: string
}

/**
 * Deterministic fingerprint of the filter set. Order-independent by construction
 * (explicit key list), null-normalized, and hashed so the cursor never carries raw
 * filter values. A truncated SHA-256 is ample: collisions only weaken the
 * "can't replay across filters" guard, and tenant isolation does not rely on it.
 */
export function fingerprintConversationFilters(filters: ConversationCursorFilters): string {
    const canonical = JSON.stringify([
        filters.organizationId,
        filters.unread ? 1 : 0,
        filters.status ?? null,
        filters.campaignId ?? null,
        filters.emailAccountId ?? null,
        filters.search ?? null,
    ])
    return createHash('sha256').update(canonical).digest('base64url').slice(0, 22)
}

export function encodeConversationCursor(
    position: ConversationCursorPosition,
    filters: ConversationCursorFilters,
): string {
    const envelope: CursorEnvelope = {
        v: CURSOR_VERSION,
        f: fingerprintConversationFilters(filters),
        t: position.lastMessageAt,
        i: position.id,
    }
    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
}

export function decodeConversationCursor(
    cursor: string,
    filters: ConversationCursorFilters,
): ConversationCursorPosition {
    if (typeof cursor !== 'string' || cursor.length === 0) {
        throw new ConversationCursorError('Empty cursor')
    }
    // Reject anything that is not strict URL-safe base64 before decoding — a padded or
    // otherwise malformed token is a client error, not a silent empty page.
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new ConversationCursorError('Malformed cursor')
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    } catch {
        throw new ConversationCursorError('Undecodable cursor')
    }

    if (typeof parsed !== 'object' || parsed === null) {
        throw new ConversationCursorError('Malformed cursor payload')
    }
    const envelope = parsed as Record<string, unknown>
    if (envelope.v !== CURSOR_VERSION) {
        throw new ConversationCursorError('Unsupported cursor version')
    }
    if (typeof envelope.f !== 'string' || typeof envelope.t !== 'string' || typeof envelope.i !== 'string') {
        throw new ConversationCursorError('Invalid cursor fields')
    }
    // The fingerprint is UNKEYED (a client can recompute it for its own filters), so a well-shaped
    // envelope can still carry a `t`/`i` that is a string but not a real timestamp / UUID. Validate
    // the keyset value shape HERE so the query's `${t}::timestamp` / `${i}::uuid` casts can never
    // throw downstream — that would surface a self-inflicted 500 instead of the correct 400 the
    // route already maps ConversationCursorError to. Purely defensive; no cross-tenant impact.
    if (Number.isNaN(Date.parse(envelope.t))) {
        throw new ConversationCursorError('Invalid cursor timestamp')
    }
    if (!uuidSchema.safeParse(envelope.i).success) {
        throw new ConversationCursorError('Invalid cursor id')
    }
    if (envelope.f !== fingerprintConversationFilters(filters)) {
        throw new ConversationCursorError('Cursor does not match the current filter set')
    }
    return { lastMessageAt: envelope.t, id: envelope.i }
}
