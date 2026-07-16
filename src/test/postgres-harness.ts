import { readFile } from 'node:fs/promises'
import path from 'node:path'
import postgres from 'postgres'

export const TEST_DATABASE_URL_ENV = 'XMAIL_TEST_DATABASE_URL'
export const TEST_DATABASE_GUARD_ENV = 'XMAIL_TEST_RUN_GUARD'
export const TEST_DATABASE_OVERRIDE_ENV = 'XMAIL_TEST_DATABASE_URL_OVERRIDE'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
const OUTREACH_TEST_BASELINE_MIGRATIONS = [
    '011_add_outreach_enabled.sql',
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

async function executeSqlFile(target: MigrationTarget, filePath: string): Promise<void> {
    assertSafeTestDatabaseUrl(target.databaseUrl, target)

    const sql = postgres(target.databaseUrl, { max: 1, prepare: false, onnotice: () => {} })
    try {
        const contents = await readFile(filePath, 'utf8')
        await sql.unsafe(contents)
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

export async function applyHandWrittenMigrations(
    target: MigrationTarget,
    rootDir = process.cwd(),
): Promise<void> {
    assertSafeTestDatabaseUrl(target.databaseUrl, target)
    await applyDrizzleBootstrap(target, rootDir)
    await installSupabaseAuthStubs(target)

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
}

export async function applyMigrationFile(target: MigrationTarget, filePath: string): Promise<void> {
    await executeSqlFile(target, filePath)
}
