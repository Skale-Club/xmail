import { describe, expect, it } from 'vitest'
import { resolveDevelopmentAuth, resolveDevelopmentServerAuth } from './development-auth'

const ref = 'abcdefghijklmnopqrst'
const env = {
    XMAIL_DEV_SUPABASE_PROJECT_REF: ref,
    XMAIL_DEV_SUPABASE_ANON_KEY: 'dev-anon',
    XMAIL_DEV_SUPABASE_SERVICE_ROLE_KEY: 'dev-service',
    SUPABASE_URL: 'https://production.example',
    VITE_SUPABASE_URL: 'https://production.example',
    SUPABASE_ANON_KEY: 'production-anon',
    VITE_SUPABASE_ANON_KEY: 'production-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'production-service',
}

describe('development Auth isolation', () => {
    it('uses one approved development project for browser and server despite inherited aliases', () => {
        const browser = resolveDevelopmentAuth(env)
        expect(browser).toEqual({ url: `https://${ref}.supabase.co`, anonKey: 'dev-anon' })
        expect(resolveDevelopmentServerAuth(env)).toEqual({ ...browser, serviceRoleKey: 'dev-service' })
        expect(browser).not.toHaveProperty('serviceRoleKey')
    })
    it.each([
        { XMAIL_DEV_SUPABASE_PROJECT_REF: undefined },
        { XMAIL_DEV_SUPABASE_PROJECT_REF: 'invalid.example' },
        { XMAIL_DEV_SUPABASE_ANON_KEY: undefined },
        { XMAIL_DEV_SUPABASE_ANON_KEY: ' ' },
        { XMAIL_DEV_SUPABASE_SERVICE_ROLE_KEY: undefined },
    ])('refuses missing development settings without falling back or exposing keys', override => {
        expect(() => resolveDevelopmentServerAuth({ ...env, ...override })).toThrow()
        try {
            resolveDevelopmentServerAuth({ ...env, ...override })
        } catch (error) {
            expect(String(error)).not.toMatch(/production-service|dev-service|production-anon|dev-anon/)
        }
    })
})
