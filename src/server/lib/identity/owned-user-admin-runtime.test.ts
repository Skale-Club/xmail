import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ pool: vi.fn(() => ({})), target: vi.fn(() => ({ databaseUrl: 'postgres://fixture.invalid/not-used' })), encrypt: vi.fn() }))
vi.mock('postgres', () => ({ default: calls.pool }))
vi.mock('../../../db/database-target', () => ({ resolveDatabaseTarget: calls.target }))
vi.mock('../crypto', () => ({ encryptSecret: calls.encrypt }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
describe('owned user administration lazy runtime', () => {
    it('does not construct a pool or read native credentials merely by importing the module', async () => {
        await import('./owned-user-admin-runtime')
        expect(calls.pool).not.toHaveBeenCalled(); expect(calls.target).not.toHaveBeenCalled(); expect(calls.encrypt).not.toHaveBeenCalled()
    })
    it('uses the explicit database resolver and a shared bounded pool without query logging', async () => {
        const runtime = await import('./owned-user-admin-runtime')
        const first = await runtime.getOwnedUserAdminStore()
        expect(await runtime.getOwnedUserAdminStore()).toBe(first)
        expect(calls.target).toHaveBeenCalledWith(process.env)
        expect(calls.pool).toHaveBeenCalledOnce()
        expect(calls.pool).toHaveBeenCalledWith('postgres://fixture.invalid/not-used', expect.objectContaining({ max: 2, prepare: false, connect_timeout: 5, debug: false }))
        expect(calls.encrypt).not.toHaveBeenCalled()
    })
})
