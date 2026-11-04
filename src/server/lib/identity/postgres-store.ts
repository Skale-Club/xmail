import type { Sql } from 'postgres'
import type { IdentityBinding, OwnedIdentityStore, UserIdentityControl } from './owned-session'

type AdmissionRow = {
    bindingId: string; userId: string; projectId: string; subject: string
    bindingDisabledAt: Date | null; userDisabledAt: Date | null; sessionsValidAfter: Date
}
type SessionRow = AdmissionRow & {
    tokenHash: string; authenticatedAt: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null
}
function admission(row: AdmissionRow): { binding: IdentityBinding; control: UserIdentityControl } {
    return {
        binding: { id: row.bindingId, userId: row.userId, projectId: row.projectId, subject: row.subject, disabledAt: row.bindingDisabledAt },
        control: { disabledAt: row.userDisabledAt, sessionsValidAfter: row.sessionsValidAfter },
    }
}

/** Explicitly injected SQL target; importing this module never opens a pool or loads dotenv. */
export function createPostgresOwnedIdentityStore(sql: Sql): OwnedIdentityStore {
    return {
        async findBinding(projectId, subject) {
            const rows = await sql<AdmissionRow[]>`
                SELECT b.id AS "bindingId", b.user_id AS "userId", b.project_id AS "projectId", b.subject,
                    b.disabled_at AS "bindingDisabledAt", c.disabled_at AS "userDisabledAt",
                    c.sessions_valid_after AS "sessionsValidAfter"
                FROM public.xmail_identity_bindings b
                JOIN public.users u ON u.id = b.user_id
                JOIN public.xmail_identity_user_controls c ON c.user_id = u.id
                WHERE b.project_id = ${projectId} AND b.subject = ${subject}
            `
            return rows[0] ? admission(rows[0]) : null
        },
        async insertSessionIfActive(session, binding) {
            return sql.begin(async tx => {
                // Always lock the user control first, matching revokeUserSessions.
                // Revocation and insertion therefore cannot pass each other on a stale read.
                // TransactionSql's published type omits the callable tag. Use
                // its supported constant-SQL/parameter API instead of a cast.
                const controls = await tx.unsafe(`
                    SELECT user_id FROM public.xmail_identity_user_controls
                    WHERE user_id = $1 AND disabled_at IS NULL
                        AND sessions_valid_after <= to_timestamp($2)
                    FOR UPDATE
                `, [binding.userId, session.authenticatedAt])
                if (!controls.length || session.bindingId !== binding.id) return false
                const bindings = await tx.unsafe(`
                    SELECT id FROM public.xmail_identity_bindings
                    WHERE id = $1 AND user_id = $2
                        AND project_id = $3 AND subject = $4
                        AND disabled_at IS NULL
                    FOR SHARE
                `, [binding.id, binding.userId, binding.projectId, binding.subject])
                if (!bindings.length) return false
                const inserted = await tx.unsafe(`
                    INSERT INTO public.xmail_identity_owned_sessions
                        (token_hash, binding_id, authenticated_at, created_at, expires_at, revoked_at)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (token_hash) DO NOTHING RETURNING token_hash
                `, [session.tokenHash, session.bindingId, session.authenticatedAt, session.createdAt, session.expiresAt, session.revokedAt])
                return inserted.length === 1
            })
        },
        async findSession(tokenHash) {
            const rows = await sql<SessionRow[]>`
                SELECT b.id AS "bindingId", b.user_id AS "userId", b.project_id AS "projectId", b.subject,
                    b.disabled_at AS "bindingDisabledAt", c.disabled_at AS "userDisabledAt",
                    c.sessions_valid_after AS "sessionsValidAfter", s.token_hash AS "tokenHash",
                    s.authenticated_at AS "authenticatedAt", s.created_at AS "createdAt",
                    s.expires_at AS "expiresAt", s.revoked_at AS "revokedAt"
                FROM public.xmail_identity_owned_sessions s
                JOIN public.xmail_identity_bindings b ON b.id = s.binding_id
                JOIN public.users u ON u.id = b.user_id
                JOIN public.xmail_identity_user_controls c ON c.user_id = u.id
                WHERE s.token_hash = ${tokenHash}
            `
            const row = rows[0]
            return row ? { ...admission(row), session: {
                tokenHash: row.tokenHash, bindingId: row.bindingId, authenticatedAt: Number(row.authenticatedAt),
                createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt,
            } } : null
        },
        async revokeSession(tokenHash, now) {
            await sql`
                UPDATE public.xmail_identity_owned_sessions SET revoked_at = coalesce(revoked_at, ${now})
                WHERE token_hash = ${tokenHash}
            `
        },
        async revokeUserSessions(userId, now) {
            await sql.begin(async tx => {
                await tx.unsafe(`
                    UPDATE public.xmail_identity_user_controls
                    SET sessions_valid_after = greatest(sessions_valid_after, $1::timestamptz) WHERE user_id = $2
                `, [now, userId])
                await tx.unsafe(`
                    UPDATE public.xmail_identity_owned_sessions s SET revoked_at = coalesce(s.revoked_at, $1::timestamptz)
                    FROM public.xmail_identity_bindings b WHERE s.binding_id = b.id AND b.user_id = $2
                `, [now, userId])
            })
        },
    }
}
