import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticateNativeUser } from '../native-mail'

const fixture = vi.hoisted(() => ({ user: vi.fn(), mailbox: vi.fn(), control: vi.fn(), compare: vi.fn(), hash: vi.fn() }))
vi.mock('../../../db', () => ({ db: { query: { users: { findFirst: fixture.user }, mailboxes: { findFirst: fixture.mailbox }, identityUserControls: { findFirst: fixture.control } } } }))
vi.mock('bcrypt', () => ({ default: { compare: fixture.compare, hash: fixture.hash } }))
const account = Object.freeze({ id: '10000000-0000-4000-8000-000000000001', email: 'native@example.invalid', passwordHash: 'existing-native-hash-fixture' })
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned')
    vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true'); vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned'); vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '')
    fixture.user.mockResolvedValue(account); fixture.mailbox.mockResolvedValue({ id: 'native-mailbox-fixture' })
    fixture.control.mockResolvedValue({ disabledAt: null }); fixture.compare.mockResolvedValue(true)
})
afterEach(() => vi.unstubAllEnvs())
describe('native authentication shared by SMTP and IMAP under owned authority', () => {
    it('admits only reviewed control and active mailbox without changing the existing native hash', async () => {
        expect(await authenticateNativeUser(account.email, 'password-fixture')).toBe(account)
        expect(fixture.compare).toHaveBeenCalledWith('password-fixture', account.passwordHash)
        expect(fixture.control).toHaveBeenCalledTimes(2); expect(fixture.mailbox).toHaveBeenCalledTimes(2)
        expect(fixture.hash).not.toHaveBeenCalled(); expect(account.passwordHash).toBe('existing-native-hash-fixture')
    })
    it.each([null, { disabledAt: new Date() }])('refuses a missing or disabled control even when the mailbox is active', async control => {
        fixture.control.mockResolvedValue(control)
        expect(await authenticateNativeUser(account.email, 'password-fixture')).toBeNull()
        expect(fixture.compare).not.toHaveBeenCalled(); expect(fixture.hash).not.toHaveBeenCalled()
    })
    it('refuses local deactivation committed while bcrypt is in progress', async () => {
        fixture.compare.mockImplementation(async () => { fixture.control.mockResolvedValue({ disabledAt: new Date() }); return true })
        expect(await authenticateNativeUser(account.email, 'password-fixture')).toBeNull()
        expect(fixture.hash).not.toHaveBeenCalled()
    })
    it('refuses a mailbox disabled while password proof is in progress', async () => {
        fixture.compare.mockImplementation(async () => { fixture.mailbox.mockResolvedValue(null); return true })
        expect(await authenticateNativeUser(account.email, 'password-fixture')).toBeNull()
        expect(fixture.hash).not.toHaveBeenCalled()
    })
    it('fails closed on owned SQL errors without propagating details to either protocol handler', async () => {
        fixture.control.mockRejectedValue(new Error('private-database-detail'))
        expect(await authenticateNativeUser(account.email, 'password-fixture')).toBeNull()
        fixture.user.mockRejectedValue(new Error('private-user-query-detail'))
        expect(await authenticateNativeUser(account.email, 'password-fixture')).toBeNull()
        expect(fixture.hash).not.toHaveBeenCalled()
    })
    it('preserves default legacy mailbox/hash admission without reading pilot controls', async () => {
        vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'legacy'); fixture.control.mockResolvedValue({ disabledAt: new Date() })
        expect(await authenticateNativeUser(account.email, 'password-fixture')).toBe(account)
        expect(fixture.control).not.toHaveBeenCalled(); expect(fixture.hash).not.toHaveBeenCalled()
    })
    it('rejects incorrect passwords, inactive native admission and incomplete owned configuration', async () => {
        fixture.compare.mockResolvedValue(false)
        expect(await authenticateNativeUser(account.email, 'incorrect-fixture')).toBeNull()
        fixture.mailbox.mockResolvedValue(null)
        expect(await authenticateNativeUser(account.email, 'password-fixture')).toBeNull()
        vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'false')
        fixture.user.mockClear()
        expect(await authenticateNativeUser(account.email, 'password-fixture')).toBeNull()
        expect(fixture.user).not.toHaveBeenCalled()
    })
})
