import { emailAccounts } from '../../db/schema'
import { effectiveDailyLimit } from './outreach-delivery-policy'
import { isCampaignSenderEligible } from './sending-domain-guard'
import { RAMP_WINDOW_DAYS, recommendDailyLimit } from './sending-ramp'
import type { SendingRampStats } from './sending-ramp-stats'

/**
 * What the agent gateway is allowed to know about an outreach inbox.
 *
 * This is an ALLOW-list on purpose: `email_accounts` carries smtp_password, imap_password,
 * smtp_username, hosts and the Outlook mailbox link, and none of them may ever reach an LLM.
 * Queries must select exactly these columns (never `select()` + delete keys afterwards), so a
 * future secret column added to the table is excluded by default instead of leaking by default.
 */
export const AGENT_ACCOUNT_COLUMNS = {
    id: emailAccounts.id,
    email: emailAccounts.email,
    displayName: emailAccounts.displayName,
    provider: emailAccounts.provider,
    mailboxProvider: emailAccounts.mailboxProvider,
    status: emailAccounts.status,
    lastError: emailAccounts.lastError,
    dailySendLimit: emailAccounts.dailySendLimit,
    currentDailySent: emailAccounts.currentDailySent,
    minMinutesBetweenEmails: emailAccounts.minMinutesBetweenEmails,
    maxMinutesBetweenEmails: emailAccounts.maxMinutesBetweenEmails,
    warmupEnabled: emailAccounts.warmupEnabled,
    warmupDays: emailAccounts.warmupDays,
    warmupCurrentDay: emailAccounts.warmupCurrentDay,
    warmupSource: emailAccounts.warmupSource,
    warmupOnly: emailAccounts.warmupOnly,
    warmupSentToday: emailAccounts.warmupSentToday,
    verifiedAt: emailAccounts.verifiedAt,
    lastSentAt: emailAccounts.lastSentAt,
    totalSent: emailAccounts.totalSent,
    totalOpens: emailAccounts.totalOpens,
    totalClicks: emailAccounts.totalClicks,
    totalReplies: emailAccounts.totalReplies,
    totalBounces: emailAccounts.totalBounces,
} as const

export type AgentAccountRow = {
    id: string
    email: string
    displayName: string | null
    provider: string
    mailboxProvider: string
    status: string
    lastError: string | null
    dailySendLimit: number
    currentDailySent: number
    minMinutesBetweenEmails: number
    maxMinutesBetweenEmails: number
    warmupEnabled: boolean
    warmupDays: number
    warmupCurrentDay: number
    warmupSource: string
    warmupOnly: boolean
    warmupSentToday: number
    verifiedAt: Date | null
    lastSentAt: Date | null
    totalSent: number
    totalOpens: number
    totalClicks: number
    totalReplies: number
    totalBounces: number
}

const percent = (numerator: number, denominator: number): number =>
    denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0

/**
 * The 7-day numbers and the ceiling behind a ramp recommendation. Passed only by callers that
 * loaded the counts (the inbox list); without it the view carries no `rampRecommendation`.
 */
export interface AgentAccountRamp {
    stats: SendingRampStats
    /** Highest limit a raise may propose (the agent's own cap, AGENT_MAX_DAILY_SEND_LIMIT). */
    ceiling: number
}

/** The shape returned to the agent: no secrets, plus the derived numbers it actually needs. */
export function toAgentAccountView(account: AgentAccountRow, ramp?: AgentAccountRamp) {
    const campaignSenderEligible = isCampaignSenderEligible(account)
    return {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        provider: account.provider,
        mailboxProvider: account.mailboxProvider,
        status: account.status,
        // Connection probes store short classified messages; cap it anyway so a raw error can
        // never become a way to move a hostname or banner into a prompt.
        lastError: account.lastError ? account.lastError.slice(0, 200) : null,
        limits: {
            dailySendLimit: account.dailySendLimit,
            effectiveDailyLimit: effectiveDailyLimit({
                dailySendLimit: account.dailySendLimit,
                warmupEnabled: account.warmupEnabled,
                warmupDays: account.warmupDays,
                warmupCurrentDay: account.warmupCurrentDay,
            } as Parameters<typeof effectiveDailyLimit>[0]),
            sentToday: account.currentDailySent,
            minMinutesBetweenEmails: account.minMinutesBetweenEmails,
            maxMinutesBetweenEmails: account.maxMinutesBetweenEmails,
        },
        warmup: {
            enabled: account.warmupEnabled,
            days: account.warmupDays,
            currentDay: account.warmupCurrentDay,
            progressPercent: account.warmupEnabled
                ? Math.min(100, Math.round((account.warmupCurrentDay / Math.max(1, account.warmupDays)) * 100))
                : 100,
            source: account.warmupSource,
            warmupOnly: account.warmupOnly,
            sentToday: account.warmupSentToday,
        },
        health: {
            totalSent: account.totalSent,
            openRatePercent: percent(account.totalOpens, account.totalSent),
            replyRatePercent: percent(account.totalReplies, account.totalSent),
            bounceRatePercent: percent(account.totalBounces, account.totalSent),
            verifiedAt: account.verifiedAt,
            lastSentAt: account.lastSentAt,
        },
        // The three-mailbox rule, stated by the server: only a verified, non-warm-up-only inbox
        // outside the operation's own domains can carry cold campaign traffic.
        campaignSenderEligible,
        // Read-only advice on the daily limit from the last 7 days of sending. NEVER applied by
        // the server: raising the limit is a PATCH the agent chooses to make (capped at the agent
        // ceiling) or the owner makes in the UI. `complaints` counts `complaint` suppressions only;
        // there is no feedback-loop ingestion, so zero here means "none recorded".
        ...(ramp
            ? {
                rampRecommendation: {
                    ...recommendDailyLimit({
                        eligible: campaignSenderEligible,
                        dailySendLimit: account.dailySendLimit,
                        ...ramp.stats,
                        ceiling: ramp.ceiling,
                    }),
                    basis: {
                        windowDays: RAMP_WINDOW_DAYS,
                        sent: ramp.stats.sent,
                        bounces: ramp.stats.bounces,
                        complaints: ramp.stats.complaints,
                        unsubscribes: ramp.stats.unsubscribes,
                        bounceRatePercent: percent(ramp.stats.bounces, ramp.stats.sent),
                        unsubscribeRatePercent: percent(ramp.stats.unsubscribes, ramp.stats.sent),
                    },
                },
            }
            : {}),
    }
}
