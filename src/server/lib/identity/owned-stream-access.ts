import type { Sql } from 'postgres'
import type { Request, Response } from 'express'
import type { OwnedAdminPrincipal } from './owned-user-admin'
import { getIdentityRuntime, type IdentityRuntime } from './runtime'
import { browserAuthAuthority } from './browser-auth-authority'
import { ownedIdentityEnabled } from './owned-session'
import { identityCookie, trustedIdentityRequest } from './http-security'

export type OwnedStreamTarget = { kind: 'mailbox' | 'organization'; id: string }
export type OwnedStreamLease = { expiresAt: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One final SQL snapshot joins BOTH current local session admission and target
 * authorization. No SQL connection is held while the provider is checked. */
export async function readOwnedStreamLease(sql: Sql, expected: OwnedAdminPrincipal, target: OwnedStreamTarget,
    projectId: string, signal: AbortSignal): Promise<OwnedStreamLease | null> {
    if (!uuid.test(expected.userId) || !uuid.test(target.id) || !/^[a-f0-9]{64}$/.test(expected.sessionHash)
        || !Number.isSafeInteger(expected.authenticatedAt) || expected.authenticatedAt <= 0
        || !['mailbox', 'organization'].includes(target.kind)) return null
    const resource = target.kind === 'mailbox'
        ? `JOIN public.mailboxes resource ON resource.id=$5
            WHERE (u.is_admin OR (resource.user_id=u.id AND (NOT resource.is_native OR lower(resource.email)=lower(u.email))))`
        : `JOIN public.organizations resource ON resource.id=$5
            WHERE (u.is_admin OR EXISTS(SELECT 1 FROM public.organization_users ou WHERE ou.organization_id=resource.id AND ou.user_id=u.id))`
    signal.throwIfAborted()
    const pending = sql.unsafe<{ expiresAt: Date }[]>(`SELECT s.expires_at AS "expiresAt"
        FROM public.xmail_identity_owned_sessions s
        JOIN public.xmail_identity_bindings b ON b.id=s.binding_id
        JOIN public.users u ON u.id=b.user_id
        JOIN public.xmail_identity_user_controls c ON c.user_id=u.id
        ${resource}
        AND u.id=$1 AND s.token_hash=$2 AND s.authenticated_at=$3 AND b.project_id=$4
        AND c.disabled_at IS NULL AND b.disabled_at IS NULL AND s.revoked_at IS NULL
        AND c.sessions_valid_after<=to_timestamp(s.authenticated_at)
        AND s.authenticated_at>0 AND to_timestamp(s.authenticated_at)<=s.created_at+interval '5 seconds'
        AND s.created_at<=clock_timestamp()+interval '5 seconds'
        AND s.expires_at>clock_timestamp() AND s.expires_at>s.created_at
        AND s.expires_at-s.created_at<=interval '12 hours'`,
    [expected.userId, expected.sessionHash, expected.authenticatedAt, projectId, target.id])
    const cancel = () => { try { pending.cancel() } catch { /* Caller remains aborted; no raw driver diagnostics. */ } }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        const rows = await pending
        signal.throwIfAborted()
        const expiresAt = rows.length === 1 && rows[0].expiresAt instanceof Date ? rows[0].expiresAt.getTime() : NaN
        return Number.isFinite(expiresAt) && expiresAt > Date.now() ? { expiresAt } : null
    } finally { signal.removeEventListener('abort', cancel) }
}

export function createOwnedStreamAuthorizer(req: Request, res: Response, target: OwnedStreamTarget, dependencies: {
    runtime?: () => Promise<IdentityRuntime>
    sql?: () => Promise<Sql>
} = {}): (signal: AbortSignal) => Promise<OwnedStreamLease | null> {
    const principal = res.locals.xmailOwnedIdentity === true ? res.locals.xmailOwnedPrincipal as OwnedAdminPrincipal | undefined : undefined
    const expected = principal ? { userId: principal.userId, sessionHash: principal.sessionHash, authenticatedAt: principal.authenticatedAt } : undefined
    return async signal => {
        if (!expected || !ownedIdentityEnabled(process.env)) return null
        browserAuthAuthority(process.env) // Invalid authority configuration never admits a stream.
        const runtime = await (dependencies.runtime ?? getIdentityRuntime)()
        if (!trustedIdentityRequest(req, runtime.config)) return null
        const token = identityCookie(req, runtime.config.sessionCookie)
        if (!token) return null
        const current = await runtime.sessions.authenticate(token, signal)
        signal.throwIfAborted()
        if (!ownedIdentityEnabled(process.env)) return null
        browserAuthAuthority(process.env)
        if (!current || current.userId !== expected.userId || current.sessionHash !== expected.sessionHash
            || current.authenticatedAt !== expected.authenticatedAt) return null
        const sql = await (dependencies.sql ?? (async () => (await import('../../../db')).queryClient))()
        const lease = await readOwnedStreamLease(sql, expected, target, runtime.config.projectId, signal)
        return ownedIdentityEnabled(process.env) ? lease : null
    }
}
