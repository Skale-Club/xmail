import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

// The email-account create path guards against SSRF by resolving mail hosts; the settings
// contract under test has nothing to do with DNS, so stub the guard to a public verdict.
vi.mock('../network-guard', () => ({
    isPrivateHostWithDns: async () => false,
    isPrivateHost: () => false,
}))

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')

const IDS = {
    admin: 'c1000000-0000-4000-8000-000000000001',
    org: 'c1000000-0000-4000-8000-000000000004',
}

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let closeApplicationDatabase: (() => Promise<void>) | undefined
let resolveOutreachSettings: typeof import('../outreach-settings')['resolveOutreachSettings']
let OUTREACH_SETTINGS_DEFAULTS: typeof import('../outreach-settings')['OUTREACH_SETTINGS_DEFAULTS']

interface CallOptions {
    method?: string
    userId?: string
    body?: unknown
}

async function call(pathname: string, options: CallOptions = {}) {
    const headers: Record<string, string> = {}
    if (options.userId) headers['x-user-id'] = options.userId
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${baseUrl}${pathname}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
    const text = await response.text()
    const json = text ? JSON.parse(text) : null
    return { status: response.status, body: json as any }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    // 024 creates outreach_settings; 040 provides the canonical-sequence contract used by
    // campaign creation. Both are idempotent and advisory-locked by the harness.
    await applyMigrationFile(target, path.join(migrationsDir, '024_outreach_settings.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '040_outreach_product_consistency.sql'))

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email) VALUES (${IDS.admin}::uuid, 'settings-admin@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id)
        VALUES (${IDS.org}::uuid, 'Settings Org', 'settings-org', ${IDS.admin}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO organization_users (organization_id, user_id, role)
        VALUES (${IDS.org}::uuid, ${IDS.admin}::uuid, 'admin')
        ON CONFLICT (organization_id, user_id) DO NOTHING
    `

    const settingsModule = await import('../outreach-settings')
    resolveOutreachSettings = settingsModule.resolveOutreachSettings
    OUTREACH_SETTINGS_DEFAULTS = settingsModule.OUTREACH_SETTINGS_DEFAULTS

    const campaignsRouter = (await import('../../routes/outreach/campaigns')).default
    const settingsRouter = (await import('../../routes/outreach/settings')).default
    const emailAccountsRouter = (await import('../../routes/outreach/email-accounts')).default
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection

    const app = express()
    app.use(express.json())
    app.use('/api/outreach/campaigns', campaignsRouter)
    app.use('/api/outreach/settings', settingsRouter)
    app.use('/api/outreach/email-accounts', emailAccountsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

async function patchSettings(body: unknown) {
    const res = await call(`/api/outreach/settings?organizationId=${IDS.org}`, {
        method: 'PATCH',
        userId: IDS.admin,
        body,
    })
    expect(res.status).toBe(200)
    return res.body
}

describe('resolveOutreachSettings', () => {
    it('returns the constant defaults when no row exists', async () => {
        // A fresh org id with no settings row.
        const freshOrg = 'c1000000-0000-4000-8000-0000000000a1'
        const resolved = await resolveOutreachSettings(freshOrg)
        expect(resolved).toEqual(OUTREACH_SETTINGS_DEFAULTS)
        expect(resolved.defaultTimezone).toBe('UTC')
        expect(resolved.defaultDailyLimit).toBe(50)
        expect(resolved.notifyOnUnsubscribe).toBe(false)
    })

    it('returns stored overrides over the defaults', async () => {
        const overrideOrg = 'c1000000-0000-4000-8000-0000000000a2'
        await sql`
            INSERT INTO outreach_settings (organization_id, default_timezone, default_daily_limit, notify_on_unsubscribe)
            VALUES (${overrideOrg}::uuid, 'Europe/Paris', 321, TRUE)
        `
        const resolved = await resolveOutreachSettings(overrideOrg)
        expect(resolved.defaultTimezone).toBe('Europe/Paris')
        expect(resolved.defaultDailyLimit).toBe(321)
        expect(resolved.notifyOnUnsubscribe).toBe(true)
        // Untouched fields still come from defaults.
        expect(resolved.warmupDays).toBe(OUTREACH_SETTINGS_DEFAULTS.warmupDays)
    })
})

describe('settings become defaults for NEW campaigns', () => {
    it('an omitted campaign field inherits the stored default; an explicit field wins', async () => {
        await patchSettings({ general: { defaultTimezone: 'America/New_York', sendOnWeekends: true } })

        const inherited = await call(`/api/outreach/campaigns?organizationId=${IDS.org}`, {
            method: 'POST',
            userId: IDS.admin,
            body: { name: 'Inherits timezone' },
        })
        expect(inherited.status).toBe(201)
        expect(inherited.body.campaign.timezone).toBe('America/New_York')
        expect(inherited.body.campaign.sendOnWeekends).toBe(true)

        const explicit = await call(`/api/outreach/campaigns?organizationId=${IDS.org}`, {
            method: 'POST',
            userId: IDS.admin,
            body: { name: 'Explicit timezone', timezone: 'Asia/Tokyo', sendOnWeekends: false },
        })
        expect(explicit.status).toBe(201)
        expect(explicit.body.campaign.timezone).toBe('Asia/Tokyo')
        expect(explicit.body.campaign.sendOnWeekends).toBe(false)
    })

    it('does not rewrite existing campaigns when the default later changes', async () => {
        await patchSettings({ general: { defaultTimezone: 'Europe/Berlin' } })
        const first = await call(`/api/outreach/campaigns?organizationId=${IDS.org}`, {
            method: 'POST',
            userId: IDS.admin,
            body: { name: 'Created under Berlin' },
        })
        expect(first.status).toBe(201)
        const campaignId = first.body.campaign.id

        await patchSettings({ general: { defaultTimezone: 'Europe/London' } })

        const [row] = await sql<{ timezone: string }[]>`
            SELECT timezone FROM campaigns WHERE id = ${campaignId}::uuid
        `
        expect(row.timezone).toBe('Europe/Berlin')

        const second = await call(`/api/outreach/campaigns?organizationId=${IDS.org}`, {
            method: 'POST',
            userId: IDS.admin,
            body: { name: 'Created under London' },
        })
        expect(second.body.campaign.timezone).toBe('Europe/London')
    })
})

describe('settings become defaults for NEW email accounts', () => {
    it('an omitted account field inherits the stored default; an explicit field wins', async () => {
        await patchSettings({ sending: { defaultDailyLimit: 137 } })

        const inherited = await call(`/api/outreach/email-accounts?organizationId=${IDS.org}`, {
            method: 'POST',
            userId: IDS.admin,
            body: {
                email: 'inherit-account@example.test',
                smtpHost: 'smtp.public.example',
                smtpUsername: 'user',
                smtpPassword: 'secret',
                smtpPort: 587,
            },
        })
        expect(inherited.status).toBe(201)
        const [inheritedRow] = await sql<{ daily_send_limit: number }[]>`
            SELECT daily_send_limit FROM email_accounts WHERE id = ${inherited.body.emailAccount.id}::uuid
        `
        expect(inheritedRow.daily_send_limit).toBe(137)

        const explicit = await call(`/api/outreach/email-accounts?organizationId=${IDS.org}`, {
            method: 'POST',
            userId: IDS.admin,
            body: {
                email: 'explicit-account@example.test',
                smtpHost: 'smtp.public.example',
                smtpUsername: 'user',
                smtpPassword: 'secret',
                smtpPort: 587,
                dailySendLimit: 9,
            },
        })
        expect(explicit.status).toBe(201)
        const [explicitRow] = await sql<{ daily_send_limit: number }[]>`
            SELECT daily_send_limit FROM email_accounts WHERE id = ${explicit.body.emailAccount.id}::uuid
        `
        expect(explicitRow.daily_send_limit).toBe(9)
    })
})
