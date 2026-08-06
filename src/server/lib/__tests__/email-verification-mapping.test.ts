import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../recipient-mx', () => ({
    hasMxRecord: vi.fn(),
}))

import { hasMxRecord } from '../recipient-mx'
import {
    isEmailStatusAbsentOrUnknown,
    mapEmailVerificationCustomFields,
    resolveLeadVerificationFields,
} from '../email-verification-mapping'

const mockedHasMxRecord = vi.mocked(hasMxRecord)

describe('mapEmailVerificationCustomFields', () => {
    it.each([
        ['ok', 'verified'],
        ['catch_all', 'likely'],
        ['unknown', 'likely'],
        ['invalid', 'invalid'],
        ['disposable', 'invalid'],
        ['bounced', 'invalid'],
    ] as const)('maps email_status %s to emailVerificationStatus %s', (emailStatus, expected) => {
        const result = mapEmailVerificationCustomFields({ email_status: emailStatus })
        expect(result.emailVerificationStatus).toBe(expected)
    })

    it('leaves emailVerificationStatus untouched when email_status is absent', () => {
        expect(mapEmailVerificationCustomFields(undefined).emailVerificationStatus).toBeUndefined()
        expect(mapEmailVerificationCustomFields({}).emailVerificationStatus).toBeUndefined()
        expect(mapEmailVerificationCustomFields(null).emailVerificationStatus).toBeUndefined()
    })

    it('leaves emailVerificationStatus untouched for an unrecognized email_status', () => {
        const result = mapEmailVerificationCustomFields({ email_status: 'some_new_status' })
        expect(result.emailVerificationStatus).toBeUndefined()
    })

    it('persists emailVerificationProvider and emailVerifiedAt when supplied', () => {
        const result = mapEmailVerificationCustomFields({
            email_status: 'ok',
            email_verification_provider: 'xphere',
            email_verified_at: '2026-07-01T00:00:00.000Z',
        })
        expect(result.emailVerificationProvider).toBe('xphere')
        expect(result.emailVerifiedAt).toEqual(new Date('2026-07-01T00:00:00.000Z'))
    })

    it('ignores a malformed email_verified_at rather than throwing', () => {
        const result = mapEmailVerificationCustomFields({ email_verified_at: 'not-a-date' })
        expect(result.emailVerifiedAt).toBeUndefined()
    })

    it('does not map email_risk onto any column (no risk column exists)', () => {
        const result = mapEmailVerificationCustomFields({ email_status: 'ok', email_risk: 'high' })
        expect(result).not.toHaveProperty('emailRisk')
        expect(result).not.toHaveProperty('email_risk')
    })
})

describe('isEmailStatusAbsentOrUnknown', () => {
    it('is true when customFields is absent, empty, or email_status is unknown', () => {
        expect(isEmailStatusAbsentOrUnknown(undefined)).toBe(true)
        expect(isEmailStatusAbsentOrUnknown({})).toBe(true)
        expect(isEmailStatusAbsentOrUnknown({ email_status: 'unknown' })).toBe(true)
    })

    it('is false for any other recognized or unrecognized email_status', () => {
        expect(isEmailStatusAbsentOrUnknown({ email_status: 'ok' })).toBe(false)
        expect(isEmailStatusAbsentOrUnknown({ email_status: 'invalid' })).toBe(false)
        expect(isEmailStatusAbsentOrUnknown({ email_status: 'something_else' })).toBe(false)
    })
})

describe('resolveLeadVerificationFields', () => {
    beforeEach(() => {
        mockedHasMxRecord.mockReset()
    })

    it('does not consult MX when email_status is a strong signal (ok)', async () => {
        const result = await resolveLeadVerificationFields('a@example.com', { email_status: 'ok' })
        expect(result.emailVerificationStatus).toBe('verified')
        expect(mockedHasMxRecord).not.toHaveBeenCalled()
    })

    it('downgrades to invalid via the MX pre-filter when email_status is absent and the domain has no MX', async () => {
        mockedHasMxRecord.mockResolvedValue(false)
        const result = await resolveLeadVerificationFields('a@nomx.example.com', undefined)
        expect(result.emailVerificationStatus).toBe('invalid')
        expect(result.emailVerificationProvider).toBe('mx')
        expect(mockedHasMxRecord).toHaveBeenCalledWith('nomx.example.com')
    })

    it('leaves the status untouched (fail open) when the MX lookup is inconclusive', async () => {
        mockedHasMxRecord.mockResolvedValue(null)
        const result = await resolveLeadVerificationFields('a@flaky.example.com', undefined)
        expect(result.emailVerificationStatus).toBeUndefined()
    })

    it('leaves the status untouched when the domain does have MX records', async () => {
        mockedHasMxRecord.mockResolvedValue(true)
        const result = await resolveLeadVerificationFields('a@good.example.com', undefined)
        expect(result.emailVerificationStatus).toBeUndefined()
    })

    it('runs the MX pre-filter when email_status is explicitly "unknown"', async () => {
        mockedHasMxRecord.mockResolvedValue(false)
        const result = await resolveLeadVerificationFields('a@nomx.example.com', { email_status: 'unknown' })
        expect(result.emailVerificationStatus).toBe('invalid')
        expect(mockedHasMxRecord).toHaveBeenCalled()
    })

    it('never lets an MX lookup failure throw out of the resolver', async () => {
        mockedHasMxRecord.mockRejectedValue(new Error('boom'))
        await expect(resolveLeadVerificationFields('a@example.com', undefined)).resolves.toBeDefined()
    })
})
