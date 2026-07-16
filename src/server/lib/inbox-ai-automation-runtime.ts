// ============================================================
// Production wiring for autonomous inbox AI automation (Phase 23 AI-03/04).
// ============================================================
// The pure decision/scheduling logic lives in `inbox-ai-automation.ts` (DB-free, fully unit-tested).
// THIS module binds it to the real database + the single Phase 22 executor, so the pure module stays
// importable without DATABASE_URL and the "structurally incapable of dispatching" proof stays clean.
//
// It NEVER imports a provider adapter and NEVER calls the low-level threaded sender or the shared
// outreach dispatcher. Its only send capability is handing a durable command to the SINGLE
// `executeInboxSendCommand` executor — which alone evaluates the Phase 18 delivery policy.

import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import { db, queryClient } from '../../db'
import {
    campaignLeads,
    campaigns,
    emailAccounts,
    leads,
    organizations,
    organizationUsers,
    outreachAiRuns,
    outreachAiSettings,
    outreachConversationMessages,
    outreachConversations,
    suppressions,
    type OutreachAiRun,
} from '../../db/schema'
import { createDrizzleAiRunStore } from './inbox-ai-audit'
import { buildSourceKey } from './unified-inbox/normalize'
import {
    executeInboxSendCommand,
    resolveSendCommand,
    type ClaimedInboxCommand,
    type InboxSql,
    type PersistedThreadMessage,
} from './inbox-command-dispatch'
import { createInboxSendCommand } from './inbox-operator'
import { requestAiDraftProposal } from './outreach-followup'
import {
    scheduleAutonomousAiRun,
    processAutonomousAiRun,
    isAutonomousRunClaimable,
    type AutonomousDispatchResult,
    type AutonomousRunResolution,
    type CreateAutonomousCommandArgs,
    type EffectiveAutonomyInputs,
    type ProcessAutonomousAiRunOutcome,
    type ScheduleAutonomousAiRunInput,
    type ScheduleAutonomousAiRunOutcome,
} from './inbox-ai-automation'
import type { InboxAiContextMessage } from './inbox-ai-context'
import { createLogger } from './logger'

const log = createLogger('outreach.aiAutomation')

const AUTONOMOUS_RUN_BATCH_LIMIT = 100
const COMMAND_LEASE_MINUTES = 5

// ------------------------------------------------------------
// Effective-autonomy inputs (the intersection controls)
// ------------------------------------------------------------

/**
 * Load the effective-autonomy control inputs for an org+campaign. Returns null when the campaign is
 * missing (the run has nothing to reason about). The org kill switch (`autonomy_paused_at`), the
 * org/campaign opt-in flags, the campaign active state, and the org-wide outreach kill switch are all
 * read here so the pure predicate can compute the intersection.
 */
export async function loadEffectiveAutonomyInputs(
    organizationId: string,
    campaignId: string | null,
): Promise<EffectiveAutonomyInputs | null> {
    if (!campaignId) return null

    const [settingsRow] = await db
        .select({
            autonomousEnabled: outreachAiSettings.autonomousEnabled,
            autonomyPausedAt: outreachAiSettings.autonomyPausedAt,
        })
        .from(outreachAiSettings)
        .where(eq(outreachAiSettings.organizationId, organizationId))
        .limit(1)

    const [orgRow] = await db
        .select({ outreachEnabled: organizations.outreachEnabled })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)

    const [campaignRow] = await db
        .select({ status: campaigns.status, aiAutonomousEnabled: campaigns.aiAutonomousEnabled })
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)))
        .limit(1)

    if (!campaignRow) return null

    return {
        orgAutonomousEnabled: settingsRow?.autonomousEnabled ?? false,
        orgAutonomyPausedAt: settingsRow?.autonomyPausedAt ?? null,
        campaignAiAutonomousEnabled: campaignRow.aiAutonomousEnabled,
        campaignActive: campaignRow.status === 'active',
        outreachEnabled: orgRow?.outreachEnabled ?? false,
    }
}

// ------------------------------------------------------------
// Task 1 — scheduling from a persisted inbound reply
// ------------------------------------------------------------

export interface ScheduleAutonomousFollowUpInput {
    organizationId: string
    emailAccountId: string
    campaignId: string
    campaignLeadId: string
    leadId: string
    provider: string
    providerMessageId: string
    /** The normalized inbound Message-ID (stable idempotency ref even before materialization). */
    triggerRef: string
    /** True when the matched inbound reply carried a usable body. */
    hasInboundBody: boolean
}

/**
 * Schedule (idempotently) an autonomous run for a just-matched inbound reply. Resolves the persisted
 * conversation + trigger message when it has already been materialized (best-effort link), loads the
 * effective-autonomy inputs, checks unsubscribe/suppression, and delegates the eligibility gate to
 * the pure `scheduleAutonomousAiRun`. Never sends. Errors are swallowed to a skip — a scheduling
 * failure must never break reply processing.
 */
export async function scheduleAutonomousFollowUp(
    input: ScheduleAutonomousFollowUpInput,
): Promise<ScheduleAutonomousAiRunOutcome> {
    try {
        const persisted = await resolvePersistedInbound(input)
        const leadUnsubscribed = await isLeadUnsubscribed(input.leadId)
        const leadSuppressed = await isRecipientSuppressed(input.organizationId, input.leadId)

        const scheduleInput: ScheduleAutonomousAiRunInput = {
            organizationId: input.organizationId,
            conversationId: persisted?.conversationId ?? null,
            triggerMessageId: persisted?.messageId ?? null,
            campaignId: input.campaignId,
            campaignLeadId: input.campaignLeadId,
            triggerKind: 'reply',
            hasInboundBody: input.hasInboundBody,
            leadUnsubscribed,
            leadSuppressed,
            triggerRef: input.triggerRef,
        }

        const outcome = await scheduleAutonomousAiRun(
            { store: createDrizzleAiRunStore(), loadAutonomy: (a) => loadEffectiveAutonomyInputs(a.organizationId, a.campaignId) },
            scheduleInput,
        )
        if (outcome.status === 'scheduled' && outcome.created) {
            log.info({
                action: 'outreach.aiAutomation.scheduled',
                organizationId: input.organizationId,
                campaignId: input.campaignId,
                runId: outcome.run.id,
            }, 'scheduled autonomous AI follow-up run')
        }
        return outcome
    } catch (error) {
        log.warn({
            action: 'outreach.aiAutomation.schedule_failed',
            organizationId: input.organizationId,
            error: { message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
        }, 'autonomous follow-up scheduling failed (no run created)')
        return { status: 'skipped', reason: 'schedule_error' }
    }
}

async function resolvePersistedInbound(input: ScheduleAutonomousFollowUpInput): Promise<{ conversationId: string; messageId: string } | null> {
    const sourceKey = buildSourceKey(input.provider as never, input.providerMessageId)
    const [row] = await db
        .select({ id: outreachConversationMessages.id, conversationId: outreachConversationMessages.conversationId })
        .from(outreachConversationMessages)
        .where(and(
            eq(outreachConversationMessages.organizationId, input.organizationId),
            eq(outreachConversationMessages.emailAccountId, input.emailAccountId),
            eq(outreachConversationMessages.sourceKey, sourceKey),
        ))
        .limit(1)
    return row ? { conversationId: row.conversationId, messageId: row.id } : null
}

async function isLeadUnsubscribed(leadId: string): Promise<boolean> {
    const [row] = await db.select({ unsubscribedAt: leads.unsubscribedAt }).from(leads).where(eq(leads.id, leadId)).limit(1)
    return row?.unsubscribedAt != null
}

async function isRecipientSuppressed(organizationId: string, leadId: string): Promise<boolean> {
    const [leadRow] = await db.select({ email: leads.email }).from(leads).where(eq(leads.id, leadId)).limit(1)
    const email = leadRow?.email?.trim().toLowerCase()
    if (!email) return false
    const domainSentinel = `@${email.split('@')[1] ?? ''}`
    const rows = await db
        .select({ emailAddress: suppressions.emailAddress })
        .from(suppressions)
        .where(eq(suppressions.organizationId, organizationId))
    const set = new Set(rows.map((r) => r.emailAddress.toLowerCase()))
    return set.has(email) || (domainSentinel.length > 1 && set.has(domainSentinel))
}

// ------------------------------------------------------------
// Task 2 — process due autonomous runs (leased) through the shared command/executor
// ------------------------------------------------------------

/** The org-scoped resolution the processor needs, built from persisted state under the run's org. */
async function resolveAutonomousRun(run: OutreachAiRun): Promise<AutonomousRunResolution | null> {
    const organizationId = run.organizationId
    if (!run.campaignId || !run.campaignLeadId) return null

    const [campaignLead] = await db
        .select({
            id: campaignLeads.id,
            leadId: campaignLeads.leadId,
            assignedEmailAccountId: campaignLeads.assignedEmailAccountId,
            followUpCount: campaignLeads.followUpCount,
        })
        .from(campaignLeads)
        .where(eq(campaignLeads.id, run.campaignLeadId))
        .limit(1)
    if (!campaignLead || !campaignLead.assignedEmailAccountId) return null

    const autonomy = await loadEffectiveAutonomyInputs(organizationId, run.campaignId)
    if (!autonomy) return null

    const [campaign] = await db
        .select({ name: campaigns.name, fromName: campaigns.fromName, maxFollowUps: campaigns.maxFollowUps })
        .from(campaigns)
        .where(and(eq(campaigns.id, run.campaignId), eq(campaigns.organizationId, organizationId)))
        .limit(1)
    if (!campaign) return null

    const [settings] = await db
        .select({ maxAutonomousFollowUps: outreachAiSettings.maxAutonomousFollowUps })
        .from(outreachAiSettings)
        .where(eq(outreachAiSettings.organizationId, organizationId))
        .limit(1)

    const [account] = await db
        .select({ email: emailAccounts.email })
        .from(emailAccounts)
        .where(and(eq(emailAccounts.id, campaignLead.assignedEmailAccountId), eq(emailAccounts.organizationId, organizationId)))
        .limit(1)
    if (!account) return null

    // Resolve the conversation: prefer the run's stored conversation, else the account+lead thread.
    const conversation = await resolveConversation(organizationId, run.conversationId, campaignLead.assignedEmailAccountId, run.campaignLeadId)
    if (!conversation) return null

    const [lead] = await db
        .select({ email: leads.email, firstName: leads.firstName, company: leads.companyName })
        .from(leads)
        .where(eq(leads.id, campaignLead.leadId))
        .limit(1)

    const messageRows = await db
        .select()
        .from(outreachConversationMessages)
        .where(and(
            eq(outreachConversationMessages.organizationId, organizationId),
            eq(outreachConversationMessages.conversationId, conversation.id),
        ))

    const contextMessages: InboxAiContextMessage[] = messageRows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        conversationId: row.conversationId,
        direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
        subject: row.subject,
        fromAddress: row.fromAddress,
        fromName: row.fromName,
        toAddresses: (row.toAddresses ?? []).map((a) => ({ address: a.address, name: a.name ?? null })),
        ccAddresses: (row.ccAddresses ?? []).map((a) => ({ address: a.address, name: a.name ?? null })),
        plainBody: row.plainBody,
        htmlBody: row.htmlBody,
        sentAt: row.sentAt,
        receivedAt: row.receivedAt,
        createdAt: row.createdAt,
    }))

    const threadMessages: PersistedThreadMessage[] = messageRows.map((row) => ({
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

    // The recipient/account/threading come ENTIRELY from the persisted conversation — a reply to the
    // latest inbound message, exactly like the Phase 22 operator reply resolver. The model never
    // contributes to this.
    const resolvedSend = resolveSendCommand({ mode: 'reply', accountAddress: account.email, messages: threadMessages })

    const orgMax = settings?.maxAutonomousFollowUps ?? 0
    const maxAutonomousFollowUps = Math.min(orgMax, campaign.maxFollowUps)

    return {
        autonomy,
        contextInput: {
            organizationId,
            conversationId: conversation.id,
            accountAddress: account.email,
            messages: contextMessages,
            campaign: { id: run.campaignId, name: campaign.name },
            lead: lead ? { email: lead.email, firstName: lead.firstName, company: lead.company } : null,
            sellerName: campaign.fromName ?? null,
        },
        conversationId: conversation.id,
        emailAccountId: campaignLead.assignedEmailAccountId,
        resolvedSend,
        autonomousFollowUpsSent: campaignLead.followUpCount,
        maxAutonomousFollowUps,
        toneGoal: null,
    }
}

async function resolveConversation(
    organizationId: string,
    conversationId: string | null,
    emailAccountId: string,
    campaignLeadId: string,
): Promise<{ id: string } | null> {
    if (conversationId) {
        const [row] = await db
            .select({ id: outreachConversations.id })
            .from(outreachConversations)
            .where(and(eq(outreachConversations.organizationId, organizationId), eq(outreachConversations.id, conversationId)))
            .limit(1)
        if (row) return row
    }
    const [row] = await db
        .select({ id: outreachConversations.id })
        .from(outreachConversations)
        .where(and(
            eq(outreachConversations.organizationId, organizationId),
            eq(outreachConversations.emailAccountId, emailAccountId),
            eq(outreachConversations.campaignLeadId, campaignLeadId),
        ))
        .orderBy(desc(outreachConversations.lastMessageAt))
        .limit(1)
    return row ?? null
}

/** Resolve a real org user to attribute the durable command to (the command requires an actor). */
async function resolveActorUser(organizationId: string): Promise<string | null> {
    const rows = await db
        .select({ userId: organizationUsers.userId, role: organizationUsers.role })
        .from(organizationUsers)
        .where(eq(organizationUsers.organizationId, organizationId))
    if (rows.length === 0) return null
    const admin = rows.find((r) => r.role === 'admin')
    return (admin ?? rows[0]).userId
}

/** Create the durable Phase 22 command from the deterministic resolution (never the model). */
async function createAutonomousCommand(args: CreateAutonomousCommandArgs): Promise<{ commandId: string; created: boolean }> {
    const actorUserId = await resolveActorUser(args.organizationId)
    if (!actorUserId) throw new Error('no_org_actor')
    const result = await createInboxSendCommand({
        organizationId: args.organizationId,
        conversationId: args.conversationId,
        actorUserId,
        emailAccountId: args.emailAccountId,
        mode: 'reply',
        sourceMessageId: args.resolvedSend.sourceMessageId,
        to: args.resolvedSend.to,
        cc: args.resolvedSend.cc,
        bcc: args.resolvedSend.bcc,
        subject: args.subject,
        bodyText: args.bodyText,
        inReplyTo: args.resolvedSend.inReplyTo,
        references: args.resolvedSend.references,
        idempotencyKey: args.idempotencyKey,
    })
    return { commandId: result.command.id, created: result.created }
}

interface CommandClaimRow {
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

function coerceArray<T>(value: unknown): T[] {
    if (Array.isArray(value)) return value as T[]
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            return Array.isArray(parsed) ? (parsed as T[]) : []
        } catch {
            return []
        }
    }
    return []
}

/**
 * Hand a just-created durable command to the SINGLE executor. Claims the command with a lease so the
 * autonomous processor dispatches it exactly once; if a concurrent inbox-commands tick already claimed
 * it, we read back its committed disposition instead of racing. The executor evaluates the Phase 18
 * delivery policy and holds ambiguous outcomes — this module never dispatches directly.
 */
async function dispatchAutonomousCommand(args: { commandId: string; organizationId: string }): Promise<AutonomousDispatchResult> {
    const sql = queryClient as unknown as InboxSql
    const leaseToken = randomUUID()

    const claimed = await sql<CommandClaimRow[]>`
        WITH candidate AS (
            SELECT id FROM inbox_send_commands
            WHERE id = ${args.commandId}::uuid
              AND organization_id = ${args.organizationId}::uuid
              AND status IN ('scheduled', 'queued')
              AND due_at <= now()
              AND attempts < max_attempts
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE inbox_send_commands c
        SET status = 'sending',
            lease_token = ${leaseToken}::uuid,
            lease_expires_at = now() + (${COMMAND_LEASE_MINUTES}::int * interval '1 minute'),
            attempts = c.attempts + 1,
            updated_at = now()
        FROM candidate
        WHERE c.id = candidate.id
        RETURNING c.id, c.organization_id, c.conversation_id, c.email_account_id, c.actor_user_id,
            c.mode, c.to_recipients, c.cc_recipients, c.bcc_recipients, c.subject, c.body_text, c.body_html,
            c.in_reply_to, c.message_references, c.attachment_ids, c.idempotency_key, c.attempts, c.max_attempts
    `

    const row = claimed[0]
    if (!row) {
        // Another tick owns it, or it is already terminal — read the committed state, never resend.
        return readCommandDisposition(sql, args)
    }

    const command: ClaimedInboxCommand = {
        id: row.id,
        organizationId: row.organization_id,
        conversationId: row.conversation_id,
        emailAccountId: row.email_account_id,
        actorUserId: row.actor_user_id,
        mode: row.mode,
        toRecipients: coerceArray(row.to_recipients),
        ccRecipients: coerceArray(row.cc_recipients),
        bccRecipients: coerceArray(row.bcc_recipients),
        subject: row.subject,
        bodyText: row.body_text,
        bodyHtml: row.body_html,
        inReplyTo: row.in_reply_to,
        messageReferences: row.message_references,
        attachmentIds: coerceArray(row.attachment_ids),
        idempotencyKey: row.idempotency_key,
        leaseToken,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
    }

    const outcome = await executeInboxSendCommand(command, { sql })
    const disposition = await readCommandDisposition(sql, args)
    // Prefer the executor's own disposition; the read-back supplies the resulting email id.
    return { ...disposition, outcome: mapExecutorOutcome(outcome) }
}

function mapExecutorOutcome(outcome: 'sent' | 'rescheduled' | 'failed' | 'held' | 'lost'): AutonomousDispatchResult['outcome'] {
    return outcome
}

async function readCommandDisposition(sql: InboxSql, args: { commandId: string; organizationId: string }): Promise<AutonomousDispatchResult> {
    const rows = await sql<{ status: string; resulting_outreach_email_id: string | null; last_policy_code: string | null; last_error: string | null }[]>`
        SELECT status, resulting_outreach_email_id, last_policy_code, last_error
        FROM inbox_send_commands
        WHERE id = ${args.commandId}::uuid AND organization_id = ${args.organizationId}::uuid
    `
    const row = rows[0]
    if (!row) return { outcome: 'failed', errorCode: 'command_missing' }
    const outreachEmailId = row.resulting_outreach_email_id
    switch (row.status) {
        case 'sent':
            return { outcome: 'sent', outreachEmailId, policyCode: row.last_policy_code }
        case 'held':
            return { outcome: 'held', policyCode: row.last_policy_code }
        case 'failed':
            return { outcome: 'failed', errorCode: row.last_error ?? 'dispatch_failed', policyCode: row.last_policy_code }
        case 'sending':
            return { outcome: 'lost' }
        default:
            return { outcome: 'rescheduled', policyCode: row.last_policy_code }
    }
}

/** Production processing deps: the pure processor wired to the real store/adapter/command/executor. */
function createProcessDeps() {
    return {
        store: createDrizzleAiRunStore(),
        resolveRun: (run: OutreachAiRun) => resolveAutonomousRun(run),
        requestProposal: requestAiDraftProposal,
        createCommand: createAutonomousCommand,
        dispatchCommand: dispatchAutonomousCommand,
        reloadAutonomy: (run: OutreachAiRun) => loadEffectiveAutonomyInputs(run.organizationId, run.campaignId),
    }
}

/**
 * Log a GLOBAL, tenant-content-free snapshot of autonomous automation enablement at startup so an
 * operator can immediately see the effective kill-control posture (how many orgs have autonomy on,
 * and how many are paused) without any org id, campaign, or message content in the log.
 */
export async function logAutonomousAutomationStatus(): Promise<void> {
    try {
        const rows = await db
            .select({ enabled: outreachAiSettings.autonomousEnabled, pausedAt: outreachAiSettings.autonomyPausedAt })
            .from(outreachAiSettings)
        let autonomyEnabled = 0
        let autonomyPaused = 0
        for (const row of rows) {
            if (row.enabled) autonomyEnabled += 1
            if (row.pausedAt != null) autonomyPaused += 1
        }
        log.info({
            action: 'outreach.aiAutomation.status',
            orgsWithSettings: rows.length,
            autonomyEnabled,
            autonomyDisabled: rows.length - autonomyEnabled,
            autonomyPaused,
        }, 'autonomous AI automation kill-control posture')
    } catch (error) {
        log.warn({
            action: 'outreach.aiAutomation.status_failed',
            error: { message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) },
        }, 'could not read autonomous automation status')
    }
}

export interface ProcessAutonomousRunsResult {
    claimable: number
    processed: number
    sent: number
    held: number
    deferred: number
    failed: number
    noAction: number
    skipped: number
}

/**
 * Claim + process a bounded batch of due autonomous runs. Deterministic ordered selection (oldest
 * first, org-wide) with per-run leases; each run flows through the pure processor and, for a valid
 * send decision, the single executor. Structured logs carry run/command/org ids + codes, never bodies.
 */
export async function processDueAutonomousRuns(now = new Date()): Promise<ProcessAutonomousRunsResult> {
    const result: ProcessAutonomousRunsResult = {
        claimable: 0, processed: 0, sent: 0, held: 0, deferred: 0, failed: 0, noAction: 0, skipped: 0,
    }
    const deps = createProcessDeps()

    // Deterministic ordered candidate selection: pending / due-deferred / lease-expired autonomous
    // runs, oldest first. Per-run claim leases (inside the processor) serialize concurrent instances.
    const candidates = await db
        .select()
        .from(outreachAiRuns)
        .where(eq(outreachAiRuns.runKind, 'autonomous'))
        .orderBy(asc(outreachAiRuns.createdAt))
        .limit(AUTONOMOUS_RUN_BATCH_LIMIT)

    for (const run of candidates) {
        if (!isAutonomousRunClaimable(run, now)) continue
        result.claimable++
        let outcome: ProcessAutonomousAiRunOutcome
        try {
            outcome = await processAutonomousAiRun(deps, run)
        } catch (error) {
            result.failed++
            log.error({
                action: 'outreach.aiAutomation.process_failed',
                organizationId: run.organizationId,
                runId: run.id,
                error: { message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
            }, 'autonomous run processing threw')
            continue
        }
        result.processed++
        switch (outcome.status) {
            case 'sent': result.sent++; break
            case 'held': result.held++; break
            case 'deferred': result.deferred++; break
            case 'failed': result.failed++; break
            case 'no_action': result.noAction++; break
            case 'skipped': result.skipped++; break
        }
        log.info({
            action: 'outreach.aiAutomation.processed',
            organizationId: run.organizationId,
            runId: run.id,
            outcome: outcome.status,
        }, 'processed autonomous AI run')
    }

    return result
}
