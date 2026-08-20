/**
 * Durable, advisory-locked processor for Unified Inbox scheduled work (Phase 22 UIX-05).
 *
 * Two independent, restart-safe responsibilities per tick:
 *
 *  1. SEND COMMANDS — claim a bounded batch of due inbox_send_commands with a lease token/expiry
 *     and bounded attempts (the same pattern as the Phase 18 dispatcher / Phase 21 materializer),
 *     recover expired leases, park poison commands, and hand each claimed lease to the SINGLE
 *     lease-aware executeInboxSendCommand executor. This job NEVER calls dispatchOutreachMessage
 *     directly — only executeInboxSendCommand does — and imports no provider adapter.
 *
 *  2. REMINDERS — atomically flip each due, scheduled reminder to 'notified' and insert one
 *     deduplicated user_notification in the SAME transaction (FOR UPDATE SKIP LOCKED + status
 *     guard), so a duplicate tick or a restart notifies exactly once and never sends email.
 *
 * The claim increments attempts so a crash between claim and finalize is bounded; a policy
 * defer (evaluated inside the executor) refunds that attempt, so waiting for a send window is
 * free. A crash after a successful send but before finalize is safe: the lease expires, the
 * command is reclaimed, and the dispatcher's idempotency key returns 'duplicate' — at most once.
 */
import { randomUUID } from 'node:crypto'
import { createLogger } from '../lib/logger'
import {
    executeInboxSendCommand,
    type ClaimedInboxCommand,
    type ExecuteInboxCommandDeps,
    type InboxCommandOutcome,
    type InboxSql,
} from '../lib/inbox-command-dispatch'

const log = createLogger('outreach.inboxCommands')

// Stable advisory-lock name — renaming would let old/new instances overlap during a rollout.
export const INBOX_COMMANDS_LOCK_NAME = 'outreach-inbox-commands'

export const DEFAULT_COMMAND_LIMIT = 100
export const DEFAULT_REMINDER_LIMIT = 200
export const COMMAND_LEASE_MINUTES = 5

export interface ProcessInboxCommandsDeps {
    sql?: InboxSql
    now?: () => Date
    limit?: number
    reminderLimit?: number
    leaseMinutes?: number
    /** Optional organization scope (unset = global, as in production). Set for test isolation. */
    organizationId?: string
    /** Injectable dispatcher forwarded to executeInboxSendCommand (tests avoid provider/network). */
    dispatch?: ExecuteInboxCommandDeps['dispatch']
}

export interface ProcessInboxCommandsResult {
    claimed: number
    sent: number
    rescheduled: number
    failed: number
    held: number
    remindersNotified: number
}

async function defaultSqlClient(): Promise<InboxSql> {
    const { queryClient } = await import('../../db')
    return queryClient as unknown as InboxSql
}

interface ClaimRow {
    id: string
    organization_id: string
    conversation_id: string
    email_account_id: string
    actor_user_id: string
    mode: ClaimedInboxCommand['mode']
    to_recipients: ClaimedInboxCommand['toRecipients']
    cc_recipients: ClaimedInboxCommand['ccRecipients']
    bcc_recipients: ClaimedInboxCommand['bccRecipients']
    subject: string | null
    body_text: string | null
    body_html: string | null
    in_reply_to: string | null
    message_references: string | null
    attachment_ids: ClaimedInboxCommand['attachmentIds']
    idempotency_key: string
    attempts: number
    max_attempts: number
}

function parseAttachmentIds(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
        } catch {
            return []
        }
    }
    return []
}

// Under prepare:false (the pooler-safe production config), postgres-js can return jsonb from a
// data-modifying CTE's RETURNING as a raw string rather than a parsed value. Normalize either.
function parseRecipients(value: unknown): ClaimedInboxCommand['toRecipients'] {
    if (Array.isArray(value)) return value as ClaimedInboxCommand['toRecipients']
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            return Array.isArray(parsed) ? parsed : []
        } catch {
            return []
        }
    }
    return []
}

function toClaimedCommand(row: ClaimRow, leaseToken: string): ClaimedInboxCommand {
    return {
        id: row.id,
        organizationId: row.organization_id,
        conversationId: row.conversation_id,
        emailAccountId: row.email_account_id,
        actorUserId: row.actor_user_id,
        mode: row.mode,
        toRecipients: parseRecipients(row.to_recipients),
        ccRecipients: parseRecipients(row.cc_recipients),
        bccRecipients: parseRecipients(row.bcc_recipients),
        subject: row.subject,
        bodyText: row.body_text,
        bodyHtml: row.body_html,
        inReplyTo: row.in_reply_to,
        messageReferences: row.message_references,
        attachmentIds: parseAttachmentIds(row.attachment_ids),
        idempotencyKey: row.idempotency_key,
        leaseToken,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
    }
}

/** Claim + dispatch due send commands, then notify due reminders. Bounded and lease-safe. */
export async function processInboxCommands(deps: ProcessInboxCommandsDeps = {}): Promise<ProcessInboxCommandsResult> {
    const sql = deps.sql ?? (await defaultSqlClient())
    const now = deps.now ?? (() => new Date())
    const limit = deps.limit ?? DEFAULT_COMMAND_LIMIT
    const reminderLimit = deps.reminderLimit ?? DEFAULT_REMINDER_LIMIT
    const leaseMinutes = deps.leaseMinutes ?? COMMAND_LEASE_MINUTES
    const organizationId = deps.organizationId ?? null

    const result: ProcessInboxCommandsResult = {
        claimed: 0, sent: 0, rescheduled: 0, failed: 0, held: 0, remindersNotified: 0,
    }

    // Park poison commands: a 'sending' row whose lease has expired and whose attempts are already
    // at the ceiling can never be reclaimed (the claim requires attempts < max), so terminate it.
    await sql`
        UPDATE inbox_send_commands
        SET status = 'failed', last_error = 'exhausted', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE status = 'sending' AND lease_expires_at < now() AND attempts >= max_attempts
          AND (${organizationId}::uuid IS NULL OR organization_id = ${organizationId}::uuid)
    `

    for (let i = 0; i < limit; i++) {
        const leaseToken = randomUUID()
        // Atomic claim: oldest due row (or a 'sending' row whose lease expired), skipping peers.
        const claimed = await sql<ClaimRow[]>`
            WITH candidate AS (
                SELECT id FROM inbox_send_commands
                WHERE (
                    (status IN ('scheduled', 'queued') AND due_at <= now())
                    OR (status = 'sending' AND lease_expires_at < now())
                )
                  AND attempts < max_attempts
                  AND (${organizationId}::uuid IS NULL OR organization_id = ${organizationId}::uuid)
                ORDER BY due_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE inbox_send_commands c
            SET status = 'sending',
                lease_token = ${leaseToken}::uuid,
                lease_expires_at = now() + (${leaseMinutes}::int * interval '1 minute'),
                attempts = c.attempts + 1,
                updated_at = now()
            FROM candidate
            WHERE c.id = candidate.id
            RETURNING c.id, c.organization_id, c.conversation_id, c.email_account_id, c.actor_user_id,
                c.mode, c.to_recipients, c.cc_recipients, c.bcc_recipients, c.subject, c.body_text, c.body_html,
                c.in_reply_to, c.message_references, c.attachment_ids, c.idempotency_key, c.attempts, c.max_attempts
        `
        const row = claimed[0]
        if (!row) break
        result.claimed++

        const command = toClaimedCommand(row, leaseToken)
        let outcome: InboxCommandOutcome
        try {
            outcome = await executeInboxSendCommand(command, { sql, now, dispatch: deps.dispatch })
        } catch (error) {
            // Defensive: executeInboxSendCommand handles its own errors, but never let one bad
            // command abort the whole tick.
            log.error({
                action: 'outreach.inboxCommands.execute_failed',
                commandId: command.id,
                error: { message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
            }, 'inbox command execution threw')
            continue
        }
        if (outcome === 'sent') result.sent++
        else if (outcome === 'failed') result.failed++
        else if (outcome === 'held') result.held++
        else result.rescheduled++
    }

    result.remindersNotified = await processDueReminders({ sql, reminderLimit, organizationId })

    if (result.claimed > 0 || result.remindersNotified > 0) {
        log.info({
            action: 'outreach.inboxCommands.tick',
            claimed: result.claimed,
            sent: result.sent,
            rescheduled: result.rescheduled,
            failed: result.failed,
            held: result.held,
            remindersNotified: result.remindersNotified,
        }, 'inbox commands tick')
    }

    return result
}

interface DueReminderRow {
    id: string
    organization_id: string
    conversation_id: string
    user_id: string
    note: string | null
}

/**
 * Notify due reminders. Each reminder is flipped scheduled->notified AND its user_notification is
 * inserted in ONE transaction under a row lock + status guard, so a duplicate tick / restart
 * notifies exactly once. Never sends email — a due reminder is an in-app notification only.
 */
export async function processDueReminders(deps: {
    sql?: InboxSql
    reminderLimit?: number
    organizationId?: string | null
}): Promise<number> {
    const sql = deps.sql ?? (await defaultSqlClient())
    const limit = deps.reminderLimit ?? DEFAULT_REMINDER_LIMIT
    const organizationId = deps.organizationId ?? null
    let notified = 0

    for (let i = 0; i < limit; i++) {
        const didNotify = await sql.begin(async (txClient) => {
            const tx = txClient as unknown as InboxSql
            const rows = await tx<DueReminderRow[]>`
                SELECT id, organization_id, conversation_id, user_id, note
                FROM inbox_reminders
                WHERE status = 'scheduled' AND remind_at <= now()
                  AND (${organizationId}::uuid IS NULL OR organization_id = ${organizationId}::uuid)
                ORDER BY remind_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            `
            const reminder = rows[0]
            if (!reminder) return false

            // sql.json() serializes the object ONCE into a jsonb object. Passing JSON.stringify()
            // instead would double-encode it into a jsonb string scalar (postgres-js re-serializes
            // the string), and metadata->>'reminderId' would then be NULL.
            await tx`
                INSERT INTO user_notifications (user_id, type, title, message, metadata)
                VALUES (
                    ${reminder.user_id}::uuid,
                    'inbox_reminder',
                    'Inbox reminder',
                    ${reminder.note ?? 'You have a reminder on a conversation'},
                    ${tx.json({
                        reminderId: reminder.id,
                        conversationId: reminder.conversation_id,
                        organizationId: reminder.organization_id,
                    })}
                )
            `
            await tx`
                UPDATE inbox_reminders
                SET status = 'notified', notified_at = now(), updated_at = now()
                WHERE id = ${reminder.id}::uuid
            `
            return true
        })
        if (!didNotify) break
        notified++
    }

    return notified
}

// Advisory lock: prevents concurrent runs across Node instances (blue-green overlap, future
// horizontal scale). Session-scoped, released automatically on crash. cron-lock is imported
// lazily so this module stays importable (e.g. in .db tests) without DATABASE_URL.
export async function runInboxCommandsWithLock(): Promise<void> {
    const { runWithLock } = await import('../lib/cron-lock')
    // jobs/index.ts schedules this every minute — cron-lock's 10-minute default budget would let
    // a hang eat up to 10 skipped ticks before it self-heals. 2 minutes bounds that to a couple of
    // ticks, which is still generous for what should be a fast dispatch loop.
    await runWithLock(INBOX_COMMANDS_LOCK_NAME, async () => {
        await processInboxCommands()
    }, { timeoutMs: 2 * 60 * 1000 })
}
