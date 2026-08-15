import { afterEach, describe, expect, it, vi } from 'vitest'
import { isR2Configured, publicObjectUrl } from '../object-storage'

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('isR2Configured', () => {
    it('is off when no R2 secret is present', () => {
        vi.stubEnv('R2_ACCESS_KEY_ID', '')
        vi.stubEnv('R2_SECRET_ACCESS_KEY', '')
        vi.stubEnv('R2_ACCOUNT_ID', '')
        vi.stubEnv('R2_ENDPOINT', '')
        expect(isR2Configured()).toBe(false)
    })

    it('requires credentials AND an endpoint or account id', () => {
        vi.stubEnv('R2_ACCESS_KEY_ID', 'key')
        vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret')
        vi.stubEnv('R2_ACCOUNT_ID', '')
        vi.stubEnv('R2_ENDPOINT', '')
        expect(isR2Configured()).toBe(false)

        vi.stubEnv('R2_ACCOUNT_ID', 'acct')
        expect(isR2Configured()).toBe(true)

        vi.stubEnv('R2_ACCOUNT_ID', '')
        vi.stubEnv('R2_ENDPOINT', 'https://acct.r2.cloudflarestorage.com')
        expect(isR2Configured()).toBe(true)
    })
})

describe('publicObjectUrl', () => {
    it('returns null without a public base, so callers fall back to Supabase URLs', () => {
        vi.stubEnv('R2_PUBLIC_BASE_URL', '')
        expect(publicObjectUrl('brand-mark.svg')).toBeNull()
    })

    it('joins base and path without duplicating slashes', () => {
        vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://assets.example.com/')
        expect(publicObjectUrl('/logo-1.svg')).toBe('https://assets.example.com/logo-1.svg')
        expect(publicObjectUrl('org/att/file.pdf')).toBe('https://assets.example.com/org/att/file.pdf')
    })
})
