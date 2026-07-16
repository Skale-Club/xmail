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
import type { OutreachAttachmentInput } from './outreach-provider'
import type { InboxSendCommandMode, InboxRecipient } from '../../db/schema'
import type { InboxSendCommandDto } from './inbox-operator'

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
    attachmentIds: string[]
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
    /**
     * Resolve the command's ready, organization-owned attachments into content for the MIME.
     * Defaults to the private-Storage loader (inbox-attachments). Injectable for tests.
     */
    resolveAttachments?: (organizationId: string, attachmentIds: string[]) => Promise<OutreachAttachmentInput[]>
    /**
     * Return the subset of the given addresses that are suppressed for the organization (exact
     * address or @domain sentinel). Used to strip suppressed Cc/Bcc from a reply-all so a reply
     * respects suppression like campaign mail. The PRIMARY To is always policy-gated by the
     * dispatcher; this closes the fan-out gap. Defaults to the DB suppression query.
     */
    loadSuppressedAddresses?: (organizationId: string, addresses: string[]) => Promise<Set<string>>
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
    const primaryToLower = primaryTo.trim().toLowerCase()

    // Fan-out recipients (reply-all / forward). The PRIMARY To is fully policy-gated by the
    // dispatcher; Cc/Bcc are additionally filtered through the org's suppression list so a
    // suppressed address is never copied on a reply-all — suppression is respected for the
    // whole recipient set, not just the primary. The primary To is never in Cc/Bcc.
    const ccAddresses = command.ccRecipients.map((r) => r.address.trim().toLowerCase()).filter((a) => a && a !== primaryToLower)
    const bccAddresses = command.bccRecipients.map((r) => r.address.trim().toLowerCase()).filter((a) => a && a !== primaryToLower)
    let cc = dedupeAddresses(ccAddresses)
    let bcc = dedupeAddresses(bccAddresses).filter((a) => !cc.includes(a))
    if (cc.length > 0 || bcc.length > 0) {
        const suppressor = deps.loadSuppressedAddresses ?? defaultLoadSuppressedAddresses
        const suppressed = await suppressor(command.organizationId, [...cc, ...bcc])
        cc = cc.filter((a) => !suppressed.has(a))
        bcc = bcc.filter((a) => !suppressed.has(a))
    }

    // Resolve ready, org-owned attachments into MIME content (never base64 in the row). A retry
    // re-loads from Storage; the metadata + ownership were validated at command creation.
    let attachments: OutreachAttachmentInput[] | undefined
    if (command.attachmentIds.length > 0) {
        const resolver = deps.resolveAttachments ?? defaultResolveAttachments
        try {
            const resolved = await resolver(command.organizationId, command.attachmentIds)
            attachments = resolved.length > 0 ? resolved : undefined
        } catch (error) {
            // A missing/unreadable attachment must not silently send a reply WITHOUT the file the
            // operator attached. Fail (bounded by attempts) so the draft is preserved for retry.
            const code = sanitizeError(error)
            if (command.attempts >= command.maxAttempts) {
                await markFailed(sql, command, `attachment_unresolved:${code}`.slice(0, MAX_ERROR_LENGTH))
                return 'failed'
            }
            await reschedule(sql, command, new Date(now().getTime() + RETRY_BACKOFF_MS), { error: 'attachment_unresolved' })
            return 'rescheduled'
        }
    }

    const input: DispatchOutreachInput = {
        origin: 'unified_inbox',
        organizationId: command.organizationId,
        emailAccountId: command.emailAccountId,
        leadId,
        idempotencyKey: command.idempotencyKey,
        to: primaryTo,
        cc: cc.length > 0 ? cc : undefined,
        bcc: bcc.length > 0 ? bcc : undefined,
        attachments,
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

// ============================================================
// Server-side recipient + threading resolution (Phase 22 UIX-03)
// ============================================================
// A reply/reply-all/forward's recipients and RFC threading headers (In-Reply-To, References)
// are RESOLVED and VALIDATED here from the PERSISTED outreach_conversation_messages — never
// trusted from the client. The composer only chooses the mode, an optional source message, the
// (forward-only) recipients, and the body. Everything the mail actually gets addressed and
// threaded by is computed from the durable thread. This is a PURE function: fully unit-testable
// without a database.

export class InboxCommandResolutionError extends Error {
    code: string
    status: number
    constructor(code: string, message?: string, status = 400) {
        super(message ?? code)
        this.name = 'InboxCommandResolutionError'
        this.code = code
        this.status = status
    }
}

/** A persisted conversation message projected for resolution. Ordered oldest→newest by sortIndex. */
export interface PersistedThreadMessage {
    id: string
    direction: 'inbound' | 'outbound'
    internetMessageId: string | null
    inReplyTo: string | null
    messageReferences: string | null
    subject: string | null
    fromAddress: string | null
    fromName: string | null
    toAddresses: InboxRecipient[]
    ccAddresses: InboxRecipient[]
    replyToAddresses: InboxRecipient[]
    /** Sort order (ms of received/sent/created). Higher = later. */
    sortIndex: number
}

export interface ResolveSendCommandInput {
    mode: InboxSendCommandMode
    /** The sending account's address (lowercased-compared, always excluded from recipients). */
    accountAddress: string
    /** The persisted thread, any order (resolver sorts by sortIndex). */
    messages: PersistedThreadMessage[]
    /** Optional explicit source message; must exist in the thread or resolution fails. */
    sourceMessageId?: string | null
    /** Forward-only: the explicit recipients the operator typed. Required for forward. */
    forwardRecipients?: InboxRecipient[]
    /** Forward-only: optional explicit Cc. */
    forwardCc?: InboxRecipient[]
    /** Forward-only: optional subject override; otherwise `Fwd:`-derived from the source. */
    subjectOverride?: string | null
}

export interface ResolvedSendCommand {
    sourceMessageId: string | null
    to: InboxRecipient[]
    cc: InboxRecipient[]
    bcc: InboxRecipient[]
    subject: string
    inReplyTo: string | null
    references: string | null
}

const MAX_REFERENCES = 20
const MAX_REFERENCES_CHARS = 8000

function normalizeRecipient(r: InboxRecipient): InboxRecipient | null {
    const address = (r.address ?? '').trim().toLowerCase()
    if (!address) return null
    return { address, name: r.name?.trim() || null }
}

function dedupeRecipients(list: InboxRecipient[], exclude: Set<string>): InboxRecipient[] {
    const seen = new Set<string>(exclude)
    const out: InboxRecipient[] = []
    for (const raw of list) {
        const r = normalizeRecipient(raw)
        if (!r || seen.has(r.address)) continue
        seen.add(r.address)
        out.push(r)
    }
    return out
}

function stripSubjectPrefix(subject: string, re: RegExp): string {
    let s = subject.trim()
    // Strip any leading Re:/Fwd:/Fw: chain (case-insensitive), leaving the base subject once.
    while (re.test(s)) s = s.replace(re, '').trim()
    return s
}

function buildReferencesChain(existing: string | null, parentId: string | null): string | null {
    const chain: string[] = []
    const push = (token: string) => {
        const t = token.trim()
        if (t && !chain.includes(t)) chain.push(t)
    }
    if (existing) existing.split(/\s+/).forEach(push)
    if (parentId) push(parentId)
    if (chain.length === 0) return null
    // Bound the chain: keep the root (first) and the most recent ids, capping count + chars.
    let bounded = chain
    if (bounded.length > MAX_REFERENCES) {
        bounded = [bounded[0], ...bounded.slice(bounded.length - (MAX_REFERENCES - 1))]
    }
    let joined = bounded.join(' ')
    while (joined.length > MAX_REFERENCES_CHARS && bounded.length > 2) {
        bounded = [bounded[0], ...bounded.slice(2)]
        joined = bounded.join(' ')
    }
    return joined.slice(0, MAX_REFERENCES_CHARS)
}

function pickSourceMessage(input: ResolveSendCommandInput, ordered: PersistedThreadMessage[]): PersistedThreadMessage {
    if (ordered.length === 0) throw new InboxCommandResolutionError('no_source_message', 'Thread has no messages to act on')
    if (input.sourceMessageId) {
        const found = ordered.find((m) => m.id === input.sourceMessageId)
        if (!found) throw new InboxCommandResolutionError('source_message_not_found', 'Source message is not part of this thread')
        return found
    }
    if (input.mode === 'forward') return ordered[ordered.length - 1]
    // reply / reply_all: default to the latest INBOUND message (the reply we are answering).
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
        if (ordered[i].direction === 'inbound') return ordered[i]
    }
    return ordered[ordered.length - 1]
}

/** Resolve recipients + threading headers from the persisted thread. Pure, client-input-free. */
export function resolveSendCommand(input: ResolveSendCommandInput): ResolvedSendCommand {
    const self = input.accountAddress.trim().toLowerCase()
    const selfSet = new Set<string>(self ? [self] : [])
    const ordered = [...input.messages].sort((a, b) => a.sortIndex - b.sortIndex)

    if (input.mode === 'forward') {
        const source = pickSourceMessage(input, ordered)
        const to = dedupeRecipients(input.forwardRecipients ?? [], new Set())
        if (to.length === 0) throw new InboxCommandResolutionError('forward_recipients_required', 'A forward needs at least one recipient')
        const cc = dedupeRecipients(input.forwardCc ?? [], new Set(to.map((r) => r.address)))
        const baseSubject = input.subjectOverride?.trim() || stripSubjectPrefix(source.subject ?? '', /^(re|fwd?|fw)\s*:\s*/i)
        return {
            sourceMessageId: source.id,
            to,
            cc,
            bcc: [],
            subject: `Fwd: ${baseSubject || '(no subject)'}`.slice(0, 2000),
            // A forward starts a new thread — no In-Reply-To/References by default.
            inReplyTo: null,
            references: null,
        }
    }

    const source = pickSourceMessage(input, ordered)

    // Primary reply target: the source's Reply-To, else its From, else (replying to our own
    // outbound) the original To — always excluding the sending account.
    const replyTo = dedupeRecipients(source.replyToAddresses, new Set())
    const fromRecipient = source.fromAddress
        ? normalizeRecipient({ address: source.fromAddress, name: source.fromName })
        : null
    let primaryPool: InboxRecipient[] = []
    if (replyTo.length > 0) primaryPool = replyTo
    else if (fromRecipient && !selfSet.has(fromRecipient.address)) primaryPool = [fromRecipient]
    else primaryPool = dedupeRecipients(source.toAddresses, new Set())

    const to = dedupeRecipients(primaryPool, selfSet).slice(0, 1)
    if (to.length === 0) {
        throw new InboxCommandResolutionError('no_reply_recipient', 'Could not resolve a reply recipient that is not the sending account')
    }

    let cc: InboxRecipient[] = []
    if (input.mode === 'reply_all') {
        const excluded = new Set<string>([...selfSet, ...to.map((r) => r.address)])
        cc = dedupeRecipients([...primaryPool, ...source.toAddresses, ...source.ccAddresses], excluded)
    }

    const baseSubject = stripSubjectPrefix(source.subject ?? '', /^(re|fwd?|fw)\s*:\s*/i)
    return {
        sourceMessageId: source.id,
        to,
        cc,
        bcc: [],
        subject: `Re: ${baseSubject || '(no subject)'}`.slice(0, 2000),
        inReplyTo: source.internetMessageId ?? null,
        references: buildReferencesChain(source.messageReferences, source.internetMessageId),
    }
}

// ============================================================
// Durable command creation (route hands off; never dispatches inline)
// ============================================================
// The route resolves the thread server-side and persists a durable command. There is NO
// dispatch capability on this path — the only side effect is persistCommand. The claimer
// (processInboxCommands) later hands the command to executeInboxSendCommand, the sole
// policy-gated dispatcher.

export interface CreateResolvedSendCommandRequest {
    organizationId: string
    conversationId: string
    actorUserId: string
    emailAccountId: string
    mode: InboxSendCommandMode
    sourceMessageId?: string | null
    /** Forward-only recipients (validated as emails by the route schema). */
    forwardRecipients?: InboxRecipient[]
    forwardCc?: InboxRecipient[]
    subject?: string | null
    bodyText?: string | null
    bodyHtml?: string | null
    attachmentIds?: string[]
    scheduledAt?: Date | null
    idempotencyKey?: string
    now?: Date
}

export interface PersistResolvedCommandArgs {
    organizationId: string
    conversationId: string
    actorUserId: string
    emailAccountId: string
    mode: InboxSendCommandMode
    sourceMessageId: string | null
    to: InboxRecipient[]
    cc: InboxRecipient[]
    bcc: InboxRecipient[]
    subject: string
    bodyText: string | null
    bodyHtml: string | null
    inReplyTo: string | null
    references: string | null
    attachmentIds: string[]
    scheduledAt: Date | null
    idempotencyKey?: string
}

export interface CreateResolvedSendCommandDeps {
    loadConversation: (organizationId: string, conversationId: string) => Promise<{ leadId: string | null } | null>
    loadAccountAddress: (organizationId: string, emailAccountId: string) => Promise<string | null>
    loadThreadMessages: (organizationId: string, conversationId: string) => Promise<PersistedThreadMessage[]>
    validateAttachments: (organizationId: string, attachmentIds: string[]) => Promise<void>
    persistCommand: (args: PersistResolvedCommandArgs) => Promise<{ command: InboxSendCommandDto; created: boolean }>
}

export async function createResolvedSendCommand(
    request: CreateResolvedSendCommandRequest,
    deps?: CreateResolvedSendCommandDeps,
): Promise<{ command: InboxSendCommandDto; created: boolean }> {
    const d = deps ?? defaultCreateResolvedSendCommandDeps()

    const conversation = await d.loadConversation(request.organizationId, request.conversationId)
    if (!conversation) throw new InboxCommandResolutionError('conversation_not_found', 'Conversation not found', 404)

    const accountAddress = await d.loadAccountAddress(request.organizationId, request.emailAccountId)
    if (!accountAddress) throw new InboxCommandResolutionError('account_not_found', 'Sending account not found', 404)

    const attachmentIds = request.attachmentIds ?? []
    if (attachmentIds.length > 0) {
        await d.validateAttachments(request.organizationId, attachmentIds)
    }

    const messages = await d.loadThreadMessages(request.organizationId, request.conversationId)
    const resolved = resolveSendCommand({
        mode: request.mode,
        accountAddress,
        messages,
        sourceMessageId: request.sourceMessageId,
        forwardRecipients: request.forwardRecipients,
        forwardCc: request.forwardCc,
        subjectOverride: request.subject,
    })

    return d.persistCommand({
        organizationId: request.organizationId,
        conversationId: request.conversationId,
        actorUserId: request.actorUserId,
        emailAccountId: request.emailAccountId,
        mode: request.mode,
        sourceMessageId: resolved.sourceMessageId,
        to: resolved.to,
        cc: resolved.cc,
        bcc: resolved.bcc,
        subject: resolved.subject,
        bodyText: request.bodyText ?? null,
        bodyHtml: request.bodyHtml ?? null,
        inReplyTo: resolved.inReplyTo,
        references: resolved.references,
        attachmentIds,
        scheduledAt: request.scheduledAt ?? null,
        idempotencyKey: request.idempotencyKey,
    })
}

/** Production deps: org-scoped DB reads + createInboxSendCommand + attachment ownership. Lazily imported. */
export function defaultCreateResolvedSendCommandDeps(): CreateResolvedSendCommandDeps {
    return {
        async loadConversation(organizationId, conversationId) {
            const { db } = await import('../../db')
            const { and, eq } = await import('drizzle-orm')
            const { outreachConversations } = await import('../../db/schema')
            const rows = await db
                .select({ leadId: outreachConversations.leadId })
                .from(outreachConversations)
                .where(and(eq(outreachConversations.organizationId, organizationId), eq(outreachConversations.id, conversationId)))
                .limit(1)
            return rows[0] ? { leadId: rows[0].leadId ?? null } : null
        },
        async loadAccountAddress(organizationId, emailAccountId) {
            const { db } = await import('../../db')
            const { and, eq } = await import('drizzle-orm')
            const { emailAccounts } = await import('../../db/schema')
            const rows = await db
                .select({ email: emailAccounts.email })
                .from(emailAccounts)
                .where(and(eq(emailAccounts.organizationId, organizationId), eq(emailAccounts.id, emailAccountId)))
                .limit(1)
            return rows[0]?.email ?? null
        },
        async loadThreadMessages(organizationId, conversationId) {
            const { db } = await import('../../db')
            const { and, eq } = await import('drizzle-orm')
            const { outreachConversationMessages } = await import('../../db/schema')
            const rows = await db
                .select()
                .from(outreachConversationMessages)
                .where(and(
                    eq(outreachConversationMessages.organizationId, organizationId),
                    eq(outreachConversationMessages.conversationId, conversationId),
                ))
            return rows.map((row) => ({
                id: row.id,
                direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
                internetMessageId: row.internetMessageId,
                inReplyTo: row.inReplyTo,
                messageReferences: row.messageReferences,
                subject: row.subject,
                fromAddress: row.fromAddress,
                fromName: row.fromName,
                toAddresses: (row.toAddresses ?? []).map((a) => ({ address: a.address, name: a.name ?? null })),
                ccAddresses: (row.ccAddresses ?? []).map((a) => ({ address: a.address, name: a.name ?? null })),
                replyToAddresses: (row.replyToAddresses ?? []).map((a) => ({ address: a.address, name: a.name ?? null })),
                sortIndex: (row.receivedAt ?? row.sentAt ?? row.createdAt).getTime(),
            }))
        },
        async validateAttachments(organizationId, attachmentIds) {
            const { assertAttachmentsUsable, InboxAttachmentError } = await import('./inbox-attachments')
            try {
                await assertAttachmentsUsable(organizationId, attachmentIds)
            } catch (error) {
                if (error instanceof InboxAttachmentError) {
                    throw new InboxCommandResolutionError(error.code, error.message, error.status)
                }
                throw error
            }
        },
        async persistCommand(args) {
            const { createInboxSendCommand } = await import('./inbox-operator')
            const result = await createInboxSendCommand({
                organizationId: args.organizationId,
                conversationId: args.conversationId,
                actorUserId: args.actorUserId,
                emailAccountId: args.emailAccountId,
                mode: args.mode,
                sourceMessageId: args.sourceMessageId,
                to: args.to,
                cc: args.cc,
                bcc: args.bcc,
                subject: args.subject,
                bodyText: args.bodyText,
                bodyHtml: args.bodyHtml,
                inReplyTo: args.inReplyTo,
                references: args.references,
                attachmentIds: args.attachmentIds,
                scheduledAt: args.scheduledAt,
                idempotencyKey: args.idempotencyKey,
            })
            if (result.created && args.attachmentIds.length > 0) {
                const { bindAttachmentsToCommand } = await import('./inbox-attachments')
                await bindAttachmentsToCommand(args.organizationId, result.command.id, args.attachmentIds)
            }
            return result
        },
    }
}

function dedupeAddresses(addresses: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const a of addresses) {
        if (!a || seen.has(a)) continue
        seen.add(a)
        out.push(a)
    }
    return out
}

async function defaultResolveAttachments(organizationId: string, attachmentIds: string[]): Promise<OutreachAttachmentInput[]> {
    const { loadAttachmentsForDispatch } = await import('./inbox-attachments')
    return loadAttachmentsForDispatch(organizationId, attachmentIds)
}

/**
 * Default org-scoped suppression lookup for Cc/Bcc fan-out. Matches the exact address AND the
 * lowercased `@domain` sentinel (the same model the delivery policy enforces), so a reply-all
 * never copies a suppressed address or a suppressed domain. Lazily imports the DB.
 */
async function defaultLoadSuppressedAddresses(organizationId: string, addresses: string[]): Promise<Set<string>> {
    if (addresses.length === 0) return new Set()
    const { db } = await import('../../db')
    const { and, eq, inArray } = await import('drizzle-orm')
    const { suppressions } = await import('../../db/schema')
    const lowered = addresses.map((a) => a.trim().toLowerCase())
    const domains = Array.from(new Set(lowered.map((a) => `@${a.split('@')[1] ?? ''}`).filter((d) => d.length > 1)))
    const candidates = Array.from(new Set([...lowered, ...domains]))
    const rows = await db
        .select({ emailAddress: suppressions.emailAddress })
        .from(suppressions)
        .where(and(eq(suppressions.organizationId, organizationId), inArray(suppressions.emailAddress, candidates)))
    const suppressedExact = new Set(rows.map((r) => r.emailAddress.toLowerCase()))
    const result = new Set<string>()
    for (const address of lowered) {
        const domainSentinel = `@${address.split('@')[1] ?? ''}`
        if (suppressedExact.has(address) || suppressedExact.has(domainSentinel)) result.add(address)
    }
    return result
}

export { randomUUID as inboxCommandLeaseToken }
