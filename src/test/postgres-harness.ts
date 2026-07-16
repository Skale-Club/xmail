import { readFile } from 'node:fs/promises'
import path from 'node:path'
import postgres from 'postgres'

export const TEST_DATABASE_URL_ENV = 'XMAIL_TEST_DATABASE_URL'
export const TEST_DATABASE_GUARD_ENV = 'XMAIL_TEST_RUN_GUARD'
export const TEST_DATABASE_OVERRIDE_ENV = 'XMAIL_TEST_DATABASE_URL_OVERRIDE'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
const OUTREACH_TEST_BASELINE_MIGRATIONS = [
    '011_add_outreach_enabled.sql',
    // email_accounts.provider + outlook_mailbox_id, and the nullable smtp_* columns that
    // provider='native'/'outlook' rows depend on. The Drizzle snapshot predates all three.
    '012_add_provider_to_email_accounts.sql',
    // mailboxes.is_native — what distinguishes a platform mailbox from a connected one.
    '015_schema_reconciliation.sql',
    // mailboxes.skip_tls_verify (SEC-02). Drizzle selects every mapped column, so a
    // mailbox read fails without it.
    '018_add_mailbox_skip_tls_verify.sql',
    // mail_folders.uid_validity / uid_next — same reason, on the folder read.
    '025_add_folder_uid_tracking.sql',
    // email_accounts.mailbox_provider / provider_ref — same reason, on the account read.
    '033_email_accounts_provider_source.sql',
    '021_email_accounts_last_sent_at.sql',
    '022_outreach_emails_sent_at_status_idx.sql',
    '027_outreach_p0_fixes.sql',
    '034_outreach_agentic_followup.sql',
    '035_outreach_reproducibility_and_reply_index.sql',
    '036_email_accounts_case_insensitive_unique.sql',
] as const

export interface TestDatabaseGuardOptions {
    runGuard: string | undefined
    configuredDatabaseUrl?: string
}

export interface MigrationTarget extends TestDatabaseGuardOptions {
    databaseUrl: string
}

function normalizedDatabaseUrl(value: string): string {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
}

export function redactDatabaseUrl(value: string): string {
    try {
        const url = new URL(value)
        if (url.username) url.username = '[redacted]'
        if (url.password) url.password = '[redacted]'
        return url.toString()
    } catch {
        return '[invalid database URL]'
    }
}

export function assertSafeTestDatabaseUrl(
    candidate: string | undefined,
    options: TestDatabaseGuardOptions,
): asserts candidate is string {
    if (!options.runGuard || !/^xmail-test-[a-z0-9-]+$/i.test(options.runGuard)) {
        throw new Error('Refusing database access without a valid per-run test guard')
    }

    if (!candidate) {
        throw new Error('Refusing database access without an explicit test database URL')
    }

    let url: URL
    try {
        url = new URL(candidate)
    } catch {
        throw new Error('Refusing database access because the test database URL is invalid')
    }

    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
        throw new Error(`Refusing non-PostgreSQL test database URL: ${redactDatabaseUrl(candidate)}`)
    }

    if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
        throw new Error(`Refusing non-loopback test database host: ${url.hostname}`)
    }

    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!databaseName || !databaseName.toLowerCase().includes('test')) {
        throw new Error(`Refusing database without a test marker in its name: ${databaseName || '[missing]'}`)
    }

    if (
        options.configuredDatabaseUrl
        && normalizedDatabaseUrl(candidate) === normalizedDatabaseUrl(options.configuredDatabaseUrl)
    ) {
        throw new Error('Refusing to reuse the configured application DATABASE_URL for tests')
    }
}

/**
 * Serializes concurrent migration applies against the shared disposable database.
 *
 * Our migrations guard with `CREATE ... IF NOT EXISTS` and `DO $$ IF NOT EXISTS ... $$`,
 * which is idempotent when applied one after another — but not when two appliers
 * interleave: both see "not exists", both issue `ADD CONSTRAINT`, and the loser fails with
 * "already exists". Production applies migrations serially by hand, so this is purely an
 * artefact of vitest running .db suites in parallel against one container. An arbitrary
 * fixed key is enough; every applier of every file waits behind the same lock.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 4_019_390_211

async function executeSqlFile(target: MigrationTarget, filePath: string): Promise<void> {
    assertSafeTestDatabaseUrl(target.databaseUrl, target)

    const sql = postgres(target.databaseUrl, { max: 1, prepare: false, onnotice: () => {} })
    try {
        const contents = await readFile(filePath, 'utf8')
        // Session-scoped, so it spans the BEGIN/COMMIT inside the migration body and is
        // dropped when this connection closes even if the apply throws.
        await sql`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`
        try {
            await sql.unsafe(contents)
        } finally {
            await sql`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown SQL error'
        throw new Error(`Migration ${path.basename(filePath)} failed against ${redactDatabaseUrl(target.databaseUrl)}: ${message}`)
    } finally {
        await sql.end({ timeout: 1 })
    }
}

async function applyDrizzleBootstrap(target: MigrationTarget, rootDir: string): Promise<void> {
    assertSafeTestDatabaseUrl(target.databaseUrl, target)

    const bootstrapPath = path.join(rootDir, 'drizzle', '0000_dear_wolverine.sql')
    const contents = await readFile(bootstrapPath, 'utf8')
    const statements = contents
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean)

    const sql = postgres(target.databaseUrl, { max: 1, prepare: false, onnotice: () => {} })
    try {
        for (const statement of statements) {
            await sql.unsafe(statement)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown SQL error'
        throw new Error(`Schema bootstrap failed against ${redactDatabaseUrl(target.databaseUrl)}: ${message}`)
    } finally {
        await sql.end({ timeout: 1 })
    }
}

async function installSupabaseAuthStubs(target: MigrationTarget): Promise<void> {
    assertSafeTestDatabaseUrl(target.databaseUrl, target)

    const sql = postgres(target.databaseUrl, { max: 1, prepare: false, onnotice: () => {} })
    try {
        await sql.unsafe(`
            CREATE SCHEMA IF NOT EXISTS auth;
            CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
            LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
                    CREATE ROLE authenticated NOLOGIN;
                END IF;
            END $$;
        `)
    } finally {
        await sql.end({ timeout: 1 })
    }
}

/**
 * Production defines these membership helpers in 020_consolidate_rls.sql, which the
 * baseline below deliberately does not replay (see the schema-history note in
 * applyHandWrittenMigrations). Migrations that attach defense-in-depth RLS policies
 * reference them by name, so the disposable database needs the signatures to exist.
 *
 * They always return false: the tests assert that policies were ATTACHED, never that
 * they grant access. Tenant isolation is enforced in JS (src/server/lib/access.ts) —
 * the app role bypasses RLS — so a stub that authorized rows would be a lie about
 * where the real boundary lives.
 */
async function installRlsHelperStubs(target: MigrationTarget): Promise<void> {
    assertSafeTestDatabaseUrl(target.databaseUrl, target)

    const sql = postgres(target.databaseUrl, { max: 1, prepare: false, onnotice: () => {} })
    try {
        await sql.unsafe(`
            CREATE OR REPLACE FUNCTION public.is_org_member(target_organization_id uuid)
            RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
            CREATE OR REPLACE FUNCTION public.is_platform_admin()
            RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
        `)
    } finally {
        await sql.end({ timeout: 1 })
    }
}

/**
 * campaigns.ai_autonomous_enabled (migration 043) is a CANONICAL Drizzle-mapped column, so every
 * campaign INSERT/SELECT the app issues references it. The full 043 file cannot be replayed in this
 * baseline (its FKs target the Phase 21/22 tables 041/042 does not seed here, and its RLS references
 * helpers this harness deliberately does not replay), but the column ALTER is self-contained and
 * idempotent — mirroring the per-column baseline migrations above. Suites that exercise the full 043
 * schema still apply it explicitly via applyMigrationFile; this only closes the campaigns-column gap
 * so any campaign-touching suite matches the current schema.
 */
async function installCampaignsAiAutonomousColumn(target: MigrationTarget): Promise<void> {
    assertSafeTestDatabaseUrl(target.databaseUrl, target)
    const sql = postgres(target.databaseUrl, { max: 1, prepare: false, onnotice: () => {} })
    try {
        await sql.unsafe(
            `ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS ai_autonomous_enabled boolean NOT NULL DEFAULT false;`,
        )
    } finally {
        await sql.end({ timeout: 1 })
    }
}

/**
 * outreach_ai_runs (migration 043) is read by the Phase 23 autonomous processor, which the campaign
 * follow-up job (`processFollowUps` → `processDueAutonomousRuns`) queries on every tick. Any campaign-
 * lifecycle suite that drives that job therefore needs the table to EXIST, or its `SELECT` fails with
 * `relation "outreach_ai_runs" does not exist`. The full 043 file cannot be replayed in this generic
 * baseline (its composite FKs target the Phase 21/22 tables 041/042 do not seed here, and its RLS
 * references helpers this harness deliberately stubs), but the column-only CREATE is self-contained
 * and idempotent — mirroring `installCampaignsAiAutonomousColumn` above. The dedicated migration suite
 * (`inbox-ai-migration.db.test.ts`) still applies the FULL 043 explicitly (twice, for idempotency),
 * which adds every constraint / index / RLS policy over this table via its own IF-NOT-EXISTS /
 * DROP-then-ADD guards — so this baseline only closes the "table must exist for a SELECT" gap.
 */
async function installOutreachAiRunsTable(target: MigrationTarget): Promise<void> {
    assertSafeTestDatabaseUrl(target.databaseUrl, target)
    const sql = postgres(target.databaseUrl, { max: 1, prepare: false, onnotice: () => {} })
    try {
        // Column-for-column parity with 043's CREATE TABLE (and the Drizzle schema, which selects every
        // mapped column). No FKs / checks / indexes / RLS — those are owned by the full-043 migration suite.
        await sql.unsafe(`
            CREATE TABLE IF NOT EXISTS public.outreach_ai_runs (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id uuid NOT NULL,
                conversation_id uuid,
                campaign_id uuid,
                campaign_lead_id uuid,
                trigger_message_id uuid,
                input_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
                context_hash text,
                run_kind text NOT NULL,
                status text NOT NULL DEFAULT 'pending',
                action text,
                prompt_version text,
                provider text,
                model text,
                model_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
                output_subject text,
                output_body text,
                output_outcome text,
                policy_code text,
                policy_retry_at timestamp,
                actor_user_id uuid,
                approved_by_user_id uuid,
                approved_at timestamp,
                send_command_id uuid,
                outreach_email_id uuid,
                lease_token uuid,
                lease_expires_at timestamp,
                attempts integer NOT NULL DEFAULT 0,
                max_attempts integer NOT NULL DEFAULT 5,
                idempotency_key text NOT NULL,
                latency_ms integer,
                prompt_tokens integer,
                completion_tokens integer,
                total_tokens integer,
                error_code text,
                error_detail text,
                created_at timestamp DEFAULT now() NOT NULL,
                updated_at timestamp DEFAULT now() NOT NULL
            );
        `)
    } finally {
        await sql.end({ timeout: 1 })
    }
}

export async function applyHandWrittenMigrations(
    target: MigrationTarget,
    rootDir = process.cwd(),
): Promise<void> {
    assertSafeTestDatabaseUrl(target.databaseUrl, target)
    await applyDrizzleBootstrap(target, rootDir)
    await installSupabaseAuthStubs(target)
    await installRlsHelperStubs(target)

    // The repository's old Drizzle snapshot and early SQL history describe
    // mutually exclusive server-vs-organization schemas. Replaying both would
    // fabricate a state production never had. Bootstrap the disposable database
    // with the snapshot, then apply the hand-written migrations required by the
    // current outreach contract. Feature migrations under test are always passed
    // explicitly through applyMigrationFile below.
    const migrationsDir = path.join(rootDir, 'supabase', 'migrations')
    for (const migrationFile of OUTREACH_TEST_BASELINE_MIGRATIONS) {
        await executeSqlFile(target, path.join(migrationsDir, migrationFile))
    }

    // Canonical campaigns column from 043 (see note above) — applied inline because the full file
    // has dependencies the generic baseline does not seed.
    await installCampaignsAiAutonomousColumn(target)
    // outreach_ai_runs table from 043 (columns only) so the follow-up job's autonomous-run SELECT
    // succeeds in every campaign-lifecycle suite. The full-043 migration suite adds constraints/RLS.
    await installOutreachAiRunsTable(target)
}

export async function applyMigrationFile(target: MigrationTarget, filePath: string): Promise<void> {
    await executeSqlFile(target, filePath)
}
