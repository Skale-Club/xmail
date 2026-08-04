/**
 * The single source of default outreach configuration and notification policy.
 *
 * A NEW campaign or email account inherits these defaults for any field the request OMITS;
 * an explicit request value always wins (see the `??` merges in campaigns.ts / email-accounts.ts).
 * Existing rows are never rewritten when an org later changes its stored defaults — the merge
 * only runs at creation time.
 *
 * The notification flags are NOT decoration: `resolveOutreachSettings` is consumed by the
 * reply/bounce/unsubscribe event paths (processReplies, processBounces, unsubscribe) to decide
 * whether to emit the corresponding outreach event notification. The database column
 * `weekly_report` is intentionally NOT surfaced here — no weekly-report transport exists, so the
 * control was removed from the API and UI rather than left decorative.
 */
import { db } from '../../db'
import { outreachSettings } from '../../db/schema'
import { eq } from 'drizzle-orm'

export interface ResolvedOutreachSettings {
    // general
    defaultTimezone: string
    defaultSendStartTime: string
    defaultSendEndTime: string
    sendOnWeekends: boolean
    trackOpens: boolean
    trackClicks: boolean
    // sending
    defaultDailyLimit: number
    defaultMinMinutesBetweenEmails: number
    warmupEnabled: boolean
    warmupDays: number
    // notification policy (event-transport gates)
    notifyOnReply: boolean
    notifyOnBounce: boolean
    notifyOnUnsubscribe: boolean
    // deliverability circuit breaker
    deliverabilityGuardEnabled: boolean
    bounceRateLimitPercent: number
    bounceRateMinSample: number
    unsubscribeRateLimitPercent: number
    unsubscribeRateMinSample: number
}

export const OUTREACH_SETTINGS_DEFAULTS: ResolvedOutreachSettings = {
    defaultTimezone: 'UTC',
    defaultSendStartTime: '09:00',
    defaultSendEndTime: '17:00',
    sendOnWeekends: false,
    trackOpens: true,
    trackClicks: true,
    defaultDailyLimit: 50,
    defaultMinMinutesBetweenEmails: 5,
    warmupEnabled: true,
    warmupDays: 21,
    notifyOnReply: true,
    notifyOnBounce: true,
    notifyOnUnsubscribe: false,
    deliverabilityGuardEnabled: true,
    bounceRateLimitPercent: 5,
    bounceRateMinSample: 20,
    unsubscribeRateLimitPercent: 2,
    unsubscribeRateMinSample: 50,
}

/**
 * Resolve an organization's effective settings: the stored row when present, otherwise the
 * constant defaults. Never creates a row (reads must not mutate).
 */
export async function resolveOutreachSettings(organizationId: string): Promise<ResolvedOutreachSettings> {
    const row = await db.query.outreachSettings.findFirst({
        where: eq(outreachSettings.organizationId, organizationId),
    })
    if (!row) return { ...OUTREACH_SETTINGS_DEFAULTS }
    return {
        defaultTimezone: row.defaultTimezone,
        defaultSendStartTime: row.defaultSendStartTime,
        defaultSendEndTime: row.defaultSendEndTime,
        sendOnWeekends: row.sendOnWeekends,
        trackOpens: row.trackOpens,
        trackClicks: row.trackClicks,
        defaultDailyLimit: row.defaultDailyLimit,
        defaultMinMinutesBetweenEmails: row.defaultMinMinutesBetweenEmails,
        warmupEnabled: row.warmupEnabled,
        warmupDays: row.warmupDays,
        notifyOnReply: row.notifyOnReply,
        notifyOnBounce: row.notifyOnBounce,
        notifyOnUnsubscribe: row.notifyOnUnsubscribe,
        deliverabilityGuardEnabled: row.deliverabilityGuardEnabled,
        bounceRateLimitPercent: row.bounceRateLimitPercent,
        bounceRateMinSample: row.bounceRateMinSample,
        unsubscribeRateLimitPercent: row.unsubscribeRateLimitPercent,
        unsubscribeRateMinSample: row.unsubscribeRateMinSample,
    }
}

export type OutreachNotificationEvent = 'reply' | 'bounce' | 'unsubscribe'

/**
 * Whether an organization wants an outreach event notification emitted for the given inbound
 * event. Resolved per-organization, so one tenant's toggle can never gate another's event.
 */
export async function shouldNotifyOutreachEvent(
    organizationId: string,
    event: OutreachNotificationEvent,
): Promise<boolean> {
    const settings = await resolveOutreachSettings(organizationId)
    if (event === 'reply') return settings.notifyOnReply
    if (event === 'bounce') return settings.notifyOnBounce
    return settings.notifyOnUnsubscribe
}

/** Nested presentation shape returned by the settings API. */
export function toApiOutreachSettings(s: ResolvedOutreachSettings) {
    return {
        general: {
            defaultTimezone: s.defaultTimezone,
            defaultSendStartTime: s.defaultSendStartTime,
            defaultSendEndTime: s.defaultSendEndTime,
            sendOnWeekends: s.sendOnWeekends,
            trackOpens: s.trackOpens,
            trackClicks: s.trackClicks,
        },
        sending: {
            defaultDailyLimit: s.defaultDailyLimit,
            defaultMinMinutesBetweenEmails: s.defaultMinMinutesBetweenEmails,
            warmupEnabled: s.warmupEnabled,
            warmupDays: s.warmupDays,
        },
        notifications: {
            notifyOnReply: s.notifyOnReply,
            notifyOnBounce: s.notifyOnBounce,
            notifyOnUnsubscribe: s.notifyOnUnsubscribe,
        },
        deliverability: {
            guardEnabled: s.deliverabilityGuardEnabled,
            bounceRateLimitPercent: s.bounceRateLimitPercent,
            bounceRateMinSample: s.bounceRateMinSample,
            unsubscribeRateLimitPercent: s.unsubscribeRateLimitPercent,
            unsubscribeRateMinSample: s.unsubscribeRateMinSample,
        },
    }
}
