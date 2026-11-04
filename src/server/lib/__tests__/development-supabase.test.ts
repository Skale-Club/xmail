import { afterEach, expect, it, vi } from 'vitest'

const createClient = vi.hoisted(() => vi.fn(() => ({})))
vi.mock('@supabase/supabase-js', () => ({ createClient }))

afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.clearAllMocks()
})

it('constructs development clients only on explicit use with dedicated Auth settings', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('XMAIL_DEV_SUPABASE_PROJECT_REF', 'abcdefghijklmnopqrst')
    vi.stubEnv('XMAIL_DEV_SUPABASE_ANON_KEY', 'dev-anon')
    vi.stubEnv('XMAIL_DEV_SUPABASE_SERVICE_ROLE_KEY', 'dev-role')
    vi.stubEnv('SUPABASE_URL', 'https://production.example')
    vi.stubEnv('SUPABASE_ANON_KEY', 'production-anon')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'production-role')
    const { supabasePublicConfig, supabaseAnonClient, supabaseAdminClient } = await import('../supabase')
    expect(createClient).not.toHaveBeenCalled()
    void supabaseAnonClient.auth; void supabaseAdminClient.auth
    expect(createClient.mock.calls).toEqual([
        ['https://abcdefghijklmnopqrst.supabase.co', 'dev-anon', expect.objectContaining({ auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })],
        ['https://abcdefghijklmnopqrst.supabase.co', 'dev-role', expect.any(Object)],
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
    const { supabaseAnonClient, supabaseAdminClient } = await import('../supabase')
    expect(createClient).not.toHaveBeenCalled()
    void supabaseAnonClient.auth; void supabaseAdminClient.auth
    expect(createClient.mock.calls).toEqual([
        ['https://production.example', 'production-anon', expect.any(Object)],
        ['https://production.example', 'production-role', expect.any(Object)],
    ])
})

it('owned startup imports without hosted Auth credentials and refuses all hosted Auth calls', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned')
    vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true'); vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned')
    vi.stubEnv('SUPABASE_URL', ''); vi.stubEnv('SUPABASE_ANON_KEY', ''); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const module = await import('../supabase')
    expect(module.supabasePublicConfig).toEqual({ url: '', anonKey: '' })
    expect(() => module.supabaseAnonClient.auth).toThrow('Legacy server authentication is unavailable')
    expect(() => module.supabaseAdminClient.auth).toThrow('Legacy server authentication is unavailable')
    expect(() => module.createSupabaseUserClient('independent-proof-fixture')).toThrow('Legacy server authentication is unavailable')
    await expect(module.checkSupabaseAuthHealth()).rejects.toThrow('Legacy server authentication is unavailable')
    expect(createClient).not.toHaveBeenCalled()
})

it('keeps explicit legacy Storage independent while owned server Auth remains blocked', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned')
    vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true'); vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned')
    vi.stubEnv('SUPABASE_URL', 'https://storage-fixture.invalid'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'storage-fixture-role')
    const { supabaseAdminClient } = await import('../supabase')
    void supabaseAdminClient.storage
    expect(createClient).toHaveBeenCalledOnce()
    expect(() => supabaseAdminClient.auth).toThrow('Legacy server authentication is unavailable')
    expect(createClient).toHaveBeenCalledOnce()
})

it('does not use production aliases for owned development Storage without dedicated settings', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned')
    vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true'); vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned')
    vi.stubEnv('XMAIL_DEV_SUPABASE_PROJECT_REF', ''); vi.stubEnv('SUPABASE_URL', 'https://production.example')
    const { supabaseAdminClient, supabasePublicConfig } = await import('../supabase')
    expect(supabasePublicConfig).toEqual({ url: '', anonKey: '' })
    expect(() => supabaseAdminClient.storage).toThrow('XMAIL_DEV_SUPABASE_PROJECT_REF')
    expect(createClient).not.toHaveBeenCalled()
})
