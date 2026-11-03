import type { Request } from 'express'
import { db, withRetry } from '../../db'
import { users } from '../../db/schema'
import { eq } from 'drizzle-orm'

interface AuthenticatedUserSnapshot {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    emailVerified: boolean
}

export function getAuthenticatedUserFromRequest(req: Request): AuthenticatedUserSnapshot | null {
    const id = req.headers['x-user-id']
    const email = req.headers['x-user-email']

    if (typeof id !== 'string' || typeof email !== 'string' || !email) {
        return null
    }

    return {
        id,
        email,
        firstName: typeof req.headers['x-user-first-name'] === 'string' ? req.headers['x-user-first-name'] : null,
        lastName: typeof req.headers['x-user-last-name'] === 'string' ? req.headers['x-user-last-name'] : null,
        emailVerified: req.headers['x-user-email-verified'] === 'true',
    }
}

export async function ensureLocalUser(snapshot: AuthenticatedUserSnapshot, options: { existingOnly?: boolean } = {}) {
    const existing = await withRetry(
        () => db.query.users.findFirst({ where: eq(users.id, snapshot.id) }),
        2,
        100
    )

    if (existing) {
        if (options.existingOnly) return existing
        const shouldUpdate =
            existing.email !== snapshot.email ||
            existing.firstName !== snapshot.firstName ||
            existing.lastName !== snapshot.lastName ||
            existing.emailVerified !== snapshot.emailVerified

        if (!shouldUpdate) {
            return existing
        }

        const [updated] = await db.update(users)
            .set({
                email: snapshot.email,
                firstName: snapshot.firstName,
                lastName: snapshot.lastName,
                emailVerified: snapshot.emailVerified,
                updatedAt: new Date(),
            })
            .where(eq(users.id, snapshot.id))
            .returning()

        return updated
    }

    if (options.existingOnly) throw new Error('Existing identity account is unavailable.')
    const [created] = await db.insert(users)
        .values({
            id: snapshot.id,
            email: snapshot.email,
            firstName: snapshot.firstName,
            lastName: snapshot.lastName,
            isAdmin: false,
            emailVerified: snapshot.emailVerified,
        })
        .returning()

    return created
}
