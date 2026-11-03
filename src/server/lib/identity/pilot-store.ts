import type { Sql } from 'postgres'
import type { GoogleIdentity } from './google-provider'

export interface IdentityProfile {
    id: string; email: string; firstName: string | null; lastName: string | null
    emailVerified: boolean; isAdmin: boolean
}
export interface BrowserChallenge {
    challengeHash: string; browserHash: string; origin: string; operation: string; expiresAt: Date
}
export interface IdentityPilotStore {
    profile(userId: string): Promise<IdentityProfile | null>
    createChallenge(challenge: BrowserChallenge, now: Date): Promise<void>
    consumeChallenge(challenge: Omit<BrowserChallenge, 'expiresAt'>, now: Date): Promise<boolean>
    linkExisting(identity: GoogleIdentity, userId: string, proofSource: 'legacy-session' | 'owned-session', now: Date): Promise<boolean>
    setDisabled(userId: string, disabled: boolean, now: Date): Promise<void>
}

export function createIdentityPilotStore(sql: Sql): IdentityPilotStore {
    return {
        async profile(userId) {
            const rows = await sql<IdentityProfile[]>`
                SELECT u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName",
                    u.email_verified AS "emailVerified", u.is_admin AS "isAdmin"
                FROM public.users u JOIN public.xmail_identity_user_controls c ON c.user_id = u.id
                WHERE u.id = ${userId} AND c.disabled_at IS NULL
            `
            return rows[0] || null
        },
        async createChallenge(challenge, now) {
            await sql`DELETE FROM public.xmail_identity_browser_challenges WHERE expires_at <= ${now}`
            await sql`INSERT INTO public.xmail_identity_browser_challenges
                (challenge_hash, browser_hash, origin, operation, expires_at)
                VALUES (${challenge.challengeHash}, ${challenge.browserHash}, ${challenge.origin}, ${challenge.operation}, ${challenge.expiresAt})`
        },
        async consumeChallenge(challenge, now) {
            const rows = await sql`UPDATE public.xmail_identity_browser_challenges SET consumed_at = ${now}
                WHERE challenge_hash = ${challenge.challengeHash} AND browser_hash = ${challenge.browserHash}
                    AND origin = ${challenge.origin} AND operation = ${challenge.operation}
                    AND consumed_at IS NULL AND expires_at > ${now} RETURNING challenge_hash`
            return rows.length === 1
        },
        async linkExisting(identity, userId, proofSource, now) {
            return sql.begin(async tx => {
                const controls = await tx.unsafe(`SELECT user_id FROM public.xmail_identity_user_controls
                    WHERE user_id = $1 AND disabled_at IS NULL AND sessions_valid_after <= to_timestamp($2)
                    FOR UPDATE`, [userId, identity.authenticatedAt])
                if (!controls.length) return false
                await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([identity.projectId, identity.subject])])
                const existing = await tx.unsafe('SELECT user_id, disabled_at FROM public.xmail_identity_bindings WHERE project_id = $1 AND subject = $2 FOR UPDATE', [identity.projectId, identity.subject])
                if (existing.length) return existing[0].user_id === userId && existing[0].disabled_at === null
                await tx.unsafe(`INSERT INTO public.xmail_identity_bindings (project_id, subject, user_id, proof_reference, created_at)
                    VALUES ($1, $2, $3, $4, $5)`, [identity.projectId, identity.subject, userId, `${proofSource}:${userId}`, now])
                return true
            })
        },
        async setDisabled(userId, disabled, now) {
            await sql.begin(async tx => {
                await tx.unsafe(`UPDATE public.xmail_identity_user_controls SET disabled_at = $1,
                    sessions_valid_after = greatest(sessions_valid_after, $2::timestamptz) WHERE user_id = $3`, [disabled ? now : null, now, userId])
                await tx.unsafe(`UPDATE public.xmail_identity_owned_sessions s SET revoked_at = coalesce(s.revoked_at, $1::timestamptz)
                    FROM public.xmail_identity_bindings b WHERE s.binding_id = b.id AND b.user_id = $2`, [now, userId])
            })
        },
    }
}
