import { sql } from 'drizzle-orm'

/**
 * Bind a Date into a raw `sql` template.
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
 * Use this anywhere a Date meets a raw sql template.
 */
export function sqlTimestamp(value: Date) {
    return sql`${value.toISOString()}::timestamp`
}
