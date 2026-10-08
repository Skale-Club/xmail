import { Router } from 'express'
import { and, asc, count, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { emailAccounts } from '../../db/schema'
import {
    MANAGE_SCOPE,
    READ_SCOPE,
    ManageError,
    auditManage,
    diffFields,
    handleManageError,
    isUuid,
    paginationMeta,
    paginationSchema,
    requireScope,
} from '../lib/agent-manage'
import { AGENT_ACCOUNT_COLUMNS, toAgentAccountView, type AgentAccountRow } from '../lib/agent-account-view'

/**
 * Hermes / Kai view of the organization's outreach inboxes.
 *
 *   GET   /email-accounts        outreach:read    status, limits, warm-up, health (no secrets, ever)
 *   PATCH /email-accounts/:id    outreach:manage  pacing and warm-up length, never identity
 *
 * What the PATCH cannot do, by construction (the schema is `.strict()`, so these are 400s):
 *   - change provider, host, username, password, IMAP/SMTP settings or the Outlook link;
 *   - change `warmupSource` or `warmupOnly`, the two switches that decide whether a box is a
 *     warm-up seed or may carry campaigns (regra das três caixas);
 *   - mark an inbox verified, or un-pause one.
 * And it cannot weaken the warm-up gate: `warmupDays` can only go up and `warmupEnabled` can only
 * be turned on, because `sending_inbox_not_warmed` is evaluated against exactly those two columns
 * and an agent that could shorten them could walk an unwarmed inbox past activation.
 */

const router = Router()

// A ceiling on what the agent may set. The ramp only slows a box that is still warming up: once
// warmupCurrentDay reaches warmupDays, effectiveDailyLimit() returns the column as is, so on the
// Icemail Google boxes the agent's number would apply the same day. 30/day per box is the safe
// band for those accounts (2026-10-07, 15/day in use); anything above is the owner's call, made
// in the UI. Hermes reads prospect replies, so a prompt-injected "raise it" must stop here.
export const AGENT_MAX_DAILY_SEND_LIMIT = 30

const MAX_SPACING_MINUTES = 24 * 60

const updateAccountSchema = z.object({
    dailySendLimit: z.number().int().min(1).max(AGENT_MAX_DAILY_SEND_LIMIT).optional(),
    minMinutesBetweenEmails: z.number().int().min(1).max(MAX_SPACING_MINUTES).optional(),
    maxMinutesBetweenEmails: z.number().int().min(1).max(MAX_SPACING_MINUTES).optional(),
    warmupEnabled: z.boolean().optional(),
    warmupDays: z.number().int().min(1).max(60).optional(),
    /** The only status the agent can set: stop this inbox from sending. */
    status: z.literal('paused').optional(),
    reason: z.string().trim().max(500).optional(),
}).strict().refine(
    (value) => Object.entries(value).some(([key, entry]) => key !== 'reason' && entry !== undefined),
    { message: 'Provide at least one setting to change' },
)

const listQuerySchema = paginationSchema.extend({
    status: z.enum(['pending', 'verified', 'failed', 'paused']).optional(),
})

const SETTING_KEYS = ['dailySendLimit', 'minMinutesBetweenEmails', 'maxMinutesBetweenEmails', 'warmupEnabled', 'warmupDays', 'status'] as const

router.get('/email-accounts', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        const query = listQuerySchema.parse(req.query)
        const where = query.status
            ? and(eq(emailAccounts.organizationId, principal.organizationId), eq(emailAccounts.status, query.status))
            : eq(emailAccounts.organizationId, principal.organizationId)
        const [{ total }] = await db.select({ total: count() }).from(emailAccounts).where(where)
        const rows = await db
            .select(AGENT_ACCOUNT_COLUMNS)
            .from(emailAccounts)
            .where(where)
            .orderBy(asc(emailAccounts.email))
            .limit(query.limit)
            .offset((query.page - 1) * query.limit)
        res.json({
            emailAccounts: (rows as AgentAccountRow[]).map(toAgentAccountView),
            pagination: paginationMeta(query.page, query.limit, Number(total)),
        })
    } catch (error) {
        handleManageError(error, res, 'email account list')
    }
})

router.patch('/email-accounts/:id', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = updateAccountSchema.parse(req.body)
        if (!isUuid(req.params.id)) throw new ManageError(404, { error: 'Email account not found' })

        const outcome = await db.transaction(async (tx) => {
            const [current] = await tx
                .select(AGENT_ACCOUNT_COLUMNS)
                .from(emailAccounts)
                .where(and(eq(emailAccounts.id, req.params.id), eq(emailAccounts.organizationId, principal.organizationId)))
                .for('update')
            if (!current) throw new ManageError(404, { error: 'Email account not found' })

            const patch: Record<string, unknown> = {}
            for (const key of SETTING_KEYS) {
                if (input[key] !== undefined) patch[key] = input[key]
            }
            const { before, after, changedFields } = diffFields(current as unknown as Record<string, unknown>, patch)
            if (changedFields.length === 0) return { changed: false as const, account: current as AgentAccountRow }

            if (after.warmupEnabled === false) {
                throw new ManageError(422, {
                    error: 'warmupEnabled can only be turned on; switching the warm-up off is a human decision',
                    code: 'warmup_cannot_be_weakened',
                })
            }
            if (typeof after.warmupDays === 'number' && after.warmupDays < current.warmupDays) {
                throw new ManageError(422, {
                    error: `warmupDays can only be raised (currently ${current.warmupDays}); shortening the warm-up is a human decision`,
                    code: 'warmup_cannot_be_weakened',
                })
            }
            const nextMin = (after.minMinutesBetweenEmails as number | undefined) ?? current.minMinutesBetweenEmails
            const nextMax = (after.maxMinutesBetweenEmails as number | undefined) ?? current.maxMinutesBetweenEmails
            if (nextMax < nextMin) {
                throw new ManageError(422, {
                    error: 'maxMinutesBetweenEmails must be greater than or equal to minMinutesBetweenEmails',
                    code: 'invalid_spacing_range',
                    minMinutesBetweenEmails: nextMin,
                    maxMinutesBetweenEmails: nextMax,
                })
            }

            const [updated] = await tx
                .update(emailAccounts)
                .set({ ...after, updatedAt: new Date() })
                .where(and(eq(emailAccounts.id, current.id), eq(emailAccounts.organizationId, principal.organizationId)))
                .returning(AGENT_ACCOUNT_COLUMNS)
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.email_account.updated',
                resourceType: 'email_account',
                resourceId: current.id,
                metadata: {
                    emailAccountId: current.id,
                    email: current.email,
                    reason: input.reason ?? null,
                    changedFields,
                    before,
                    after,
                },
            })
            return { changed: true as const, account: updated as AgentAccountRow, before, after, changedFields }
        })

        res.json({
            changed: outcome.changed,
            changedFields: outcome.changed ? outcome.changedFields : [],
            ...(outcome.changed ? { before: outcome.before, after: outcome.after } : { note: 'The payload matches what is already saved; nothing was written.' }),
            emailAccount: toAgentAccountView(outcome.account),
        })
    } catch (error) {
        handleManageError(error, res, 'email account update')
    }
})

export default router
