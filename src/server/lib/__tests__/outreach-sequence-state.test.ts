import { describe, expect, it, vi } from 'vitest'
import type { SequenceStep } from '../../../db/schema'
import {
    pickDelayMinutes,
    resolveSequenceAction,
    validateSequenceForActivation,
    type SequenceSchedule,
} from '../outreach-sequence-state'

const schedule: SequenceSchedule = {
    timezone: 'UTC',
    sendStartTime: '09:00',
    sendEndTime: '17:00',
    sendOnWeekends: false,
}

function step(overrides: Partial<SequenceStep> = {}): SequenceStep {
    return {
        id: 'step-1',
        sequenceId: 'sequence-1',
        stepOrder: 1,
        type: 'email',
        delayHours: 0,
        delayHoursMax: null,
        subject: 'Hello',
        plainBody: 'Plain body',
        htmlBody: null,
        subjectB: null,
        plainBodyB: null,
        htmlBodyB: null,
        abTestEnabled: false,
        abTestPercentage: 50,
        totalSent: 0,
        totalOpens: 0,
        totalClicks: 0,
        totalReplies: 0,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
    }
}

describe('resolveSequenceAction', () => {
    it('sorts unordered input and prepares only an email step for dispatch', () => {
        const first = step({ id: 'email-1', stepOrder: 1 })
        const delay = step({ id: 'delay-2', stepOrder: 2, type: 'delay', delayHours: 24, subject: null, plainBody: null })
        const last = step({ id: 'email-3', stepOrder: 3 })

        const action = resolveSequenceAction(
            [last, first, delay],
            first,
            new Date('2026-07-16T10:00:00.000Z'),
            schedule,
        )

        expect(action).toMatchObject({
            type: 'send_email',
            step: { id: 'email-1', type: 'email' },
            nextStep: { id: 'delay-2' },
        })
        if (action.type === 'send_email') {
            expect(action.content).toEqual({ subject: 'Hello', plainBody: 'Plain body', htmlBody: null })
            expect(action.nextScheduledAt).toEqual(new Date('2026-07-16T10:00:00.000Z'))
        }
    })

    it('applies a first delay and advances without provider content', () => {
        const delay = step({ id: 'delay-1', type: 'delay', delayHours: 3, subject: null, plainBody: null })
        const email = step({ id: 'email-2', stepOrder: 2 })

        const action = resolveSequenceAction(
            [email, delay],
            delay,
            new Date('2026-07-16T10:00:00.000Z'),
            schedule,
        )

        expect(action).toEqual({
            type: 'advance_without_send',
            fromStep: delay,
            nextStep: email,
            nextScheduledAt: new Date('2026-07-16T13:00:00.000Z'),
        })
        expect('content' in action).toBe(false)
    })

    it('completes a sequence whose last row is a delay without sending', () => {
        const delay = step({ id: 'delay-last', type: 'delay', delayHours: 8, subject: null, plainBody: null })

        expect(resolveSequenceAction([delay], delay, new Date('2026-07-16T10:00:00.000Z'), schedule)).toEqual({
            type: 'complete',
            completedAt: new Date('2026-07-16T10:00:00.000Z'),
        })
    })

    it.each([
        { subject: '   ', plainBody: 'body', htmlBody: null },
        { subject: 'subject', plainBody: '   ', htmlBody: '\n' },
    ])('quarantines malformed email content: %o', (content) => {
        const email = step(content)

        expect(resolveSequenceAction([email], email, new Date('2026-07-16T10:00:00.000Z'), schedule)).toEqual({
            type: 'quarantine',
            reason: 'invalid_email_content',
            step: email,
        })
    })

    it('quarantines legacy condition rows', () => {
        const condition = step({ type: 'condition', subject: null, plainBody: null })

        expect(resolveSequenceAction([condition], condition, new Date('2026-07-16T10:00:00.000Z'), schedule)).toEqual({
            type: 'quarantine',
            reason: 'unsupported_condition_step',
            step: condition,
        })
    })

    it('rolls a delay outside the send window across the weekend', () => {
        const delay = step({ id: 'delay-1', type: 'delay', delayHours: 2, subject: null, plainBody: null })
        const email = step({ id: 'email-2', stepOrder: 2 })

        const action = resolveSequenceAction(
            [delay, email],
            delay,
            new Date('2026-07-17T18:00:00.000Z'),
            schedule,
        )

        expect(action).toMatchObject({ type: 'advance_without_send' })
        if (action.type === 'advance_without_send') {
            expect(action.nextScheduledAt).toEqual(new Date('2026-07-20T09:00:00.000Z'))
        }
    })

    it('returns completion when there is no current step', () => {
        expect(resolveSequenceAction([], null, new Date('2026-07-16T10:00:00.000Z'), schedule)).toEqual({
            type: 'complete',
            completedAt: new Date('2026-07-16T10:00:00.000Z'),
        })
    })

    const impossibleSchedule: SequenceSchedule = {
        ...schedule,
        sendStartTime: '17:00',
        sendEndTime: '09:00', // start >= end: no minute of any day ever qualifies
    }

    it('quarantines instead of sending when a delay step cannot compute a valid next send window', () => {
        const delay = step({ id: 'delay-1', type: 'delay', delayHours: 2, subject: null, plainBody: null })
        const email = step({ id: 'email-2', stepOrder: 2 })

        expect(resolveSequenceAction(
            [delay, email],
            delay,
            new Date('2026-07-16T10:00:00.000Z'),
            impossibleSchedule,
        )).toEqual({
            type: 'quarantine',
            reason: 'invalid_send_window',
            step: delay,
        })
    })

    it('quarantines instead of sending when the FOLLOWING email step cannot compute a valid send window', () => {
        const first = step({ id: 'email-1', stepOrder: 1 })
        const second = step({ id: 'email-2', stepOrder: 2 })

        // The current step is a perfectly valid, due email — but since we cannot honor a
        // schedule for whatever comes after it, we must not silently strand the lead by sending
        // anyway. The whole row is quarantined instead of shipped.
        expect(resolveSequenceAction(
            [first, second],
            first,
            new Date('2026-07-16T10:00:00.000Z'),
            impossibleSchedule,
        )).toEqual({
            type: 'quarantine',
            reason: 'invalid_send_window',
            step: first,
        })
    })
})

describe('variable delay between steps (delayHours..delayHoursMax)', () => {
    // Open all day, every day, so the send-window roll-forward never moves the picked time.
    const allDay: SequenceSchedule = { timezone: 'UTC', sendStartTime: '00:00', sendEndTime: '23:59', sendOnWeekends: true }
    const now = new Date('2026-07-16T10:00:00.000Z')
    const first = step({ id: 'email-1', stepOrder: 1 })

    function nextAt(next: Partial<SequenceStep>, random: () => number, window: SequenceSchedule = allDay): Date | null {
        const second = step({ id: 'email-2', stepOrder: 2, ...next })
        const action = resolveSequenceAction([first, second], first, now, window, random)
        if (action.type !== 'send_email') throw new Error('expected send_email, got ' + action.type)
        return action.nextScheduledAt
    }

    it('picks the lower bound, the middle and the upper bound from the injected randomness', () => {
        const range = { delayHours: 2, delayHoursMax: 10 }
        expect(nextAt(range, () => 0)).toEqual(new Date('2026-07-16T12:00:00.000Z'))
        expect(nextAt(range, () => 0.5)).toEqual(new Date('2026-07-16T16:00:00.000Z'))
        expect(nextAt(range, () => 1)).toEqual(new Date('2026-07-16T20:00:00.000Z'))
    })

    it('allows fractional hours at minute precision', () => {
        // 1h + 0.25 * 1h = 1h15m
        expect(nextAt({ delayHours: 1, delayHoursMax: 2 }, () => 0.25)).toEqual(new Date('2026-07-16T11:15:00.000Z'))
        // 0.123 * 60 min = 7.38 -> 7 min
        expect(nextAt({ delayHours: 1, delayHoursMax: 2 }, () => 0.123)).toEqual(new Date('2026-07-16T11:07:00.000Z'))
    })

    it('never leaves [delayHours, delayHoursMax] over a sweep of random values', () => {
        for (let i = 0; i <= 100; i++) {
            const minutes = pickDelayMinutes({ delayHours: 24, delayHoursMax: 72 }, () => i / 100)
            expect(minutes).toBeGreaterThanOrEqual(24 * 60)
            expect(minutes).toBeLessThanOrEqual(72 * 60)
            expect(Number.isInteger(minutes)).toBe(true)
        }
    })

    it('a null delayHoursMax keeps the fixed delay and does not consume randomness', () => {
        const random = vi.fn(() => 0.9)
        expect(nextAt({ delayHours: 3, delayHoursMax: null }, random)).toEqual(new Date('2026-07-16T13:00:00.000Z'))
        expect(random).not.toHaveBeenCalled()
    })

    it('a delayHoursMax equal to delayHours is a fixed delay', () => {
        const random = vi.fn(() => 0.9)
        expect(nextAt({ delayHours: 3, delayHoursMax: 3 }, random)).toEqual(new Date('2026-07-16T13:00:00.000Z'))
        expect(random).not.toHaveBeenCalled()
    })

    it('still rolls the picked time forward to the send window', () => {
        // 10:00 + 10h = 20:00, outside 09:00-17:00 -> next window start, Friday 09:00.
        expect(nextAt({ delayHours: 2, delayHoursMax: 10 }, () => 1, schedule)).toEqual(new Date('2026-07-17T09:00:00.000Z'))
    })

    it('applies to an explicit delay row as well', () => {
        const delay = step({ id: 'delay-1', type: 'delay', delayHours: 4, delayHoursMax: 8, subject: null, plainBody: null })
        const email = step({ id: 'email-2', stepOrder: 2 })
        const action = resolveSequenceAction([email, delay], delay, now, allDay, () => 0.5)
        expect(action).toMatchObject({ type: 'advance_without_send', nextScheduledAt: new Date('2026-07-16T16:00:00.000Z') })
    })
})

describe('validateSequenceForActivation', () => {
    it('returns stable issue codes for unsupported, malformed, and ambiguous steps', () => {
        const issues = validateSequenceForActivation([
            step({ id: 'email-invalid', stepOrder: 0, subject: ' ', plainBody: ' ' }),
            step({ id: 'condition', stepOrder: 2, type: 'condition' }),
            // Valid content, but (like the default fixture body) missing {{unsubscribeUrl}} —
            // exercises both issues firing for the same step, in push order.
            step({ id: 'duplicate', stepOrder: 2 }),
        ])

        expect(issues.map((issue) => issue.code)).toEqual([
            'invalid_step_order',
            'invalid_email_content',
            'unsupported_condition_step',
            'missing_unsubscribe_placeholder',
            'duplicate_step_order',
        ])
    })

    it('requires at least one valid email step', () => {
        const issues = validateSequenceForActivation([
            step({ type: 'delay', subject: null, plainBody: null }),
        ])

        expect(issues.map((issue) => issue.code)).toEqual(['sequence_missing_email'])
    })

    it('flags an email step whose body does not render {{unsubscribeUrl}}', () => {
        const issues = validateSequenceForActivation([
            step({ id: 'no-unsub', plainBody: 'Hi there, no opt-out link here.' }),
        ])

        expect(issues).toEqual([{
            code: 'missing_unsubscribe_placeholder',
            message: 'Email steps must render {{unsubscribeUrl}} in the sent body (CAN-SPAM compliance).',
            stepId: 'no-unsub',
        }])
    })

    it('does not flag an email step that renders {{unsubscribeUrl}} in its plain body', () => {
        const issues = validateSequenceForActivation([
            step({ id: 'has-unsub', plainBody: 'Bye. Unsubscribe: {{unsubscribeUrl}}' }),
        ])

        expect(issues).toEqual([])
    })

    it('does not flag an email step that renders {{unsubscribeUrl}} only in its HTML body', () => {
        const issues = validateSequenceForActivation([
            step({ id: 'has-unsub-html', plainBody: 'Bye, no plain link.', htmlBody: '<a href="{{unsubscribeUrl}}">Unsubscribe</a>' }),
        ])

        expect(issues).toEqual([])
    })

    it('does not pile on a missing-placeholder issue for a step already flagged as invalid content', () => {
        const issues = validateSequenceForActivation([
            step({ id: 'empty', subject: ' ', plainBody: ' ' }),
        ])

        // No 'missing_unsubscribe_placeholder' alongside 'invalid_email_content' — the empty
        // step also has no valid email at all, hence 'sequence_missing_email' too.
        expect(issues.map((issue) => issue.code)).toEqual(['invalid_email_content', 'sequence_missing_email'])
    })

    it('flags a malformed {{#flag}} block in any template of an email step', () => {
        const issues = validateSequenceForActivation([
            step({ id: 'bad-plain', plainBody: 'Hi {{#nearby}}close by. {{unsubscribeUrl}}' }),
            step({ id: 'bad-subject', stepOrder: 2, subject: 'Hi {{/nearby}}', plainBody: 'ok {{unsubscribeUrl}}' }),
        ])

        expect(issues.map((issue) => [issue.code, issue.stepId])).toEqual([
            ['malformed_template_block', 'bad-plain'],
            ['malformed_template_block', 'bad-subject'],
        ])
        expect(issues[0].message).toContain('{{#nearby}}')
    })

    it('does not flag well-formed blocks', () => {
        const issues = validateSequenceForActivation([
            step({ id: 'ok', plainBody: '{{#nearby}}Close by.{{/nearby}}{{^nearby}}Far.{{/nearby}} {{unsubscribeUrl}}' }),
        ])

        expect(issues).toEqual([])
    })

    it('requires {{unsubscribeUrl}} in BOTH A/B variants when A/B testing is enabled', () => {
        const issues = validateSequenceForActivation([
            step({
                id: 'ab-step',
                plainBody: 'Variant A. {{unsubscribeUrl}}',
                abTestEnabled: true,
                subjectB: 'Subject B',
                plainBodyB: 'Variant B, no opt-out link.',
            }),
        ])

        expect(issues.map((issue) => issue.code)).toEqual(['missing_unsubscribe_placeholder'])
    })
})

describe('blank subject on follow-up steps (sent as a reply in the same thread)', () => {
    const now = new Date('2026-07-16T10:00:00.000Z')
    const first = step({ id: 'email-1', stepOrder: 1, plainBody: 'Hi {{unsubscribeUrl}}' })
    const followUp = step({ id: 'email-2', stepOrder: 2, subject: '', plainBody: 'Bumping this {{unsubscribeUrl}}' })

    it('validation accepts a blank subject on an email step after the first', () => {
        expect(validateSequenceForActivation([first, followUp])).toEqual([])
    })

    it('validation still requires a subject on the first email step', () => {
        const issues = validateSequenceForActivation([
            step({ id: 'email-1', stepOrder: 1, subject: '  ', plainBody: 'Hi {{unsubscribeUrl}}' }),
            followUp,
        ])

        expect(issues.map((issue) => [issue.code, issue.stepId])).toEqual([['invalid_email_content', 'email-1']])
    })

    it('treats the first EMAIL step as the first, even behind a leading delay', () => {
        const delay = step({ id: 'delay-1', stepOrder: 1, type: 'delay', delayHours: 2, subject: null, plainBody: null })
        const opener = step({ id: 'email-2', stepOrder: 2, subject: '', plainBody: 'Hi {{unsubscribeUrl}}' })

        expect(validateSequenceForActivation([delay, opener]).map((issue) => issue.code))
            .toEqual(['invalid_email_content', 'sequence_missing_email'])
    })

    it('still requires a body on a follow-up', () => {
        const issues = validateSequenceForActivation([
            first,
            step({ id: 'email-2', stepOrder: 2, subject: '', plainBody: ' ', htmlBody: null }),
        ])

        expect(issues.map((issue) => [issue.code, issue.stepId])).toEqual([['invalid_email_content', 'email-2']])
    })

    it('sends a follow-up with a blank subject instead of quarantining it', () => {
        const action = resolveSequenceAction([first, followUp], followUp, now, schedule)

        expect(action).toMatchObject({ type: 'send_email', step: { id: 'email-2' }, content: { subject: '' } })
    })

    it('still quarantines a blank subject on the first email step', () => {
        const blankFirst = step({ id: 'email-1', stepOrder: 1, subject: '' })

        expect(resolveSequenceAction([blankFirst, followUp], blankFirst, now, schedule)).toMatchObject({
            type: 'quarantine',
            reason: 'invalid_email_content',
        })
    })
})
