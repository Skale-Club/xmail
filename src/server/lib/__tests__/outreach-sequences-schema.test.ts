import { describe, expect, it, vi } from 'vitest'

// outreach-sequences.ts builds the DB client at import time; the schema itself needs none.
vi.mock('../../../db', () => ({ db: {}, queryClient: vi.fn() }))

import { sequencePayloadSchema } from '../outreach-sequences'

describe('sequencePayloadSchema subject rule', () => {
    const email = (extra: Record<string, unknown> = {}) => ({ type: 'email', plainBody: 'Body', ...extra })

    it('requires a subject on the first email step', () => {
        const result = sequencePayloadSchema.safeParse({ steps: [email({ subject: '' })] })

        expect(result.success).toBe(false)
        if (!result.success) {
            expect(result.error.issues[0]).toMatchObject({
                path: ['steps', 0, 'subject'],
                message: 'The first email step requires a subject',
            })
        }
        expect(sequencePayloadSchema.safeParse({ steps: [email({ subject: '   ' })] }).success).toBe(false)
    })

    it('accepts a blank subject on an email step after the first', () => {
        const result = sequencePayloadSchema.safeParse({
            steps: [email({ subject: 'Hello' }), { type: 'delay', delayHours: 72 }, email({ subject: '' })],
        })

        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.data.steps[2]).toMatchObject({ type: 'email', subject: '' })
        }
    })

    it('counts the first EMAIL step, not the first step', () => {
        const result = sequencePayloadSchema.safeParse({
            steps: [{ type: 'delay', delayHours: 2 }, email({ subject: '' })],
        })

        expect(result.success).toBe(false)
    })

    it('still requires a body on a follow-up with a blank subject', () => {
        const result = sequencePayloadSchema.safeParse({
            steps: [email({ subject: 'Hello' }), { type: 'email', subject: '', plainBody: '', htmlBody: '' }],
        })

        expect(result.success).toBe(false)
    })
})
