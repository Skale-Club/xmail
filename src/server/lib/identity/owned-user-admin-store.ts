import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { nullableSqlTimestampDate, sqlTimestampDate } from './sql-timestamp'
import { OwnedAdminError, type OwnedAdminPrincipal, type OwnedAdminStore } from './owned-user-admin'

type Transaction = Pick<Sql, 'unsafe'>
type NativeSettings = { host: string; smtpPort: number; imapPort: number; placeholder: string }
type UserRow = {
    id: string; email: string; firstName: string | null; lastName: string | null
    isAdmin: boolean; emailVerified: boolean; isActive: boolean; organizations: unknown[]
    createdAt: Date | string; lastLoginAt: Date | string | null
}

/** No ambient database, provider client, dotenv, retry or credential initialization. */
export function createOwnedUserAdminStore(sql: Sql, dependencies: {
    hashPassword: (password: string) => Promise<string>
    nativeSettings: () => NativeSettings
}): OwnedAdminStore {
    async function transaction<T>(principal: OwnedAdminPrincipal, target: string | undefined,
        body: (tx: Transaction, admin: boolean) => Promise<T>, requireAdmin = true): Promise<T> {
        if (!/^[a-f0-9]{64}$/.test(principal.sessionHash) || !Number.isSafeInteger(principal.authenticatedAt)) {
            throw new OwnedAdminError(401, 'Recent owned authentication is required.')
        }
        return sql.begin(async tx => {
            await tx.unsafe("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='8s'")
            const ids = [...new Set([principal.userId, ...(target ? [target] : [])])].sort()
            // Same control-first ordering as owned session issue/revoke. Lock both
            // actor and target before checking admission or changing native access.
            const controls = await tx.unsafe(`SELECT user_id FROM public.xmail_identity_user_controls
                WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE`, [ids])
            if (controls.length !== ids.length) throw new OwnedAdminError(409, 'A reviewed local user control is required.')
            await tx.unsafe('SELECT id FROM public.users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
            const actor = await tx.unsafe(`SELECT u.is_admin FROM public.users u
                JOIN public.xmail_identity_user_controls c ON c.user_id=u.id
                JOIN public.xmail_identity_bindings b ON b.user_id=u.id
                JOIN public.xmail_identity_owned_sessions s ON s.binding_id=b.id
                WHERE u.id=$1 AND s.token_hash=$2 AND s.authenticated_at=$3
                    AND c.disabled_at IS NULL AND b.disabled_at IS NULL AND s.revoked_at IS NULL
                    AND c.sessions_valid_after<=to_timestamp(s.authenticated_at)
                    AND s.expires_at>clock_timestamp() AND s.created_at<=clock_timestamp()+interval '5 seconds'
                    AND s.expires_at>s.created_at AND s.expires_at-s.created_at<=interval '12 hours'
                    AND to_timestamp(s.authenticated_at)<=s.created_at+interval '5 seconds'
                    AND to_timestamp(s.authenticated_at)>=clock_timestamp()-interval '5 minutes'
                    AND to_timestamp(s.authenticated_at)<=clock_timestamp()+interval '5 seconds'
                FOR SHARE OF b,s`, [principal.userId, principal.sessionHash, principal.authenticatedAt])
            if (actor.length !== 1) throw new OwnedAdminError(401, 'Recent owned authentication is required.')
            if (requireAdmin && actor[0].is_admin !== true) throw new OwnedAdminError(403, 'Platform admin access is required.')
            return body(tx, actor[0].is_admin === true)
        }) as Promise<T>
    }
    async function readUsers(tx: Transaction, id?: string) {
        // Explicit projection: no password hashes, 2FA secrets, provider subjects,
        // session tokens or encrypted mailbox credentials may leave this store.
        const rows = await tx.unsafe<UserRow[]>(`SELECT u.id,u.email,u.first_name AS "firstName",u.last_name AS "lastName",
            u.is_admin AS "isAdmin",u.email_verified AS "emailVerified",u.created_at AS "createdAt",u.last_login_at AS "lastLoginAt",
            (c.disabled_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.mailboxes m
                WHERE m.user_id=u.id AND m.is_native AND NOT m.is_active)) AS "isActive",
            coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'slug',o.slug,'role',ou.role) ORDER BY o.id)
                FROM public.organization_users ou JOIN public.organizations o ON o.id=ou.organization_id WHERE ou.user_id=u.id),'[]'::jsonb) AS organizations
            FROM public.users u JOIN public.xmail_identity_user_controls c ON c.user_id=u.id
            WHERE ($1::uuid IS NULL OR u.id=$1::uuid) ORDER BY u.created_at DESC,u.id LIMIT 2001`, [id ?? null])
        return rows.map(row => ({ ...row, createdAt: sqlTimestampDate(row.createdAt), lastLoginAt: nullableSqlTimestampDate(row.lastLoginAt) }))
    }
    async function readUser(tx: Transaction, id: string) {
        const rows = await readUsers(tx, id)
        if (rows.length !== 1) throw new OwnedAdminError(404, 'User not found.')
        return rows[0]
    }
    async function revoke(tx: Transaction, id: string) {
        await tx.unsafe(`UPDATE public.xmail_identity_user_controls SET sessions_valid_after=greatest(sessions_valid_after,clock_timestamp()) WHERE user_id=$1`, [id])
        await tx.unsafe(`UPDATE public.xmail_identity_owned_sessions s SET revoked_at=coalesce(s.revoked_at,clock_timestamp())
            FROM public.xmail_identity_bindings b WHERE b.id=s.binding_id AND b.user_id=$1`, [id])
    }
    async function nativeMailbox(tx: Transaction, id: string, email: string, settings: NativeSettings) {
        // Matches native-mail.ts's canonical mailbox/folder contract, in the SAME
        // transaction as user/control/hash creation, so partial provisioning rolls back.
        await tx.unsafe(`INSERT INTO public.mailboxes(user_id,email,smtp_host,smtp_port,smtp_username,smtp_password_encrypted,smtp_secure,
            imap_host,imap_port,imap_username,imap_password_encrypted,imap_secure,is_default,is_native,is_active)
            SELECT $1,$2,$3,$4,$2,$5,false,$3,$6,$2,$5,false,true,true,c.disabled_at IS NULL
            FROM public.xmail_identity_user_controls c WHERE c.user_id=$1 ON CONFLICT DO NOTHING`,
        [id, email, settings.host, settings.smtpPort, settings.placeholder, settings.imapPort])
        const rows = await tx.unsafe('SELECT id FROM public.mailboxes WHERE user_id=$1 AND email=$2 AND is_native FOR UPDATE', [id, email])
        if (rows.length !== 1) throw new OwnedAdminError(409, 'Native mailbox provisioning is ambiguous.')
        for (const [remote, name, type] of [['INBOX','Inbox','inbox'],['Sent','Sent','sent'],['Drafts','Drafts','drafts'],['Archive','Archive','archive'],['Trash','Trash','trash'],['Spam','Spam','spam']]) {
            await tx.unsafe(`INSERT INTO public.mail_folders(mailbox_id,remote_id,name,type,uid_validity)
                VALUES($1,$2,$3,$4,floor(extract(epoch FROM clock_timestamp()))::integer) ON CONFLICT DO NOTHING`, [rows[0].id, remote, name, type])
        }
    }
    return {
        list(principal) {
            return transaction(principal, undefined, async tx => {
                const rows = await readUsers(tx)
                if (rows.length > 2000) throw new OwnedAdminError(409, 'User administration requires pagination before listing this account set.')
                return rows
            })
        },
        async create(principal, input) {
            if (input.sendInvite || (!input.isAdmin && !input.password)) throw new OwnedAdminError(409, 'Explicit native provisioning is required; no invitation was sent.')
            const id = randomUUID()
            const passwordHash = !input.isAdmin && input.password ? await dependencies.hashPassword(input.password) : null
            const native = passwordHash ? dependencies.nativeSettings() : null
            return transaction(principal, undefined, async tx => {
                if (input.organizationId) {
                    const org = await tx.unsafe('SELECT id FROM public.organizations WHERE id=$1 FOR SHARE', [input.organizationId])
                    if (org.length !== 1) throw new OwnedAdminError(404, 'Organization not found.')
                }
                if (!input.isAdmin) {
                    if (!input.organizationId) throw new OwnedAdminError(400, 'A verified organization domain is required for a native mailbox.')
                    const domains = await tx.unsafe(`SELECT id FROM public.domains WHERE organization_id=$1 AND name=$2
                        AND verification_status='verified' FOR SHARE`, [input.organizationId, input.email.split('@')[1]])
                    if (!domains.length) throw new OwnedAdminError(400, 'The mailbox domain must be verified for this organization.')
                }
                await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,7))', [input.email])
                if ((await tx.unsafe('SELECT id FROM public.users WHERE lower(email)=$1', [input.email])).length) {
                    throw new OwnedAdminError(409, 'A local user with this email already exists; no identity link was made.')
                }
                const inserted = await tx.unsafe(`INSERT INTO public.users(id,email,first_name,last_name,is_admin,email_verified,password_hash)
                    VALUES($1,$2,$3,$4,$5,false,$6) ON CONFLICT(email) DO NOTHING RETURNING id`,
                [id,input.email,input.firstName ?? null,input.lastName ?? null,input.isAdmin,passwordHash])
                if (inserted.length !== 1) throw new OwnedAdminError(409, 'A local user with this email already exists; no identity link was made.')
                await tx.unsafe(`INSERT INTO public.xmail_identity_user_controls(user_id,review_source,sessions_valid_after)
                    VALUES($1,$2,clock_timestamp())`, [id, `owned-admin-created:${principal.userId}`])
                if (input.organizationId) await tx.unsafe(`INSERT INTO public.organization_users(organization_id,user_id,role) VALUES($1,$2,$3)`, [input.organizationId,id,input.organizationRole])
                if (native) await nativeMailbox(tx, id, input.email, native)
                return readUser(tx, id)
            })
        },
        update(principal, id, input) {
            return transaction(principal, id, async tx => {
                const target = await readUser(tx, id)
                if (id === principal.userId && input.isAdmin === false) throw new OwnedAdminError(400, 'Cannot remove your own platform admin access.')
                await tx.unsafe(`UPDATE public.users SET first_name=CASE WHEN $2 THEN $3 ELSE first_name END,
                    last_name=CASE WHEN $4 THEN $5 ELSE last_name END,is_admin=CASE WHEN $6 THEN $7 ELSE is_admin END,
                    email_verified=CASE WHEN $8 THEN $9 ELSE email_verified END,updated_at=clock_timestamp() WHERE id=$1`,
                [id,input.firstName !== undefined,input.firstName ?? null,input.lastName !== undefined,input.lastName ?? null,
                    input.isAdmin !== undefined,input.isAdmin ?? false,input.emailVerified !== undefined,input.emailVerified ?? false])
                if (input.isAdmin !== undefined && input.isAdmin !== target.isAdmin) await revoke(tx, id)
                return readUser(tx, id)
            })
        },
        setActive(principal, id, active) {
            return transaction(principal, id, async tx => {
                const target = await readUser(tx, id)
                if (!active && id === principal.userId) throw new OwnedAdminError(400, 'Cannot deactivate yourself.')
                if (!active && target.isAdmin === true) throw new OwnedAdminError(400, 'Remove platform admin access before deactivating this user.')
                await tx.unsafe(`UPDATE public.xmail_identity_user_controls SET disabled_at=CASE WHEN $2 THEN NULL ELSE clock_timestamp() END WHERE user_id=$1`, [id,active])
                await revoke(tx, id)
                await tx.unsafe('UPDATE public.mailboxes SET is_active=$2,updated_at=clock_timestamp() WHERE user_id=$1 AND is_native', [id,active])
                return readUser(tx, id)
            })
        },
        async resetNativePassword(principal, id, password) {
            await transaction(principal, id, async (tx, admin) => {
                const target = await readUser(tx, id)
                if (!admin) {
                    if (target.isAdmin === true) throw new OwnedAdminError(403, 'Platform admin access is required to reset this account.')
                    const memberships = await tx.unsafe(`SELECT id,user_id,organization_id,role FROM public.organization_users
                        WHERE user_id=ANY($1::uuid[]) ORDER BY id FOR SHARE`, [[principal.userId,id]])
                    const managed = new Set(memberships.filter(row => row.user_id === principal.userId && row.role === 'admin').map(row => row.organization_id))
                    if (!memberships.some(row => row.user_id === id && managed.has(row.organization_id))) throw new OwnedAdminError(403, 'Organization admin access is required.')
                }
                // The legacy admin reset never provisioned native credentials for
                // platform admins. A browser reset must not silently become SMTP.
                if (target.isAdmin === true) throw new OwnedAdminError(409, 'Native password reset is unavailable for platform administrators. Browser identity is unchanged.')
                const passwordHash = await dependencies.hashPassword(password)
                const settings = dependencies.nativeSettings()
                // Explicit reset changes only the existing local native credential.
                // Browser Google credentials and provider bindings remain untouched.
                await tx.unsafe('UPDATE public.users SET password_hash=$2,updated_at=clock_timestamp() WHERE id=$1', [id,passwordHash])
                await nativeMailbox(tx, id, target.email, settings)
                await revoke(tx, id)
            }, false)
        },
    }
}
