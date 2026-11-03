import { afterEach, expect, it, vi } from 'vitest'

const schedule = vi.hoisted(() => vi.fn())
vi.mock('node-cron', () => ({ default: { schedule } }))
vi.mock('../../lib/inbox-ai-automation-runtime', () => ({ logAutonomousAutomationStatus: vi.fn().mockResolvedValue(undefined) }))

afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
})

it('does not register any queued delivery, campaign or webhook jobs in development', async () => {
    // Import using test settings: imports must remain inert, and callbacks are never run.
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:1/xmail_test')
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:1')
    vi.stubEnv('SUPABASE_ANON_KEY', 'test-only')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only')
    vi.stubEnv('ENCRYPTION_KEY', 'test-only-outreach-signing-key')
    const { startJobs } = await import('../index')
    vi.stubEnv('NODE_ENV', 'development')
    startJobs()
    expect(schedule).not.toHaveBeenCalled()
    vi.stubEnv('NODE_ENV', 'production')
    startJobs()
    expect(schedule.mock.calls.length).toBeGreaterThan(10)
})
