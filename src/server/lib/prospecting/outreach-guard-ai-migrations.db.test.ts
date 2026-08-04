import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

const USER_ID = 'a4900000-0000-4000-8000-000000000001'
const OTHER_USER_ID = 'a4900000-0000-4000-8000-000000000002'
const ORG_ID = 'a4900000-0000-4000-8000-000000000003'
const OTHER_ORG_ID = 'a4900000-0000-4000-8000-000000000004'

let sql: ReturnType<typeof postgres>

beforeAll(async () => {
    const databaseUrl = process.env[TEST_DATABASE_URL_ENV]
    const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
    assertSafeTestDatabaseUrl(databaseUrl, { runGuard })
    const target = { databaseUrl, runGuard }
    const migrations = [
        '045_outreach_agent_gateway.sql',
        '046_prospecting_pipeline.sql',
        '047_outreach_action_approvals.sql',
        '048_deliverability_guardrails.sql',
        '049_prospect_ai_assessments.sql',
    ]
    for (const migration of migrations) {
        await applyMigrationFile(target, path.join(process.cwd(), 'supabase', 'migrations', migration))
    }
    sql = postgres(databaseUrl, { max: 2, prepare: false })
    await sql`
        INSERT INTO users (id, email) VALUES
            (${USER_ID}::uuid, 'guard-ai@example.test'),
            (${OTHER_USER_ID}::uuid, 'guard-ai-other@example.test')
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id) VALUES
            (${ORG_ID}::uuid, 'Guard AI', 'guard-ai-test', ${USER_ID}::uuid),
            (${OTHER_ORG_ID}::uuid, 'Other Guard AI', 'guard-ai-other-test', ${OTHER_USER_ID}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
})

afterAll(async () => {
    await sql?.end({ timeout: 1 })
})

describe('048 deliverability and 049 AI assessment migrations', () => {
    it('creates conservative deliverability defaults and validates pause reasons', async () => {
        const [settings] = await sql`
            INSERT INTO outreach_settings (organization_id)
            VALUES (${ORG_ID}::uuid)
            RETURNING deliverability_guard_enabled, bounce_rate_limit_percent,
                bounce_rate_min_sample, unsubscribe_rate_limit_percent,
                unsubscribe_rate_min_sample
        `
        expect(settings).toMatchObject({
            deliverability_guard_enabled: true,
            bounce_rate_limit_percent: 5,
            bounce_rate_min_sample: 20,
            unsubscribe_rate_limit_percent: 2,
            unsubscribe_rate_min_sample: 50,
        })

        await expect(sql`
            UPDATE outreach_settings SET bounce_rate_limit_percent = 0
            WHERE organization_id = ${ORG_ID}::uuid
        `).rejects.toThrow()
        await expect(sql`
            INSERT INTO campaigns (organization_id, name, paused_reason)
            VALUES (${ORG_ID}::uuid, 'Invalid pause', 'agent_guess')
        `).rejects.toThrow()
        const [campaign] = await sql`
            INSERT INTO campaigns (organization_id, name, paused_reason, paused_at)
            VALUES (${ORG_ID}::uuid, 'Guarded campaign', 'bounce_rate', NOW())
            RETURNING paused_reason
        `
        expect(campaign.paused_reason).toBe('bounce_rate')
    })

    it('keeps assessment evidence tenant-bound and schema validated', async () => {
        const [credential] = await sql`
            INSERT INTO outreach_agent_credentials (
                organization_id, principal_user_id, created_by_user_id, name,
                key_prefix, key_hash, scopes
            ) VALUES (
                ${ORG_ID}::uuid, ${USER_ID}::uuid, ${USER_ID}::uuid, 'Assessment agent',
                'a490000000000001', repeat('c', 64), '["prospects:assess"]'::jsonb
            ) RETURNING id
        `
        const [run] = await sql`
            INSERT INTO prospecting_runs (
                organization_id, agent_credential_id, actor_user_id, provider,
                idempotency_key, status, search_filters, scoring_criteria
            ) VALUES (
                ${ORG_ID}::uuid, ${credential.id}::uuid, ${USER_ID}::uuid, 'apollo',
                'guard-ai-run', 'discovered', '{}'::jsonb, '{}'::jsonb
            ) RETURNING id
        `
        const [candidate] = await sql`
            INSERT INTO prospect_candidates (
                organization_id, run_id, provider, external_person_id, score, score_tier
            ) VALUES (${ORG_ID}::uuid, ${run.id}::uuid, 'apollo', 'guard-ai-candidate', 85, 'a')
            RETURNING id
        `
        const [assessment] = await sql`
            INSERT INTO prospect_ai_assessments (
                organization_id, candidate_id, agent_credential_id, idempotency_key,
                model_provider, model_name, candidate_input_hash, recommendation,
                confidence, rationale, evidence_fields, risk_flags
            ) VALUES (
                ${ORG_ID}::uuid, ${candidate.id}::uuid, ${credential.id}::uuid, 'assessment-1',
                'hermes', 'test-model', ${'d'.repeat(64)}, 'qualified', 88,
                'Evidence is present and bounded.', '["title","companyDomain"]'::jsonb, '[]'::jsonb
            ) RETURNING recommendation, confidence
        `
        expect(assessment).toMatchObject({ recommendation: 'qualified', confidence: 88 })

        await expect(sql`
            INSERT INTO prospect_ai_assessments (
                organization_id, candidate_id, agent_credential_id, idempotency_key,
                model_provider, model_name, candidate_input_hash, recommendation,
                confidence, rationale
            ) VALUES (
                ${OTHER_ORG_ID}::uuid, ${candidate.id}::uuid, ${credential.id}::uuid, 'cross-tenant',
                'hermes', 'test-model', ${'e'.repeat(64)}, 'review', 50, 'Cross tenant attempt.'
            )
        `).rejects.toThrow()
        await expect(sql`
            INSERT INTO prospect_ai_assessments (
                organization_id, candidate_id, agent_credential_id, idempotency_key,
                model_provider, model_name, candidate_input_hash, recommendation,
                confidence, rationale
            ) VALUES (
                ${ORG_ID}::uuid, ${candidate.id}::uuid, ${credential.id}::uuid, 'invalid-shape',
                'hermes', 'test-model', 'not-a-sha256', 'qualified', 101, ''
            )
        `).rejects.toThrow()
    })
})
