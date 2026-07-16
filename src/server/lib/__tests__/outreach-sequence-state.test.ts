import { describe, expect, it } from 'vitest'
import type { SequenceStep } from '../../../db/schema'
import {
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
})

describe('validateSequenceForActivation', () => {
    it('returns stable issue codes for unsupported, malformed, and ambiguous steps', () => {
        const issues = validateSequenceForActivation([
            step({ id: 'email-invalid', stepOrder: 0, subject: ' ', plainBody: ' ' }),
            step({ id: 'condition', stepOrder: 2, type: 'condition' }),
            step({ id: 'duplicate', stepOrder: 2 }),
        ])

        expect(issues.map((issue) => issue.code)).toEqual([
            'invalid_step_order',
            'invalid_email_content',
            'unsupported_condition_step',
            'duplicate_step_order',
        ])
    })

    it('requires at least one valid email step', () => {
        const issues = validateSequenceForActivation([
            step({ type: 'delay', subject: null, plainBody: null }),
        ])

        expect(issues.map((issue) => issue.code)).toEqual(['sequence_missing_email'])
    })
})
