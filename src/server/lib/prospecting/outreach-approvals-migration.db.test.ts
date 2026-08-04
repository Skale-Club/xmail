import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

const USER_ID = 'a4700000-0000-4000-8000-000000000001'
const OTHER_USER_ID = 'a4700000-0000-4000-8000-000000000002'
const ORG_ID = 'a4700000-0000-4000-8000-000000000003'
const OTHER_ORG_ID = 'a4700000-0000-4000-8000-000000000004'

let sql: ReturnType<typeof postgres>

beforeAll(async () => {
    const databaseUrl = process.env[TEST_DATABASE_URL_ENV]
    const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
    assertSafeTestDatabaseUrl(databaseUrl, { runGuard })
    const target = { databaseUrl, runGuard }
    const migrations = ['045_outreach_agent_gateway.sql', '046_prospecting_pipeline.sql', '047_outreach_action_approvals.sql']
    for (const migration of migrations) {
        await applyMigrationFile(target, path.join(process.cwd(), 'supabase', 'migrations', migration))
    }
    sql = postgres(databaseUrl, { max: 2, prepare: false })
    await sql`
        INSERT INTO users (id, email) VALUES
            (${USER_ID}::uuid, 'approvals@example.test'),
            (${OTHER_USER_ID}::uuid, 'approvals-other@example.test')
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id) VALUES
            (${ORG_ID}::uuid, 'Approvals', 'approvals-test', ${USER_ID}::uuid),
            (${OTHER_ORG_ID}::uuid, 'Other Approvals', 'approvals-other-test', ${OTHER_USER_ID}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
})

afterAll(async () => {
    await sql?.end({ timeout: 1 })
})

describe('047 durable human action approvals', () => {
    it('binds an approval request to the requester credential tenant and immutable payload', async () => {
        const [credential] = await sql`
            INSERT INTO outreach_agent_credentials (
                organization_id, principal_user_id, created_by_user_id, name, key_prefix, key_hash, scopes
            ) VALUES (
                ${ORG_ID}::uuid, ${USER_ID}::uuid, ${USER_ID}::uuid, 'Approval agent',
                'a470000000000001', repeat('b', 64), '["prospects:enrich","approvals:read"]'::jsonb
            ) RETURNING id
        `
        const [approval] = await sql`
            INSERT INTO outreach_action_approvals (
                organization_id, requester_agent_credential_id, requester_user_id,
                action_kind, resource_type, resource_id, idempotency_key, request_payload, maximum_credit_cost
            ) VALUES (
                ${ORG_ID}::uuid, ${credential.id}::uuid, ${USER_ID}::uuid,
                'prospect_enrichment', 'prospecting_run', gen_random_uuid()::text, 'approval-key-1',
                '{"candidateIds":["a4700000-0000-4000-8000-000000000099"],"provider":"apollo"}'::jsonb, 9
            ) RETURNING id, status, maximum_credit_cost
        `
        expect(approval).toMatchObject({ status: 'requested', maximum_credit_cost: 9 })

        await expect(sql`
            INSERT INTO outreach_action_approvals (
                organization_id, requester_agent_credential_id, requester_user_id,
                action_kind, resource_type, resource_id, idempotency_key
            ) VALUES (
                ${OTHER_ORG_ID}::uuid, ${credential.id}::uuid, ${OTHER_USER_ID}::uuid,
                'prospect_enrichment', 'prospecting_run', gen_random_uuid()::text, 'cross-tenant'
            )
        `).rejects.toThrow()
    })

    it('enforces review pairing, action/status enums and nonnegative cost', async () => {
        await expect(sql`
            INSERT INTO outreach_action_approvals (
                organization_id, requester_user_id, reviewer_user_id,
                action_kind, resource_type, resource_id, idempotency_key, maximum_credit_cost
            ) VALUES (
                ${ORG_ID}::uuid, ${USER_ID}::uuid, ${USER_ID}::uuid,
                'prospect_enrichment', 'prospecting_run', 'run', 'unpaired-review', -1
            )
        `).rejects.toThrow()
        await expect(sql`
            INSERT INTO outreach_action_approvals (
                organization_id, requester_user_id, action_kind, resource_type, resource_id, idempotency_key
            ) VALUES (${ORG_ID}::uuid, ${USER_ID}::uuid, 'direct_send', 'campaign', 'campaign', 'invalid-action')
        `).rejects.toThrow()
    })
})
