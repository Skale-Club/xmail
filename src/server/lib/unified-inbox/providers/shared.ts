/**
 * Small helpers shared by the three provider adapters (Phase 21 UIF-02).
 *
 * Kept deliberately tiny and free of db/imapflow/Graph imports so that native.ts, imap.ts,
 * and outlook.ts can be unit-tested in isolation and stay byte-for-byte consistent in how
 * they bound bodies and headers.
 */

/** Bodies are stored but bounded: a pathological megabyte body is truncated at ingest. */
export const MAX_BODY_LENGTH = 100_000

/** A single header value is capped so a long Received chain cannot bloat the jsonb column. */
export const MAX_HEADER_VALUE_LENGTH = 1_000

/** Truncates a body to MAX_BODY_LENGTH; null passes through as null. */
export function truncate(value: string | null | undefined, max = MAX_BODY_LENGTH): string | null {
    if (!value) return null
    return value.length > max ? value.slice(0, max) : value
}

/** Normalizes a provider address field (array or comma string) into a plain string[]. */
export function addressList(value: unknown): string[] {
    if (!value) return []
    if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean)
    if (typeof value === 'string') {
        return value.split(',').map((entry) => entry.trim()).filter(Boolean)
    }
    return []
}
