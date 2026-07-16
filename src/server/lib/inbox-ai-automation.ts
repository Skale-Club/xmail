// ============================================================
// Autonomous inbox AI automation (Phase 23 AI-03 / AI-04) — the safe replacement for the legacy
// direct-send follow-up job.
// ============================================================
// This module turns a persisted inbound reply into an AUDITED, LEASED, POLICY-GATED autonomous
// decision. It replaces the retired `processFollowUps` direct-send path. Its safety contract:
//
//   1. EFFECTIVE AUTONOMY IS AN INTERSECTION (locked #1 / #7). A run is only scheduled and only
//      dispatched when the organization AND the campaign are both opted in AND unpaused AND the
//      org-wide outreach kill switch is clear. Any one control off/paused → no run, no send. The
//      intersection is re-evaluated at CLAIM and again IMMEDIATELY BEFORE dispatch (pause race).
//
//   2. THE MODEL CANNOT PICK RECIPIENTS/ACCOUNT OR OVERRIDE POLICY (scope fence, locked #3/#4). The
//      recipient and sending account are RESOLVED DETERMINISTICALLY from the persisted conversation
//      (exactly like the Phase 22 reply resolver). The model only proposes a body/subject/outcome.
//
//   3. ONE DELIVERY PATH (locked #3). This module NEVER imports a provider adapter and NEVER calls
//      the low-level threaded sender or the shared outreach dispatcher. Every send becomes a durable
//      Phase 22 inbox command handed to the SINGLE lease-aware `executeInboxSendCommand` executor —
//      which alone evaluates the Phase 18 delivery policy and calls the shared dispatcher. Source
//      -level regression tests assert the forbidden send primitives never appear in THIS module or
//      the runtime — see the structural guard in `inbox-ai-automation.test.ts` and the entrypoint
//      guard in `__tests__/outreach-entrypoints.test.ts`.
//
//   4. NO HIDDEN RETRY LOOP (locked #4). Decisions use leases, bounded attempts, and idempotency.
//      An ambiguous provider outcome is HELD (a deferred run with no retry time — never re-claimed,
//      never resent). A policy defer is a bounded, time-gated re-arm.
//
//   5. XPHERE STAYS OPTIONAL + FAIL-CLOSED (locked #8). A missing config / timeout / malformed /
//      unsafe / context failure produces an inspectable failed/no-action run, never a send.
//
// Every dependency is INJECTED so the whole thing is unit-tested without a database or network; the
// production wiring lives in `src/server/jobs/processFollowUps.ts`.

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
    deferAiRun,
    linkAiRunCommand,
    AiRunError,
    type AiRunRecord,
    type AiRunStore,
} from './inbox-ai-audit'
import type { AiDraftAdapterInput, AiDraftProposalResult } from './outreach-followup'
import type { ResolvedSendCommand } from './inbox-command-dispatch'

/** The stable prompt/template version recorded on every autonomous run for reproducibility/audit. */
export const INBOX_AUTONOMOUS_PROMPT_VERSION = 'inbox-autonomous@1'

const AUTONOMOUS_PROVIDER = 'xphere'

// ============================================================
// Effective autonomy — the intersection of every control (locked #1 / #7)
// ============================================================

export type AutonomyDenyReason =
    | 'org_disabled'
    | 'org_paused'
    | 'campaign_disabled'
    | 'campaign_inactive'
    | 'outreach_disabled'

/**
 * The raw control inputs. NONE of them alone authorizes a send — effective autonomy is their
 * intersection. `orgAutonomyPausedAt` is the immediate org kill switch; `outreachEnabled` is the
 * org-wide outreach kill switch (also enforced authoritatively by the Phase 18 policy in the
 * executor, checked here as an early short-circuit so we never call the model when outreach is off).
 */
export interface EffectiveAutonomyInputs {
    orgAutonomousEnabled: boolean
    orgAutonomyPausedAt: Date | null
    campaignAiAutonomousEnabled: boolean
    campaignActive: boolean
    outreachEnabled: boolean
}

export interface EffectiveAutonomyResult {
    enabled: boolean
    reason: AutonomyDenyReason | null
}

/** Pure predicate: autonomy is enabled only when EVERY control is on and unpaused. */
export function evaluateEffectiveAutonomy(inputs: EffectiveAutonomyInputs): EffectiveAutonomyResult {
    if (!inputs.orgAutonomousEnabled) return { enabled: false, reason: 'org_disabled' }
    if (inputs.orgAutonomyPausedAt != null) return { enabled: false, reason: 'org_paused' }
    if (!inputs.campaignAiAutonomousEnabled) return { enabled: false, reason: 'campaign_disabled' }
    if (!inputs.campaignActive) return { enabled: false, reason: 'campaign_inactive' }
    if (!inputs.outreachEnabled) return { enabled: false, reason: 'outreach_disabled' }
    return { enabled: true, reason: null }
}

// ============================================================
// Task 1 — schedule an auditable run from a persisted inbound reply (at most once, no send)
// ============================================================

/** The classification of the triggering inbound message. Only a genuine `reply` is eligible. */
export type AutonomyTriggerKind = 'reply' | 'auto_reply' | 'dsn' | 'bounce' | 'other'

export interface ScheduleAutonomousAiRunInput {
    organizationId: string
    /** The persisted conversation the reply belongs to (may be null before materialization). */
    conversationId: string | null
    /** The persisted inbound message id (may be null before materialization). */
    triggerMessageId: string | null
    campaignId: string | null
    campaignLeadId: string | null
    triggerKind: AutonomyTriggerKind
    /** True when the latest inbound message carries a usable body (headers-only fails closed). */
    hasInboundBody: boolean
    leadUnsubscribed: boolean
    leadSuppressed: boolean
    /** A stable reference for idempotency: the persisted message id or the normalized Message-ID. */
    triggerRef: string
    now?: Date
}

export interface ScheduleAutonomousAiRunDeps {
    store: AiRunStore
    /** Load the effective-autonomy control inputs for this org+campaign (null when no settings row). */
    loadAutonomy: (args: { organizationId: string; campaignId: string | null }) => Promise<EffectiveAutonomyInputs | null>
}

export type ScheduleAutonomousAiRunOutcome =
    | { status: 'skipped'; reason: string }
    | { status: 'scheduled'; run: AiRunRecord; created: boolean }

/**
 * The idempotency key for an autonomous run. Deterministic per (campaign-lead|conversation, trigger)
 * so a duplicate ingestion of the same inbound reply reuses the one run. The organization is scoped
 * by the store's `(organization_id, idempotency_key)` uniqueness, so the SAME key under two orgs is
 * two distinct runs.
 */
export function autonomousRunIdempotencyKey(input: {
    campaignLeadId: string | null
    conversationId: string | null
    triggerRef: string
}): string {
    const anchor = input.campaignLeadId ?? input.conversationId ?? 'unlinked'
    return `autonomous:${anchor}:${input.triggerRef}`
}

/**
 * Schedule exactly one auditable autonomous run for an eligible persisted inbound reply — or skip
 * with a reason. NEVER sends: it only inserts a `pending` audit run. Ineligible kinds (auto-reply,
 * DSN, bounce), missing-body, suppressed/unsubscribed leads, and any disabled/paused control all
 * short-circuit to a `skipped` outcome with no run created.
 */
export async function scheduleAutonomousAiRun(
    deps: ScheduleAutonomousAiRunDeps,
    input: ScheduleAutonomousAiRunInput,
): Promise<ScheduleAutonomousAiRunOutcome> {
    // 1. Only a genuine inbound reply is eligible — never an auto-reply, DSN, or bounce.
    if (input.triggerKind !== 'reply') return { status: 'skipped', reason: 'ineligible_trigger_kind' }
    // 2. Headers-only inbound fails closed — there is nothing to reason over.
    if (!input.hasInboundBody) return { status: 'skipped', reason: 'no_inbound_body' }
    // 3. Never re-engage a lead who opted out or is suppressed.
    if (input.leadUnsubscribed) return { status: 'skipped', reason: 'lead_unsubscribed' }
    if (input.leadSuppressed) return { status: 'skipped', reason: 'recipient_suppressed' }

    // 4. Effective autonomy must be enabled (org + campaign + kill switches).
    const autonomy = await deps.loadAutonomy({ organizationId: input.organizationId, campaignId: input.campaignId })
    if (!autonomy) return { status: 'skipped', reason: 'no_autonomy_settings' }
    const effective = evaluateEffectiveAutonomy(autonomy)
    if (!effective.enabled) return { status: 'skipped', reason: effective.reason ?? 'autonomy_disabled' }

    // 5. Create the pending audit run, idempotent on (org, key). A duplicate ingestion reuses it.
    const idempotencyKey = autonomousRunIdempotencyKey({
        campaignLeadId: input.campaignLeadId,
        conversationId: input.conversationId,
        triggerRef: input.triggerRef,
    })
    const { run, created } = await createAiRun(deps.store, {
        organizationId: input.organizationId,
        runKind: 'autonomous',
        idempotencyKey,
        conversationId: input.conversationId,
        campaignId: input.campaignId,
        campaignLeadId: input.campaignLeadId,
        triggerMessageId: input.triggerMessageId,
        promptVersion: INBOX_AUTONOMOUS_PROMPT_VERSION,
        provider: AUTONOMOUS_PROVIDER,
        now: input.now,
    })
    return { status: 'scheduled', run, created }
}

// ============================================================
// Task 2 — process a leased autonomous run through the shared command/executor path
// ============================================================

/**
 * Everything the processor needs, resolved DETERMINISTICALLY from persisted state under the run's
 * organization scope. `resolvedSend` carries the recipient/account/threading derived from the
 * persisted conversation — the model never contributes to it.
 */
export interface AutonomousRunResolution {
    /** Effective-autonomy control inputs, re-read at processing time. */
    autonomy: EffectiveAutonomyInputs
    /** Deterministic bounded context inputs (persisted messages + facts + account address). */
    contextInput: BuildInboxAiContextInput
    conversationId: string
    emailAccountId: string
    /** Recipient/account/threading resolved from the persisted conversation (Phase 22 resolver). */
    resolvedSend: ResolvedSendCommand
    /** How many autonomous follow-ups have already been sent on this thread. */
    autonomousFollowUpsSent: number
    /** The effective ceiling (min of org + campaign limits). */
    maxAutonomousFollowUps: number
    toneGoal?: string | null
}

export interface CreateAutonomousCommandArgs {
    organizationId: string
    conversationId: string
    runId: string
    emailAccountId: string
    /** The deterministic recipient/threading resolution — the model contributes NONE of this. */
    resolvedSend: ResolvedSendCommand
    /** The subject (proposal override or the resolved `Re:` subject). */
    subject: string | null
    /** The model-proposed body — the ONLY model-authored field that reaches the command. */
    bodyText: string
    /** Stable per-run key so a re-process replays onto the same durable command. */
    idempotencyKey: string
}

export interface AutonomousCommandCreated {
    commandId: string
    created: boolean
}

/** The disposition executeInboxSendCommand reported for the durable command. */
export type AutonomousDispatchOutcome = 'sent' | 'duplicate' | 'held' | 'rescheduled' | 'failed' | 'lost'

export interface AutonomousDispatchResult {
    outcome: AutonomousDispatchOutcome
    outreachEmailId?: string | null
    policyCode?: string | null
    retryAt?: Date | null
    errorCode?: string | null
}

export interface ProcessAutonomousAiRunDeps {
    store: AiRunStore
    /** Resolve the run's persisted context/recipient/limits (org-scoped). null → context is gone. */
    resolveRun: (run: AiRunRecord) => Promise<AutonomousRunResolution | null>
    /** The proposal-only adapter (requestAiDraftProposal). It cannot send. */
    requestProposal: (input: AiDraftAdapterInput) => Promise<AiDraftProposalResult>
    /** Create the durable Phase 22 inbox command (deterministic recipient/account). */
    createCommand: (args: CreateAutonomousCommandArgs) => Promise<AutonomousCommandCreated>
    /** Hand the durable command to the SINGLE executeInboxSendCommand executor and report its outcome. */
    dispatchCommand: (args: { commandId: string; organizationId: string }) => Promise<AutonomousDispatchResult>
    /**
     * Re-read effective autonomy IMMEDIATELY BEFORE dispatch (pause race). REQUIRED — there is no
     * default: a caller must supply a FRESH read (production wires a DB reader) so a kill switch
     * flipped during the model call still stops the send. Making this optional once let a caller
     * silently fall back to the stale pre-model autonomy and skip the pause recheck entirely (M-2).
     */
    reloadAutonomy: (run: AiRunRecord) => Promise<EffectiveAutonomyInputs | null>
    now?: () => Date
    leaseMs?: number
}

export type ProcessAutonomousAiRunOutcome =
    | { status: 'skipped'; reason: string; run: AiRunRecord }
    | { status: 'no_action'; run: AiRunRecord }
    | { status: 'sent'; run: AiRunRecord; commandId: string; outreachEmailId: string | null }
    | { status: 'held'; run: AiRunRecord; commandId: string }
    | { status: 'deferred'; run: AiRunRecord }
    | { status: 'failed'; run: AiRunRecord; errorCode: string }

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/**
 * Whether a run is due to be claimed by a processing tick. A HELD run (deferred with NO retry time)
 * is deliberately NOT claimable — that is how an ambiguous provider outcome is held and never resent
 * without human intervention. A deferred run is only claimable once its retry time has passed.
 */
export function isAutonomousRunClaimable(run: AiRunRecord, now: Date): boolean {
    if (run.runKind !== 'autonomous') return false
    if (run.status === 'pending') return true
    if (run.status === 'deferred') {
        return run.policyRetryAt != null && run.policyRetryAt.getTime() <= now.getTime()
    }
    if (run.status === 'running') {
        // Reclaimable only if the previous lease has expired (crash recovery).
        return run.leaseExpiresAt != null && run.leaseExpiresAt.getTime() <= now.getTime()
    }
    return false
}

/**
 * Process ONE autonomous run: claim it with a lease, re-check every control, build the persisted
 * context, ask the decider, and — only for a valid `draft` decision and only while autonomy is still
 * enabled — resolve the recipient/account deterministically, create a durable command, and hand it
 * to the single executor. Every path is audited; no path dispatches directly.
 */
export async function processAutonomousAiRun(
    deps: ProcessAutonomousAiRunDeps,
    run: AiRunRecord,
): Promise<ProcessAutonomousAiRunOutcome> {
    const now = deps.now ?? (() => new Date())
    const organizationId = run.organizationId

    // 0. Gate on claimability. A terminal run, a not-yet-due deferred run, and — critically — a HELD
    //    run (deferred with no retry time) are never re-processed, so an ambiguous outcome is never
    //    resent.
    if (TERMINAL_STATUSES.has(run.status)) return { status: 'skipped', reason: 'terminal', run }
    if (!isAutonomousRunClaimable(run, now())) {
        const reason = run.status === 'deferred' && run.policyRetryAt == null ? 'held' : 'not_due'
        return { status: 'skipped', reason, run }
    }

    // 1. Claim the run into `running` with a fresh lease + one bounded attempt. A concurrent tick
    //    holding a live lease loses here (lease_held); an exhausted run fails closed.
    let claimed: AiRunRecord
    try {
        claimed = await claimAiRun(deps.store, { organizationId, runId: run.id, leaseMs: deps.leaseMs, now: now() })
    } catch (error) {
        if (error instanceof AiRunError && error.code === 'lease_held') {
            return { status: 'skipped', reason: 'lease_held', run }
        }
        if (error instanceof AiRunError && error.code === 'exhausted') {
            const current = (await deps.store.findById(organizationId, run.id)) ?? run
            return { status: 'failed', run: current, errorCode: 'attempts_exhausted' }
        }
        if (error instanceof AiRunError && error.code === 'invalid_transition') {
            return { status: 'skipped', reason: 'not_claimable', run }
        }
        throw error
    }
    const leaseToken = claimed.leaseToken ?? null

    // 2. Resolve the persisted context/recipient/limits. A vanished conversation fails closed.
    let resolution: AutonomousRunResolution | null
    try {
        resolution = await deps.resolveRun(claimed)
    } catch (error) {
        const code = error instanceof InboxAiContextError ? error.code : 'resolution_error'
        const failed = await failAiRun(deps.store, { organizationId, runId: claimed.id, leaseToken, errorCode: code })
        return { status: 'failed', run: failed, errorCode: code }
    }
    if (!resolution) {
        const failed = await failAiRun(deps.store, { organizationId, runId: claimed.id, leaseToken, errorCode: 'resolution_missing' })
        return { status: 'failed', run: failed, errorCode: 'resolution_missing' }
    }

    // 3. Re-check effective autonomy AT CLAIM. Any control turned off/paused since scheduling → a
    //    clean no-action run, never a send.
    const effective = evaluateEffectiveAutonomy(resolution.autonomy)
    if (!effective.enabled) {
        const run2 = await completeAiRun(deps.store, {
            organizationId, runId: claimed.id, leaseToken,
            action: 'none', outputOutcome: `autonomy_${effective.reason}`,
        })
        return { status: 'skipped', reason: effective.reason ?? 'autonomy_disabled', run: run2 }
    }

    // 4. Enforce the autonomous follow-up ceiling deterministically (never the model's choice).
    if (resolution.autonomousFollowUpsSent >= resolution.maxAutonomousFollowUps) {
        const run2 = await completeAiRun(deps.store, {
            organizationId, runId: claimed.id, leaseToken,
            action: 'complete', outputOutcome: 'max_follow_ups',
        })
        return { status: 'no_action', run: run2 }
    }

    // 5. Build the deterministic, bounded, tenant-checked context. Fail closed on any context error.
    let context
    try {
        context = buildInboxAiContext(resolution.contextInput)
    } catch (error) {
        const code = error instanceof InboxAiContextError ? error.code : 'context_error'
        const failed = await failAiRun(deps.store, {
            organizationId, runId: claimed.id, leaseToken,
            errorCode: code, errorDetail: error instanceof Error ? error.message : null,
        })
        return { status: 'failed', run: failed, errorCode: code }
    }

    // 6. Ask the proposal-only decider. Fail-closed: any transport/parse/safety error → a failed run.
    const proposal = await deps.requestProposal({
        context,
        promptVersion: INBOX_AUTONOMOUS_PROMPT_VERSION,
        runId: claimed.id,
        toneGoal: resolution.toneGoal ?? null,
    })
    if (!proposal.ok) {
        const failed = await failAiRun(deps.store, {
            organizationId, runId: claimed.id, leaseToken,
            errorCode: proposal.code, errorDetail: proposal.detail ?? null,
        })
        return { status: 'failed', run: failed, errorCode: proposal.code }
    }

    const usage = {
        latencyMs: proposal.latencyMs,
        promptTokens: proposal.promptTokens,
        completionTokens: proposal.completionTokens,
        totalTokens: proposal.totalTokens,
    }
    const decision = proposal.proposal

    // 7. Non-send decisions only transition the audit trail (locked #3: never a send).
    if (decision.action === 'wait' || decision.action === 'complete' || decision.action === 'escalate') {
        const run2 = await completeAiRun(deps.store, {
            organizationId, runId: claimed.id, leaseToken,
            action: decision.action, outputSubject: decision.subject, outputOutcome: decision.outcome, ...usage,
        })
        return { status: 'no_action', run: run2 }
    }

    // 8. A `draft` decision is the only send path. An empty body is unsafe → fail closed.
    const body = decision.body?.trim() ?? ''
    if (body.length === 0) {
        const failed = await failAiRun(deps.store, { organizationId, runId: claimed.id, leaseToken, errorCode: 'unsafe_output', errorDetail: 'draft_without_body' })
        return { status: 'failed', run: failed, errorCode: 'unsafe_output' }
    }

    // 9. RECHECK autonomy IMMEDIATELY BEFORE dispatch (pause race, locked #7). A kill switch flipped
    //    during the model call still stops the send — no command is created.
    // `reloadAutonomy` is a REQUIRED dep (a fresh read in production), so this recheck can never be
    // silently skipped by falling back to the stale pre-model autonomy (M-2).
    const fresh = await deps.reloadAutonomy(claimed)
    if (!fresh || !evaluateEffectiveAutonomy(fresh).enabled) {
        const run2 = await completeAiRun(deps.store, {
            organizationId, runId: claimed.id, leaseToken,
            action: 'none', outputSubject: decision.subject, outputBody: body, outputOutcome: 'paused_before_dispatch', ...usage,
        })
        return { status: 'skipped', reason: 'paused_before_dispatch', run: run2 }
    }

    // 10. The recipient/account come ENTIRELY from the persisted resolution — never the model.
    if (resolution.resolvedSend.to.length === 0) {
        const failed = await failAiRun(deps.store, { organizationId, runId: claimed.id, leaseToken, errorCode: 'no_reply_recipient' })
        return { status: 'failed', run: failed, errorCode: 'no_reply_recipient' }
    }

    // 11. Create the durable Phase 22 command (idempotent per run) and LINK it to the run before
    //     dispatch, so a crash leaves a recoverable, inspectable trail.
    const commandIdempotencyKey = `ai-cmd:${claimed.id}`
    const created = await deps.createCommand({
        organizationId,
        conversationId: resolution.conversationId,
        runId: claimed.id,
        emailAccountId: resolution.emailAccountId,
        resolvedSend: resolution.resolvedSend,
        subject: decision.subject ?? resolution.resolvedSend.subject,
        bodyText: body,
        idempotencyKey: commandIdempotencyKey,
    })
    await linkAiRunCommand(deps.store, { organizationId, runId: claimed.id, sendCommandId: created.commandId })

    // 12. Hand the durable command to the SINGLE executor. This module has no dispatcher — the
    //     executor alone evaluates the Phase 18 policy and calls the shared dispatcher.
    const dispatch = await deps.dispatchCommand({ commandId: created.commandId, organizationId })

    switch (dispatch.outcome) {
        case 'sent':
        case 'duplicate': {
            const run2 = await completeAiRun(deps.store, {
                organizationId, runId: claimed.id, leaseToken,
                action: 'draft', outputSubject: decision.subject, outputBody: body, outputOutcome: decision.outcome,
                policyCode: dispatch.policyCode ?? null, ...usage,
            })
            const linked = await linkAiRunCommand(deps.store, {
                organizationId, runId: claimed.id, sendCommandId: created.commandId, outreachEmailId: dispatch.outreachEmailId ?? null,
            })
            return { status: 'sent', run: linked ?? run2, commandId: created.commandId, outreachEmailId: dispatch.outreachEmailId ?? null }
        }
        case 'held': {
            // Ambiguous provider outcome: the command is held by the executor; hold the run too with
            // NO retry time so it is never re-claimed and never resent (locked #4).
            const run2 = await deferAiRun(deps.store, {
                organizationId, runId: claimed.id, leaseToken,
                policyCode: 'provider_outcome_held', policyRetryAt: null,
            })
            return { status: 'held', run: run2, commandId: created.commandId }
        }
        case 'rescheduled': {
            // A bounded policy defer / transient retry. Re-arm with a retry time for a later tick.
            const retryAt = dispatch.retryAt ?? new Date(now().getTime() + 60 * 60 * 1000)
            const run2 = await deferAiRun(deps.store, {
                organizationId, runId: claimed.id, leaseToken,
                policyCode: dispatch.policyCode ?? dispatch.errorCode ?? 'rescheduled', policyRetryAt: retryAt,
            })
            return { status: 'deferred', run: run2 }
        }
        case 'lost': {
            // Another attempt owns the dispatch; requeue shortly without a resend decision.
            const retryAt = new Date(now().getTime() + 5 * 60 * 1000)
            const run2 = await deferAiRun(deps.store, {
                organizationId, runId: claimed.id, leaseToken,
                policyCode: 'lease_lost', policyRetryAt: retryAt,
            })
            return { status: 'deferred', run: run2 }
        }
        case 'failed':
        default: {
            const failed = await failAiRun(deps.store, {
                organizationId, runId: claimed.id, leaseToken,
                errorCode: dispatch.errorCode ?? 'dispatch_failed', policyCode: dispatch.policyCode ?? null,
            })
            return { status: 'failed', run: failed, errorCode: dispatch.errorCode ?? 'dispatch_failed' }
        }
    }
}
