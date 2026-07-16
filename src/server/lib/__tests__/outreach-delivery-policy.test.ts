import { describe, expect, it, vi } from 'vitest'
import {
    evaluateOutreachDeliveryPolicy,
    type DeliveryPolicySnapshot,
    type OutreachOrigin,
} from '../outreach-delivery-policy'

const now = new Date('2026-07-15T14:00:00.000Z')

function snapshot(overrides: Partial<DeliveryPolicySnapshot> = {}): DeliveryPolicySnapshot {
    return {
        organization: { id: 'org-1', outreachEnabled: true },
        account: {
            id: 'account-1',
            organizationId: 'org-1',
            email: 'sender@example.test',
            status: 'verified',
            dailySendLimit: 50,
            currentDailySent: 0,
            warmupEnabled: false,
            warmupDays: 14,
            warmupCurrentDay: 14,
            minMinutesBetweenEmails: 5,
            lastSentAt: null,
        },
        campaign: {
            id: 'campaign-1',
            organizationId: 'org-1',
            status: 'active',
            timezone: 'UTC',
            sendOnWeekends: true,
            sendStartTime: '09:00',
            sendEndTime: '17:00',
        },
        lead: {
            id: 'lead-1',
            organizationId: 'org-1',
            email: 'lead@example.com',
            unsubscribedAt: null,
        },
        suppressed: false,
        ...overrides,
    }
}

function input(origin: OutreachOrigin) {
    return {
        origin,
        organizationId: 'org-1',
        emailAccountId: 'account-1',
        campaignId: origin === 'campaign' || origin === 'agentic' ? 'campaign-1' : undefined,
        leadId: origin === 'campaign' || origin === 'agentic' ? 'lead-1' : undefined,
        recipientEmail: 'lead@example.com',
        now,
    }
}

describe('evaluateOutreachDeliveryPolicy', () => {
    it.each<OutreachOrigin>(['campaign', 'manual', 'agentic', 'unified_inbox'])(
        'blocks %s dispatches when the organization kill switch is disabled',
        async (origin) => {
            const decision = await evaluateOutreachDeliveryPolicy(input(origin), {
                loadSnapshot: async () => snapshot({
                    organization: { id: 'org-1', outreachEnabled: false },
                }),
            })

            expect(decision).toEqual({ allowed: false, code: 'organization_disabled' })
        },
    )

    it('rejects an account owned by another organization', async () => {
        const decision = await evaluateOutreachDeliveryPolicy(input('campaign'), {
            loadSnapshot: async () => snapshot({
                account: { ...snapshot().account!, organizationId: 'org-2' },
            }),
        })

        expect(decision).toEqual({ allowed: false, code: 'account_cross_organization' })
    })

    it('rejects a suppressed recipient', async () => {
        const decision = await evaluateOutreachDeliveryPolicy(input('manual'), {
            loadSnapshot: async () => snapshot({ campaign: undefined, lead: undefined, suppressed: true }),
        })

        expect(decision).toEqual({ allowed: false, code: 'recipient_suppressed' })
    })

    it('returns the next UTC reset for warm-up exhaustion', async () => {
        const decision = await evaluateOutreachDeliveryPolicy(input('campaign'), {
            loadSnapshot: async () => snapshot({
                account: {
                    ...snapshot().account!,
                    warmupEnabled: true,
                    warmupDays: 10,
                    warmupCurrentDay: 0,
                    currentDailySent: 5,
                },
            }),
        })

        expect(decision).toEqual({
            allowed: false,
            code: 'warmup_limit_exhausted',
            retryAt: new Date('2026-07-16T00:00:00.000Z'),
        })
    })

    it('returns the spacing deadline when the account sent too recently', async () => {
        const decision = await evaluateOutreachDeliveryPolicy(input('manual'), {
            loadSnapshot: async () => snapshot({
                campaign: undefined,
                lead: undefined,
                account: {
                    ...snapshot().account!,
                    minMinutesBetweenEmails: 10,
                    lastSentAt: new Date('2026-07-15T13:55:00.000Z'),
                },
            }),
        })

        expect(decision).toEqual({
            allowed: false,
            code: 'account_spacing',
            retryAt: new Date('2026-07-15T14:05:00.000Z'),
        })
    })

    it.each<OutreachOrigin>(['campaign', 'manual', 'agentic', 'unified_inbox'])(
        'allows %s when every policy check passes',
        async (origin) => {
            const decision = await evaluateOutreachDeliveryPolicy(input(origin), {
                loadSnapshot: async () => snapshot({
                    campaign: origin === 'manual' || origin === 'unified_inbox' ? undefined : snapshot().campaign,
                    lead: origin === 'manual' || origin === 'unified_inbox' ? undefined : snapshot().lead,
                }),
            })

            expect(decision.allowed).toBe(true)
        },
    )

    it('does not call a provider after a denied decision', async () => {
        const provider = vi.fn()
        const decision = await evaluateOutreachDeliveryPolicy(input('agentic'), {
            loadSnapshot: async () => snapshot({
                organization: { id: 'org-1', outreachEnabled: false },
            }),
        })

        if (decision.allowed) await provider()

        expect(provider).not.toHaveBeenCalled()
    })
})
