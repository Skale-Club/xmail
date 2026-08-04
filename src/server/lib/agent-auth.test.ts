import { beforeAll, describe, expect, it } from 'vitest'

let auth: typeof import('./agent-auth')

beforeAll(async () => {
    process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused'
    auth = await import('./agent-auth')
})

describe('outreach agent tokens', () => {
    it('generates a parseable token and persists only a deterministic hash', () => {
        const generated = auth.generateAgentToken()

        expect(generated.token).toMatch(/^xma_[0-9a-f]{16}_[A-Za-z0-9_-]{40,}$/)
        expect(auth.parseAgentToken(generated.token)).toEqual({ keyPrefix: generated.keyPrefix })
        expect(generated.keyHash).toBe(auth.hashAgentToken(generated.token))
        expect(generated.keyHash).not.toContain(generated.token)
    })

    it('fails closed for malformed tokens', () => {
        expect(auth.parseAgentToken('')).toBeNull()
        expect(auth.parseAgentToken('xma_short_secret')).toBeNull()
        expect(auth.parseAgentToken('service-key')).toBeNull()
    })

    it('drops unknown scopes and removes duplicates', () => {
        expect(auth.normalizeAgentScopes([
            'outreach:read',
            'outreach:read',
            'campaigns:activate',
            123,
            'events:read',
        ])).toEqual(['outreach:read', 'events:read'])
    })
})
