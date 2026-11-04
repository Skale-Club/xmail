import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createOwnedUserAdminStore } from './owned-user-admin-store'
import type { OwnedAdminPrincipal, OwnedAdminStore } from './owned-user-admin'
import { readOwnedStreamLease } from './owned-stream-access'

// Never loads dotenv, the application database module or a provider SDK. Only
// the declared loopback CI service can create this dedicated disposable DB.
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
    } catch { /* Connection details are never included in errors. */ }
    if (!valid) throw new Error('Owned administration tests require the isolated loopback CI database and sentinel.')
}

describe.skipIf(!databaseUrl)('owned user administration PostgreSQL atomicity (dedicated disposable CI DB)', () => {
    let admin: Sql, sql: Sql, store: OwnedAdminStore, created = false
    let principal: OwnedAdminPrincipal, target: string, organization: string, targetBinding: string
    const nativeHash = 'existing-native-hash-fixture'
    beforeAll(async () => {
        admin = postgres(databaseUrl!, { max: 1, prepare: false, onnotice: () => {} })
        if ((await admin`SELECT 1 FROM pg_database WHERE datname='xmail_owned_admin_test'`).length) {
            throw new Error('Refusing to reuse an existing owned administration test database.')
        }
        await admin.unsafe('CREATE DATABASE xmail_owned_admin_test')
        created = true
        const targetUrl = new URL(databaseUrl!); targetUrl.pathname = '/xmail_owned_admin_test'
        sql = postgres(targetUrl.toString(), { max: 4, prepare: false, onnotice: () => {} })
        // Production initializes Drizzle on this SAME raw client before identity stores.
        drizzle(sql)
        await sql.unsafe(`
            CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text NOT NULL UNIQUE,
                first_name text,last_name text,password_hash text,is_admin boolean NOT NULL DEFAULT false,
                email_verified boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),last_login_at timestamptz);
            CREATE TYPE user_role AS ENUM('admin','member','viewer');
            CREATE TABLE public.organizations(id uuid PRIMARY KEY,name text NOT NULL,slug text NOT NULL);
            CREATE TABLE public.organization_users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id uuid NOT NULL REFERENCES public.organizations(id),user_id uuid NOT NULL REFERENCES public.users(id),
                role user_role NOT NULL,UNIQUE(organization_id,user_id));
            CREATE TABLE public.domains(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
                name text NOT NULL,verification_status text NOT NULL);
            CREATE TABLE public.mailboxes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES public.users(id),
                email text NOT NULL,smtp_host text NOT NULL,smtp_port integer NOT NULL,smtp_username text NOT NULL,
                smtp_password_encrypted text NOT NULL,smtp_secure boolean NOT NULL,imap_host text NOT NULL,imap_port integer NOT NULL,
                imap_username text NOT NULL,imap_password_encrypted text NOT NULL,imap_secure boolean NOT NULL,
                is_default boolean NOT NULL DEFAULT false,is_native boolean NOT NULL DEFAULT false,is_active boolean NOT NULL DEFAULT true,
                updated_at timestamptz NOT NULL DEFAULT now());
            CREATE UNIQUE INDEX mailboxes_native_email_unique ON public.mailboxes(lower(email)) WHERE is_native;
            CREATE TABLE public.mail_folders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),mailbox_id uuid NOT NULL REFERENCES public.mailboxes(id),
                remote_id text NOT NULL,name text NOT NULL,type text NOT NULL,uid_validity integer NOT NULL,UNIQUE(mailbox_id,remote_id));
        `)
        await sql.unsafe(readFileSync(resolve('supabase/migrations/079_owned_identity_foundation.sql'), 'utf8'))
        store = createOwnedUserAdminStore(sql, {
            hashPassword: async password => `test-only-hashed:${password}`,
            nativeSettings: () => ({ host: 'localhost', smtpPort: 2587, imapPort: 2993, placeholder: 'test-only-encrypted-placeholder' }),
        })
    })
    afterAll(async () => {
        await sql?.end({ timeout: 1 })
        // Only the exact database successfully created by this test may be removed.
        if (created) await admin.unsafe('DROP DATABASE xmail_owned_admin_test WITH (FORCE)')
        await admin?.end({ timeout: 1 })
    })
    beforeEach(async () => {
        await sql`TRUNCATE public.users,public.organizations CASCADE`
        principal = { userId: randomUUID(), sessionHash: 'a'.repeat(64), authenticatedAt: Math.floor(Date.now() / 1000) - 2 }
        target = randomUUID(); organization = randomUUID(); targetBinding = randomUUID()
        await sql`INSERT INTO public.users(id,email,is_admin,password_hash) VALUES
            (${principal.userId},'admin@example.invalid',true,'unchanged-admin-hash'),(${target},'member@example.invalid',false,${nativeHash})`
        await sql`INSERT INTO public.xmail_identity_user_controls(user_id,review_source) VALUES
            (${principal.userId},'reviewed-fixture'),(${target},'reviewed-fixture')`
        const actorBinding = randomUUID()
        await sql`INSERT INTO public.xmail_identity_bindings(id,project_id,subject,user_id,proof_reference) VALUES
            (${actorBinding},'skaleclub','actor-fixture',${principal.userId},'independent-fixture'),
            (${targetBinding},'skaleclub','target-fixture',${target},'independent-fixture')`
        await sql`INSERT INTO public.xmail_identity_owned_sessions(token_hash,binding_id,authenticated_at,created_at,expires_at) VALUES
            (${principal.sessionHash},${actorBinding},${principal.authenticatedAt},clock_timestamp(),clock_timestamp()+interval '1 hour'),
            (${'b'.repeat(64)},${targetBinding},${principal.authenticatedAt},clock_timestamp(),clock_timestamp()+interval '1 hour')`
        await sql`INSERT INTO public.organizations(id,name,slug) VALUES(${organization},'Fixture organization','fixture')`
        await sql`INSERT INTO public.organization_users(organization_id,user_id,role) VALUES(${organization},${target},'member')`
        await sql`INSERT INTO public.domains(organization_id,name,verification_status) VALUES(${organization},'example.invalid','verified')`
    })
    it('creates one local UUID/control/membership/native mailbox and six folders without provider bindings', async () => {
        const result = await store.create(principal, { email: 'created@example.invalid', password: 'native-test-password', isAdmin: false,
            sendInvite: false, organizationId: organization, organizationRole: 'viewer' }) as { id: string; emailVerified: boolean }
        expect(result.id).not.toBe(target); expect(result.emailVerified).toBe(false)
        expect((await sql`SELECT review_source FROM public.xmail_identity_user_controls WHERE user_id=${result.id}`)[0].review_source).toBe(`owned-admin-created:${principal.userId}`)
        expect((await sql`SELECT role FROM public.organization_users WHERE user_id=${result.id}`)[0].role).toBe('viewer')
        expect((await sql`SELECT count(*)::int AS n FROM public.mail_folders f JOIN public.mailboxes m ON m.id=f.mailbox_id WHERE m.user_id=${result.id}`)[0].n).toBe(6)
        expect((await sql`SELECT count(*)::int AS n FROM public.xmail_identity_bindings WHERE user_id=${result.id}`)[0].n).toBe(0)
        expect((await sql`SELECT password_hash FROM public.users WHERE id=${target}`)[0].password_hash).toBe(nativeHash)
    })
    it('rolls back the complete creation when native folder provisioning fails', async () => {
        await sql`ALTER TABLE public.mail_folders ADD CONSTRAINT reject_spam_fixture CHECK(remote_id<>'Spam')`
        try {
            await expect(store.create(principal, { email: 'rollback@example.invalid', password: 'native-test-password', isAdmin: false,
                sendInvite: false, organizationId: organization, organizationRole: 'member' })).rejects.toThrow()
        } finally { await sql`ALTER TABLE public.mail_folders DROP CONSTRAINT reject_spam_fixture` }
        expect((await sql`SELECT count(*)::int AS n FROM public.users`)[0].n).toBe(2)
        expect((await sql`SELECT count(*)::int AS n FROM public.xmail_identity_user_controls`)[0].n).toBe(2)
        expect((await sql`SELECT count(*)::int AS n FROM public.mailboxes`)[0].n).toBe(0)
    })
    it('refuses a matching contact instead of attaching a provider identity or altering the existing user', async () => {
        await expect(store.create(principal, { email: 'member@example.invalid', password: 'different-password', isAdmin: false,
            sendInvite: false, organizationId: organization, organizationRole: 'admin' })).rejects.toMatchObject({ status: 409 })
        expect((await sql`SELECT password_hash FROM public.users WHERE id=${target}`)[0].password_hash).toBe(nativeHash)
        expect((await sql`SELECT role FROM public.organization_users WHERE user_id=${target}`)[0].role).toBe('member')
    })
    it('checks verified domain ownership and existing reviewed target controls', async () => {
        await expect(store.create(principal, { email: 'wrong@other.invalid', password: 'native-password', isAdmin: false,
            sendInvite: false, organizationId: organization, organizationRole: 'member' })).rejects.toMatchObject({ status: 400 })
        await sql`DELETE FROM public.xmail_identity_user_controls WHERE user_id=${target}`
        await expect(store.setActive(principal, target, false)).rejects.toMatchObject({ status: 409 })
        expect((await sql`SELECT count(*)::int AS n FROM public.xmail_identity_user_controls WHERE user_id=${target}`)[0].n).toBe(0)
    })
    it('atomically disables/revokes owned and native admission, preserving hashes, IDs and memberships', async () => {
        await store.resetNativePassword(principal, target, 'initial-native-test-password')
        const hash = (await sql`SELECT password_hash FROM public.users WHERE id=${target}`)[0].password_hash
        await store.setActive(principal, target, false)
        expect((await sql`SELECT disabled_at FROM public.xmail_identity_user_controls WHERE user_id=${target}`)[0].disabled_at).not.toBeNull()
        expect((await sql`SELECT revoked_at FROM public.xmail_identity_owned_sessions WHERE binding_id=${targetBinding}`)[0].revoked_at).not.toBeNull()
        expect((await sql`SELECT is_active FROM public.mailboxes WHERE user_id=${target}`)[0].is_active).toBe(false)
        await store.setActive(principal, target, true)
        expect((await sql`SELECT is_active FROM public.mailboxes WHERE user_id=${target}`)[0].is_active).toBe(true)
        expect((await sql`SELECT revoked_at FROM public.xmail_identity_owned_sessions WHERE binding_id=${targetBinding}`)[0].revoked_at).not.toBeNull()
        expect((await sql`SELECT password_hash FROM public.users WHERE id=${target}`)[0].password_hash).toBe(hash)
        expect((await sql`SELECT role FROM public.organization_users WHERE user_id=${target}`)[0].role).toBe('member')
    })
    it('does not enable a missing native mailbox when explicitly resetting a disabled user', async () => {
        await store.setActive(principal, target, false)
        await store.resetNativePassword(principal, target, 'explicit-native-password')
        expect((await sql`SELECT is_active FROM public.mailboxes WHERE user_id=${target}`)[0].is_active).toBe(false)
        expect((await sql`SELECT password_hash FROM public.users WHERE id=${target}`)[0].password_hash).toBe('test-only-hashed:explicit-native-password')
    })
    it('rejects revoked or stale sessions and a demoted actor inside the mutation transaction', async () => {
        await sql`UPDATE public.xmail_identity_owned_sessions SET revoked_at=now() WHERE token_hash=${principal.sessionHash}`
        await expect(store.update(principal, target, { firstName: 'Unauthorized' })).rejects.toMatchObject({ status: 401 })
        await sql`UPDATE public.xmail_identity_owned_sessions SET revoked_at=NULL WHERE token_hash=${principal.sessionHash}`
        const stale = principal.authenticatedAt - 301
        await sql`UPDATE public.xmail_identity_owned_sessions SET authenticated_at=${stale} WHERE token_hash=${principal.sessionHash}`
        await expect(store.update({ ...principal, authenticatedAt: stale }, target, { firstName: 'Unauthorized' })).rejects.toMatchObject({ status: 401 })
        await sql`UPDATE public.xmail_identity_owned_sessions SET authenticated_at=${principal.authenticatedAt} WHERE token_hash=${principal.sessionHash}`
        await sql`UPDATE public.users SET is_admin=false WHERE id=${principal.userId}`
        await expect(store.setActive(principal, target, false)).rejects.toMatchObject({ status: 403 })
        expect((await sql`SELECT first_name FROM public.users WHERE id=${target}`)[0].first_name).toBeNull()
        expect((await sql`SELECT disabled_at FROM public.xmail_identity_user_controls WHERE user_id=${target}`)[0].disabled_at).toBeNull()
    })
    it('honors a concurrent actor demotion committed while authorization waits for the user lock', async () => {
        let operation: Promise<unknown> | undefined
        await sql.begin(async tx => {
            await tx.unsafe('UPDATE public.users SET is_admin=false WHERE id=$1', [principal.userId])
            operation = store.update(principal, target, { firstName: 'Forbidden' })
            // Attach a rejection handler immediately; the actual result is asserted below.
            void operation.catch(() => {})
            let waiting = false
            const deadline = Date.now() + 1500
            while (!waiting && Date.now() < deadline) {
                waiting = (await sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                    AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM public.users%'`).length === 1
                if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
            }
            expect(waiting).toBe(true)
        })
        await expect(operation).rejects.toMatchObject({ status: 403 })
        expect((await sql`SELECT first_name FROM public.users WHERE id=${target}`)[0].first_name).toBeNull()
    })
    it('allows native password reset only within an exact shared organization admin membership', async () => {
        await sql`UPDATE public.users SET is_admin=false WHERE id=${principal.userId}`
        await expect(store.resetNativePassword(principal, target, 'denied-password')).rejects.toMatchObject({ status: 403 })
        await sql`INSERT INTO public.organization_users(organization_id,user_id,role) VALUES(${organization},${principal.userId},'viewer')`
        await expect(store.resetNativePassword(principal, target, 'denied-password')).rejects.toMatchObject({ status: 403 })
        await sql`UPDATE public.organization_users SET role='admin' WHERE user_id=${principal.userId}`
        await store.resetNativePassword(principal, target, 'allowed-password')
        expect((await sql`SELECT password_hash FROM public.users WHERE id=${target}`)[0].password_hash).toBe('test-only-hashed:allowed-password')
        expect((await sql`SELECT subject FROM public.xmail_identity_bindings WHERE user_id=${target}`)[0].subject).toBe('target-fixture')
    })
    it('never creates native credentials for a platform admin on an unverified external domain', async () => {
        await sql`UPDATE public.users SET is_admin=true,email='admin@unverified.invalid' WHERE id=${target}`
        await expect(store.resetNativePassword(principal, target, 'must-not-be-applied')).rejects.toMatchObject({ status: 409 })
        expect((await sql`SELECT password_hash FROM public.users WHERE id=${target}`)[0].password_hash).toBe(nativeHash)
        expect((await sql`SELECT count(*)::int AS n FROM public.mailboxes WHERE user_id=${target}`)[0].n).toBe(0)
        expect((await sql`SELECT revoked_at FROM public.xmail_identity_owned_sessions WHERE binding_id=${targetBinding}`)[0].revoked_at).toBeNull()
    })
    it('projects safe profile fields and prevents self-disable/self-demotion', async () => {
        const listed = await store.list(principal)
        expect(JSON.stringify(listed)).not.toMatch(/password_hash|passwordHash|sessionHash|token_hash|actor-fixture/)
        await expect(store.setActive(principal, principal.userId, false)).rejects.toMatchObject({ status: 400 })
        await expect(store.update(principal, principal.userId, { isAdmin: false })).rejects.toMatchObject({ status: 400 })
    })
    it('authorizes mailbox streams from one fresh session/control/ownership snapshot', async () => {
        await store.resetNativePassword(principal, target, 'native-stream-fixture')
        const mailbox = (await sql`SELECT id FROM public.mailboxes WHERE user_id=${target}`)[0].id
        const resource = { kind: 'mailbox' as const, id: mailbox }
        const lease = () => readOwnedStreamLease(sql, principal, resource, 'skaleclub', new AbortController().signal)
        expect(await lease()).toMatchObject({ expiresAt: expect.any(Number) })
        await sql`UPDATE public.users SET is_admin=false WHERE id=${principal.userId}`
        expect(await lease()).toBeNull()
        await sql`UPDATE public.mailboxes SET user_id=${principal.userId},email='admin@example.invalid' WHERE id=${mailbox}`
        expect(await lease()).not.toBeNull()
        await sql`UPDATE public.mailboxes SET email='different@example.invalid' WHERE id=${mailbox}`
        expect(await lease()).toBeNull()
        await sql`UPDATE public.mailboxes SET email='admin@example.invalid' WHERE id=${mailbox}`
        await sql`UPDATE public.xmail_identity_user_controls SET disabled_at=clock_timestamp() WHERE user_id=${principal.userId}`
        expect(await lease()).toBeNull()
    })
    it('revokes organization stream leases on membership, session, project, cutoff or expiry changes', async () => {
        const resource = { kind: 'organization' as const, id: organization }
        const lease = (project = 'skaleclub') => readOwnedStreamLease(sql, principal, resource, project, new AbortController().signal)
        expect(await lease()).not.toBeNull()
        await sql`UPDATE public.users SET is_admin=false WHERE id=${principal.userId}`
        expect(await lease()).toBeNull()
        await sql`INSERT INTO public.organization_users(organization_id,user_id,role) VALUES(${organization},${principal.userId},'viewer')`
        expect(await lease()).not.toBeNull()
        expect(await lease('different-project')).toBeNull()
        await sql`UPDATE public.xmail_identity_owned_sessions SET revoked_at=now() WHERE token_hash=${principal.sessionHash}`
        expect(await lease()).toBeNull()
        await sql`UPDATE public.xmail_identity_owned_sessions SET revoked_at=NULL WHERE token_hash=${principal.sessionHash}`
        await sql`UPDATE public.xmail_identity_user_controls SET sessions_valid_after=clock_timestamp() WHERE user_id=${principal.userId}`
        expect(await lease()).toBeNull()
        await sql`UPDATE public.xmail_identity_user_controls SET sessions_valid_after='epoch'::timestamptz WHERE user_id=${principal.userId}`
        await sql`UPDATE public.xmail_identity_owned_sessions SET created_at=to_timestamp(authenticated_at),
            expires_at=to_timestamp(authenticated_at)+interval '1 second' WHERE token_hash=${principal.sessionHash}`
        expect(await lease()).toBeNull()
    })
})
