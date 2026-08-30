import { sql } from 'drizzle-orm'

/** What a timestamp can look like by the time it reaches this module. See below. */
export type TimestampLike = Date | string | number

/**
 * Serialize a timestamp for postgres-js tagged templates and `unsafe` parameters.
 *
 * Accepts a string or a number as well as a Date, on purpose. The declared type of a
 * value read back from Postgres is not a guarantee: `outreach_provider_cursors
 * .last_received_at` is a real `timestamp` column, typed `Date` all the way through
 * `CursorRow` and `ProviderCursorState`, and production still handed back the string
 * `"2026-08-29 04:16:43"` — which is Postgres's own text rendering, not even ISO.
 * `value.toISOString()` then threw on every native inbound tick, roughly 770 times a
 * day, for every account. TypeScript could not see it because every declaration in
 * that chain said `Date`.
 *
 * So this is total by design: it is the boundary where a timestamp-shaped value
 * becomes a string Postgres will accept, and a boundary that trusts its input is
 * exactly what failed. The same file already carries `toNumber` in
 * outreach-inbound.ts for the identical surprise with integers; timestamps simply
 * had not been given the same treatment.
 *
 * Garbage is rejected loudly rather than written: an unparseable value would
 * otherwise reach the database as `Invalid Date` and corrupt a cursor silently.
 */
export function sqlTimestampValue(value: TimestampLike): string
export function sqlTimestampValue(value: TimestampLike | null | undefined): string | null
export function sqlTimestampValue(value: TimestampLike | null | undefined): string | null {
    if (value === null || value === undefined) return null

    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
        throw new TypeError(
            `sqlTimestampValue received a value that is not a usable timestamp: ${JSON.stringify(value)}`,
        )
    }
    return date.toISOString()
}

/**
 * Bind a timestamp into a raw `sql` template.
 *
 * Drizzle converts Date -> string only for direct column assignments (`set({ ts: date })`)
 * and its own comparison helpers. Inside a raw `sql` fragment the value is handed to
 * postgres-js as an untyped parameter, which serializes it against the OID Postgres infers
 * and throws:
 *
 *     TypeError: The "string" argument must be of type string or an instance of Buffer
 *                or ArrayBuffer. Received an instance of Date
 *
 * That is not a type error TypeScript can see — `sql` accepts anything — so it only ever
 * surfaces against a real database. It shipped once in markAsReplied's agentic-follow-up
 * CASE, where it threw on every matched reply and no test caught it because they all mock
 * db (Phase 19 review, W-2).
 *
 * Use this anywhere a timestamp meets a raw sql template.
 */
export function sqlTimestamp(value: TimestampLike) {
    return sql`${sqlTimestampValue(value)}::timestamp`
}
