import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureLocalUser } from '../user-sync'

const mocks = vi.hoisted(() => ({ find: vi.fn(), insert: vi.fn(), update: vi.fn() }))
vi.mock('../../../db', () => ({ db: { query: { users: { findFirst: mocks.find } }, insert: mocks.insert, update: mocks.update },
    withRetry: (run: () => Promise<unknown>) => run() }))
const snapshot = { id: crypto.randomUUID(), email: 'provider@example.invalid', firstName: 'Provider', lastName: null, emailVerified: true }
beforeEach(() => vi.clearAllMocks())
describe('existing-only owned user synchronization', () => {
    it('never recreates a user deleted after owned admission', async () => {
        mocks.find.mockResolvedValue(undefined)
        await expect(ensureLocalUser(snapshot, { existingOnly: true })).rejects.toThrow('Existing identity account is unavailable.')
        expect(mocks.insert).not.toHaveBeenCalled()
    })
    it('preserves local authority and contact data instead of synchronizing provider attributes', async () => {
        const existing = { id: snapshot.id, email: 'local@example.invalid', firstName: 'Local', isAdmin: true }
        mocks.find.mockResolvedValue(existing)
        expect(await ensureLocalUser(snapshot, { existingOnly: true })).toBe(existing)
        expect(mocks.update).not.toHaveBeenCalled()
    })
})
