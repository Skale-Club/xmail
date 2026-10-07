import type { Request } from 'express'
import { db } from '../../db'
import { outreachAgentAuditLog } from '../../db/schema'
import type { AgentPrincipal } from './agent-auth'
import { jsonbParam } from './jsonb'

/** Anything that can run an insert: the shared `db` or a transaction handle from `db.transaction`. */
export type AgentAuditExecutor = Pick<typeof db, 'insert'>

export interface AgentAuditInput {
    principal: AgentPrincipal
    request?: Request
    action: string
    resourceType?: string
    resourceId?: string
    outcome?: 'success' | 'denied' | 'failed'
    metadata?: Record<string, unknown>
    /**
     * Write through this handle instead of the shared connection. Pass the transaction when the
     * audit row must commit or roll back together with the change it describes.
     */
    executor?: AgentAuditExecutor
}

export async function writeAgentAudit(input: AgentAuditInput): Promise<void> {
    const requestId = input.request?.headers['x-request-id']
    await (input.executor ?? db).insert(outreachAgentAuditLog).values({
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
