import { sql } from 'drizzle-orm'

/**
 * Bind JSON through a text parameter before PostgreSQL casts it to jsonb.
 *
 * Supavisor can infer a Drizzle JSONB parameter as jsonb before postgres-js sends it.
 * Drizzle has already JSON.stringify'd the value at that point, so the pooler encodes
 * it a second time and PostgreSQL receives a JSON string instead of an object/array.
 * The intermediate text cast keeps the parameter scalar and lets PostgreSQL perform
 * the single, authoritative JSON parse. Values remain parameterized.
 */
export function jsonbParam(value: unknown) {
    return sql`${JSON.stringify(value)}::text::jsonb`
}
