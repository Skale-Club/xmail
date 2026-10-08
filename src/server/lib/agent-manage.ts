import type { Request, Response } from 'express'
import { z } from 'zod'
import { agentHasScope, getAgentPrincipal, type AgentPrincipal } from './agent-auth'
import { writeAgentAudit, type AgentAuditExecutor } from './agent-audit'
import type { OutreachAgentScope } from '../../db/schema'

/**
 * Plumbing shared by the "manage" half of the Hermes gateway (scope `outreach:manage`):
 * campaign settings, leads, inboxes, inbox reads, analytics and suppressions.
 *
 * Every route built on this follows the same contract as agent-campaign-copy.ts:
 *   - the scope is checked first and a denial is audited;
 *   - the organization ALWAYS comes from the credential's principal, never from the client;
 *   - another organization's ids answer 404, exactly like an id that does not exist;
 *   - every write puts its `outreach_agent_audit_log` row in the SAME transaction as the change;
 *   - destructive writes need `confirm: true` and otherwise answer 409 with what would happen.
 */

export const MANAGE_SCOPE: OutreachAgentScope = 'outreach:manage'
export const READ_SCOPE: OutreachAgentScope = 'outreach:read'

export function requireScope(req: Request, res: Response, scope: OutreachAgentScope): AgentPrincipal | null {
    const principal = getAgentPrincipal(req)
    if (!principal) {
        res.status(401).json({ error: 'Unauthorized' })
        return null
    }
    if (!agentHasScope(principal, scope)) {
        void writeAgentAudit({
            principal,
            request: req,
            action: 'agent.scope.denied',
            outcome: 'denied',
            metadata: { requiredScope: scope },
        }).catch(() => undefined)
        res.status(403).json({ error: `Missing required scope: ${scope}` })
        return null
    }
    return principal
}

export function isUuid(value: string): boolean {
    return z.string().uuid().safeParse(value).success
}

/** Raised (inside or outside a transaction) to answer with a specific HTTP status and body. */
export class ManageError extends Error {
    constructor(readonly status: number, readonly body: Record<string, unknown>) {
        super(String(body.error ?? 'Request rejected'))
    }
}

/** Maps the errors every manage route can throw onto a response; unknown errors become a logged 500. */
export function handleManageError(error: unknown, res: Response, context: string): void {
    if (error instanceof ManageError) {
        res.status(error.status).json(error.body)
        return
    }
    if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation error', details: error.errors })
        return
    }
    console.error(`Agent gateway: ${context} failed:`, error instanceof Error ? error.message : error)
    res.status(500).json({ error: 'Internal server error' })
}

/** Body of every destructive request: `confirm: true` plus an optional reason kept in the audit row. */
export const confirmBodySchema = z.object({
    confirm: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
}).strict()

export type ConfirmBody = z.infer<typeof confirmBodySchema>

/**
 * Destructive actions never run on the first call. Without `confirm: true` the caller gets a 409
 * that says exactly what confirming would do, so the agent can show it to a human first.
 */
export function requireConfirmation(body: ConfirmBody, willDo: Record<string, unknown>): void {
    if (body.confirm === true) return
    throw new ManageError(409, {
        error: 'Confirmation required: this action changes data that is hard to get back. Resend with {"confirm": true} to proceed.',
        code: 'confirmation_required',
        willDo,
    })
}

export interface ManageAuditInput {
    principal: AgentPrincipal
    request: Request
    executor: AgentAuditExecutor
    action: string
    resourceType: string
    resourceId: string
    metadata: Record<string, unknown>
}

/** Audit row for a write; always pass the transaction handle so both commit or roll back together. */
export async function auditManage(input: ManageAuditInput): Promise<void> {
    await writeAgentAudit({
        principal: input.principal,
        request: input.request,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        executor: input.executor,
        metadata: input.metadata,
    })
}

/** Rows come back as an array from postgres-js and as `{ rows }` from other drivers. */
export function resultRows<T>(value: unknown): T[] {
    if (Array.isArray(value)) return value as T[]
    if (value && typeof value === 'object' && 'rows' in value) {
        const rows = (value as { rows?: unknown }).rows
        return Array.isArray(rows) ? rows as T[] : []
    }
    return []
}

export const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
})

export function paginationMeta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) }
}

/** Only the keys of `patch` whose value differs from `current`, as { before, after }. */
export function diffFields(current: Record<string, unknown>, patch: Record<string, unknown>) {
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if ((current[key] ?? null) === (value ?? null)) continue
        before[key] = current[key] ?? null
        after[key] = value
    }
    return { before, after, changedFields: Object.keys(after) }
}
