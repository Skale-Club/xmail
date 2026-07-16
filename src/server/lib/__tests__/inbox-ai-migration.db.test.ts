import path from 'node:path'
import postgres from 'postgres'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyHandWrittenMigrations,
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'
import { outreachAiSettings, outreachAiRuns } from '../../../db/schema'

// ------------------------------------------------------------
// Phase 23 (AI-01 / AI-03 / AI-05) foundation migration test.
//
// This ONLY ever touches the Phase 18 protected disposable Postgres URL. It never reads or falls
// back to the application DATABASE_URL — assertSafeTestDatabaseUrl rejects non-loopback hosts,
// databases without a `test` marker, and the configured application URL itself. Migration 043 is
// applied TWICE to prove it is re-runnable (a partially applied production run must be safe to
// repeat). All rows are cleaned up in afterAll so the shared database stays pristine for siblings.
//
// Manual production apply (never Drizzle generate/push):
//   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/043_ai_inbox_automation_audit.sql
// ------------------------------------------------------------

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
const dispatchMigration = path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql')
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')
const operatorMigration = path.join(migrationsDir, '042_unified_inbox_operator_workflows.sql')
const aiMigration = path.join(migrationsDir, '043_ai_inbox_automation_audit.sql')

// Distinct id space so this suite never collides with sibling .db suites on the shared DB.
const U = (n: string) => `23010000-0000-4000-8000-${n.padStart(12, '0')}`
const OWNER_A = U('1')
const OWNER_B = U('2')
const ORG_A = U('10')
const ORG_B = U('11')
const ACCOUNT_A = U('20')
const ACCOUNT_B = U('21')
const CONV_A = U('30')
const CONV_B = U('31')
const MSG_A = U('40')

let sql: ReturnType<typeof postgres>

function connect(max = 2) {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl as string, { max, prepare: false, onnotice: () => {} })
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl as string, runGuard }

    await applyHandWrittenMigrations(target)
    await applyMigrationFile(target, dispatchMigration)
    await applyMigrationFile(target, providerEventsMigration)
    await applyMigrationFile(target, unifiedInboxMigration)
    await applyMigrationFile(target, operatorMigration)

    // Apply the migration under test TWICE — idempotency is a hard requirement.
    await applyMigrationFile(target, aiMigration)
    await applyMigrationFile(target, aiMigration)

    sql = connect()

    await sql`INSERT INTO users (id, email) VALUES
        (${OWNER_A}::uuid, 'ai-mig-owner-a@example.test'),
        (${OWNER_B}::uuid, 'ai-mig-owner-b@example.test')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG_A}::uuid, 'AI Mig A', 'ai-mig-a', ${OWNER_A}::uuid),
        (${ORG_B}::uuid, 'AI Mig B', 'ai-mig-b', ${OWNER_B}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO email_accounts (id, organization_id, email, status) VALUES
        (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'ai-acc-a@example.test', 'verified'),
        (${ACCOUNT_B}::uuid, ${ORG_B}::uuid, 'ai-acc-b@example.test', 'verified')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO outreach_conversations (id, organization_id, email_account_id, thread_key) VALUES
        (${CONV_A}::uuid, ${ORG_A}::uuid, ${ACCOUNT_A}::uuid, ${'rfc:ai-conv-a'}),
        (${CONV_B}::uuid, ${ORG_B}::uuid, ${ACCOUNT_B}::uuid, ${'rfc:ai-conv-b'})
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO outreach_conversation_messages
        (id, organization_id, conversation_id, email_account_id, direction, provider, source_key) VALUES
        (${MSG_A}::uuid, ${ORG_A}::uuid, ${CONV_A}::uuid, ${ACCOUNT_A}::uuid, 'inbound', 'native', 'native:ai-mig-a')
        ON CONFLICT (id) DO NOTHING`
})

afterAll(async () => {
    await sql`DELETE FROM outreach_ai_runs WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_ai_settings WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_conversation_messages WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_conversations WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql?.end({ timeout: 1 })
})

async function tableExists(name: string): Promise<boolean> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${name}`
    return Number(rows[0].n) === 1
}

async function columnExists(table: string, column: string): Promise<boolean> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`
    return Number(rows[0].n) === 1
}

async function indexExists(name: string): Promise<boolean> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ${name}`
    return Number(rows[0].n) === 1
}

async function columnDefault(table: string, column: string): Promise<string | null> {
    const rows = await sql<{ column_default: string | null }[]>`
        SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`
    return rows[0]?.column_default ?? null
}

describe('043 AI foundation migration — tables and default-off controls', () => {
    it('creates the AI settings and AI-run audit tables', async () => {
        expect(await tableExists('outreach_ai_settings')).toBe(true)
        expect(await tableExists('outreach_ai_runs')).toBe(true)
    })

    it('makes BOTH org controls SEPARATE and default OFF', async () => {
        expect(await columnExists('outreach_ai_settings', 'draft_assistance_enabled')).toBe(true)
        expect(await columnExists('outreach_ai_settings', 'autonomous_enabled')).toBe(true)
        expect(await columnDefault('outreach_ai_settings', 'draft_assistance_enabled')).toContain('false')
        expect(await columnDefault('outreach_ai_settings', 'autonomous_enabled')).toContain('false')

        // A settings row created with no explicit flags is fully OFF.
        await sql`INSERT INTO outreach_ai_settings (organization_id) VALUES (${ORG_A}::uuid)
            ON CONFLICT (organization_id) DO NOTHING`
        const rows = await sql<{ draft: boolean; autonomous: boolean; paused: Date | null }[]>`
            SELECT draft_assistance_enabled AS draft, autonomous_enabled AS autonomous, autonomy_paused_at AS paused
            FROM outreach_ai_settings WHERE organization_id = ${ORG_A}::uuid`
        expect(rows[0].draft).toBe(false)
        expect(rows[0].autonomous).toBe(false)
        expect(rows[0].paused).toBeNull()
    })

    it('exposes the immediate org kill switch and vetted-model controls', async () => {
        for (const column of ['autonomy_paused_at', 'autonomy_paused_reason', 'model_profile', 'max_autonomous_follow_ups']) {
            expect(await columnExists('outreach_ai_settings', column), `outreach_ai_settings.${column}`).toBe(true)
        }
    })

    it('adds a per-campaign autonomy opt-in that backfills to OFF and preserves the legacy flag', async () => {
        expect(await columnExists('campaigns', 'ai_autonomous_enabled')).toBe(true)
        expect(await columnDefault('campaigns', 'ai_autonomous_enabled')).toContain('false')
        // Legacy 034 direct-send follow-up flag is untouched (compatible rollout).
        expect(await columnExists('campaigns', 'agentic_followup_enabled')).toBe(true)
    })

    it('enforces exactly one AI settings row per organization', async () => {
        let collided = false
        try {
            await sql`INSERT INTO outreach_ai_settings (organization_id) VALUES (${ORG_A}::uuid)`
        } catch {
            collided = true
        }
        expect(collided).toBe(true)
    })
})

describe('043 AI foundation migration — audit-run references, hash, and lifecycle columns', () => {
    it('stores stable references + context hash + provenance + policy + links, never secrets', async () => {
        for (const column of [
            'organization_id', 'conversation_id', 'campaign_id', 'campaign_lead_id',
            'trigger_message_id', 'input_message_ids', 'context_hash',
            'run_kind', 'status', 'action',
            'prompt_version', 'provider', 'model', 'model_parameters',
            'output_subject', 'output_body', 'output_outcome',
            'policy_code', 'policy_retry_at',
            'actor_user_id', 'approved_by_user_id', 'approved_at',
            'send_command_id', 'outreach_email_id',
            'lease_token', 'lease_expires_at', 'attempts', 'max_attempts', 'idempotency_key',
            'latency_ms', 'prompt_tokens', 'completion_tokens', 'total_tokens',
            'error_code', 'error_detail', 'created_at', 'updated_at',
        ]) {
            expect(await columnExists('outreach_ai_runs', column), `outreach_ai_runs.${column}`).toBe(true)
        }
        // The audit table must never carry credential/secret/prompt columns.
        const forbidden = await sql<{ column_name: string }[]>`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'outreach_ai_runs'
              AND column_name ~* '(api_?key|authorization|secret|token_secret|system_prompt|raw_prompt|hidden|chain_of_thought|credential)'`
        expect(forbidden.map((r) => r.column_name)).toEqual([])
    })
})

describe('043 AI foundation migration — strict statuses/kinds, lease/attempt/idempotency bounds', () => {
    const RUN_A = U('100')

    it('binds a valid audit run and enforces org-scoped idempotency uniqueness', async () => {
        await sql`INSERT INTO outreach_ai_runs
            (id, organization_id, conversation_id, trigger_message_id, run_kind, status, idempotency_key,
             input_message_ids, context_hash)
            VALUES (${RUN_A}::uuid, ${ORG_A}::uuid, ${CONV_A}::uuid, ${MSG_A}::uuid, 'draft', 'pending', 'ai-run-a',
             ${sql.json([MSG_A])}, 'deadbeef')`
        // Same (org, idempotency_key) collides.
        let collided = false
        try {
            await sql`INSERT INTO outreach_ai_runs (organization_id, run_kind, idempotency_key)
                VALUES (${ORG_A}::uuid, 'draft', 'ai-run-a')`
        } catch {
            collided = true
        }
        expect(collided).toBe(true)
        // Another org may reuse the key.
        await sql`INSERT INTO outreach_ai_runs (organization_id, run_kind, idempotency_key)
            VALUES (${ORG_B}::uuid, 'draft', 'ai-run-a')`
    })

    it('rejects unknown run kinds, statuses, and actions', async () => {
        await expect(sql`INSERT INTO outreach_ai_runs (organization_id, run_kind, idempotency_key)
            VALUES (${ORG_A}::uuid, 'telepathy', 'bad-kind')`).rejects.toThrow(/outreach_ai_runs_kind_check/)
        await expect(sql`INSERT INTO outreach_ai_runs (organization_id, run_kind, status, idempotency_key)
            VALUES (${ORG_A}::uuid, 'draft', 'teleporting', 'bad-status')`).rejects.toThrow(/outreach_ai_runs_status_check/)
        await expect(sql`INSERT INTO outreach_ai_runs (organization_id, run_kind, action, idempotency_key)
            VALUES (${ORG_A}::uuid, 'draft', 'nuke', 'bad-action')`).rejects.toThrow(/outreach_ai_runs_action_check/)
    })

    it('enforces lease/attempt/idempotency/approval invariants', async () => {
        // Lease token without expiry.
        await expect(sql`INSERT INTO outreach_ai_runs (organization_id, run_kind, idempotency_key, lease_token)
            VALUES (${ORG_A}::uuid, 'draft', 'bad-lease', gen_random_uuid())`).rejects.toThrow(/outreach_ai_runs_lease_check/)
        // Attempts above max.
        await expect(sql`INSERT INTO outreach_ai_runs (organization_id, run_kind, idempotency_key, attempts, max_attempts)
            VALUES (${ORG_A}::uuid, 'draft', 'bad-attempts', 6, 5)`).rejects.toThrow(/outreach_ai_runs_attempts_check/)
        // Blank idempotency key.
        await expect(sql`INSERT INTO outreach_ai_runs (organization_id, run_kind, idempotency_key)
            VALUES (${ORG_A}::uuid, 'draft', '   ')`).rejects.toThrow(/outreach_ai_runs_idempotency_key_check/)
        // Approval must be an atomic pair (approver without time).
        await expect(sql`INSERT INTO outreach_ai_runs (organization_id, run_kind, idempotency_key, approved_by_user_id)
            VALUES (${ORG_A}::uuid, 'draft', 'bad-approval', ${OWNER_A}::uuid)`).rejects.toThrow(/outreach_ai_runs_approval_check/)
    })

    it('indexes the claim queue, lease recovery, and history/linkage scans', async () => {
        expect(await indexExists('outreach_ai_runs_org_idempotency_unique')).toBe(true)
        expect(await indexExists('idx_outreach_ai_runs_claim')).toBe(true)
        expect(await indexExists('idx_outreach_ai_runs_lease')).toBe(true)
        expect(await indexExists('idx_outreach_ai_runs_org_created')).toBe(true)
        expect(await indexExists('idx_outreach_ai_runs_conversation')).toBe(true)
        expect(await indexExists('idx_outreach_ai_runs_campaign')).toBe(true)
        expect(await indexExists('idx_outreach_ai_runs_send_command')).toBe(true)
    })
})

describe('043 AI foundation migration — database-level tenant isolation', () => {
    it('refuses to bind an audit run to another organization\'s conversation', async () => {
        let rejected = false
        try {
            await sql`INSERT INTO outreach_ai_runs (organization_id, conversation_id, run_kind, idempotency_key)
                VALUES (${ORG_A}::uuid, ${CONV_B}::uuid, 'draft', 'x-cross-conv')`
        } catch {
            rejected = true
        }
        expect(rejected).toBe(true)
    })

    it('refuses to bind an audit run to another organization\'s trigger message', async () => {
        let rejected = false
        try {
            await sql`INSERT INTO outreach_ai_runs (organization_id, trigger_message_id, run_kind, idempotency_key)
                VALUES (${ORG_B}::uuid, ${MSG_A}::uuid, 'draft', 'x-cross-msg')`
        } catch {
            rejected = true
        }
        expect(rejected).toBe(true)
    })
})

describe('043 AI foundation migration — RLS defense-in-depth', () => {
    it('enables row level security with organization-membership select policies', async () => {
        const tables = await sql<{ relname: string; relrowsecurity: boolean }[]>`
            SELECT relname, relrowsecurity FROM pg_class
            WHERE relnamespace = 'public'::regnamespace
              AND relname IN ('outreach_ai_settings', 'outreach_ai_runs')`
        expect(tables).toHaveLength(2)
        for (const table of tables) {
            expect(table.relrowsecurity, table.relname).toBe(true)
        }
        const policies = await sql<{ policyname: string; qual: string | null }[]>`
            SELECT policyname, qual FROM pg_policies
            WHERE schemaname = 'public' AND tablename IN ('outreach_ai_settings', 'outreach_ai_runs')`
        expect(policies.map((r) => r.policyname).sort()).toEqual([
            'outreach_ai_runs_select',
            'outreach_ai_settings_select',
        ])
        for (const policy of policies) {
            expect(policy.qual, policy.policyname).toContain('is_org_member')
        }
    })
})

describe('043 AI foundation migration — schema mirror', () => {
    it('mirrors the SQL table names byte-for-byte in src/db/schema.ts', () => {
        expect(getTableConfig(outreachAiSettings).name).toBe('outreach_ai_settings')
        expect(getTableConfig(outreachAiRuns).name).toBe('outreach_ai_runs')
    })
})
