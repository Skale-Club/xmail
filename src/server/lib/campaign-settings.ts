import type { Campaign } from '../../db/schema'

/**
 * Campaign settings rules shared by the human routes (routes/outreach/campaigns.ts) and the agent
 * gateway (routes/agent-campaign-manage.ts), so the two cannot drift apart.
 */

export const SEND_TIME_PATTERN = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/
export const CONTENT_LANGUAGE_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/

/** HH:mm -> minutes since midnight, for the send-window ordering check. */
export function timeToMinutes(value: string): number {
    const [hours, minutes] = value.split(':').map(Number)
    return hours * 60 + (minutes || 0)
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone })
        return true
    } catch {
        return false
    }
}

/** The send window is valid when it starts strictly before it ends. */
export function isValidSendWindow(start: string, end: string): boolean {
    return timeToMinutes(start) < timeToMinutes(end)
}

/**
 * The settings a duplicate inherits from its source. Never leads, stats, timestamps, the agent
 * idempotency columns or `activationApprovalId`: a copy is a fresh draft that must be activated
 * on its own.
 */
export function buildDuplicateCampaignValues(source: Pick<Campaign,
    | 'organizationId' | 'description' | 'contentLanguage' | 'fromName' | 'replyToEmail' | 'timezone'
    | 'sendOnWeekends' | 'sendStartTime' | 'sendEndTime' | 'trackOpens' | 'trackClicks'
    | 'agenticFollowupEnabled' | 'maxFollowUps' | 'aiAutonomousEnabled'>) {
    return {
        organizationId: source.organizationId,
        description: source.description,
        contentLanguage: source.contentLanguage,
        fromName: source.fromName,
        replyToEmail: source.replyToEmail,
        timezone: source.timezone,
        sendOnWeekends: source.sendOnWeekends,
        sendStartTime: source.sendStartTime,
        sendEndTime: source.sendEndTime,
        trackOpens: source.trackOpens,
        trackClicks: source.trackClicks,
        agenticFollowupEnabled: source.agenticFollowupEnabled,
        maxFollowUps: source.maxFollowUps,
        aiAutonomousEnabled: source.aiAutonomousEnabled,
        status: 'draft' as const,
    }
}
