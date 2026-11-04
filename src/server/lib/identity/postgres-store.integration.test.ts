import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createPostgresOwnedIdentityStore } from './postgres-store'
import { createIdentityPilotStore } from './pilot-store'
import { createExistingAccountLinker } from './existing-account-link'
import { createOwnedIdentitySessions, hashOwnedSessionToken, OWNED_SESSION_LIFETIME_MS, type IdentityBinding, type OwnedIdentityStore, type OwnedSession } from './owned-session'

function acceptanceQuery(facts: Record<string, string>): string {
    const program = String.raw`import json,sys,textwrap
from pathlib import Path
s=Path('.github/scripts/deploy-xmail.sh').read_text()
a=s.index('import datetime as dt\n',s.index('# BEGIN XMAIL OWNED POLICY'));b=s.index('XMAIL_OWNED_POLICY_PY',a)
n={'__name__':'offline_fixture'};exec(compile(textwrap.dedent(s[a:b]),'policy','exec'),n)
print(n['admin_acceptance_query'](json.load(sys.stdin)))`
    return execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', program],
        { input: JSON.stringify(facts), encoding: 'utf8', timeout: 5000 }).trim()
}

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
        // Production initializes Drizzle on this SAME raw client before identity stores.
        drizzle(sql)
        await sql`CREATE TABLE public.users (id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text, is_admin boolean NOT NULL DEFAULT false,
            first_name text, last_name text, email_verified boolean NOT NULL DEFAULT false)`
        await sql.unsafe(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        END $$;`)
        await sql.unsafe(migration)
        await sql.unsafe(readFileSync(resolve('supabase/migrations/080_identity_browser_challenges.sql'), 'utf8'))
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
    function sessions(offset = 0) {
        return createOwnedIdentitySessions({
            enabled: () => true, store, clock: () => now + offset,
            verifyIdentity: async () => ({ projectId: binding.projectId, subject: binding.subject, provider: 'phone', providerSubject: '+12025550123', authenticatedAt: authTime }),
            readProviderStatus: async () => ({ disabled: false, validSince: 0 }),
        })
    }

    it('reapplies additively without changing application UUID, admin authority or SMTP/IMAP hash', async () => {
        await sql.unsafe(migration)
        await sql.unsafe(readFileSync(resolve('supabase/migrations/080_identity_browser_challenges.sql'), 'utf8'))
        const [user] = await sql`SELECT id, password_hash, is_admin FROM public.users WHERE id = ${binding.userId}`
        expect(user).toEqual({ id: binding.userId, password_hash: existingPasswordHash, is_admin: true })
    })
    it('enables RLS on all three tables and revokes browser-role reads', async () => {
        for (const table of ['xmail_identity_user_controls', 'xmail_identity_bindings', 'xmail_identity_owned_sessions', 'xmail_identity_browser_challenges']) {
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
    it('normalizes shared Drizzle string timestamps and refuses an expired real stored session', async () => {
        const [wire] = await sql`SELECT ${new Date(now).toISOString()}::timestamptz AS value`
        expect(typeof wire.value).toBe('string')
        const admission = await store.findBinding(binding.projectId, binding.subject)
        expect(admission?.control.sessionsValidAfter).toBeInstanceOf(Date)
        expect(admission?.control.disabledAt).toBeNull()
        const engine = sessions(), issued = await engine.issue('offline-verified-token')
        const stored = await store.findSession(hashOwnedSessionToken(issued.token))
        expect(stored?.session.createdAt).toBeInstanceOf(Date)
        expect(stored?.session.expiresAt).toEqual(issued.expiresAt)
        expect(stored?.session.revokedAt).toBeNull()
        expect(await sessions(OWNED_SESSION_LIFETIME_MS + 1).authenticate(issued.token)).toBeNull()
        const pilot = createIdentityPilotStore(sql)
        const challenge = { challengeHash: hashOwnedSessionToken(randomUUID()), browserHash: hashOwnedSessionToken(randomUUID()), origin: 'https://offline.example.invalid', operation: 'link' }
        await pilot.createChallenge({ ...challenge, expiresAt: new Date(now + 1000) }, new Date(now))
        expect(await pilot.consumeChallenge(challenge, new Date(now + 1001))).toBe(false)
        await pilot.createChallenge({ ...challenge, challengeHash: hashOwnedSessionToken(randomUUID()), expiresAt: new Date(now + 10000) }, new Date(now + 1001))
        expect((await sql`SELECT count(*)::int AS n FROM public.xmail_identity_browser_challenges`)[0].n).toBe(1)
    })
    it('atomically consumes a browser/origin/operation-bound challenge once', async () => {
        const pilot = createIdentityPilotStore(sql)
        const challenge = { challengeHash: hashOwnedSessionToken(randomUUID()), browserHash: hashOwnedSessionToken(randomUUID()), origin: 'https://offline.example.invalid', operation: 'link' }
        await pilot.createChallenge({ ...challenge, expiresAt: new Date(now + 60_000) }, new Date(now))
        expect(await pilot.consumeChallenge({ ...challenge, operation: 'session' }, new Date(now))).toBe(false)
        expect(await pilot.consumeChallenge({ ...challenge, origin: 'https://other.example.invalid' }, new Date(now))).toBe(false)
        expect(await pilot.consumeChallenge({ ...challenge, browserHash: hashOwnedSessionToken(randomUUID()) }, new Date(now))).toBe(false)
        const result = await Promise.all([pilot.consumeChallenge(challenge, new Date(now)), pilot.consumeChallenge(challenge, new Date(now))])
        expect(result.filter(Boolean)).toHaveLength(1)
    })
    it('links only reviewed existing UUIDs and refuses conflicting or disabled bindings', async () => {
        const pilot = createIdentityPilotStore(sql)
        const identity = { projectId: 'skaleclub', subject: randomUUID(), provider: 'google.com' as const, providerSubject: 'offline-google-subject', authenticatedAt: authTime }
        expect(await pilot.linkExisting(identity, randomUUID(), 'legacy-session', new Date(now))).toBe(false)
        expect(await pilot.linkExisting(identity, binding.userId, 'legacy-session', new Date(now))).toBe(true)
        expect((await store.findBinding(identity.projectId, identity.subject))?.binding.userId).toBe(binding.userId)
        await sql`UPDATE public.xmail_identity_bindings SET disabled_at = now() WHERE project_id = ${identity.projectId} AND subject = ${identity.subject}`
        expect(await pilot.linkExisting(identity, binding.userId, 'owned-session', new Date(now))).toBe(false)
        const [user] = await sql`SELECT id, password_hash, is_admin FROM public.users WHERE id = ${binding.userId}`
        expect(user).toEqual({ id: binding.userId, password_hash: existingPasswordHash, is_admin: true })
    })
    it('preserves SQL bans and revokes sessions when the legacy administration changes account status', async () => {
        const pilot = createIdentityPilotStore(sql), engine = sessions(), issued = await engine.issue('offline-verified-token')
        await pilot.setDisabled(binding.userId, true, new Date(now))
        expect(await pilot.profile(binding.userId)).toBeNull()
        expect(await engine.authenticate(issued.token)).toBeNull()
        await pilot.setDisabled(binding.userId, false, new Date(now + 1000))
        expect((await pilot.profile(binding.userId))?.isAdmin).toBe(true)
        expect(await engine.authenticate(issued.token)).toBeNull()
        const [count] = await sql`SELECT count(*)::int AS count FROM public.xmail_identity_user_controls`
        await pilot.setDisabled(randomUUID(), false, new Date(now))
        expect((await sql`SELECT count(*)::int AS count FROM public.xmail_identity_user_controls`)[0].count).toBe(count.count)
    })
    it('serializes competing independently proved users so an immutable provider UID has one owner', async () => {
        const pilot = createIdentityPilotStore(sql), otherUser = randomUUID()
        await sql`INSERT INTO public.users (id, email) VALUES (${otherUser}, ${`${randomUUID()}@example.invalid`})`
        await sql`INSERT INTO public.xmail_identity_user_controls (user_id, review_source) VALUES (${otherUser}, 'reviewed-offline-fixture')`
        const identity = { projectId: 'skaleclub', subject: randomUUID(), provider: 'google.com' as const, providerSubject: 'offline-google-subject', authenticatedAt: authTime }
        const results = await Promise.all([pilot.linkExisting(identity, binding.userId, 'legacy-session', new Date(now)), pilot.linkExisting(identity, otherUser, 'legacy-session', new Date(now))])
        expect(results.filter(Boolean)).toHaveLength(1)
        const winner = results[0] ? binding.userId : otherUser
        expect((await store.findBinding(identity.projectId, identity.subject))?.binding.userId).toBe(winner)
        expect(await pilot.linkExisting(identity, winner === otherUser ? binding.userId : otherUser, 'owned-session', new Date(now))).toBe(false)
    })
    it('links previous-password proof by exact UUID without changing native hash/admin role or issuing a session', async () => {
        const pilot = createIdentityPilotStore(sql)
        let identity = { projectId: 'skaleclub', subject: randomUUID(), provider: 'phone' as const, providerSubject: '+12025550123', authenticatedAt: authTime }
        const linker = createExistingAccountLinker({ verify: async () => identity, status: async () => ({ disabled: false, validSince: 0 }),
            passwordProof: async () => ({ id: binding.userId }), sessions: { authenticate: async () => null }, store: pilot, clock: () => now })
        await linker('fresh-phone-proof', { email: 'different-form@example.invalid', password: randomUUID() })
        expect((await sql`SELECT proof_reference FROM public.xmail_identity_bindings WHERE subject=${identity.subject}`)[0].proof_reference).toBe(`legacy-password:${binding.userId}`)
        expect((await sql`SELECT id,password_hash,is_admin FROM public.users WHERE id=${binding.userId}`)[0])
            .toEqual({ id: binding.userId, password_hash: existingPasswordHash, is_admin: true })
        expect(Number((await sql`SELECT count(*) AS n FROM public.xmail_identity_owned_sessions`)[0].n)).toBe(0)
        // Evaluate the actual deployment consumer's changed proof predicate
        // against PostgreSQL, rather than imitating it with a mocked boolean.
        const policy = readFileSync(resolve('.github/scripts/deploy-xmail.sh'), 'utf8')
        const proofPredicate = /AND (b\.proof_reference IN \([^\n]+\))/.exec(policy)?.[1]
        expect(proofPredicate).toBeTruthy()
        const admitted = async () => (await sql.unsafe(`SELECT (${proofPredicate}) AS admitted FROM public.users u
            JOIN public.xmail_identity_bindings b ON b.user_id=u.id WHERE b.subject=$1`, [identity.subject]))[0].admitted
        expect(await admitted()).toBe(true)
        for (const invalid of [`legacy-password:${randomUUID()}`, `owned-session:${binding.userId}`, binding.userId]) {
            await sql`UPDATE public.xmail_identity_bindings SET proof_reference=${invalid} WHERE subject=${identity.subject}`
            expect(await admitted()).toBe(false)
        }
        await sql`UPDATE public.xmail_identity_bindings SET proof_reference=${`legacy-session:${binding.userId}`} WHERE subject=${identity.subject}`
        expect(await admitted()).toBe(true)
        identity = { ...identity, subject: randomUUID() }
        await sql`UPDATE public.xmail_identity_user_controls SET sessions_valid_after=to_timestamp(${authTime + 60}) WHERE user_id=${binding.userId}`
        await expect(linker('fresh-phone-proof', { email: 'different-form@example.invalid', password: randomUUID() })).rejects.toThrow()
        expect((await sql`SELECT subject FROM public.xmail_identity_bindings WHERE subject=${identity.subject}`)).toHaveLength(0)
    })
    it('evaluates the actual deployment temporal legacy-anchor chain and refuses broken ownership', async () => {
        const childId = randomUUID(), otherUser = randomUUID(), parentHash = 'a'.repeat(64), childHash = 'b'.repeat(64)
        await sql`INSERT INTO public.users(id,email) VALUES (${otherUser},${`${randomUUID()}@example.invalid`})`
        const facts = { adminUserId: binding.userId, bindingId: childId, sessionHash: childHash,
            legacyAnchorBindingId: binding.id, legacyAnchorSessionHash: parentHash }
        const query = acceptanceQuery(facts)
        const admitted = async () => (await sql.unsafe(query))[0].exists
        await sql`UPDATE public.xmail_identity_bindings SET proof_reference=${`legacy-password:${binding.userId}`}, created_at=now()-interval '60 seconds' WHERE id=${binding.id}`
        await sql`INSERT INTO public.xmail_identity_bindings(id,project_id,subject,user_id,proof_reference,created_at)
            VALUES (${childId},'skaleclub','offline-phone-child',${binding.userId},${`owned-session:${binding.userId}`},now()-interval '20 seconds')`
        await sql`INSERT INTO public.xmail_identity_owned_sessions(token_hash,binding_id,authenticated_at,created_at,expires_at,revoked_at)
            VALUES (${parentHash},${binding.id},extract(epoch FROM now()-interval '50 seconds')::bigint,now()-interval '45 seconds',now()+interval '1 hour',now()-interval '19 seconds'),
                (${childHash},${childId},extract(epoch FROM now()-interval '20 seconds')::bigint,now()-interval '19 seconds',now()+interval '1 hour',NULL)`
        expect(await admitted()).toBe(true)
        // Each mutation is rolled back to test the exact same valid API-shaped chain.
        for (const invalid of [
            `UPDATE public.xmail_identity_owned_sessions SET revoked_at=now()-interval '21 seconds' WHERE token_hash='${parentHash}'`,
            `UPDATE public.xmail_identity_owned_sessions SET revoked_at=NULL WHERE token_hash='${parentHash}'`,
            `UPDATE public.xmail_identity_owned_sessions SET expires_at=now()-interval '21 seconds' WHERE token_hash='${parentHash}'`,
            `UPDATE public.xmail_identity_owned_sessions SET authenticated_at=extract(epoch FROM now()-interval '400 seconds')::bigint WHERE token_hash='${parentHash}'`,
            `UPDATE public.xmail_identity_owned_sessions SET revoked_at=now()+interval '11 seconds' WHERE token_hash='${parentHash}'`,
            `UPDATE public.xmail_identity_bindings SET project_id='otherproject' WHERE id='${binding.id}'`,
            `UPDATE public.xmail_identity_bindings SET user_id='${otherUser}' WHERE id='${binding.id}'`,
            `UPDATE public.xmail_identity_bindings SET proof_reference='legacy-password:${randomUUID()}' WHERE id='${binding.id}'`,
            `UPDATE public.xmail_identity_bindings SET proof_reference='owned-session:${randomUUID()}' WHERE id='${childId}'`,
            `UPDATE public.xmail_identity_bindings SET disabled_at=now() WHERE id='${binding.id}'`,
            `UPDATE public.xmail_identity_user_controls SET disabled_at=now()`,
            `UPDATE public.xmail_identity_user_controls SET sessions_valid_after=now()`,
            `UPDATE public.users SET is_admin=false`,
            `UPDATE public.xmail_identity_owned_sessions SET revoked_at=now() WHERE token_hash='${childHash}'`,
        ]) {
            await sql.begin(async tx => {
                await tx.unsafe(invalid)
                expect((await tx.unsafe(query))[0].exists).toBe(false)
                throw new Error('rollback-negative-fixture')
            }).catch(error => { if (error.message !== 'rollback-negative-fixture') throw error })
        }
        expect(await admitted()).toBe(true)
    })

    it('keeps original ownership freshness and current controls while reusing an active two-hour-old phone session', async () => {
        const child = randomUUID(), parentHash = 'c'.repeat(64), currentHash = 'd'.repeat(64)
        await sql`UPDATE public.xmail_identity_bindings SET proof_reference=${`legacy-password:${binding.userId}`}, created_at=now()-interval '1 day 60 seconds' WHERE id=${binding.id}`
        await sql`INSERT INTO public.xmail_identity_bindings(id,project_id,subject,user_id,proof_reference,created_at)
            VALUES (${child},'skaleclub','historical-phone-fixture',${binding.userId},${`owned-session:${binding.userId}`},now()-interval '1 day 20 seconds')`
        await sql`INSERT INTO public.xmail_identity_owned_sessions(token_hash,binding_id,authenticated_at,created_at,expires_at,revoked_at) VALUES
            (${parentHash},${binding.id},extract(epoch FROM now()-interval '1 day 50 seconds')::bigint,now()-interval '1 day 45 seconds',now()-interval '23 hours',now()-interval '1 day 19 seconds'),
            (${currentHash},${child},extract(epoch FROM now()-interval '2 hours')::bigint,now()-interval '119 minutes',now()+interval '1 hour',NULL)`
        const query = acceptanceQuery({ adminUserId: binding.userId, bindingId: child, sessionHash: currentHash,
            legacyAnchorBindingId: binding.id, legacyAnchorSessionHash: parentHash })
        expect((await sql.unsafe(query))[0].exists).toBe(true)
        for (const invalid of [
            `UPDATE public.xmail_identity_owned_sessions SET authenticated_at=extract(epoch FROM now()-interval '1 day 400 seconds')::bigint WHERE token_hash='${parentHash}'`,
            `UPDATE public.xmail_identity_owned_sessions SET expires_at=now()-interval '1 day 21 seconds' WHERE token_hash='${parentHash}'`,
            `UPDATE public.xmail_identity_owned_sessions SET revoked_at=now()-interval '1 day 21 seconds' WHERE token_hash='${parentHash}'`,
            `UPDATE public.xmail_identity_user_controls SET sessions_valid_after=now()-interval '12 hours'`,
            `UPDATE public.xmail_identity_owned_sessions SET expires_at=now()-interval '1 second' WHERE token_hash='${currentHash}'`,
            `UPDATE public.xmail_identity_owned_sessions SET revoked_at=now() WHERE token_hash='${currentHash}'`,
            `UPDATE public.xmail_identity_owned_sessions SET authenticated_at=0 WHERE token_hash='${currentHash}'`,
            `UPDATE public.xmail_identity_owned_sessions SET authenticated_at=extract(epoch FROM now()+interval '60 seconds')::bigint WHERE token_hash='${currentHash}'`,
        ]) {
            await sql.begin(async tx => {
                await tx.unsafe(invalid)
                expect((await tx.unsafe(query))[0].exists).toBe(false)
                throw new Error('rollback-historical-fixture')
            }).catch(error => { if (error.message !== 'rollback-historical-fixture') throw error })
        }
        expect((await sql.unsafe(query))[0].exists).toBe(true)
    })

})
