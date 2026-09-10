import { describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. `parseBounceMessage` and `decideSoftBounceOutcome` are both pure, but
 * importing the module also pulls in `../../db` (via `db`), which throws at import time without
 * DATABASE_URL. Mock it out, same as enforceDeliverabilityGuardrails.test.ts /
 * amortizeSubscriptionCosts.test.ts do for the same reason. `../lib/xphere-events` and
 * `../lib/outreach-settings` are mocked too since they are only reachable from the DB-touching
 * paths this file does not exercise.
 */
// processBounces.ts's transitive imports (cron-lock.ts, outreach-inbound-sources.ts) also pull
// named exports off '../../db' at their own top level, so the mock must provide all of them.
vi.mock('../../db', () => ({ db: {}, queryClient: vi.fn(), jobQueryClient: vi.fn() }))
vi.mock('../lib/xphere-events', () => ({ sendXphereOutreachEvent: vi.fn(), publishOutreachEvent: vi.fn() }))
vi.mock('../lib/outreach-settings', () => ({ shouldNotifyOutreachEvent: vi.fn() }))

import {
    parseBounceMessage,
    decideSoftBounceOutcome,
    SOFT_BOUNCE_BACKOFF_MS,
    SOFT_BOUNCE_GIVE_UP_AFTER,
} from './processBounces'

function parsedMail(text: string) {
    return { text, html: false, messageId: undefined } as unknown as Parameters<typeof parseBounceMessage>[0]
}

describe('parseBounceMessage', () => {
    it.each([
        'User unknown in relay recipient table',
        '550 5.1.1 The email account that you tried to reach does not exist',
        'Recipient address rejected: no such user',
    ])('classifies a hard-bounce indicator as hard: %s', (message) => {
        expect(parseBounceMessage(parsedMail(message)).bounceType).toBe('hard')
    })

    it.each([
        '452 4.2.2 The email account that you tried to reach is over quota (mailbox full)',
        '451 4.7.1 Greylisted, please try again later',
        '450 4.2.1 Recipient temporarily unavailable, rate limit exceeded',
    ])('classifies a soft-bounce (temporary-failure) indicator as soft: %s', (message) => {
        expect(parseBounceMessage(parsedMail(message)).bounceType).toBe('soft')
    })

    it('defaults to hard when no recognized indicator is present', () => {
        expect(parseBounceMessage(parsedMail('some unrecognized delivery failure')).bounceType).toBe('hard')
    })
})

describe('decideSoftBounceOutcome', () => {
    it('reschedules the first soft bounce with the shortest backoff', () => {
        const outcome = decideSoftBounceOutcome(0, 'mailbox full')
        expect(outcome).toMatchObject({
            type: 'reschedule',
            occurrence: 1,
            backoffMs: SOFT_BOUNCE_BACKOFF_MS[0],
        })
        if (outcome.type === 'reschedule') {
            expect(outcome.bounceReason).toBe(`soft_bounce(1/${SOFT_BOUNCE_GIVE_UP_AFTER}): mailbox full`)
        }
    })

    it('escalates the backoff on the second and third soft bounce', () => {
        const second = decideSoftBounceOutcome(1, 'mailbox full')
        const third = decideSoftBounceOutcome(2, 'mailbox full')
        expect(second).toMatchObject({ type: 'reschedule', occurrence: 2, backoffMs: SOFT_BOUNCE_BACKOFF_MS[1] })
        expect(third).toMatchObject({ type: 'reschedule', occurrence: 3, backoffMs: SOFT_BOUNCE_BACKOFF_MS[2] })
        // Strictly escalating, not just different.
        expect(SOFT_BOUNCE_BACKOFF_MS[0]).toBeLessThan(SOFT_BOUNCE_BACKOFF_MS[1])
        expect(SOFT_BOUNCE_BACKOFF_MS[1]).toBeLessThan(SOFT_BOUNCE_BACKOFF_MS[2])
    })

    it(`gives up after ${SOFT_BOUNCE_GIVE_UP_AFTER} prior soft bounces instead of rescheduling again`, () => {
        const outcome = decideSoftBounceOutcome(SOFT_BOUNCE_GIVE_UP_AFTER, 'mailbox full')
        expect(outcome).toEqual({
            type: 'give_up',
            hardBounceReason: `permanent failure after ${SOFT_BOUNCE_GIVE_UP_AFTER} repeated soft bounces: mailbox full`,
        })
    })

    it('the give-up reason matches the hard-bounce suppression phrase detector', () => {
        // applyHardBounce suppresses org-wide only when the reason text looks permanent
        // (/permanent|hard|550|.../i). The give-up outcome must satisfy that same regex so a
        // mailbox that exhausted its soft-bounce budget still gets suppressed, not silently
        // retried forever.
        const outcome = decideSoftBounceOutcome(SOFT_BOUNCE_GIVE_UP_AFTER, 'mailbox full')
        expect(outcome.type).toBe('give_up')
        if (outcome.type === 'give_up') {
            expect(outcome.hardBounceReason).toMatch(/permanent|hard|550|551|553|user unknown|no such user|address not found|mailbox unavailable|does not exist|recipient rejected|invalid recipient/i)
        }
    })

    it('never reschedules past the give-up threshold', () => {
        for (let prior = 0; prior < SOFT_BOUNCE_GIVE_UP_AFTER; prior++) {
            expect(decideSoftBounceOutcome(prior, 'x').type).toBe('reschedule')
        }
        for (let prior = SOFT_BOUNCE_GIVE_UP_AFTER; prior < SOFT_BOUNCE_GIVE_UP_AFTER + 3; prior++) {
            expect(decideSoftBounceOutcome(prior, 'x').type).toBe('give_up')
        }
    })
})
