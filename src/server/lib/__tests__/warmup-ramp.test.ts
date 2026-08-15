import { describe, expect, it, vi } from 'vitest'

// Same seam as outlook-inbound.test.ts: outreach-sender statically imports the app db, which
// builds a real postgres client at import time and throws without DATABASE_URL. Its tracking
// import likewise mints HMAC tokens at module load, so the secret has to exist before the
// import graph is evaluated — hence vi.hoisted rather than a plain assignment.
vi.mock('../../../db', () => ({ db: {}, queryClient: vi.fn() }))
vi.hoisted(() => {
    process.env.ENCRYPTION_KEY ||= 'warmup-ramp-test-secret'
})

import { effectiveDailyLimit, type AccountPolicySnapshot } from '../outreach-delivery-policy'
import { getEffectiveDailySendLimit } from '../outreach-sender'
import type { emailAccounts } from '../../../db/schema'

function account(overrides: Partial<AccountPolicySnapshot> = {}): AccountPolicySnapshot {
    return {
        id: 'account-1',
        organizationId: 'org-1',
        email: 'sender@example.test',
        status: 'verified',
        dailySendLimit: 50,
        currentDailySent: 0,
        warmupEnabled: true,
        warmupDays: 14,
        warmupCurrentDay: 0,
        minMinutesBetweenEmails: 5,
        lastSentAt: null,
        ...overrides,
    }
}

describe('warm-up ramp', () => {
    it('starts a warming mailbox at the 5/day floor', () => {
        expect(effectiveDailyLimit(account({ warmupCurrentDay: 0 }))).toBe(5)
    })

    it('interpolates between the floor and the full limit', () => {
        expect(effectiveDailyLimit(account({ warmupCurrentDay: 7 }))).toBe(28)
    })

    it('reaches the full limit only at the end of the ramp', () => {
        expect(effectiveDailyLimit(account({ warmupCurrentDay: 13 }))).toBe(47)
        expect(effectiveDailyLimit(account({ warmupCurrentDay: 14 }))).toBe(50)
    })

    it('ignores the ramp when warm-up is disabled', () => {
        expect(effectiveDailyLimit(account({ warmupEnabled: false, warmupCurrentDay: 0 }))).toBe(50)
    })

    it('never returns more than the configured daily limit', () => {
        expect(effectiveDailyLimit(account({ dailySendLimit: 3, warmupCurrentDay: 0 }))).toBe(3)
    })

    // The inbox API reports the limit to the UI through the sender wrapper while the dispatcher
    // enforces the policy function. They were two hand-copied implementations; if they ever
    // diverge again the inbox screen promises a quota the dispatcher will refuse.
    it('reports the same limit to the UI as the dispatcher enforces', () => {
        for (const warmupEnabled of [true, false]) {
            for (const dailySendLimit of [1, 3, 50, 200]) {
                for (const warmupDays of [1, 14, 21]) {
                    for (let warmupCurrentDay = 0; warmupCurrentDay <= warmupDays + 1; warmupCurrentDay++) {
                        const snapshot = account({ warmupEnabled, dailySendLimit, warmupDays, warmupCurrentDay })
                        expect(getEffectiveDailySendLimit(snapshot as typeof emailAccounts.$inferSelect))
                            .toBe(effectiveDailyLimit(snapshot))
                    }
                }
            }
        }
    })
})
