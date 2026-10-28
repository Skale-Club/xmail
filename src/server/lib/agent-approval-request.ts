import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { outreachActionApprovals, type OutreachApprovalActionKind } from '../../db/schema'
import type { AgentPrincipal } from './agent-auth'
import { notifyApprovalRequested } from './telegram-approvals'

/**
 * Create an approval request on behalf of an agent credential, idempotently: the same
 * (organization, credential, action kind, idempotency key) returns the first request instead of a
 * second card. A newly created request posts its card on the owner's Telegram (best effort).
 */
export async function findOrCreateApproval(input: {
    principal: AgentPrincipal
    actionKind: OutreachApprovalActionKind
    resourceType: string
    resourceId: string
    idempotencyKey: string
    requestPayload: Record<string, unknown>
    maximumCreditCost?: number
}) {
    const [created] = await db.insert(outreachActionApprovals).values({
        organizationId: input.principal.organizationId,
        requesterAgentCredentialId: input.principal.credentialId,
        requesterUserId: input.principal.principalUserId,
        actionKind: input.actionKind,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        idempotencyKey: input.idempotencyKey,
        requestPayload: input.requestPayload,
        maximumCreditCost: input.maximumCreditCost ?? 0,
    }).onConflictDoNothing({
        target: [
            outreachActionApprovals.organizationId,
            outreachActionApprovals.requesterAgentCredentialId,
            outreachActionApprovals.actionKind,
            outreachActionApprovals.idempotencyKey,
        ],
    }).returning()
    if (created) {
        // Card with Approve/Reject buttons on the owner's Telegram (best effort, never blocks).
        void notifyApprovalRequested(created.id)
        return { approval: created, idempotentReplay: false }
    }
    const existing = await db.query.outreachActionApprovals.findFirst({
        where: and(
            eq(outreachActionApprovals.organizationId, input.principal.organizationId),
            eq(outreachActionApprovals.requesterAgentCredentialId, input.principal.credentialId),
            eq(outreachActionApprovals.actionKind, input.actionKind),
            eq(outreachActionApprovals.idempotencyKey, input.idempotencyKey),
        ),
    })
    if (!existing) throw new Error('Idempotent approval conflict could not be resolved')
    return { approval: existing, idempotentReplay: true }
}
