import { describe, expect, it } from 'vitest'
import {
    RAMP_BOUNCE_RATE_TO_LOWER,
    RAMP_FLOOR,
    RAMP_MIN_SENDS,
    recommendDailyLimit,
    type SendingRampInput,
} from '../sending-ramp'

function input(overrides: Partial<SendingRampInput> = {}): SendingRampInput {
    return { eligible: true, dailySendLimit: 15, sent: 40, bounces: 0, complaints: 0, unsubscribes: 0, ...overrides }
}

describe('recommendDailyLimit: raising', () => {
    it('raises by 3 when every bar is met', () => {
        expect(recommendDailyLimit(input())).toMatchObject({ recommendedDailyLimit: 18, ready: true })
    })

    it('is ready at exactly the minimum number of sends', () => {
        expect(recommendDailyLimit(input({ sent: RAMP_MIN_SENDS }))).toMatchObject({ recommendedDailyLimit: 18, ready: true })
    })

    it('holds below the minimum number of sends, however clean they were', () => {
        const result = recommendDailyLimit(input({ sent: RAMP_MIN_SENDS - 1 }))

        expect(result).toMatchObject({ recommendedDailyLimit: 15, ready: false })
        expect(result.reason).toContain('20 are needed')
    })

    it('holds at a bounce rate of 2% or more, and raises just under it', () => {
        // 2 of 100 is exactly 2%: not "under 2%".
        expect(recommendDailyLimit(input({ sent: 100, bounces: 2 }))).toMatchObject({ recommendedDailyLimit: 15, ready: false })
        expect(recommendDailyLimit(input({ sent: 100, bounces: 1 }))).toMatchObject({ recommendedDailyLimit: 18, ready: true })
    })

    it('holds at an unsubscribe rate of 3% or more, and raises just under it', () => {
        expect(recommendDailyLimit(input({ sent: 100, unsubscribes: 3 }))).toMatchObject({ recommendedDailyLimit: 15, ready: false })
        expect(recommendDailyLimit(input({ sent: 100, unsubscribes: 2 }))).toMatchObject({ recommendedDailyLimit: 18, ready: true })
    })

    it('never proposes more than the ceiling', () => {
        expect(recommendDailyLimit(input({ dailySendLimit: 28 }))).toMatchObject({ recommendedDailyLimit: 30, ready: true })
        expect(recommendDailyLimit(input({ dailySendLimit: 29, ceiling: 30 }))).toMatchObject({ recommendedDailyLimit: 30 })
    })

    it('stays put at the ceiling and says so, and never lowers a limit the owner set above it', () => {
        const atCeiling = recommendDailyLimit(input({ dailySendLimit: 30 }))
        expect(atCeiling).toMatchObject({ recommendedDailyLimit: 30, ready: true })
        expect(atCeiling.reason).toContain('owner')

        expect(recommendDailyLimit(input({ dailySendLimit: 50 }))).toMatchObject({ recommendedDailyLimit: 50, ready: true })
    })

    it('honours a different ceiling', () => {
        expect(recommendDailyLimit(input({ dailySendLimit: 15, ceiling: 16 }))).toMatchObject({ recommendedDailyLimit: 16 })
    })
})

describe('recommendDailyLimit: lowering', () => {
    it('lowers by 3 at a bounce rate of 5% or more', () => {
        const result = recommendDailyLimit(input({ sent: 100, bounces: 5 }))

        expect(result).toMatchObject({ recommendedDailyLimit: 12, ready: false })
        expect(result.reason).toContain('15 to 12')
        expect(RAMP_BOUNCE_RATE_TO_LOWER).toBe(0.05)
    })

    it('does not lower at 4.9%: that is a hold, not a cut', () => {
        expect(recommendDailyLimit(input({ sent: 1000, bounces: 49 }))).toMatchObject({ recommendedDailyLimit: 15, ready: false })
    })

    it('lowers on a single spam complaint, even with otherwise perfect numbers', () => {
        const result = recommendDailyLimit(input({ complaints: 1 }))

        expect(result).toMatchObject({ recommendedDailyLimit: 12, ready: false })
        expect(result.reason).toContain('1 spam complaint')
    })

    it('lowers on a complaint even before the minimum number of sends', () => {
        expect(recommendDailyLimit(input({ sent: 3, complaints: 1 }))).toMatchObject({ recommendedDailyLimit: 12 })
    })

    it('never goes below the floor, and never raises a limit that is already under it', () => {
        expect(recommendDailyLimit(input({ dailySendLimit: 7, complaints: 1 }))).toMatchObject({ recommendedDailyLimit: RAMP_FLOOR })
        expect(recommendDailyLimit(input({ dailySendLimit: RAMP_FLOOR, complaints: 1 }))).toMatchObject({ recommendedDailyLimit: RAMP_FLOOR })
        const under = recommendDailyLimit(input({ dailySendLimit: 3, complaints: 1 }))
        expect(under.recommendedDailyLimit).toBe(3)
        expect(under.reason).toContain('Consider pausing')
    })

    it('puts a cut ahead of "not enough sends"', () => {
        expect(recommendDailyLimit(input({ sent: 10, bounces: 2 }))).toMatchObject({ recommendedDailyLimit: 12 })
    })
})

describe('recommendDailyLimit: holding and eligibility', () => {
    it('holds with no sends at all', () => {
        expect(recommendDailyLimit(input({ sent: 0 }))).toMatchObject({ recommendedDailyLimit: 15, ready: false })
    })

    it('never ramps an inbox that cannot carry cold campaigns', () => {
        const result = recommendDailyLimit(input({ eligible: false, complaints: 2 }))

        expect(result).toMatchObject({ recommendedDailyLimit: 15, ready: false })
        expect(result.reason).toContain('Not a campaign sender')
    })
})
