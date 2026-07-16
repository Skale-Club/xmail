import { randomUUID } from 'node:crypto'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import {
    applyHandWrittenMigrations,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_OVERRIDE_ENV,
    TEST_DATABASE_URL_ENV,
} from './postgres-harness'

export default async function setup(): Promise<() => Promise<void>> {
    const configuredDatabaseUrl = process.env.DATABASE_URL
    const previousTestUrl = process.env[TEST_DATABASE_URL_ENV]
    const previousGuard = process.env[TEST_DATABASE_GUARD_ENV]
    const runId = `xmail-test-${randomUUID().replace(/-/g, '')}`
    const databaseName = `xmail_test_${runId.slice(-12)}`
    let container: StartedPostgreSqlContainer | undefined

    let databaseUrl = process.env[TEST_DATABASE_OVERRIDE_ENV]
    if (!databaseUrl) {
        container = await new PostgreSqlContainer('postgres:16-alpine')
            .withDatabase(databaseName)
            .withUsername('xmail_test_runner')
            .withPassword(randomUUID())
            // Every .db suite opens its own short-lived postgres.js pools in
            // beforeAll/beforeEach/observer connections against this one shared database.
            // The 22+ suites churn through backends faster than a 1s .end() reaps them, so
            // the alpine default of max_connections=100 is exhausted under the full postgres
            // project and a later suite's beforeEach DELETE blocks waiting for a slot until
            // its hook times out. The headroom absorbs the churn; scoping stays per-handler.
            .withCommand(['postgres', '-c', 'max_connections=300'])
            .start()
        databaseUrl = container.getConnectionUri()
    }

    try {
        assertSafeTestDatabaseUrl(databaseUrl, { runGuard: runId, configuredDatabaseUrl })
        process.env[TEST_DATABASE_GUARD_ENV] = runId
        process.env[TEST_DATABASE_URL_ENV] = databaseUrl

        await applyHandWrittenMigrations({
            databaseUrl,
            runGuard: runId,
            configuredDatabaseUrl,
        })
    } catch (error) {
        await container?.stop()
        throw error
    }

    return async () => {
        await container?.stop()

        if (previousTestUrl === undefined) delete process.env[TEST_DATABASE_URL_ENV]
        else process.env[TEST_DATABASE_URL_ENV] = previousTestUrl

        if (previousGuard === undefined) delete process.env[TEST_DATABASE_GUARD_ENV]
        else process.env[TEST_DATABASE_GUARD_ENV] = previousGuard
    }
}
