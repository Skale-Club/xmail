import { describe, expect, it } from 'vitest'
import { resolveDatabaseTarget } from './database-target'

const ref = 'abcdefghijklmnopqrst'
const dev = `postgresql://postgres.${ref}:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres`
const prod = 'postgresql://app:secret@production.internal/xmail'
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
        expect(resolveDatabaseTarget(environment)).toEqual({ databaseUrl: dev, jobDatabaseUrl: dev })
    })
    it('accepts a direct connection only for the same project', () => {
        const direct = `postgres://postgres:secret@db.${ref}.supabase.co:5432/postgres`
        expect(resolveDatabaseTarget({ ...environment, XMAIL_DEV_DIRECT_URL: direct }).jobDatabaseUrl).toBe(direct)
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
