import path from 'node:path'
import type { Request } from 'express'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

const USER_ID = 'a4500000-0000-4000-8000-000000000001'
const ORG_ID = 'a4500000-0000-4000-8000-000000000002'

let sql: ReturnType<typeof postgres>
let closeApplicationDatabase: (() => Promise<void>) | undefined
let agentAuth: typeof import('../agent-auth')

beforeAll(async () => {
    const databaseUrl = process.env[TEST_DATABASE_URL_ENV]
    const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
    assertSafeTestDatabaseUrl(databaseUrl, { runGuard })
    await applyMigrationFile(
        { databaseUrl, runGuard },
        path.join(process.cwd(), 'supabase', 'migrations', '045_outreach_agent_gateway.sql'),
    )
    process.env.DATABASE_URL = databaseUrl
    sql = postgres(databaseUrl, { max: 2, prepare: false })
    agentAuth = await import('../agent-auth')
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection

    await sql`INSERT INTO users (id, email) VALUES (${USER_ID}::uuid, 'agent-gateway@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES (${ORG_ID}::uuid, 'Agent Gateway', 'agent-gateway', ${USER_ID}::uuid) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role) VALUES (${ORG_ID}::uuid, ${USER_ID}::uuid, 'admin') ON CONFLICT DO NOTHING`
})

afterAll(async () => {
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('outreach agent gateway migration and authentication', () => {
    it('authenticates only the stored hash and binds immutable tenant headers', async () => {
        const generated = agentAuth.generateAgentToken()
        const [credential] = await sql`
            INSERT INTO outreach_agent_credentials (
                organization_id, principal_user_id, created_by_user_id, name,
                key_prefix, key_hash, scopes
            ) VALUES (
                ${ORG_ID}::uuid, ${USER_ID}::uuid, ${USER_ID}::uuid, 'Hermes test',
                ${generated.keyPrefix}, ${generated.keyHash}, ${sql.json(['outreach:read', 'events:read'])}
            ) RETURNING id
        `
        const req = {
            headers: {
                'x-agent-key': generated.token,
                'x-agent-principal': 'forged',
                'x-agent-organization-id': 'forged',
            },
        } as unknown as Request
        agentAuth.stripAgentHeaders(req)
        const result = await agentAuth.authenticateOutreachAgent(req)

        expect(result.ok).toBe(true)
        expect(req.headers['x-agent-key']).toBeUndefined()
        expect(req.headers[agentAuth.AGENT_CREDENTIAL_HEADER]).toBe(String(credential.id))
        expect(req.headers[agentAuth.AGENT_ORGANIZATION_HEADER]).toBe(ORG_ID)
        expect(req.headers[agentAuth.AGENT_SCOPES_HEADER]).toBe('outreach:read,events:read')

        await sql`UPDATE outreach_agent_credentials SET revoked_at = NOW() WHERE id = ${credential.id}::uuid`
        const revokedReq = { headers: { 'x-agent-key': generated.token } } as unknown as Request
        const revoked = await agentAuth.authenticateOutreachAgent(revokedReq)
        expect(revoked).toMatchObject({ ok: false, status: 401 })
    })

    it('allocates stable increasing outbox cursors', async () => {
        const rows = await sql`
            INSERT INTO outreach_event_outbox (
                organization_id, deduplication_key, event_type, aggregate_type, aggregate_id, payload,
                xphere_delivery_enabled
            ) VALUES
                (${ORG_ID}::uuid, 'test:one', 'outreach.test.one', 'lead', 'one', '{}'::jsonb, false),
                (${ORG_ID}::uuid, 'test:two', 'outreach.test.two', 'lead', 'two', '{}'::jsonb, false)
            RETURNING sequence_number
        `
        expect(Number(rows[1].sequence_number)).toBeGreaterThan(Number(rows[0].sequence_number))
    })
})
