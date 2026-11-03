import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createOwnedIdentitySessions, hashOwnedSessionToken, OWNED_SESSION_LIFETIME_MS, ownedIdentityEnabled, type IdentityBinding, type OwnedIdentityStore, type OwnedSession, type UserIdentityControl } from './owned-session'
import type { GoogleIdentity } from './google-provider'

const start = 1_800_000_000_000
const identity: GoogleIdentity = { projectId: 'skaleclub', subject: 'firebase-user', provider: 'google.com', providerSubject: 'immutable-google-subject', authenticatedAt: start / 1000 }
const binding: IdentityBinding = { id: randomUUID(), userId: randomUUID(), projectId: identity.projectId, subject: identity.subject, disabledAt: null }
let control: UserIdentityControl
let now: number
let rows: Map<string, OwnedSession>
let store: OwnedIdentityStore
let verifyIdentity: ReturnType<typeof vi.fn<(token: string) => Promise<GoogleIdentity>>>
let readProviderStatus: ReturnType<typeof vi.fn<() => Promise<{ disabled: boolean; validSince: number }>>>

beforeEach(() => {
    now = start
    control = { disabledAt: null, sessionsValidAfter: new Date(0) }
    rows = new Map()
    verifyIdentity = vi.fn<(token: string) => Promise<GoogleIdentity>>(async () => identity)
    readProviderStatus = vi.fn(async () => ({ disabled: false, validSince: 0 }))
    store = {
        findBinding: vi.fn(async (project, subject) => project === binding.projectId && subject === binding.subject ? { binding, control } : null),
        insertSessionIfActive: vi.fn(async session => { rows.set(session.tokenHash, session); return true }),
        findSession: vi.fn(async hash => rows.has(hash) ? { binding, control, session: rows.get(hash)! } : null),
        revokeSession: vi.fn(async (hash, date) => { const row = rows.get(hash); if (row) row.revokedAt = date }),
        revokeUserSessions: vi.fn(async () => {}),
    }
})

function service(enabled = true) {
    return createOwnedIdentitySessions({ enabled: () => enabled, verifyIdentity, readProviderStatus, store, clock: () => now })
}

describe('owned identity pilot admission', () => {
    it('defaults off and forbids emulators even when the flag is enabled', async () => {
        expect(ownedIdentityEnabled({})).toBe(false)
        expect(ownedIdentityEnabled({ XMAIL_GOOGLE_AUTH_ENABLED: 'false' })).toBe(false)
        expect(ownedIdentityEnabled({ XMAIL_GOOGLE_AUTH_ENABLED: 'true', FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' })).toBe(false)
        expect(ownedIdentityEnabled({ XMAIL_GOOGLE_AUTH_ENABLED: 'true' })).toBe(true)
        await expect(service(false).issue('unused')).rejects.toThrow('Owned identity pilot is not enabled.')
        expect(verifyIdentity).not.toHaveBeenCalled()
        expect(store.findBinding).not.toHaveBeenCalled()
    })
    it('stores only a hashed opaque session and preserves the existing application UUID', async () => {
        const providerToken = randomUUID()
        const session = await service().issue(providerToken)
        expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(session.userId).toBe(binding.userId)
        expect(session.expiresAt.getTime()).toBe(start + OWNED_SESSION_LIFETIME_MS)
        expect(rows.size).toBe(1)
        const stored = rows.get(hashOwnedSessionToken(session.token))!
        expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/)
        expect(JSON.stringify(stored)).not.toContain(session.token)
        expect(JSON.stringify(stored)).not.toContain(providerToken)
        expect(Object.keys(stored).sort()).toEqual(['authenticatedAt', 'bindingId', 'createdAt', 'expiresAt', 'revokedAt', 'tokenHash'].sort())
        expect(store.findBinding).toHaveBeenCalledWith(identity.projectId, identity.subject)
    })
    it('requires an existing exact binding and reviewed local control rather than matching contacts', async () => {
        vi.mocked(store.findBinding).mockResolvedValue(null)
        await expect(service().issue('verified-but-unlinked')).rejects.toThrow('Owned identity authentication failed.')
        expect(store.insertSessionIfActive).not.toHaveBeenCalled()
    })
    it('rejects a binding returned for a different project or subject', async () => {
        vi.mocked(store.findBinding).mockResolvedValue({ binding: { ...binding, subject: 'different' }, control })
        await expect(service().issue('verified')).rejects.toThrow('Owned identity authentication failed.')
    })
    it('checks original auth time, not the issue time of a refreshed identity token', async () => {
        verifyIdentity.mockResolvedValue({ ...identity, authenticatedAt: start / 1000 - 301 })
        await expect(service().issue('refreshed-but-old-auth')).rejects.toThrow('Owned identity authentication failed.')
        expect(store.insertSessionIfActive).not.toHaveBeenCalled()
    })
    it('rejects revoked provider accounts before creating a session', async () => {
        readProviderStatus.mockResolvedValue({ disabled: false, validSince: identity.authenticatedAt + 1 })
        await expect(service().issue('verified')).rejects.toThrow('Owned identity authentication failed.')
        expect(store.insertSessionIfActive).not.toHaveBeenCalled()
    })
    it('preserves reviewed local account bans and reauthentication cutoffs', async () => {
        control.disabledAt = new Date(now)
        await expect(service().issue('verified')).rejects.toThrow('Owned identity authentication failed.')
        control.disabledAt = null
        control.sessionsValidAfter = new Date(now + 1)
        await expect(service().issue('verified')).rejects.toThrow('Owned identity authentication failed.')
    })
    it('requires the store to atomically recheck revocation while inserting the session', async () => {
        vi.mocked(store.insertSessionIfActive).mockResolvedValue(false)
        await expect(service().issue('verified')).rejects.toThrow('Owned identity authentication failed.')
        expect(rows.size).toBe(0)
    })
})

describe('owned session reads and revocation', () => {
    it('rechecks the local binding/control and provider status on every request without role grants', async () => {
        const sessions = service(), issued = await sessions.issue('verified')
        readProviderStatus.mockClear()
        const result = await sessions.authenticate(issued.token)
        expect(result).toEqual({ userId: binding.userId, sessionHash: hashOwnedSessionToken(issued.token), authenticatedAt: identity.authenticatedAt })
        expect(readProviderStatus).toHaveBeenCalledTimes(1)
        control.disabledAt = new Date(now)
        expect(await sessions.authenticate(issued.token)).toBeNull()
    })
    it('never extends the absolute twelve-hour deadline', async () => {
        const sessions = service(), issued = await sessions.issue('verified')
        now += OWNED_SESSION_LIFETIME_MS
        expect(await sessions.authenticate(issued.token)).toBeNull()
        expect(rows.get(hashOwnedSessionToken(issued.token))!.expiresAt.getTime()).toBe(start + OWNED_SESSION_LIFETIME_MS)
    })
    it('rejects fabricated tokens without hitting local storage', async () => {
        expect(await service().authenticate('invalid')).toBeNull()
        expect(store.findSession).not.toHaveBeenCalled()
    })
    it('revokes the exact local session immediately', async () => {
        const sessions = service(), issued = await sessions.issue('verified')
        await sessions.revoke(issued.token)
        expect(await sessions.authenticate(issued.token)).toBeNull()
        expect(store.revokeSession).toHaveBeenCalledWith(hashOwnedSessionToken(issued.token), new Date(now))
    })
    it('denies a provider ban, outage or revocation after a session was created', async () => {
        const sessions = service(), issued = await sessions.issue('verified')
        readProviderStatus.mockResolvedValueOnce({ disabled: true, validSince: 0 })
        expect(await sessions.authenticate(issued.token)).toBeNull()
        readProviderStatus.mockRejectedValueOnce(new Error('private-provider-details'))
        expect(await sessions.authenticate(issued.token)).toBeNull()
        readProviderStatus.mockResolvedValueOnce({ disabled: false, validSince: identity.authenticatedAt + 1 })
        expect(await sessions.authenticate(issued.token)).toBeNull()
    })
    it('denies revocation committed while the live provider request was in flight', async () => {
        const sessions = service(), issued = await sessions.issue('verified')
        const session = rows.get(hashOwnedSessionToken(issued.token))!
        vi.mocked(store.findSession)
            .mockResolvedValueOnce({ binding, control: { ...control }, session })
            .mockResolvedValueOnce({ binding, control: { ...control, disabledAt: new Date(now) }, session })
        expect(await sessions.authenticate(issued.token)).toBeNull()
    })
    it('denies deleted/disabled bindings and global session revocation', async () => {
        const sessions = service(), issued = await sessions.issue('verified')
        control.sessionsValidAfter = new Date(now + 1000)
        expect(await sessions.authenticate(issued.token)).toBeNull()
        vi.mocked(store.findSession).mockResolvedValue(null)
        expect(await sessions.authenticate(issued.token)).toBeNull()
    })
    it('rejects an impossible stored lifetime instead of trusting a corrupt session row', async () => {
        const sessions = service(), issued = await sessions.issue('verified')
        rows.get(hashOwnedSessionToken(issued.token))!.expiresAt = new Date(now + OWNED_SESSION_LIFETIME_MS + 1)
        expect(await sessions.authenticate(issued.token)).toBeNull()
    })
    it('denies local database failures without exposing adapter errors', async () => {
        vi.mocked(store.findSession).mockRejectedValue(new Error('private-database-details'))
        expect(await service().authenticate('x'.repeat(43))).toBeNull()
    })
})
