import { Router, type Request, type Response } from 'express'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../db'
import {
    OUTREACH_AGENT_SCOPES,
    organizationUsers,
    outreachAgentAuditLog,
    outreachAgentCredentials,
} from '../../../db/schema'
import { generateAgentToken } from '../../lib/agent-auth'
import { requireOutreachWrite, SERVICE_PRINCIPAL_HEADER } from '../../lib/outreach-access'

const router = Router()

const createCredentialSchema = z.object({
    name: z.string().trim().min(1).max(100),
    principalUserId: z.string().uuid().optional(),
    scopes: z.array(z.enum(OUTREACH_AGENT_SCOPES)).min(1).max(OUTREACH_AGENT_SCOPES.length),
    expiresAt: z.string().datetime().optional(),
})

async function requireOrganizationAdmin(req: Request, res: Response, organizationId: string) {
    if (req.headers[SERVICE_PRINCIPAL_HEADER] === 'true') {
        res.status(403).json({ error: 'Agent credentials require an interactive human session' })
        return null
    }
    const membership = await requireOutreachWrite(req, res, organizationId)
    if (!membership) return null
    if (membership.role !== 'admin') {
        res.status(403).json({ error: 'Organization admin access required' })
        return null
    }
    return membership
}

router.get('/', async (req, res) => {
    try {
        const organizationId = req.query.organizationId as string | undefined
        if (!organizationId) return res.status(400).json({ error: 'organizationId is required' })
        if (!await requireOrganizationAdmin(req, res, organizationId)) return

        const credentials = await db.query.outreachAgentCredentials.findMany({
            where: eq(outreachAgentCredentials.organizationId, organizationId),
            columns: {
                id: true,
                organizationId: true,
                principalUserId: true,
                createdByUserId: true,
                name: true,
                keyPrefix: true,
                scopes: true,
                eventCursor: true,
                expiresAt: true,
                revokedAt: true,
                lastUsedAt: true,
                createdAt: true,
                updatedAt: true,
            },
            orderBy: [desc(outreachAgentCredentials.createdAt)],
        })
        res.json({ credentials, availableScopes: OUTREACH_AGENT_SCOPES })
    } catch (error) {
        console.error('Error listing outreach agent credentials:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/', async (req, res) => {
    try {
        const organizationId = req.query.organizationId as string | undefined
        const actorUserId = req.headers['x-user-id'] as string | undefined
        if (!organizationId) return res.status(400).json({ error: 'organizationId is required' })
        if (!actorUserId) return res.status(401).json({ error: 'Unauthorized' })
        if (!await requireOrganizationAdmin(req, res, organizationId)) return

        const input = createCredentialSchema.parse(req.body)
        const principalUserId = input.principalUserId ?? actorUserId
        const membership = await db.query.organizationUsers.findFirst({
            where: and(
                eq(organizationUsers.organizationId, organizationId),
                eq(organizationUsers.userId, principalUserId),
            ),
            columns: { id: true },
        })
        if (!membership && principalUserId !== actorUserId) {
            return res.status(400).json({ error: 'principalUserId must belong to the organization' })
        }

        const generated = generateAgentToken()
        const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined
        if (expiresAt && expiresAt <= new Date()) {
            return res.status(400).json({ error: 'expiresAt must be in the future' })
        }

        const credential = await db.transaction(async (tx) => {
            const [created] = await tx.insert(outreachAgentCredentials).values({
                organizationId,
                principalUserId,
                createdByUserId: actorUserId,
                name: input.name,
                keyPrefix: generated.keyPrefix,
                keyHash: generated.keyHash,
                scopes: [...new Set(input.scopes)],
                expiresAt,
            }).returning({
                id: outreachAgentCredentials.id,
                organizationId: outreachAgentCredentials.organizationId,
                principalUserId: outreachAgentCredentials.principalUserId,
                name: outreachAgentCredentials.name,
                keyPrefix: outreachAgentCredentials.keyPrefix,
                scopes: outreachAgentCredentials.scopes,
                expiresAt: outreachAgentCredentials.expiresAt,
                createdAt: outreachAgentCredentials.createdAt,
            })
            await tx.insert(outreachAgentAuditLog).values({
                organizationId,
                credentialId: created.id,
                actorUserId,
                action: 'agent.credential.created',
                resourceType: 'agent_credential',
                resourceId: created.id,
                metadata: { scopes: created.scopes, name: created.name },
            })
            return created
        })

        res.status(201).json({
            credential,
            token: generated.token,
            warning: 'Store this token now. Xmail stores only its hash and cannot show it again.',
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error creating outreach agent credential:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:id/revoke', async (req, res) => {
    try {
        const organizationId = req.query.organizationId as string | undefined
        const actorUserId = req.headers['x-user-id'] as string | undefined
        if (!organizationId) return res.status(400).json({ error: 'organizationId is required' })
        if (!actorUserId) return res.status(401).json({ error: 'Unauthorized' })
        if (!await requireOrganizationAdmin(req, res, organizationId)) return

        const credential = await db.query.outreachAgentCredentials.findFirst({
            where: and(
                eq(outreachAgentCredentials.id, req.params.id),
                eq(outreachAgentCredentials.organizationId, organizationId),
            ),
            columns: { id: true, revokedAt: true },
        })
        if (!credential) return res.status(404).json({ error: 'Credential not found' })

        const revokedAt = credential.revokedAt ?? new Date()
        await db.transaction(async (tx) => {
            if (!credential.revokedAt) {
                await tx.update(outreachAgentCredentials)
                    .set({ revokedAt, updatedAt: revokedAt })
                    .where(eq(outreachAgentCredentials.id, credential.id))
            }
            await tx.insert(outreachAgentAuditLog).values({
                organizationId,
                credentialId: credential.id,
                actorUserId,
                action: 'agent.credential.revoked',
                resourceType: 'agent_credential',
                resourceId: credential.id,
                metadata: { alreadyRevoked: Boolean(credential.revokedAt) },
            })
        })
        res.json({ success: true, revokedAt })
    } catch (error) {
        console.error('Error revoking outreach agent credential:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
