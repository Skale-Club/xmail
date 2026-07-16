/**
 * Xphere DRAFT PROPOSAL adapter (Phase 23 AI-02/AI-04) — the strict, fail-closed, proposal-only
 * boundary shared by the human-in-the-loop suggestion endpoint AND the autonomous follow-up processor.
 *
 * `requestAiDraftProposal` accepts the canonical persisted context + prompt/run references, calls the
 * configured Xphere endpoint with a timeout, and parses a strict `draft|wait|complete|escalate` output.
 * It bounds every field, STRIPS any invented control field (recipients/account/provider/policy/`send`),
 * keeps credentials in the Authorization header only, and returns typed fail-closed error codes. It
 * cannot select recipients, change policy, or send — deterministic code owns all of that.
 *
 * The legacy `decideFollowUp`/`enforceGuardrails` direct-send contract (P001/P002) was RETIRED in
 * Phase 23 (AI-03): its `send` path invoked the low-level threaded sender directly, bypassing
 * org/campaign autonomy enablement, durable audit, leases, and the single policy-gated executor.
 * Autonomous follow-up now flows through `inbox-ai-automation.ts` → a durable command → the single
 * inbox send-command executor.
 */

import { z } from 'zod'
import type { InboxAiContextResult } from './inbox-ai-context'

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
