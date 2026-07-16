/**
 * Canonical outreach authorization helpers.
 *
 * Every tenant-scoped outreach route MUST import its read/write checks from this
 * module — there must not be a per-route `checkOrgMembership` copy. The app's
 * Postgres role bypasses RLS (see CLAUDE.md "Authentication Flow"), so this JS-side
 * check is the real tenant boundary.
 *
 * Role contract (matches the frontend OutreachCheck guard):
 *   - platform admins bypass membership entirely;
 *   - organization admins and members may read and write;
 *   - organization viewers may read only.
 */
import type { Request, Response } from 'express'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { organizationUsers } from '../../db/schema'
import { isPlatformAdmin } from './admin'

/**
 * Header markers set by the service-key middleware (src/server/lib/service-auth.ts)
 * once a machine caller is authenticated. They are always stripped from inbound
 * requests before authentication, so a client can never forge them.
 */
export const SERVICE_PRINCIPAL_HEADER = 'x-service-principal'
export const SERVICE_ORGANIZATION_HEADER = 'x-service-organization-id'

export interface OutreachMembership {
    role: string
}

/**
 * Resolve outreach membership for a user in an organization. Platform admins bypass
 * membership; otherwise the user must belong to the organization. Returns null when
 * access is denied.
 *
 * This is the low-level primitive. Route handlers should prefer requireOutreachRead /
 * requireOutreachWrite, which also enforce the service-principal organization binding
 * and emit the standard 401/403 responses.
 */
export async function checkOutreachAccess(
    userId: string,
    organizationId: string,
): Promise<OutreachMembership | null> {
    const admin = await isPlatformAdmin(userId)
    if (admin) return { role: 'admin' }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organizationId),
            eq(organizationUsers.userId, userId),
        ),
    })
    return membership ?? null
}

export function canWriteOutreach(membership: OutreachMembership | null | undefined): boolean {
    return membership?.role === 'admin' || membership?.role === 'member'
}

/**
 * A bound service principal may only act inside its configured organization. When the
 * request is a service principal AND the resolved organization differs from the bound
 * one, access is denied — even for a platform-admin service account and even on routes
 * that derive their organization from a path resource.
 */
function violatesServiceScope(req: Request, organizationId: string): boolean {
    if (req.headers[SERVICE_PRINCIPAL_HEADER] !== 'true') return false
    const bound = req.headers[SERVICE_ORGANIZATION_HEADER]
    return typeof bound === 'string' && bound.length > 0 && bound !== organizationId
}

/**
 * Require read access to an organization's outreach data. On denial it writes the
 * response (401/403) and returns null; on success it returns the membership.
 */
export async function requireOutreachRead(
    req: Request,
    res: Response,
    organizationId: string,
): Promise<OutreachMembership | null> {
    const userId = req.headers['x-user-id'] as string | undefined
    if (!userId) {
        res.status(401).json({ error: 'Unauthorized' })
        return null
    }
    if (violatesServiceScope(req, organizationId)) {
        res.status(403).json({ error: 'Organization scope not permitted for this credential' })
        return null
    }
    const membership = await checkOutreachAccess(userId, organizationId)
    if (!membership) {
        res.status(403).json({ error: 'Access denied' })
        return null
    }
    return membership
}

/**
 * Require write access (org admin or member). On denial it writes the response
 * (401/403) and returns null; on success it returns the membership.
 */
export async function requireOutreachWrite(
    req: Request,
    res: Response,
    organizationId: string,
): Promise<OutreachMembership | null> {
    const membership = await requireOutreachRead(req, res, organizationId)
    if (!membership) return null
    if (!canWriteOutreach(membership)) {
        res.status(403).json({ error: 'Write access denied' })
        return null
    }
    return membership
}
