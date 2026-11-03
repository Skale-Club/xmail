import { afterEach, expect, it, vi } from 'vitest'

const createClient = vi.hoisted(() => vi.fn(() => ({})))
vi.mock('@supabase/supabase-js', () => ({ createClient }))

afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.clearAllMocks()
})

it('constructs both development clients and public runtime config using dedicated Auth settings', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('XMAIL_DEV_SUPABASE_PROJECT_REF', 'abcdefghijklmnopqrst')
    vi.stubEnv('XMAIL_DEV_SUPABASE_ANON_KEY', 'dev-anon')
    vi.stubEnv('XMAIL_DEV_SUPABASE_SERVICE_ROLE_KEY', 'dev-role')
    vi.stubEnv('SUPABASE_URL', 'https://production.example')
    vi.stubEnv('SUPABASE_ANON_KEY', 'production-anon')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'production-role')
    const { supabasePublicConfig } = await import('../supabase')
    expect(createClient.mock.calls).toEqual([
        ['https://abcdefghijklmnopqrst.supabase.co', 'dev-anon'],
        ['https://abcdefghijklmnopqrst.supabase.co', 'dev-role'],
    ])
    expect(supabasePublicConfig).toEqual({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'dev-anon' })
})

it('refuses startup before constructing clients when only production aliases are available', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('XMAIL_DEV_SUPABASE_PROJECT_REF', '')
    vi.stubEnv('SUPABASE_URL', 'https://production.example')
    vi.stubEnv('SUPABASE_ANON_KEY', 'production-anon')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'production-role')
    await expect(import('../supabase')).rejects.toThrow('XMAIL_DEV_SUPABASE_PROJECT_REF')
    expect(createClient).not.toHaveBeenCalled()
})

it('preserves production client settings during the additive transition', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SUPABASE_URL', 'https://production.example')
    vi.stubEnv('SUPABASE_ANON_KEY', 'production-anon')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'production-role')
    await import('../supabase')
    expect(createClient.mock.calls).toEqual([
        ['https://production.example', 'production-anon'],
        ['https://production.example', 'production-role'],
    ])
})
