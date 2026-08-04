import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

const USER_ID = 'a4600000-0000-4000-8000-000000000001'
const OTHER_USER_ID = 'a4600000-0000-4000-8000-000000000002'
const ORG_ID = 'a4600000-0000-4000-8000-000000000003'
const OTHER_ORG_ID = 'a4600000-0000-4000-8000-000000000004'

let sql: ReturnType<typeof postgres>

beforeAll(async () => {
    const databaseUrl = process.env[TEST_DATABASE_URL_ENV]
    const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
    assertSafeTestDatabaseUrl(databaseUrl, { runGuard })
    const target = { databaseUrl, runGuard }
    await applyMigrationFile(target, path.join(process.cwd(), 'supabase', 'migrations', '045_outreach_agent_gateway.sql'))
    await applyMigrationFile(target, path.join(process.cwd(), 'supabase', 'migrations', '046_prospecting_pipeline.sql'))
    sql = postgres(databaseUrl, { max: 2, prepare: false })
    await sql`
        INSERT INTO users (id, email) VALUES
            (${USER_ID}::uuid, 'prospecting@example.test'),
            (${OTHER_USER_ID}::uuid, 'prospecting-other@example.test')
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id) VALUES
            (${ORG_ID}::uuid, 'Prospecting', 'prospecting-test', ${USER_ID}::uuid),
            (${OTHER_ORG_ID}::uuid, 'Other Prospecting', 'prospecting-other-test', ${OTHER_USER_ID}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
})

afterAll(async () => {
    await sql?.end({ timeout: 1 })
})

describe('046 provider-neutral prospecting migration', () => {
    it('creates bounded runs and candidates with tenant-safe composite keys', async () => {
        const [credential] = await sql`
            INSERT INTO outreach_agent_credentials (
                organization_id, principal_user_id, created_by_user_id, name, key_prefix, key_hash, scopes
            ) VALUES (
                ${ORG_ID}::uuid, ${USER_ID}::uuid, ${USER_ID}::uuid, 'Prospecting agent',
                'a460000000000001', repeat('a', 64), '["prospects:search"]'::jsonb
            ) RETURNING id
        `
        const [run] = await sql`
            INSERT INTO prospecting_runs (
                organization_id, agent_credential_id, actor_user_id, provider, idempotency_key,
                status, requested_limit, search_filters, scoring_criteria
            ) VALUES (
                ${ORG_ID}::uuid, ${credential.id}::uuid, ${USER_ID}::uuid, 'apollo', 'search-unique-1',
                'discovered', 25, '{"personTitles":["VP Sales"]}'::jsonb, '{}'::jsonb
            ) RETURNING id
        `
        const [candidate] = await sql`
            INSERT INTO prospect_candidates (
                organization_id, run_id, provider, external_person_id, score, score_tier
            ) VALUES (${ORG_ID}::uuid, ${run.id}::uuid, 'apollo', 'apollo-person-1', 80, 'a')
            RETURNING id
        `
        expect(candidate.id).toBeTruthy()

        await expect(sql`
            INSERT INTO prospect_candidates (
                organization_id, run_id, provider, external_person_id, score, score_tier
            ) VALUES (${OTHER_ORG_ID}::uuid, ${run.id}::uuid, 'apollo', 'cross-tenant', 80, 'a')
        `).rejects.toThrow()
        await expect(sql`
            INSERT INTO prospect_candidates (
                organization_id, run_id, provider, external_person_id, score, score_tier
            ) VALUES (${ORG_ID}::uuid, ${run.id}::uuid, 'apollo', 'bad-score', 101, 'a')
        `).rejects.toThrow()
    })

    it('enforces organization-wide idempotency before a provider can spend credits', async () => {
        const rows = await sql`
            SELECT organization_id, provider, idempotency_key, count(*)::int AS count
            FROM prospecting_runs
            WHERE organization_id = ${ORG_ID}::uuid AND idempotency_key = 'search-unique-1'
            GROUP BY organization_id, provider, idempotency_key
        `
        expect(rows[0]?.count).toBe(1)
        await expect(sql`
            INSERT INTO prospecting_runs (
                organization_id, actor_user_id, provider, idempotency_key, search_filters, scoring_criteria
            ) VALUES (${ORG_ID}::uuid, ${USER_ID}::uuid, 'apollo', 'search-unique-1', '{}'::jsonb, '{}'::jsonb)
        `).rejects.toThrow()
    })
})
