import type { Request } from 'express'
import { db } from '../../db'
import { outreachAgentAuditLog } from '../../db/schema'
import type { AgentPrincipal } from './agent-auth'
import { jsonbParam } from './jsonb'

export interface AgentAuditInput {
    principal: AgentPrincipal
    request?: Request
    action: string
    resourceType?: string
    resourceId?: string
    outcome?: 'success' | 'denied' | 'failed'
    metadata?: Record<string, unknown>
}

export async function writeAgentAudit(input: AgentAuditInput): Promise<void> {
    const requestId = input.request?.headers['x-request-id']
    await db.insert(outreachAgentAuditLog).values({
        organizationId: input.principal.organizationId,
        credentialId: input.principal.credentialId,
        actorUserId: input.principal.principalUserId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        requestId: typeof requestId === 'string' ? requestId.slice(0, 200) : undefined,
        outcome: input.outcome ?? 'success',
        metadata: jsonbParam(input.metadata ?? {}),
    })
}
