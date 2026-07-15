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
 */

import { z } from 'zod'

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
