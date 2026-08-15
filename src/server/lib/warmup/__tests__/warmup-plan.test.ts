import { describe, expect, it } from 'vitest'
import {
    hashFraction,
    rankRecipients,
    remainingWarmupQuota,
    scheduleSendTimes,
    selectRecipients,
    shouldReply,
    warmupDailyTarget,
    WARMUP_MAINTENANCE_TARGET,
    type WarmupRecipient,
    type WarmupSender,
} from '../plan'
import { generateWarmupContent, generateWarmupReply, replySubject } from '../content'

function sender(overrides: Partial<WarmupSender> = {}): WarmupSender {
    return {
        accountId: 'acc-1',
        address: 'a@tryskaleclub.com',
        domain: 'tryskaleclub.com',
        providerHint: 'gmail',
        warmupCurrentDay: 0,
        warmupDays: 14,
        warmupSentToday: 0,
        ...overrides,
    }
}

function recipient(address: string, providerHint?: string): WarmupRecipient {
    return { accountId: `acc-${address}`, address, domain: address.split('@')[1], providerHint }
}

describe('warmupDailyTarget', () => {
    it('starts small and never decreases along the ramp', () => {
        let previous = 0
        for (let day = 0; day <= 14; day += 1) {
            const target = warmupDailyTarget(day, 14)
            expect(target).toBeGreaterThanOrEqual(previous)
            previous = target
        }
        expect(warmupDailyTarget(0, 14)).toBeLessThanOrEqual(3)
        expect(warmupDailyTarget(14, 14)).toBe(20)
    })

    it('is concave: the first half of the ramp grows faster than the second', () => {
        const firstHalf = warmupDailyTarget(7, 14) - warmupDailyTarget(0, 14)
        const secondHalf = warmupDailyTarget(14, 14) - warmupDailyTarget(7, 14)
        expect(firstHalf).toBeGreaterThan(secondHalf)
    })
})

describe('remainingWarmupQuota', () => {
    it('subtracts what was already sent today', () => {
        const target = warmupDailyTarget(3, 14)
        expect(remainingWarmupQuota(sender({ warmupCurrentDay: 3, warmupSentToday: 2 }))).toBe(target - 2)
    })

    it('keeps a maintenance volume after the ramp instead of stopping cold', () => {
        expect(remainingWarmupQuota(sender({ warmupCurrentDay: 14 }))).toBe(WARMUP_MAINTENANCE_TARGET)
    })

    it('never goes negative', () => {
        expect(remainingWarmupQuota(sender({ warmupSentToday: 999 }))).toBe(0)
    })
})

describe('rankRecipients', () => {
    it('prefers other-domain other-provider, then other-domain, then same-domain', () => {
        const ranked = rankRecipients(sender(), [
            recipient('same@tryskaleclub.com', 'gmail'),
            recipient('crossdomain@xtimator.com', 'gmail'),
            recipient('crossall@stuscle.com', 'native'),
        ])
        expect(ranked.map((r) => r.address)).toEqual([
            'crossall@stuscle.com',
            'crossdomain@xtimator.com',
            'same@tryskaleclub.com',
        ])
    })

    it('never returns the sender itself', () => {
        const ranked = rankRecipients(sender(), [recipient('a@tryskaleclub.com', 'gmail')])
        expect(ranked).toHaveLength(0)
    })
})

describe('selectRecipients', () => {
    it('skips addresses already contacted today while fresh ones remain', () => {
        const pool = [recipient('x@stuscle.com', 'native'), recipient('y@xtimator.com', 'native')]
        const picked = selectRecipients(sender(), pool, 1, ['x@stuscle.com'])
        expect(picked[0].address).toBe('y@xtimator.com')
    })

    it('falls back to repeats only when the fresh pool is exhausted', () => {
        const pool = [recipient('x@stuscle.com', 'native')]
        const picked = selectRecipients(sender(), pool, 1, ['x@stuscle.com'])
        expect(picked[0].address).toBe('x@stuscle.com')
    })
})

describe('shouldReply', () => {
    it('is deterministic per message id', () => {
        for (const id of ['m-1', 'm-2', 'm-3']) {
            expect(shouldReply(id)).toBe(shouldReply(id))
        }
    })

    it('replies to roughly the configured fraction', () => {
        const ids = Array.from({ length: 2000 }, (_, index) => `msg-${index}`)
        const replies = ids.filter((id) => shouldReply(id)).length
        expect(replies / ids.length).toBeGreaterThan(0.25)
        expect(replies / ids.length).toBeLessThan(0.45)
    })
})

describe('scheduleSendTimes', () => {
    it('spreads sends inside the remaining window without bursting', () => {
        const now = new Date('2026-08-14T12:00:00.000Z')
        const times = scheduleSendTimes(5, now, 21)
        expect(times).toHaveLength(5)
        for (let index = 1; index < times.length; index += 1) {
            expect(times[index].getTime()).toBeGreaterThan(times[index - 1].getTime())
        }
    })
})

describe('hashFraction', () => {
    it('stays in [0, 1) and is stable', () => {
        for (const value of ['a', 'b', 'acc:0', 'acc:1']) {
            const fraction = hashFraction(value)
            expect(fraction).toBeGreaterThanOrEqual(0)
            expect(fraction).toBeLessThan(1)
            expect(hashFraction(value)).toBe(fraction)
        }
    })
})

describe('warm-up content', () => {
    it('is deterministic per seed and varied across seeds', () => {
        const one = generateWarmupContent('w.seed-1@x.com')
        expect(generateWarmupContent('w.seed-1@x.com')).toEqual(one)
        const texts = new Set(Array.from({ length: 50 }, (_, index) => generateWarmupContent(`w.${index}@x.com`).text))
        expect(texts.size).toBeGreaterThan(20)
    })

    it('contains no links, no tracking markers and no template syntax', () => {
        for (let index = 0; index < 50; index += 1) {
            const { subject, text } = generateWarmupContent(`w.${index}@x.com`)
            expect(text).not.toMatch(/https?:\/\//i)
            expect(`${subject} ${text}`).not.toMatch(/\{\{|\}\}|warm.?up|unsubscribe/i)
        }
    })

    it('reply subject does not stack Re: prefixes', () => {
        expect(replySubject('ponto rápido')).toBe('Re: ponto rápido')
        expect(replySubject('Re: ponto rápido')).toBe('Re: ponto rápido')
    })

    it('replies are short and deterministic', () => {
        const reply = generateWarmupReply('w.seed-9@x.com')
        expect(generateWarmupReply('w.seed-9@x.com')).toEqual(reply)
        expect(reply.text.length).toBeLessThan(200)
    })
})
