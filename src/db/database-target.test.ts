import { describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { resolveDatabaseTarget } from './database-target'

const ref = 'abcdefghijklmnopqrst'
// Offline-only credentials are generated rather than committed as scanner findings.
const secret = randomUUID()
const dev = `postgresql://postgres.${ref}:${secret}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`
const prod = `postgresql://app:${secret}@production.internal/xmail`
const securedDev = `${dev}?sslmode=require`
const environment = {
    NODE_ENV: 'development',
    XMAIL_DEV_SUPABASE_PROJECT_REF: ref,
    XMAIL_DEV_DATABASE_URL: dev,
    DATABASE_URL: prod,
    DIRECT_URL: prod,
    XMAIL_ALLOW_REMOTE_DB: 'true',
}

describe('database environment separation', () => {
    it('selects the approved development project for both pools despite production aliases', () => {
        expect(resolveDatabaseTarget(environment)).toEqual({ databaseUrl: securedDev, jobDatabaseUrl: securedDev })
    })
    it('accepts a direct connection only for the same project', () => {
        const direct = `postgres://postgres:${secret}@db.${ref}.supabase.co:5432/postgres`
        expect(resolveDatabaseTarget({ ...environment, XMAIL_DEV_DIRECT_URL: direct }).jobDatabaseUrl).toBe(`${direct}?sslmode=require`)
    })
    it.each([
        { XMAIL_DEV_DATABASE_URL: undefined },
        { XMAIL_DEV_SUPABASE_PROJECT_REF: undefined },
        { XMAIL_DEV_SUPABASE_PROJECT_REF: 'invalid' },
        { XMAIL_DEV_DATABASE_URL: prod },
        { XMAIL_DEV_DIRECT_URL: prod },
        { XMAIL_DEV_DIRECT_URL: dev.replace(ref, 'zyxwvutsrqponmlkjihg') },
        { XMAIL_DEV_DATABASE_URL: dev.replace('.com:', '.com.evil.example:') },
        { XMAIL_DEV_DATABASE_URL: dev.replace('/postgres', '/other') },
        { XMAIL_DEV_DATABASE_URL: dev.replace('postgresql:', 'https:') },
        { XMAIL_DEV_DATABASE_URL: 'invalid' },
    ])('refuses unsafe development configuration without exposing credentials: %j', override => {
        expect(() => resolveDatabaseTarget({ ...environment, ...override })).toThrow()
        try {
            resolveDatabaseTarget({ ...environment, ...override })
        } catch (error) {
            expect(String(error)).not.toContain('secret')
            expect(String(error)).not.toContain(secret)
        }
    })
    it.each([
        ['transaction-pooler port', dev.replace(':5432/', ':6543/')],
        ['unexpected port', dev.replace(':5432/', ':9999/')],
        ['unexpected direct user', `postgresql://other:${secret}@db.${ref}.supabase.co:5432/postgres`],
        ['missing user', `postgresql://:${secret}@db.${ref}.supabase.co:5432/postgres`],
        ['missing explicit password', dev.replace(`:${secret}@`, '@')],
        ['malformed encoded user', dev.replace('postgres.', 'postgres%ZZ.')],
        ['malformed encoded password', dev.replace(secret, 'invalid%ZZ')],
        ['TLS disabled', `${dev}?sslmode=disable`],
        ['opportunistic TLS', `${dev}?sslmode=prefer`],
        ['duplicate TLS options', `${dev}?sslmode=require&sslmode=disable`],
        ['driver query override', `${dev}?debug=true`],
        ['SQL startup options', `${dev}?options=-csearch_path=other`],
        ['URL fragment', `${dev}#ignored`],
    ])('refuses %s for either development pool without leaking credentials', (_label, url) => {
        for (const key of ['XMAIL_DEV_DATABASE_URL', 'XMAIL_DEV_DIRECT_URL']) {
            expect(() => resolveDatabaseTarget({ ...environment, [key]: url })).toThrow(/XMAIL_DEV/)
            try {
                resolveDatabaseTarget({ ...environment, [key]: url })
            } catch (error) {
                expect(String(error)).not.toContain(secret)
                expect(String(error)).not.toContain(url)
            }
        }
    })
    it.each(['require', 'verify-ca', 'verify-full'])('preserves the supported explicit TLS mode %s', mode => {
        const url = `${dev}?sslmode=${mode}`
        expect(resolveDatabaseTarget({ ...environment, XMAIL_DEV_DATABASE_URL: url }))
            .toEqual({ databaseUrl: url, jobDatabaseUrl: url })
    })
    it('pins the default port and TLS in actual driver options without opening a connection', async () => {
        const target = resolveDatabaseTarget({ ...environment, XMAIL_DEV_DATABASE_URL: dev.replace(':5432', '') })
        expect(target.databaseUrl).toBe(securedDev)
        const client = postgres(target.databaseUrl)
        try {
            expect(client.options.host).toEqual(['aws-0-us-east-1.pooler.supabase.com'])
            expect(client.options.port).toEqual([5432])
            expect(client.options.user).toBe(`postgres.${ref}`)
            expect(client.options.database).toBe('postgres')
            expect(client.options.ssl).toBe('require')
        } finally {
            await client.end({ timeout: 0 })
        }
    })
    it('keeps existing production pool selection during the additive transition', () => {
        expect(resolveDatabaseTarget({ NODE_ENV: 'production', DATABASE_URL: prod, DIRECT_URL: dev }))
            .toEqual({ databaseUrl: prod, jobDatabaseUrl: dev })
    })
    it('keeps disposable test targets independent from development settings', () => {
        expect(resolveDatabaseTarget({ NODE_ENV: 'test', DATABASE_URL: prod }))
            .toEqual({ databaseUrl: prod, jobDatabaseUrl: prod })
    })
    it('refuses a missing production/test URL', () => {
        expect(() => resolveDatabaseTarget({ NODE_ENV: 'production' })).toThrow('Missing DATABASE_URL')
    })
})
