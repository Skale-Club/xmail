// ============================================================
// Phase 23 AI-02 — human-in-the-loop inbox suggestion orchestrator (no-send by construction)
// ============================================================
// This module turns a persisted conversation into an EDITABLE draft suggestion + an audit run. It is
// the core of the on-demand suggestion endpoint (src/server/routes/outreach/unified-inbox.ts).
//
// It is STRUCTURALLY INCAPABLE OF SENDING (locked decision #6): it imports NO dispatcher, NO send
// command factory, and NO provider adapter. Its only external effect is (a) creating/updating an
// audit run through an injected `AiRunStore`, and (b) asking the injected proposal adapter for a
// DRAFT PROPOSAL. Even a prompt-injection body in the thread can, at worst, become an
// awaiting-approval draft — never a send. The operator later sends via the separate Phase 22 path.
//
// Fail-closed everywhere (locked decision #8): missing config, timeout, malformed/unsafe output, a
// missing inbound body, or a disabled draft setting all resolve to an inspectable no-send outcome
// (a `failed`/`completed` run or a clean `not_enabled` gate) — never a send and never an infinite
// retry (bounded attempts + leases live in inbox-ai-audit.ts).
//
// Every dependency is INJECTED so the whole orchestrator is unit-tested without a database or network.

import {
    buildInboxAiContext,
    InboxAiContextError,
    type BuildInboxAiContextInput,
} from './inbox-ai-context'
import {
    createAiRun,
    claimAiRun,
    completeAiRun,
    failAiRun,
    AiRunError,
    type AiRunRecord,
    type AiRunStore,
} from './inbox-ai-audit'
import type { AiDraftAdapterInput, AiDraftProposalResult } from './outreach-followup'

/** The stable prompt/template version recorded on every draft run for reproducibility/audit. */
export const INBOX_DRAFT_PROMPT_VERSION = 'inbox-draft@1'

/** The bounded allowlist of tone goals an operator may request. Anything else is rejected server-side. */
export const AI_SUGGESTION_TONE_GOALS = ['neutral', 'warm', 'concise', 'formal', 'friendly'] as const
export type AiSuggestionToneGoal = (typeof AI_SUGGESTION_TONE_GOALS)[number]

export function isAiSuggestionToneGoal(value: unknown): value is AiSuggestionToneGoal {
    return typeof value === 'string' && (AI_SUGGESTION_TONE_GOALS as readonly string[]).includes(value)
}

// ------------------------------------------------------------
// Dependencies (all injected)
// ------------------------------------------------------------

export interface InboxAiSuggestionSettings {
    draftAssistanceEnabled: boolean
}

export interface InboxAiSuggestionDeps {
    /** Org-scoped audit-run persistence (createDrizzleAiRunStore in production). */
    store: AiRunStore
    /** Load the org's AI settings (null when the org has no settings row → treated as OFF). */
    loadSettings: (organizationId: string) => Promise<InboxAiSuggestionSettings | null>
    /**
     * Load the deterministic context INPUTS (persisted messages + facts + account address) for the
     * org+conversation. Returns null when the conversation does not exist for the organization (404).
     */
    loadContext: (args: { organizationId: string; conversationId: string }) => Promise<BuildInboxAiContextInput | null>
    /** The proposal-only adapter (requestAiDraftProposal). It has no send capability. */
    requestProposal: (input: AiDraftAdapterInput) => Promise<AiDraftProposalResult>
    now?: () => Date
    leaseMs?: number
}

export interface GenerateInboxAiSuggestionInput {
    organizationId: string
    conversationId: string
    actorUserId: string
    /** Stable client key: a replay returns the same run without a second external call. */
    idempotencyKey: string
    toneGoal?: AiSuggestionToneGoal | null
}

// ------------------------------------------------------------
// Outcome (a discriminated union the route maps to HTTP status)
// ------------------------------------------------------------

export type InboxAiSuggestionOutcome =
    | { status: 'not_enabled' }
    | { status: 'not_found' }
    | { status: 'in_progress'; run: AiRunRecord }
    | { status: 'suggested'; run: AiRunRecord; suggestion: { runId: string; subject: string | null; body: string } }
    | { status: 'no_action'; run: AiRunRecord }
    | { status: 'failed'; run: AiRunRecord; errorCode: string }

/** Map a stored terminal/awaiting run to an outcome (used for idempotent replay of the same key). */
function outcomeFromStoredRun(run: AiRunRecord): InboxAiSuggestionOutcome | null {
    if (run.status === 'awaiting_approval' && run.action === 'draft' && run.outputBody) {
        return { status: 'suggested', run, suggestion: { runId: run.id, subject: run.outputSubject, body: run.outputBody } }
    }
    if (run.status === 'completed') return { status: 'no_action', run }
    if (run.status === 'failed') return { status: 'failed', run, errorCode: run.errorCode ?? 'failed' }
    if (run.status === 'cancelled') return { status: 'failed', run, errorCode: 'cancelled' }
    return null
}

/**
 * Generate (or idempotently replay) an editable AI draft suggestion for a persisted conversation.
 * Always produces an inspectable audit run — or a clean `not_enabled`/`not_found` gate — and PROVABLY
 * never sends (there is no dispatcher in this module's dependency surface).
 */
export async function generateInboxAiSuggestion(
    deps: InboxAiSuggestionDeps,
    input: GenerateInboxAiSuggestionInput,
): Promise<InboxAiSuggestionOutcome> {
    const { store } = deps
    const { organizationId, conversationId, actorUserId, idempotencyKey } = input

    // 1. Gate on the per-org, default-off draft setting. A disabled org gets a clean not-enabled
    //    response — NOT an error, NOT a draft, and NOT an audit row.
    const settings = await deps.loadSettings(organizationId)
    if (!settings || !settings.draftAssistanceEnabled) {
        return { status: 'not_enabled' }
    }

    // 2. Load the deterministic context inputs. A missing conversation is a 404 with no run.
    const contextInput = await deps.loadContext({ organizationId, conversationId })
    if (!contextInput) return { status: 'not_found' }

    const baseCreate = {
        organizationId,
        runKind: 'draft' as const,
        idempotencyKey,
        conversationId,
        campaignId: contextInput.campaign?.id ?? null,
        actorUserId,
        promptVersion: INBOX_DRAFT_PROMPT_VERSION,
    }

    // 3. Build the bounded, tenant-checked context. A fail-closed context error (no inbound body,
    //    attribution mismatch, ...) still yields an INSPECTABLE failed run — never a send.
    let context
    try {
        context = buildInboxAiContext(contextInput)
    } catch (error) {
        if (error instanceof InboxAiContextError) {
            const { run, created } = await createAiRun(store, baseCreate)
            if (!created) {
                const replay = outcomeFromStoredRun(run)
                if (replay) return replay
            }
            // Fail the pending run directly (lease is null on a fresh pending run).
            const failed = await failAiRun(store, {
                organizationId,
                runId: run.id,
                leaseToken: run.leaseToken ?? null,
                errorCode: error.code,
                errorDetail: error.message,
            })
            return { status: 'failed', run: failed, errorCode: error.code }
        }
        throw error
    }

    // 4. Create the audit run BEFORE the external call, recording the persisted-context references.
    const { run: created, created: isNew } = await createAiRun(store, {
        ...baseCreate,
        triggerMessageId: context.latestInboundMessageId,
        inputMessageIds: context.messageIds,
        contextHash: context.contextHash,
        provider: 'xphere',
    })

    // Idempotent replay: a duplicate key whose run already reached a terminal/awaiting state returns
    // that same run without a second external call. A still-in-flight run reports in_progress.
    if (!isNew) {
        const replay = outcomeFromStoredRun(created)
        if (replay) return replay
        return { status: 'in_progress', run: created }
    }

    // 5. Claim the run (→ running with a lease + one attempt). A concurrent duplicate finds a live
    //    lease and is reported as in_progress by the caller path above; here a lease conflict on OUR
    //    own fresh run cannot happen, but we still translate a claim conflict to in_progress.
    let claimed
    try {
        claimed = await claimAiRun(store, { organizationId, runId: created.id, leaseMs: deps.leaseMs, now: deps.now?.() })
    } catch (error) {
        if (error instanceof AiRunError && (error.code === 'lease_held')) {
            const current = await store.findById(organizationId, created.id)
            return { status: 'in_progress', run: current ?? created }
        }
        if (error instanceof AiRunError && error.code === 'exhausted') {
            const current = await store.findById(organizationId, created.id)
            return { status: 'failed', run: current ?? created, errorCode: 'attempts_exhausted' }
        }
        throw error
    }

    const leaseToken = claimed.leaseToken ?? null

    // 6. Ask the proposal-only adapter. It cannot send; it returns a bounded proposal or an error code.
    const result = await deps.requestProposal({
        context,
        promptVersion: INBOX_DRAFT_PROMPT_VERSION,
        runId: created.id,
        toneGoal: input.toneGoal ?? null,
    })

    if (!result.ok) {
        const failed = await failAiRun(store, {
            organizationId,
            runId: created.id,
            leaseToken,
            errorCode: result.code,
            errorDetail: result.detail ?? null,
        })
        return { status: 'failed', run: failed, errorCode: result.code }
    }

    const { proposal } = result
    const usage = {
        latencyMs: result.latencyMs,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
    }

    // 7a. A `draft` proposal parks in awaiting_approval with the editable suggestion. It is NEVER sent
    //     here — the operator inserts + edits it and uses the separate Phase 22 send action.
    if (proposal.action === 'draft' && proposal.body) {
        const run = await completeAiRun(store, {
            organizationId,
            runId: created.id,
            leaseToken,
            action: 'draft',
            outputSubject: proposal.subject,
            outputBody: proposal.body,
            outputOutcome: proposal.outcome,
            awaitingApproval: true,
            ...usage,
        })
        return { status: 'suggested', run, suggestion: { runId: run.id, subject: run.outputSubject, body: proposal.body } }
    }

    // 7b. A `draft` with no body is unsafe (defensive; the adapter already rejects it). Fail closed.
    if (proposal.action === 'draft') {
        const failed = await failAiRun(store, {
            organizationId,
            runId: created.id,
            leaseToken,
            errorCode: 'unsafe_output',
            errorDetail: 'draft_without_body',
        })
        return { status: 'failed', run: failed, errorCode: 'unsafe_output' }
    }

    // 7c. wait/complete/escalate → a completed no-action run. There is no draft to insert and, by
    //     construction, no send.
    const run = await completeAiRun(store, {
        organizationId,
        runId: created.id,
        leaseToken,
        action: proposal.action,
        outputOutcome: proposal.outcome,
        awaitingApproval: false,
        ...usage,
    })
    return { status: 'no_action', run }
}

// ------------------------------------------------------------
// Public, redacted DTO (locked decision #5 / AI-06)
// ------------------------------------------------------------
// Exposes ONLY allowlisted fields. NEVER leaks credentials, model-parameter secrets, the raw error
// detail, lease/attempt bookkeeping, the idempotency key, or cross-tenant message ids.

export interface PublicAiRunDto {
    id: string
    conversationId: string | null
    campaignId: string | null
    /** A stable REFERENCE to the persisted inbound message that triggered the run (never its body). */
    triggerMessageId: string | null
    runKind: AiRunRecord['runKind']
    status: AiRunRecord['status']
    action: AiRunRecord['action']
    promptVersion: string | null
    provider: string | null
    model: string | null
    outputSubject: string | null
    outputBody: string | null
    outputOutcome: string | null
    policyCode: string | null
    /** A coarse machine code only — the raw provider detail is intentionally omitted. */
    errorCode: string | null
    contextHash: string | null
    actorUserId: string | null
    approvedByUserId: string | null
    approvedAt: string | null
    sendCommandId: string | null
    outreachEmailId: string | null
    latencyMs: number | null
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
    createdAt: string
    updatedAt: string
}

function iso(value: Date | null | undefined): string | null {
    return value ? new Date(value).toISOString() : null
}

/** Project a stored AI run into its public, redacted DTO. */
export function toPublicAiRun(run: AiRunRecord): PublicAiRunDto {
    return {
        id: run.id,
        conversationId: run.conversationId,
        campaignId: run.campaignId,
        triggerMessageId: run.triggerMessageId,
        runKind: run.runKind,
        status: run.status,
        action: run.action,
        promptVersion: run.promptVersion,
        provider: run.provider,
        model: run.model,
        outputSubject: run.outputSubject,
        outputBody: run.outputBody,
        outputOutcome: run.outputOutcome,
        policyCode: run.policyCode,
        errorCode: run.errorCode,
        contextHash: run.contextHash,
        actorUserId: run.actorUserId,
        approvedByUserId: run.approvedByUserId,
        approvedAt: iso(run.approvedAt),
        sendCommandId: run.sendCommandId,
        outreachEmailId: run.outreachEmailId,
        latencyMs: run.latencyMs,
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        totalTokens: run.totalTokens,
        createdAt: iso(run.createdAt) ?? new Date(0).toISOString(),
        updatedAt: iso(run.updatedAt) ?? new Date(0).toISOString(),
    }
}

// ------------------------------------------------------------
// Bounded per-user/org rate limiter (in-memory sliding window)
// ------------------------------------------------------------

export interface InMemoryRateLimiterOptions {
    windowMs: number
    max: number
    now?: () => number
}

export interface InMemoryRateLimiter {
    take: (key: string) => boolean
}

/**
 * A tiny fixed-window rate limiter keyed by an arbitrary string (we key on `${org}:${user}`). It caps
 * how many suggestions a single user/org can request per window, independent of other keys. Bounded
 * memory: stale windows are lazily dropped on access.
 */
export function createInMemoryRateLimiter(options: InMemoryRateLimiterOptions): InMemoryRateLimiter {
    const now = options.now ?? (() => Date.now())
    const windows = new Map<string, { windowStart: number; count: number }>()
    return {
        take(key: string): boolean {
            const t = now()
            const entry = windows.get(key)
            if (!entry || t - entry.windowStart >= options.windowMs) {
                windows.set(key, { windowStart: t, count: 1 })
                return true
            }
            if (entry.count >= options.max) return false
            entry.count += 1
            return true
        },
    }
}
