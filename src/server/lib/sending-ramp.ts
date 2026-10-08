/**
 * Volume ramp recommendation for the cold-sending inboxes (the Google accounts bought on Icemail).
 *
 * The daily limit of those inboxes starts low on purpose (15/day, 2026-10-07) and has to rise as
 * the reputation allows. This module only RECOMMENDS: it reads one inbox's last 7 days and says
 * what limit the numbers support and why. Nothing here, and nothing that calls it, applies the
 * change. Raising the limit stays a decision (agent PATCH, capped at AGENT_MAX_DAILY_SEND_LIMIT,
 * or the owner in the UI); a recommendation that applied itself would be one prompt-injected
 * reply away from a reputation-burning volume.
 *
 * Pure on purpose: the counts come from sending-ramp-stats.ts, the eligibility verdict from
 * isCampaignSenderEligible in the caller, and every threshold is a named constant so the tests
 * and the docs say the same numbers as the code.
 */

/** Days of sending history the recommendation looks at. */
export const RAMP_WINDOW_DAYS = 7
/** Sends in the window needed before the numbers mean anything. */
export const RAMP_MIN_SENDS = 20
/** Bounce rate (fraction of sends) below which the inbox may go up. */
export const RAMP_MAX_BOUNCE_RATE_TO_RAISE = 0.02
/** Unsubscribe rate (fraction of sends) below which the inbox may go up. */
export const RAMP_MAX_UNSUBSCRIBE_RATE_TO_RAISE = 0.03
/** Bounce rate (fraction of sends) at or above which the inbox should go down. */
export const RAMP_BOUNCE_RATE_TO_LOWER = 0.05
/** How much a recommendation moves the limit, up or down. */
export const RAMP_STEP = 3
/** Lowest limit a recommendation ever proposes. */
export const RAMP_FLOOR = 5
/**
 * Default ceiling of a recommended raise. Equals AGENT_MAX_DAILY_SEND_LIMIT (routes/agent-accounts.ts),
 * which callers pass explicitly; it is repeated here only so the module stands alone.
 */
export const RAMP_DEFAULT_CEILING = 30

export interface SendingRampInput {
    /** isCampaignSenderEligible(account): only a cold-campaign sender is ever ramped. */
    eligible: boolean
    /** The inbox's configured `daily_send_limit`. */
    dailySendLimit: number
    /** Outreach emails this inbox sent in the window. */
    sent: number
    /** Of those, how many bounced. */
    bounces: number
    /** Of those, how many recipients later complained (a `complaint` suppression). */
    complaints: number
    /** Of those, how many recipients unsubscribed. */
    unsubscribes: number
    /** Highest limit a raise may propose. Defaults to RAMP_DEFAULT_CEILING. */
    ceiling?: number
}

export interface SendingRampRecommendation {
    recommendedDailyLimit: number
    /** One sentence for a human or the agent: what the numbers say and why this limit. */
    reason: string
    /** True when the numbers meet every bar to raise the limit (even if it is already at the ceiling). */
    ready: boolean
}

const asPercent = (fraction: number): string => `${Math.round(fraction * 1000) / 10}%`

export function recommendDailyLimit(input: SendingRampInput): SendingRampRecommendation {
    const current = input.dailySendLimit
    const ceiling = input.ceiling ?? RAMP_DEFAULT_CEILING
    const { sent, bounces, complaints, unsubscribes } = input

    if (!input.eligible) {
        return {
            recommendedDailyLimit: current,
            reason: 'Not a campaign sender (unverified, a warm-up-only box, or on a company domain), so there is no volume to ramp.',
            ready: false,
        }
    }

    const bounceRate = sent > 0 ? bounces / sent : 0
    const unsubscribeRate = sent > 0 ? unsubscribes / sent : 0

    // Down first: a complaint or a high bounce rate outranks any amount of otherwise good history.
    if (complaints > 0 || bounceRate >= RAMP_BOUNCE_RATE_TO_LOWER) {
        const lowered = Math.min(current, Math.max(RAMP_FLOOR, current - RAMP_STEP))
        const why = complaints > 0
            ? `${complaints} spam complaint${complaints === 1 ? '' : 's'} in the last ${RAMP_WINDOW_DAYS} days`
            : `bounce rate ${asPercent(bounceRate)} (${bounces} of ${sent}) in the last ${RAMP_WINDOW_DAYS} days is at or above ${asPercent(RAMP_BOUNCE_RATE_TO_LOWER)}`
        return {
            recommendedDailyLimit: lowered,
            reason: lowered < current
                ? `Lower the limit from ${current} to ${lowered}: ${why}.`
                : `Hold at ${current}, already at the floor of ${RAMP_FLOOR}: ${why}. Consider pausing the inbox.`,
            ready: false,
        }
    }

    if (sent < RAMP_MIN_SENDS) {
        return {
            recommendedDailyLimit: current,
            reason: `Hold at ${current}: ${sent} send${sent === 1 ? '' : 's'} in the last ${RAMP_WINDOW_DAYS} days, ${RAMP_MIN_SENDS} are needed before the numbers say anything.`,
            ready: false,
        }
    }

    if (bounceRate >= RAMP_MAX_BOUNCE_RATE_TO_RAISE) {
        return {
            recommendedDailyLimit: current,
            reason: `Hold at ${current}: bounce rate ${asPercent(bounceRate)} (${bounces} of ${sent}) must be under ${asPercent(RAMP_MAX_BOUNCE_RATE_TO_RAISE)} to raise.`,
            ready: false,
        }
    }

    if (unsubscribeRate >= RAMP_MAX_UNSUBSCRIBE_RATE_TO_RAISE) {
        return {
            recommendedDailyLimit: current,
            reason: `Hold at ${current}: unsubscribe rate ${asPercent(unsubscribeRate)} (${unsubscribes} of ${sent}) must be under ${asPercent(RAMP_MAX_UNSUBSCRIBE_RATE_TO_RAISE)} to raise.`,
            ready: false,
        }
    }

    const healthy = `${sent} sends in ${RAMP_WINDOW_DAYS} days, bounce ${asPercent(bounceRate)}, unsubscribe ${asPercent(unsubscribeRate)}, no complaints`
    // A limit already above the ceiling (set by the owner in the UI) is left alone, never lowered
    // to the ceiling: this only proposes raises up to it.
    if (current >= ceiling) {
        return {
            recommendedDailyLimit: current,
            reason: `Healthy (${healthy}) and already at ${current}, the ceiling for agent-set limits (${ceiling}). Going higher is the owner's decision.`,
            ready: true,
        }
    }
    const raised = Math.min(current + RAMP_STEP, ceiling)
    return {
        recommendedDailyLimit: raised,
        reason: `Raise the limit from ${current} to ${raised}: ${healthy}.`,
        ready: true,
    }
}
