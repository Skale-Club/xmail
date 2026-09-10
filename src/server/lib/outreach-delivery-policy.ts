import { and, eq, or, sql } from 'drizzle-orm'
import {
    campaigns,
    emailAccounts,
    leads,
    organizations,
    suppressions,
} from '../../db/schema'
import { isWithinWindow, nextWindowStart, type SendWindow } from './outreach-send-window'

export type OutreachOrigin = 'campaign' | 'manual' | 'agentic' | 'unified_inbox'

export type DeliveryPolicyCode =
    | 'resource_missing'
    | 'organization_disabled'
    | 'campaign_inactive'
    | 'account_cross_organization'
    | 'account_not_verified'
    | 'lead_unsubscribed'
    | 'recipient_suppressed'
    | 'recipient_email_invalid'
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
    // The sending identity: `From` and the Message-ID domain are both derived from it, so
    // the dispatcher needs it from the same snapshot the policy already loaded.
    | 'email'
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
    'id' | 'organizationId' | 'email' | 'unsubscribedAt' | 'emailVerificationStatus'
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

function campaignSendWindow(campaign: CampaignPolicySnapshot): SendWindow {
    return {
        timezone: campaign.timezone,
        sendStartTime: campaign.sendStartTime,
        sendEndTime: campaign.sendEndTime,
        sendOnWeekends: campaign.sendOnWeekends,
    }
}

function isWithinCampaignWindow(campaign: CampaignPolicySnapshot, now: Date): boolean {
    return isWithinWindow(now, campaignSendWindow(campaign))
}

function nextCampaignWindow(campaign: CampaignPolicySnapshot, now: Date): Date {
    // +1 minute: unlike outreach-sequence-state.ts's scheduleAfterDelay (which searches from a
    // candidate that has already had a delay added to `now`), this is evaluated against "right
    // now" — searching from `now` itself would immediately re-match if a send-window edge case
    // ever put `now` inside the window while still failing the caller's own check above.
    const searchFrom = new Date(now.getTime() + 60_000)
    const next = nextWindowStart(searchFrom, campaignSendWindow(campaign), { horizonDays: 8 })

    // A malformed or permanently closed schedule must still defer rather than accidentally
    // authorize a send. Returning one week out keeps retryAt stable. (This is the ONE place the
    // two former copies of this rule intentionally still differ post-unification: sequence-state
    // quarantines a lead when no slot exists at all, because that path decides whether to send;
    // this one only computes a retry-after for a decision already made elsewhere, so it keeps
    // deferring instead.)
    return next ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
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
    // Send-time safety net (verification-gates step 3): a lead whose email was determined
    // invalid (Xphere import mapping or the MX pre-filter) must never be dispatched to, even if
    // it slipped past the enrollment-time gate (e.g. it was 'unknown'/'likely' at enrollment and
    // was downgraded afterwards). 'unknown' and 'likely' are deliberately NOT blocked here — only
    // a confirmed 'invalid' status stops a send.
    if (lead?.emailVerificationStatus === 'invalid') {
        return { allowed: false, code: 'recipient_email_invalid' }
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
                email: true,
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
                    emailVerificationStatus: true,
                },
            })
            : undefined,
    ])

    const recipientEmail = (input.recipientEmail || lead?.email)?.trim().toLowerCase()
    // Match an exact-address suppression OR a domain-scope block stored as an `@domain` sentinel
    // (Phase 22 UIX-04): a domain block suppresses every current + future address at that domain.
    const recipientDomain = recipientEmail?.split('@')[1]
    const suppression = recipientEmail
        ? await db.query.suppressions.findFirst({
            where: and(
                eq(suppressions.organizationId, input.organizationId),
                or(
                    sql`lower(${suppressions.emailAddress}) = ${recipientEmail}`,
                    recipientDomain ? sql`lower(${suppressions.emailAddress}) = ${'@' + recipientDomain}` : sql`false`,
                ),
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
