import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { createPostgresOwnedIdentityStore } from './postgres-store'
import { createOwnedIdentitySessions, hashOwnedSessionToken, OWNED_SESSION_LIFETIME_MS, type IdentityBinding, type OwnedIdentityStore, type OwnedSession } from './owned-session'

// This standalone gate never loads dotenv, application DB aliases or the shared
// migration harness. Only the declared loopback CI service may be destructive.
const databaseUrl = process.env.XMAIL_IDENTITY_TEST_DATABASE_URL
if (databaseUrl) {
    let valid = false
    try {
        const target = new URL(databaseUrl)
        valid = ['postgres:', 'postgresql:'].includes(target.protocol)
            && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
            && target.pathname === '/xmail_identity_test' && target.username === 'postgres'
            && !target.search && !target.hash
            && process.env.XMAIL_IDENTITY_TEST_SENTINEL === 'xmail-owned-identity-ci'
    } catch { /* The error below intentionally omits connection values. */ }
    if (!valid) throw new Error('Identity integration tests require the isolated loopback CI database and sentinel.')
}

describe.skipIf(!databaseUrl)('owned identity PostgreSQL foundation (disposable CI service only)', () => {
    let sql: Sql
    let store: OwnedIdentityStore
    let binding: IdentityBinding
    let existingPasswordHash: string
    const now = Date.now()
    const authTime = Math.floor(now / 1000) - 10
    const migration = readFileSync(resolve('supabase/migrations/079_owned_identity_foundation.sql'), 'utf8')

    beforeAll(async () => {
        sql = postgres(databaseUrl!, { max: 4, prepare: false, onnotice: () => {} })
        await sql`CREATE TABLE public.users (id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text, is_admin boolean NOT NULL DEFAULT false)`
        await sql.unsafe(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        END $$;`)
        await sql.unsafe(migration)
        store = createPostgresOwnedIdentityStore(sql)
    })
    afterAll(async () => { await sql?.end({ timeout: 1 }) })
    beforeEach(async () => {
        await sql`TRUNCATE public.users CASCADE`
        binding = { id: randomUUID(), userId: randomUUID(), projectId: 'skaleclub', subject: 'firebase-test-user', disabledAt: null }
        existingPasswordHash = randomUUID()
        await sql`INSERT INTO public.users (id, email, password_hash, is_admin) VALUES (${binding.userId}, ${`${randomUUID()}@example.invalid`}, ${existingPasswordHash}, true)`
        await sql`INSERT INTO public.xmail_identity_user_controls (user_id, review_source) VALUES (${binding.userId}, 'reviewed-offline-fixture')`
        await sql`INSERT INTO public.xmail_identity_bindings (id, project_id, subject, user_id, proof_reference)
            VALUES (${binding.id}, ${binding.projectId}, ${binding.subject}, ${binding.userId}, 'independent-proof-fixture')`
    })

    function session(): OwnedSession {
        return {
            tokenHash: hashOwnedSessionToken(randomBytes(32).toString('base64url')), bindingId: binding.id,
            authenticatedAt: authTime, createdAt: new Date(now), expiresAt: new Date(now + OWNED_SESSION_LIFETIME_MS), revokedAt: null,
        }
    }
    function sessions() {
        return createOwnedIdentitySessions({
            enabled: () => true, store, clock: () => now,
            verifyIdentity: async () => ({ projectId: binding.projectId, subject: binding.subject, provider: 'phone', providerSubject: '+12025550123', authenticatedAt: authTime }),
            readProviderStatus: async () => ({ disabled: false, validSince: 0 }),
        })
    }

    it('reapplies additively without changing application UUID, admin authority or SMTP/IMAP hash', async () => {
        await sql.unsafe(migration)
        const [user] = await sql`SELECT id, password_hash, is_admin FROM public.users WHERE id = ${binding.userId}`
        expect(user).toEqual({ id: binding.userId, password_hash: existingPasswordHash, is_admin: true })
    })
    it('enables RLS on all three tables and revokes browser-role reads', async () => {
        for (const table of ['xmail_identity_user_controls', 'xmail_identity_bindings', 'xmail_identity_owned_sessions']) {
            const [row] = await sql`SELECT relrowsecurity FROM pg_class WHERE oid = ${`public.${table}`}::regclass`
            expect(row.relrowsecurity).toBe(true)
            for (const role of ['anon', 'authenticated']) {
                const [access] = await sql`SELECT has_table_privilege(${role}, ${`public.${table}`}, 'SELECT') AS allowed`
                expect(access.allowed).toBe(false)
            }
        }
    })
    it('resolves only an exact project/UID binding with a reviewed existing local user', async () => {
        expect((await store.findBinding(binding.projectId, binding.subject))?.binding.userId).toBe(binding.userId)
        expect(await store.findBinding('another-project', binding.subject)).toBeNull()
        expect(await store.findBinding(binding.projectId, 'unlinked-user')).toBeNull()
        await sql`DELETE FROM public.xmail_identity_user_controls WHERE user_id = ${binding.userId}`
        expect(await store.findBinding(binding.projectId, binding.subject)).toBeNull()
    })
    it('refuses conflicting UID ownership and locally disabled user/binding admission', async () => {
        await expect(sql`INSERT INTO public.xmail_identity_bindings (project_id, subject, user_id, proof_reference)
            VALUES (${binding.projectId}, ${binding.subject}, ${binding.userId}, 'conflicting-proof')`).rejects.toMatchObject({ code: '23505' })
        await sql`UPDATE public.xmail_identity_user_controls SET disabled_at = now() WHERE user_id = ${binding.userId}`
        expect(await store.insertSessionIfActive(session(), binding)).toBe(false)
        await sql`UPDATE public.xmail_identity_user_controls SET disabled_at = NULL WHERE user_id = ${binding.userId}`
        await sql`UPDATE public.xmail_identity_bindings SET disabled_at = now() WHERE id = ${binding.id}`
        expect(await store.insertSessionIfActive(session(), binding)).toBe(false)
    })
    it('issues hashed sessions for the same immutable user and revokes them immediately', async () => {
        const engine = sessions(), issued = await engine.issue('offline-verified-token')
        expect((await engine.authenticate(issued.token))?.userId).toBe(binding.userId)
        const [stored] = await sql`SELECT token_hash FROM public.xmail_identity_owned_sessions`
        expect(stored.token_hash).toBe(hashOwnedSessionToken(issued.token))
        await engine.revoke(issued.token)
        expect(await engine.authenticate(issued.token)).toBeNull()
    })
    it('serializes concurrent global revocation and insertion so no stale session survives', async () => {
        const engine = sessions(), issued = await engine.issue('offline-verified-token')
        await Promise.all([
            store.insertSessionIfActive(session(), binding),
            store.revokeUserSessions(binding.userId, new Date(now + 1000)),
        ])
        expect(await engine.authenticate(issued.token)).toBeNull()
        expect(await store.insertSessionIfActive(session(), binding)).toBe(false)
        const [active] = await sql`
            SELECT count(*)::int AS count FROM public.xmail_identity_owned_sessions s
            JOIN public.xmail_identity_bindings b ON b.id = s.binding_id
            JOIN public.xmail_identity_user_controls c ON c.user_id = b.user_id
            WHERE s.revoked_at IS NULL AND to_timestamp(s.authenticated_at) >= c.sessions_valid_after
        `
        expect(active.count).toBe(0)
    })
    it('enforces the session lifetime and owner again at the database boundary', async () => {
        const invalid = session()
        invalid.expiresAt = new Date(now + OWNED_SESSION_LIFETIME_MS + 1)
        await expect(store.insertSessionIfActive(invalid, binding)).rejects.toMatchObject({ code: '23514' })
        expect(await store.insertSessionIfActive(session(), { ...binding, userId: randomUUID() })).toBe(false)
    })
})
