/**
 * Agentic follow-up (P001) — decision contract + guardrails.
 *
 * When a campaign has agentic follow-up enabled, a matched inbound reply schedules a follow-up
 * decision instead of only stopping the sequence. The DECISION is made by a decider — by default
 * Xphere ("Xphere decides, Xmail executes", per OQ-04) — which returns one of:
 *   - send     → Xmail sends a threaded reply (the executor handles this)
 *   - wait     → re-arm the follow-up clock
 *   - complete → terminate the conversation with an outcome
 *
 * This module owns the contract, the decider call (fail-safe), and the guardrails that run BEFORE
 * any 'send' is executed. It never sends mail itself.
 *
 * Phase 23 (AI-02) ALSO houses the strict Xphere DRAFT PROPOSAL adapter used by the human-in-the-loop
 * suggestion endpoint (see `requestAiDraftProposal` below). That adapter is PROPOSAL-ONLY: it accepts
 * the canonical persisted context + prompt/run references, calls the configured Xphere endpoint with a
 * timeout, and parses a strict `draft|wait|complete|escalate` output. It bounds every field, strips any
 * invented control field (recipients/account/provider/policy), keeps credentials in the Authorization
 * header only, and returns typed fail-closed error codes. It cannot select recipients, change policy,
 * or send — deterministic code owns all of that.
 */

import { z } from 'zod'
import type { InboxAiContextResult } from './inbox-ai-context'

export type FollowUpAction = 'send' | 'wait' | 'complete'

export interface FollowUpDecision {
    action: FollowUpAction
    /** Reply body (plain text / simple HTML) — required when action === 'send'. */
    message?: string
    /** Optional subject override for the threaded reply. */
    subject?: string
    /** Terminal outcome label when action === 'complete' (e.g. 'positive', 'not_interested'). */
    outcome?: string
    /** Hours until the next follow-up when action === 'wait' (or to re-arm after a 'send'). */
    followUpHours?: number
}

export interface FollowUpContext {
    organizationId: string
    campaignId: string
    campaignLeadId: string
    leadEmail: string
    leadFirstName: string | null
    leadCompany: string | null
    sellerName: string | null
    /** The latest inbound reply text the decider reasons over. */
    lastReplyText: string | null
    followUpCount: number
    maxFollowUps: number
}

const DECIDER_TIMEOUT_MS = 15_000

const decisionSchema = z.object({
    action: z.enum(['send', 'wait', 'complete']),
    message: z.string().optional(),
    subject: z.string().optional(),
    outcome: z.string().optional(),
    followUpHours: z.number().finite().min(0).max(24 * 30).optional(),
})

/**
 * Ask the configured decider what to do next. No-op-safe: if no decider is configured, or the call
 * fails / times out / returns garbage, we return a terminal 'complete' with a diagnostic outcome
 * rather than risk an unintended send or an infinite wait. This means enabling agentic follow-up
 * WITHOUT a decider degrades to "stop and leave for a human" — never to auto-sending.
 */
export async function decideFollowUp(ctx: FollowUpContext): Promise<FollowUpDecision> {
    const url = process.env.XPHERE_FOLLOWUP_URL
    const apiKey = process.env.XPHERE_FOLLOWUP_API_KEY || process.env.XPHERE_EVENTS_API_KEY

    if (!url || !apiKey) {
        return { action: 'complete', outcome: 'no_decider_configured' }
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ event: 'followup.decide', data: ctx }),
            signal: AbortSignal.timeout(DECIDER_TIMEOUT_MS),
        })
        if (!res.ok) {
            return { action: 'complete', outcome: `decider_http_${res.status}` }
        }
        const json = await res.json()
        const parsed = decisionSchema.safeParse(json?.decision ?? json)
        if (!parsed.success) {
            return { action: 'complete', outcome: 'decider_bad_response' }
        }
        return parsed.data
    } catch {
        return { action: 'complete', outcome: 'decider_unreachable' }
    }
}

export interface Guardrails {
    unsubscribed: boolean
    suppressed: boolean
    withinWindow: boolean
    followUpCount: number
    maxFollowUps: number
}

/**
 * Enforce hard safety rules before a 'send' is executed. Downgrades the decision when a rule would
 * be violated. Non-'send' decisions pass through unchanged.
 */
export function enforceGuardrails(decision: FollowUpDecision, guard: Guardrails): FollowUpDecision {
    if (decision.action !== 'send') return decision

    if (guard.unsubscribed || guard.suppressed) {
        return { action: 'complete', outcome: 'suppressed' }
    }
    if (guard.followUpCount >= guard.maxFollowUps) {
        return { action: 'complete', outcome: 'max_follow_ups' }
    }
    if (!decision.message || decision.message.trim().length === 0) {
        return { action: 'complete', outcome: 'empty_message' }
    }
    if (!guard.withinWindow) {
        // Defer the send until the sending window reopens rather than dropping it.
        return { action: 'wait', followUpHours: decision.followUpHours ?? 4 }
    }
    return decision
}

// ============================================================
// Phase 23 AI-02 — strict Xphere DRAFT PROPOSAL adapter (fail-closed, proposal-only)
// ============================================================
// This is the ONLY external call the human-in-the-loop suggestion endpoint makes. It is a strict,
// bounded, proposal-only boundary: the model may propose a subject/body/outcome/delay, but it can
// never name recipients/accounts/providers, change policy, or send. Deterministic code (the endpoint
// and the Phase 22 send path) owns all of that. Xphere stays OPTIONAL + fail-closed (locked #8): a
// missing config, timeout, malformed response, or unsafe output is a typed error code — never a send.

/** The allowlisted actions the decider may propose for an inbox draft. */
export type AiDraftAction = 'draft' | 'wait' | 'complete' | 'escalate'

/**
 * The strict, allowlisted proposal. It carries ONLY these five fields — any other key the model
 * invents (recipients, account, provider, policy overrides, `send`) is stripped before it is read.
 */
export interface AiDraftProposal {
    action: AiDraftAction
    subject: string | null
    body: string | null
    outcome: string | null
    followUpMinutes: number | null
}

/** Typed fail-closed error codes. None of these can result in a send. */
export type AiDraftErrorCode =
    | 'no_decider_configured'
    | 'decider_timeout'
    | 'decider_unreachable'
    | 'decider_http_error'
    | 'decider_bad_response'
    | 'unsafe_output'

export interface AiDraftProposalOk {
    ok: true
    proposal: AiDraftProposal
    provider: string
    model: string | null
    latencyMs: number
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
}
export interface AiDraftProposalErr {
    ok: false
    code: AiDraftErrorCode
    detail?: string
    latencyMs: number
}
export type AiDraftProposalResult = AiDraftProposalOk | AiDraftProposalErr

// Hard output bounds — the model's own claimed lengths are never trusted.
export const AI_DRAFT_MAX_SUBJECT = 400
export const AI_DRAFT_MAX_BODY = 20_000
export const AI_DRAFT_MAX_OUTCOME = 200
export const AI_DRAFT_MAX_FOLLOW_UP_MINUTES = 30 * 24 * 60 // 30 days
const AI_DRAFT_TIMEOUT_MS = 15_000
const AI_DRAFT_PROVIDER = 'xphere'

export interface XphereDraftConfig {
    url: string
    apiKey: string
    timeoutMs: number
    model: string | null
}

/**
 * Resolve the Xphere draft config from the environment ONLY. Credentials never come from a caller,
 * a request body, or the conversation. Returns null when the feature is not configured (fail-closed).
 */
export function resolveXphereDraftConfig(env: NodeJS.ProcessEnv = process.env): XphereDraftConfig | null {
    const url = env.XPHERE_DRAFT_URL || env.XPHERE_FOLLOWUP_URL
    const apiKey = env.XPHERE_DRAFT_API_KEY || env.XPHERE_FOLLOWUP_API_KEY || env.XPHERE_EVENTS_API_KEY
    if (!url || !apiKey) return null
    return { url, apiKey, timeoutMs: AI_DRAFT_TIMEOUT_MS, model: env.XPHERE_DRAFT_MODEL || null }
}

/**
 * The adapter input. It deliberately CANNOT carry an account/recipient/provider/policy override —
 * only the deterministic persisted context plus the prompt/run references and an allowlisted tone.
 */
export interface AiDraftAdapterInput {
    context: InboxAiContextResult
    promptVersion: string
    runId: string
    toneGoal?: string | null
}

export interface AiDraftAdapterDeps {
    /** When omitted, resolved from the environment. `null` forces the not-configured path. */
    config?: XphereDraftConfig | null
    fetchImpl?: typeof fetch
    now?: () => number
    signal?: AbortSignal
}

// Strict schema. Unknown keys are STRIPPED (Zod default), so any invented control field is dropped
// before it can be read. `message`/`followUpHours` are tolerated as legacy aliases.
const draftProposalSchema = z.object({
    action: z.enum(['draft', 'wait', 'complete', 'escalate']),
    subject: z.string().nullish(),
    body: z.string().nullish(),
    message: z.string().nullish(),
    outcome: z.string().nullish(),
    followUpMinutes: z.number().finite().nullish(),
    followUpHours: z.number().finite().nullish(),
})

/** Trim, drop-if-empty, and hard-bound a model-supplied string. */
function boundDraftString(value: string | null | undefined, max: number): string | null {
    if (value == null) return null
    const trimmed = String(value).trim()
    if (trimmed.length === 0) return null
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Ask the configured Xphere endpoint for a DRAFT PROPOSAL over the canonical persisted context.
 * Fail-closed: any transport/parse/safety problem returns a typed error code and NEVER a send. The
 * returned proposal is a strict, bounded, control-field-stripped object that downstream code treats
 * as a suggestion only.
 */
export async function requestAiDraftProposal(
    input: AiDraftAdapterInput,
    deps: AiDraftAdapterDeps = {},
): Promise<AiDraftProposalResult> {
    const now = deps.now ?? (() => Date.now())
    const start = now()
    const elapsed = (): number => Math.max(0, now() - start)

    const config = deps.config !== undefined ? deps.config : resolveXphereDraftConfig()
    if (!config) return { ok: false, code: 'no_decider_configured', latencyMs: elapsed() }

    const fetchImpl = deps.fetchImpl ?? fetch

    // The payload is built from the CANONICAL persisted context (bodies already fenced as untrusted
    // data). The API key is placed in the Authorization header only — never in the body.
    const payload = {
        event: 'inbox.draft.suggest',
        promptVersion: input.promptVersion,
        runId: input.runId,
        toneGoal: input.toneGoal ?? null,
        context: {
            organizationId: input.context.organizationId,
            conversationId: input.context.conversationId,
            latestInboundMessageId: input.context.latestInboundMessageId,
            messageIds: input.context.messageIds,
            contextHash: input.context.contextHash,
            facts: input.context.facts,
            serialized: input.context.serialized,
        },
    }

    let res: Response
    try {
        res = await fetchImpl(config.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: deps.signal ?? AbortSignal.timeout(config.timeoutMs),
        })
    } catch (error) {
        const name = (error as { name?: string } | null)?.name
        if (name === 'TimeoutError' || name === 'AbortError') {
            return { ok: false, code: 'decider_timeout', latencyMs: elapsed() }
        }
        return { ok: false, code: 'decider_unreachable', latencyMs: elapsed() }
    }

    if (!res.ok) {
        return { ok: false, code: 'decider_http_error', detail: `status_${res.status}`, latencyMs: elapsed() }
    }

    let json: unknown
    try {
        json = await res.json()
    } catch {
        return { ok: false, code: 'decider_bad_response', latencyMs: elapsed() }
    }

    const envelope = (json ?? {}) as Record<string, unknown>
    const candidate = envelope.proposal ?? envelope.decision ?? json
    const parsed = draftProposalSchema.safeParse(candidate)
    if (!parsed.success) {
        return { ok: false, code: 'decider_bad_response', latencyMs: elapsed() }
    }

    const data = parsed.data
    const rawFollowUpMinutes = data.followUpMinutes ?? (data.followUpHours != null ? data.followUpHours * 60 : null)
    const proposal: AiDraftProposal = {
        action: data.action,
        subject: boundDraftString(data.subject, AI_DRAFT_MAX_SUBJECT),
        body: boundDraftString(data.body ?? data.message, AI_DRAFT_MAX_BODY),
        outcome: boundDraftString(data.outcome, AI_DRAFT_MAX_OUTCOME),
        followUpMinutes:
            rawFollowUpMinutes == null
                ? null
                : Math.min(Math.max(0, Math.round(rawFollowUpMinutes)), AI_DRAFT_MAX_FOLLOW_UP_MINUTES),
    }

    // A `draft` action with no usable body is unsafe — there is nothing an operator can insert.
    if (proposal.action === 'draft' && (!proposal.body || proposal.body.length === 0)) {
        return { ok: false, code: 'unsafe_output', detail: 'draft_without_body', latencyMs: elapsed() }
    }

    const usage = (envelope.usage ?? {}) as Record<string, unknown>
    return {
        ok: true,
        proposal,
        provider: AI_DRAFT_PROVIDER,
        model: config.model,
        latencyMs: elapsed(),
        promptTokens: finiteOrNull(usage.promptTokens),
        completionTokens: finiteOrNull(usage.completionTokens),
        totalTokens: finiteOrNull(usage.totalTokens),
    }
}
