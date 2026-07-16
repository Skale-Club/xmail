// ============================================================
// Unified Inbox durable send-command executor (Phase 22 UIX-05)
// ============================================================
// executeInboxSendCommand is the SINGLE lease-aware entrypoint through which a claimed
// inbox_send_commands row reaches the shared durable dispatcher. It is the ONLY inbox/AI
// module permitted to call dispatchOutreachMessage — the worker (processInboxCommands) hands
// it a claimed lease rather than dispatching directly, and no route/job imports the provider
// adapter. It revalidates organization ownership of the conversation, dispatches through the
// shared send-policy gate, and finalizes the command's status guarded by the claimed lease.
//
// At-most-once: the command's stable idempotency_key is passed straight to the dispatcher,
// whose (organization_id, idempotency_key) uniqueness collapses a re-execution after a crash
// onto the same outreach_emails row and returns 'duplicate' — so a scheduled command dispatches
// at most once even across a Node process restart.
//
// NOTE: the full reply composition (cc/bcc fan-out, quoting, attachment streaming) is Plan
// 22-04. Here the executor dispatches the frozen command snapshot's primary recipient/body via
// the existing threaded-reply provider, and the durable command model + claimer are complete.

import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { createLogger } from './logger'
import {
    dispatchOutreachMessage,
    type DispatchDependencies,
    type DispatchOutreachInput,
    type DispatchResult,
} from './outreach-dispatch'
import type { InboxSendCommandMode, InboxRecipient } from '../../db/schema'

const log = createLogger('outreach.inboxCommands')

export type InboxSql = ReturnType<typeof postgres>

const MAX_ERROR_LENGTH = 1000
const RETRY_BACKOFF_MS = 60_000
const SHORT_REQUEUE_MS = 30_000

/** A command row claimed by the worker (status already flipped to 'sending' + lease held). */
export interface ClaimedInboxCommand {
    id: string
    organizationId: string
    conversationId: string
    emailAccountId: string
    actorUserId: string
    mode: InboxSendCommandMode
    toRecipients: InboxRecipient[]
    ccRecipients: InboxRecipient[]
    bccRecipients: InboxRecipient[]
    subject: string | null
    bodyText: string | null
    bodyHtml: string | null
    inReplyTo: string | null
    messageReferences: string | null
    idempotencyKey: string
    leaseToken: string
    attempts: number
    maxAttempts: number
}

export type InboxCommandOutcome = 'sent' | 'rescheduled' | 'failed' | 'held' | 'lost'

export interface ExecuteInboxCommandDeps {
    sql: InboxSql
    now?: () => Date
    /**
     * Injectable dispatcher (tests pass a fake so no provider/network is touched). Defaults to
     * building the account's threaded-reply provider and calling dispatchOutreachMessage — the
     * one place inbox commands reach the shared policy-gated dispatcher.
     */
    dispatch?: (input: DispatchOutreachInput) => Promise<DispatchResult>
}

function sanitizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.slice(0, MAX_ERROR_LENGTH)
}

function isUuid(value: string | undefined | null): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/**
 * Default production dispatch: resolve the sending account, build its threaded-reply provider,
 * and go through the shared durable dispatcher (policy gate + lease + idempotency). Lazily
 * imports the DB/provider so this module stays importable without DATABASE_URL in tests.
 */
async function defaultDispatch(
    input: DispatchOutreachInput,
    command: ClaimedInboxCommand,
    now?: () => Date,
): Promise<DispatchResult> {
    const { db } = await import('../../db')
    const { eq } = await import('drizzle-orm')
    const { emailAccounts } = await import('../../db/schema')
    const account = await db.query.emailAccounts.findFirst({
        where: eq(emailAccounts.id, command.emailAccountId),
    })
    if (!account) return { status: 'failed', rowId: '', code: 'account_missing' }

    const { createThreadedDispatchProvider } = await import('./outreach-dispatch-provider')
    const provider = createThreadedDispatchProvider({ account })
    const dependencies: DispatchDependencies = { provider, now }
    return dispatchOutreachMessage(input, dependencies)
}

/** All finalize writes are guarded by the claimed lease token — an expired/cancelled command is left untouched. */
type SqlParam = string | number | Date | null

async function finalize(
    sql: InboxSql,
    command: ClaimedInboxCommand,
    assignments: string,
    values: Record<string, SqlParam>,
): Promise<boolean> {
    // Build a parameterized UPDATE from the assignment fragment + named values via unsafe (the
    // fragment is a fixed string built in-module; values are bound, never interpolated).
    const params = Object.values(values)
    const rows = await sql.unsafe(
        `UPDATE inbox_send_commands SET ${assignments}, updated_at = now()
         WHERE id = $${params.length + 1} AND lease_token = $${params.length + 2}::uuid
         RETURNING id`,
        [...params, command.id, command.leaseToken],
    )
    return rows.length > 0
}

async function markSent(sql: InboxSql, command: ClaimedInboxCommand, outreachEmailId: string | undefined): Promise<boolean> {
    return finalize(
        sql,
        command,
        `status = 'sent', resulting_outreach_email_id = $1, lease_token = NULL, lease_expires_at = NULL, last_error = NULL, last_policy_code = NULL`,
        { rowId: isUuid(outreachEmailId) ? outreachEmailId : null },
    )
}

async function reschedule(
    sql: InboxSql,
    command: ClaimedInboxCommand,
    dueAt: Date,
    opts: { attemptDelta?: number; policyCode?: string | null; error?: string | null } = {},
): Promise<boolean> {
    const attemptDelta = opts.attemptDelta ?? 0
    return finalize(
        sql,
        command,
        `status = 'scheduled', due_at = $1, attempts = GREATEST(attempts + (${attemptDelta}), 0),
         lease_token = NULL, lease_expires_at = NULL, last_policy_code = $2, last_error = $3`,
        { dueAt, policyCode: opts.policyCode ?? null, error: opts.error ?? null },
    )
}

async function markFailed(sql: InboxSql, command: ClaimedInboxCommand, code: string): Promise<boolean> {
    return finalize(
        sql,
        command,
        `status = 'failed', lease_token = NULL, lease_expires_at = NULL, last_error = $1`,
        { error: code },
    )
}

async function markHeld(sql: InboxSql, command: ClaimedInboxCommand, code: string): Promise<boolean> {
    return finalize(
        sql,
        command,
        `status = 'held', lease_token = NULL, lease_expires_at = NULL, last_error = $1`,
        { error: code },
    )
}

/**
 * Lease-aware executor: revalidate org ownership, dispatch through the shared gate, and finalize.
 * Returns the resulting command disposition. All writes are guarded by the claimed lease.
 */
export async function executeInboxSendCommand(
    command: ClaimedInboxCommand,
    deps: ExecuteInboxCommandDeps,
): Promise<InboxCommandOutcome> {
    const sql = deps.sql
    const now = deps.now ?? (() => new Date())

    // 1. Revalidate that the conversation still belongs to the command's organization. The claim
    //    row carried org scope, but a worker has no request middleware, so ownership is re-checked
    //    before any side effect.
    const convRows = await sql<{ lead_id: string | null }[]>`
        SELECT lead_id FROM outreach_conversations
        WHERE id = ${command.conversationId}::uuid AND organization_id = ${command.organizationId}::uuid
    `
    if (convRows.length === 0) {
        await markFailed(sql, command, 'conversation_missing')
        return 'failed'
    }
    const leadId = convRows[0].lead_id ?? undefined

    const primaryTo = command.toRecipients[0]?.address
    if (!primaryTo) {
        await markFailed(sql, command, 'recipients_missing')
        return 'failed'
    }

    const input: DispatchOutreachInput = {
        origin: 'unified_inbox',
        organizationId: command.organizationId,
        emailAccountId: command.emailAccountId,
        leadId,
        idempotencyKey: command.idempotencyKey,
        to: primaryTo,
        subject: command.subject?.trim() || '(no subject)',
        text: command.bodyText,
        html: command.bodyHtml,
        inReplyTo: command.inReplyTo,
        references: command.messageReferences,
    }

    let result: DispatchResult
    try {
        result = deps.dispatch
            ? await deps.dispatch(input)
            : await defaultDispatch(input, command, deps.now)
    } catch (error) {
        // An unexpected executor error: the claim already incremented attempts, so bound the loop.
        const code = sanitizeError(error)
        if (command.attempts >= command.maxAttempts) {
            await markFailed(sql, command, code)
            return 'failed'
        }
        await reschedule(sql, command, new Date(now().getTime() + RETRY_BACKOFF_MS), { error: code })
        return 'rescheduled'
    }

    switch (result.status) {
        case 'sent':
            await markSent(sql, command, result.rowId)
            return 'sent'
        case 'duplicate':
            // Idempotency-key replay after a crash: the email is already sent. Finalize, don't resend.
            await markSent(sql, command, result.rowId)
            return 'sent'
        case 'deferred':
            // Policy wait (send window / spacing / rate limit). Free — undo the claim's attempt.
            await reschedule(sql, command, result.retryAt ?? new Date(now().getTime() + SHORT_REQUEUE_MS), {
                attemptDelta: -1,
                policyCode: result.code,
            })
            return 'rescheduled'
        case 'retry_scheduled':
            // The dispatcher scheduled a bounded retry (transient provider failure). Keep the attempt.
            await reschedule(sql, command, result.nextAttemptAt ?? new Date(now().getTime() + RETRY_BACKOFF_MS), {
                error: result.code,
            })
            return 'rescheduled'
        case 'held':
            // Ambiguous provider outcome — held for manual review; NEVER blindly resent.
            await markHeld(sql, command, 'provider_outcome_held')
            return 'held'
        case 'failed':
            if (command.attempts >= command.maxAttempts) {
                await markFailed(sql, command, result.code)
                return 'failed'
            }
            await reschedule(sql, command, new Date(now().getTime() + RETRY_BACKOFF_MS), { error: result.code })
            return 'rescheduled'
        case 'exhausted':
            await markFailed(sql, command, 'dispatch_exhausted')
            return 'failed'
        case 'lost_lease':
        case 'in_progress':
            // Another attempt owns the dispatch row; requeue shortly without burning an attempt.
            await reschedule(sql, command, new Date(now().getTime() + SHORT_REQUEUE_MS), {
                attemptDelta: -1,
                error: result.status,
            })
            return 'rescheduled'
        default: {
            log.warn({ action: 'outreach.inboxCommands.unknown_result', commandId: command.id, result }, 'unknown dispatch result')
            await reschedule(sql, command, new Date(now().getTime() + SHORT_REQUEUE_MS), { attemptDelta: -1 })
            return 'rescheduled'
        }
    }
}

export { randomUUID as inboxCommandLeaseToken }
