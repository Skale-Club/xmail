import { describe, expect, it, vi } from 'vitest'

// This suite only exercises the PURE helpers (bucketRawEmailStatus, summarizeLeadVerification,
// renderCampaignPreviewSequence) — never the DB-touching buildCampaignActivationPreview. But the
// module itself imports `db` (and, transitively via getCanonicalSequence/generateUnsubscribeLink,
// a few more db-backed modules) at the top level, and `../../../db` throws at import time without
// a configured DATABASE_URL. Mock it out, mirroring mx-guard.connect-rate.test.ts. The unsubscribe
// route module also throws at import time without ENCRYPTION_KEY/JWT_SECRET (outreach-tokens.ts),
// so it needs the same treatment.
vi.mock('../../../db', () => ({ db: {} }))
vi.mock('../../routes/outreach/unsubscribe', () => ({ generateUnsubscribeLink: vi.fn() }))

import {
    bucketRawEmailStatus,
    renderCampaignPreviewSequence,
    summarizeLeadVerification,
} from '../outreach-approval-preview'
import type { LeadForTemplate } from '../template-variables'

describe('bucketRawEmailStatus', () => {
    it('buckets email_status: ok as verified', () => {
        expect(bucketRawEmailStatus({ email_status: 'ok' })).toBe('verified')
    })

    it('buckets email_status: catch_all as catchAll (distinct from the mapped "likely" column)', () => {
        expect(bucketRawEmailStatus({ email_status: 'catch_all' })).toBe('catchAll')
    })

    it('buckets a literal "unknown" status, a missing field, and any other value as unknown', () => {
        expect(bucketRawEmailStatus({ email_status: 'unknown' })).toBe('unknown')
        expect(bucketRawEmailStatus({})).toBe('unknown')
        expect(bucketRawEmailStatus(null)).toBe('unknown')
        expect(bucketRawEmailStatus(undefined)).toBe('unknown')
        expect(bucketRawEmailStatus({ email_status: 'invalid' })).toBe('unknown')
        expect(bucketRawEmailStatus('not-an-object')).toBe('unknown')
    })
})

describe('summarizeLeadVerification', () => {
    it('aggregates a mixed set of leads into the three-way split plus total', () => {
        const result = summarizeLeadVerification([
            { email_status: 'ok' },
            { email_status: 'ok' },
            { email_status: 'catch_all' },
            { email_status: 'unknown' },
            {},
        ])

        expect(result).toEqual({ total: 5, verified: 2, catchAll: 1, unknown: 2 })
    })

    it('returns all zeros for an empty enrollment', () => {
        expect(summarizeLeadVerification([])).toEqual({ total: 0, verified: 0, catchAll: 0, unknown: 0 })
    })
})

function lead(overrides: Partial<LeadForTemplate> = {}): LeadForTemplate {
    return {
        email: 'jane@acme.com',
        firstName: 'Jane',
        lastName: 'Doe',
        companyName: 'Acme Corp',
        companySize: null,
        industry: null,
        title: null,
        website: null,
        linkedinUrl: null,
        phone: null,
        location: null,
        customFields: {},
        ...overrides,
    }
}

describe('renderCampaignPreviewSequence', () => {
    it('substitutes a real lead\'s values and the real unsubscribe URL', () => {
        const steps = [{
            stepOrder: 1,
            type: 'email',
            delayHours: 0,
            subject: 'Hi {{firstName}} from {{companyName}}',
            plainBody: 'Hello {{firstName}}, unsubscribe here: {{unsubscribeUrl}}',
            htmlBody: null,
            subjectB: null,
            plainBodyB: null,
            htmlBodyB: null,
            abTestEnabled: false,
        }]

        const [rendered] = renderCampaignPreviewSequence(steps, lead(), {
            unsubscribeUrl: 'https://mail.skale.club/o/u/tok123',
            contentLanguage: 'en',
        })

        expect(rendered.variantA.subject).toBe('Hi Jane from Acme Corp')
        expect(rendered.variantA.bodyPlain).toBe('Hello Jane, unsubscribe here: https://mail.skale.club/o/u/tok123')
        expect(rendered.variantB).toBeNull()
    })

    it('renders both A/B variants and labels them, when A/B testing is on', () => {
        const steps = [{
            stepOrder: 1,
            type: 'email',
            delayHours: 24,
            subject: 'Subject A for {{firstName}}',
            plainBody: 'Body A',
            htmlBody: null,
            subjectB: 'Subject B for {{firstName}}',
            plainBodyB: 'Body B',
            htmlBodyB: null,
            abTestEnabled: true,
        }]

        const [rendered] = renderCampaignPreviewSequence(steps, lead(), {
            unsubscribeUrl: 'https://mail.skale.club/o/u/tok123',
            contentLanguage: 'en',
        })

        expect(rendered.variantA.subject).toBe('Subject A for Jane')
        expect(rendered.variantB).not.toBeNull()
        expect(rendered.variantB?.subject).toBe('Subject B for Jane')
    })

    it('skips non-email steps (delay/condition)', () => {
        const steps = [
            {
                stepOrder: 1,
                type: 'delay',
                delayHours: 48,
                subject: null,
                plainBody: null,
                htmlBody: null,
                subjectB: null,
                plainBodyB: null,
                htmlBodyB: null,
                abTestEnabled: false,
            },
            {
                stepOrder: 2,
                type: 'email',
                delayHours: 0,
                subject: 'Follow-up',
                plainBody: 'Body',
                htmlBody: null,
                subjectB: null,
                plainBodyB: null,
                htmlBodyB: null,
                abTestEnabled: false,
            },
        ]

        const rendered = renderCampaignPreviewSequence(steps, lead(), {
            unsubscribeUrl: 'https://mail.skale.club/o/u/tok123',
            contentLanguage: 'en',
        })

        expect(rendered).toHaveLength(1)
        expect(rendered[0].stepOrder).toBe(2)
    })
})
