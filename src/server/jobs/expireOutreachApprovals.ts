import { queryClient } from '../../db'
import { runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'
import { publishOutreachEvent } from '../lib/xphere-events'

const log = createLogger('outreach.approvals.expiry')

interface ExpiredApprovalRow {
    id: string
    organizationId: string
    actionKind: string
    resourceType: string
    resourceId: string
}

export async function expireOutreachApprovals(now: Date = new Date()): Promise<number> {
    const expired = await queryClient<ExpiredApprovalRow[]>`
        UPDATE outreach_action_approvals
        SET status = 'expired', updated_at = ${now}
        WHERE status IN ('requested', 'approved')
          AND expires_at <= ${now}
        RETURNING id::text,
            organization_id::text AS "organizationId",
            action_kind AS "actionKind",
            resource_type AS "resourceType",
            resource_id AS "resourceId"
    `
    for (const approval of expired) {
        await publishOutreachEvent({
            organizationId: approval.organizationId,
            eventType: 'action.approval_expired',
            aggregateType: approval.resourceType,
            aggregateId: approval.resourceId,
            deduplicationKey: `action.approval_expired:${approval.id}`,
            payload: { approval_id: approval.id, action_kind: approval.actionKind },
        })
    }
    if (expired.length > 0) {
        log.info({ action: 'outreach.approvals.expired', count: expired.length }, 'expired stale action approvals')
    }
    return expired.length
}

export async function runApprovalExpiryWithLock(): Promise<void> {
    await runWithLock('expireOutreachApprovals', expireOutreachApprovals)
}
