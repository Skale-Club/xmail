import { and, eq, sql } from 'drizzle-orm'
import {
    campaigns,
    emailAccounts,
    leads,
    organizations,
    suppressions,
} from '../../db/schema'

export type OutreachOrigin = 'campaign' | 'manual' | 'agentic' | 'unified_inbox'

export type DeliveryPolicyCode =
    | 'resource_missing'
    | 'organization_disabled'
    | 'campaign_inactive'
    | 'account_cross_organization'
    | 'account_not_verified'
    | 'lead_unsubscribed'
    | 'recipient_suppressed'
    | 'outside_send_window'
    | 'daily_limit_exhausted'
    | 'warmup_limit_exhausted'
    | 'account_spacing'

export interface DeliveryPolicyInput {
    origin: OutreachOrigin
    organizationId: string
    emailAccountId: string
    campaignId?: string
    leadId?: string
    recipientEmail?: string
    now?: Date
}

export type OrganizationPolicySnapshot = Pick<
    typeof organizations.$inferSelect,
    'id' | 'outreachEnabled'
>

export type AccountPolicySnapshot = Pick<
    typeof emailAccounts.$inferSelect,
    | 'id'
    | 'organizationId'
    | 'status'
    | 'dailySendLimit'
    | 'currentDailySent'
    | 'warmupEnabled'
    | 'warmupDays'
    | 'warmupCurrentDay'
    | 'minMinutesBetweenEmails'
    | 'lastSentAt'
>

export type CampaignPolicySnapshot = Pick<
    typeof campaigns.$inferSelect,
    | 'id'
    | 'organizationId'
    | 'status'
    | 'timezone'
    | 'sendOnWeekends'
    | 'sendStartTime'
    | 'sendEndTime'
>

export type LeadPolicySnapshot = Pick<
    typeof leads.$inferSelect,
    'id' | 'organizationId' | 'email' | 'unsubscribedAt'
>

export interface DeliveryPolicySnapshot {
    organization?: OrganizationPolicySnapshot
    account?: AccountPolicySnapshot
    campaign?: CampaignPolicySnapshot
    lead?: LeadPolicySnapshot
    suppressed: boolean
}

export type DeliveryPolicyDecision =
    | {
        allowed: true
        organization: OrganizationPolicySnapshot
        account: AccountPolicySnapshot
        campaign?: CampaignPolicySnapshot
        lead?: LeadPolicySnapshot
    }
    | {
        allowed: false
        code: DeliveryPolicyCode
        retryAt?: Date
    }

export interface DeliveryPolicyDependencies {
    loadSnapshot?: (input: DeliveryPolicyInput) => Promise<DeliveryPolicySnapshot>
}

interface ZonedDateParts {
    weekday: number
    hour: number
    minute: number
}

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
    let parts: Intl.DateTimeFormatPart[]
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone || 'UTC',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date)
    } catch {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'UTC',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date)
    }

    const value = (type: string) => parts.find((part) => part.type === type)?.value
    const weekdays: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    }

    return {
        weekday: weekdays[value('weekday') || 'Sun'] ?? 0,
        hour: Number(value('hour') || 0),
        minute: Number(value('minute') || 0),
    }
}

function parseTime(value: string): number {
    const [hours, minutes] = value.split(':').map(Number)
    return hours * 60 + (minutes || 0)
}

function isWithinCampaignWindow(campaign: CampaignPolicySnapshot, now: Date): boolean {
    const zoned = getZonedDateParts(now, campaign.timezone)
    if ((zoned.weekday === 0 || zoned.weekday === 6) && !campaign.sendOnWeekends) {
        return false
    }

    const currentMinutes = zoned.hour * 60 + zoned.minute
    return currentMinutes >= parseTime(campaign.sendStartTime)
        && currentMinutes <= parseTime(campaign.sendEndTime)
}

function nextCampaignWindow(campaign: CampaignPolicySnapshot, now: Date): Date {
    const candidate = new Date(now)
    candidate.setUTCSeconds(0, 0)
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)

    const maxMinutes = 8 * 24 * 60
    for (let minute = 0; minute < maxMinutes; minute++) {
        if (isWithinCampaignWindow(campaign, candidate)) return new Date(candidate)
        candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
    }

    // A malformed or permanently closed schedule must still defer rather than
    // accidentally authorize a send. Returning one week out keeps retryAt stable.
    return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
}

function nextUtcDailyReset(now: Date): Date {
    return new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
    ))
}

export function effectiveDailyLimit(account: AccountPolicySnapshot): number {
    const fullLimit = Math.max(1, account.dailySendLimit)
    if (!account.warmupEnabled) return fullLimit

    const warmupDays = Math.max(1, account.warmupDays)
    const currentDay = Math.max(0, Math.min(account.warmupCurrentDay, warmupDays))
    if (currentDay >= warmupDays) return fullLimit

    const startLimit = Math.min(5, fullLimit)
    const progress = currentDay / warmupDays
    return Math.max(1, Math.min(
        fullLimit,
        Math.ceil(startLimit + (fullLimit - startLimit) * progress),
    ))
}

export function evaluateOutreachDeliverySnapshot(
    input: DeliveryPolicyInput,
    snapshot: DeliveryPolicySnapshot,
): DeliveryPolicyDecision {
    const now = input.now ?? new Date()
    const { organization, account, campaign, lead } = snapshot

    if (!organization || !account || (input.campaignId && !campaign) || (input.leadId && !lead)) {
        return { allowed: false, code: 'resource_missing' }
    }

    if (campaign && campaign.organizationId !== input.organizationId) {
        return { allowed: false, code: 'resource_missing' }
    }
    if (lead && lead.organizationId !== input.organizationId) {
        return { allowed: false, code: 'resource_missing' }
    }

    if (!organization.outreachEnabled) {
        return { allowed: false, code: 'organization_disabled' }
    }

    if (campaign && campaign.status !== 'active') {
        return { allowed: false, code: 'campaign_inactive' }
    }

    if (account.organizationId !== input.organizationId) {
        return { allowed: false, code: 'account_cross_organization' }
    }
    if (account.status !== 'verified') {
        return { allowed: false, code: 'account_not_verified' }
    }

    if (lead?.unsubscribedAt) {
        return { allowed: false, code: 'lead_unsubscribed' }
    }
    if (snapshot.suppressed) {
        return { allowed: false, code: 'recipient_suppressed' }
    }

    if (campaign && !isWithinCampaignWindow(campaign, now)) {
        return {
            allowed: false,
            code: 'outside_send_window',
            retryAt: nextCampaignWindow(campaign, now),
        }
    }

    const dailyLimit = effectiveDailyLimit(account)
    if (account.currentDailySent >= dailyLimit) {
        return {
            allowed: false,
            code: account.warmupEnabled && dailyLimit < Math.max(1, account.dailySendLimit)
                ? 'warmup_limit_exhausted'
                : 'daily_limit_exhausted',
            retryAt: nextUtcDailyReset(now),
        }
    }

    if (account.lastSentAt) {
        const retryAt = new Date(
            account.lastSentAt.getTime() + Math.max(0, account.minMinutesBetweenEmails) * 60_000,
        )
        if (retryAt.getTime() > now.getTime()) {
            return { allowed: false, code: 'account_spacing', retryAt }
        }
    }

    return { allowed: true, organization, account, campaign, lead }
}

export async function loadOutreachDeliverySnapshot(
    input: DeliveryPolicyInput,
): Promise<DeliveryPolicySnapshot> {
    // Dynamic import keeps pure policy tests independent from DATABASE_URL.
    const { db } = await import('../../db')

    const [organization, account, campaign, lead] = await Promise.all([
        db.query.organizations.findFirst({
            where: eq(organizations.id, input.organizationId),
            columns: { id: true, outreachEnabled: true },
        }),
        db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.id, input.emailAccountId),
            columns: {
                id: true,
                organizationId: true,
                status: true,
                dailySendLimit: true,
                currentDailySent: true,
                warmupEnabled: true,
                warmupDays: true,
                warmupCurrentDay: true,
                minMinutesBetweenEmails: true,
                lastSentAt: true,
            },
        }),
        input.campaignId
            ? db.query.campaigns.findFirst({
                where: eq(campaigns.id, input.campaignId),
                columns: {
                    id: true,
                    organizationId: true,
                    status: true,
                    timezone: true,
                    sendOnWeekends: true,
                    sendStartTime: true,
                    sendEndTime: true,
                },
            })
            : undefined,
        input.leadId
            ? db.query.leads.findFirst({
                where: eq(leads.id, input.leadId),
                columns: {
                    id: true,
                    organizationId: true,
                    email: true,
                    unsubscribedAt: true,
                },
            })
            : undefined,
    ])

    const recipientEmail = (input.recipientEmail || lead?.email)?.trim().toLowerCase()
    const suppression = recipientEmail
        ? await db.query.suppressions.findFirst({
            where: and(
                eq(suppressions.organizationId, input.organizationId),
                sql`lower(${suppressions.emailAddress}) = ${recipientEmail}`,
            ),
            columns: { id: true },
        })
        : undefined

    return {
        organization,
        account,
        campaign,
        lead,
        suppressed: suppression != null,
    }
}

export async function evaluateOutreachDeliveryPolicy(
    input: DeliveryPolicyInput,
    dependencies: DeliveryPolicyDependencies = {},
): Promise<DeliveryPolicyDecision> {
    const loadSnapshot = dependencies.loadSnapshot ?? loadOutreachDeliverySnapshot
    const snapshot = await loadSnapshot(input)
    return evaluateOutreachDeliverySnapshot(input, snapshot)
}
