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
