import path from 'node:path'
import postgres from 'postgres'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'
import { materializeUnifiedInbox } from '../materializeUnifiedInbox'
import type { UnifiedInboxSql } from '../../lib/unified-inbox/ingest'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
const dispatchMigration = path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql')
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')

const P = '21021000-0000-4000-8000-0000000000'
const OWNER = `${P}01`
const ORG_A = `${P}02`
const ACCOUNT_A = `${P}11`
const LEAD_A = `${P}21`
const CAMP_A = `${P}31`
const CL_A = `${P}41`
const OE_A = `${P}51`
const OE_A_MESSAGE_ID = 'job-thread-root@mail.test'

function connect(max = 4): postgres.Sql {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl, { max, prepare: false, onnotice: () => {} })
}

function jobDeps(sql: postgres.Sql, extra: Record<string, unknown> = {}) {
    return { sql: sql as unknown as UnifiedInboxSql, ...extra }
}

let seq = 0
async function insertReplyEvent(sql: postgres.Sql, overrides: Record<string, unknown> = {}): Promise<string> {
    seq += 1
    const rows = await sql<{ id: string }[]>`
        INSERT INTO outreach_provider_events (
            organization_id, email_account_id, provider, provider_message_id,
            classification, in_reply_to, from_address, subject, text_body, received_at
        ) VALUES (
            ${ORG_A}::uuid, ${ACCOUNT_A}::uuid, 'native', ${`job-msg-${seq}-${Math.random().toString(16).slice(2)}`},
            'reply', ${`<${OE_A_MESSAGE_ID}>`}, 'alice@lead.test', 'Re: hi', ${`body ${seq}`}, now()
        )
        RETURNING id
    `
    const id = rows[0].id
    if (Object.keys(overrides).length > 0) {
        await sql`
            UPDATE outreach_provider_events
            SET materialization_status = ${(overrides.status as string) ?? 'pending'},
                materialization_attempts = ${(overrides.attempts as number) ?? 0},
                materialization_lease_token = ${(overrides.leaseToken as string) ?? null}::uuid,
                materialization_lease_expires_at = ${(overrides.leaseExpiresAt as string) ?? null}::timestamp
            WHERE id = ${id}::uuid
        `
    }
    return id
}

async function eventState(sql: postgres.Sql, id: string) {
    const rows = await sql<{
        materialization_status: string
        materialization_attempts: number
        materialized_at: Date | null
        conversation_message_id: string | null
        materialization_error: string | null
        processed_at: Date | null
    }[]>`
        SELECT materialization_status, materialization_attempts, materialized_at,
               conversation_message_id, materialization_error, processed_at
        FROM outreach_provider_events WHERE id = ${id}::uuid
    `
    return rows[0]
}

async function countMessages(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM outreach_conversation_messages WHERE organization_id = ${ORG_A}::uuid
    `
    return Number(rows[0].n)
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(target, dispatchMigration)
    await applyMigrationFile(target, providerEventsMigration)
    await applyMigrationFile(target, unifiedInboxMigration)

    const sql = connect()
    try {
        await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'job-owner@example.test') ON CONFLICT (id) DO NOTHING`
        await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES (${ORG_A}::uuid, 'Job Org', 'job-org', ${OWNER}::uuid) ON CONFLICT (id) DO NOTHING`
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
            VALUES (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'job-inbox@example.test', 'localhost', 'j', 'x', 'verified')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`INSERT INTO leads (id, organization_id, email) VALUES (${LEAD_A}::uuid, ${ORG_A}::uuid, 'alice@lead.test') ON CONFLICT (id) DO NOTHING`
        await sql`INSERT INTO campaigns (id, organization_id, name) VALUES (${CAMP_A}::uuid, ${ORG_A}::uuid, 'Job Camp') ON CONFLICT (id) DO NOTHING`
        await sql`INSERT INTO campaign_leads (id, campaign_id, lead_id) VALUES (${CL_A}::uuid, ${CAMP_A}::uuid, ${LEAD_A}::uuid) ON CONFLICT (id) DO NOTHING`
        await sql`
            INSERT INTO outreach_emails (
                id, organization_id, origin, idempotency_key, to_address, subject,
                campaign_id, campaign_lead_id, email_account_id, message_id, status, sent_at
            ) VALUES (
                ${OE_A}::uuid, ${ORG_A}::uuid, 'agentic', 'job-oe', 'alice@lead.test', 'Hi',
                ${CAMP_A}::uuid, ${CL_A}::uuid, ${ACCOUNT_A}::uuid, ${OE_A_MESSAGE_ID}, 'sent', now()
            )
            ON CONFLICT (id) DO NOTHING
        `
    } finally {
        await sql.end({ timeout: 1 })
    }
})

beforeEach(async () => {
    const sql = connect()
    try {
        await sql`DELETE FROM outreach_provider_events WHERE organization_id = ${ORG_A}::uuid`
        await sql`DELETE FROM outreach_conversations WHERE organization_id = ${ORG_A}::uuid`
    } finally {
        await sql.end({ timeout: 1 })
    }
})

describe('materializeUnifiedInbox — bounded leased consumer', () => {
    it('materializes every pending staged event into a durable message', async () => {
        const sql = connect()
        try {
            const ids = [await insertReplyEvent(sql), await insertReplyEvent(sql), await insertReplyEvent(sql)]
            const result = await materializeUnifiedInbox(jobDeps(sql))
            expect(result.materialized).toBe(3)
            expect(result.failed).toBe(0)
            expect(await countMessages(sql)).toBe(3)
            for (const id of ids) {
                const state = await eventState(sql, id)
                expect(state.materialization_status).toBe('materialized')
                expect(state.conversation_message_id).not.toBeNull()
                // The materializer never writes the Phase 19 classification lifecycle.
                expect(state.processed_at).toBeNull()
            }
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('never double-materializes under two concurrent runs', async () => {
        const sql = connect()
        const a = connect()
        const b = connect()
        try {
            for (let i = 0; i < 4; i++) await insertReplyEvent(sql)
            const [ra, rb] = await Promise.all([
                materializeUnifiedInbox(jobDeps(a)),
                materializeUnifiedInbox(jobDeps(b)),
            ])
            expect(ra.materialized + rb.materialized).toBe(4)
            expect(await countMessages(sql)).toBe(4)
        } finally {
            await sql.end({ timeout: 1 })
            await a.end({ timeout: 1 })
            await b.end({ timeout: 1 })
        }
    })

    it('reclaims a stale processing lease and increments attempts', async () => {
        const sql = connect()
        try {
            const id = await insertReplyEvent(sql, {
                status: 'processing',
                attempts: 1,
                leaseToken: '21021000-0000-4000-8000-0000000000ff',
                leaseExpiresAt: '2000-01-01 00:00:00',
            })
            const result = await materializeUnifiedInbox(jobDeps(sql))
            expect(result.materialized).toBe(1)
            const state = await eventState(sql, id)
            expect(state.materialization_status).toBe('materialized')
            expect(state.materialization_attempts).toBe(2)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('does not reclaim a still-valid lease held by another worker', async () => {
        const sql = connect()
        try {
            await insertReplyEvent(sql, {
                status: 'processing',
                attempts: 1,
                leaseToken: '21021000-0000-4000-8000-0000000000fe',
                leaseExpiresAt: '2999-01-01 00:00:00',
            })
            const result = await materializeUnifiedInbox(jobDeps(sql))
            expect(result.claimed).toBe(0)
            expect(await countMessages(sql)).toBe(0)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('moves a poison event to failed after the bounded attempt limit', async () => {
        const sql = connect()
        try {
            const id = await insertReplyEvent(sql)
            const result = await materializeUnifiedInbox(jobDeps(sql, {
                maxAttempts: 3,
                materialize: async () => {
                    throw new Error('permanent parse failure with secret token=abc')
                },
            }))
            expect(result.failed).toBe(1)
            const state = await eventState(sql, id)
            expect(state.materialization_status).toBe('failed')
            expect(state.materialization_attempts).toBe(3)
            expect(state.materialization_error).toBeTruthy()
            // Bodies/tokens are never surfaced verbatim; the sanitized error is bounded.
            expect(state.materialization_error!.length).toBeLessThanOrEqual(1000)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('respects the per-tick claim bound', async () => {
        const sql = connect()
        try {
            for (let i = 0; i < 3; i++) await insertReplyEvent(sql)
            const result = await materializeUnifiedInbox(jobDeps(sql, { limit: 2 }))
            expect(result.claimed).toBe(2)
            expect(await countMessages(sql)).toBe(2)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})
