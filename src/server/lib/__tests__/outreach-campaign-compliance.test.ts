import { describe, expect, it } from 'vitest'
import {
    assessCampaignActivationCompliance,
    containsPhysicalPostalAddress,
    type CampaignComplianceStep,
} from '../outreach-campaign-compliance'

function step(overrides: Partial<CampaignComplianceStep> = {}): CampaignComplianceStep {
    return {
        stepOrder: 1,
        type: 'email',
        subject: 'Subject',
        plainBody: null,
        htmlBody: null,
        subjectB: null,
        plainBodyB: null,
        htmlBodyB: null,
        abTestEnabled: false,
        ...overrides,
    }
}

describe('containsPhysicalPostalAddress', () => {
    it('is false for text with no address at all', () => {
        expect(containsPhysicalPostalAddress('Hi {{firstName}}, thanks for your time!')).toBe(false)
    })

    it('is false for a bare street mention with no ZIP/state nearby', () => {
        // A street-typed phrase alone is not a mailing address — this is the exact shape of
        // false positive the ZIP/state window guards against.
        expect(containsPhysicalPostalAddress('We just opened a shop on Main Street downtown.')).toBe(false)
    })

    it('is true for a real US postal address (street + city, state ZIP)', () => {
        expect(containsPhysicalPostalAddress('Skale Club, 75 Main St, Hudson, MA 01749')).toBe(true)
    })

    it('is true when the address is inside HTML markup', () => {
        expect(containsPhysicalPostalAddress('<p>Skale Club</p><address>75 Main St, Hudson, MA 01749</address>')).toBe(true)
    })

    it('is false/empty-safe for null and empty input', () => {
        expect(containsPhysicalPostalAddress(null)).toBe(false)
        expect(containsPhysicalPostalAddress(undefined)).toBe(false)
        expect(containsPhysicalPostalAddress('')).toBe(false)
    })
})

describe('assessCampaignActivationCompliance', () => {
    it('matches the pilot campaign today: unsubscribe present, no postal address -> blocked', () => {
        // This is the exact real-world shape described in Fase 37: the pilot campaign's own
        // description calls out "COMPLIANCE BLOCKER: add Skale Club valid physical postal
        // address before activation", and the sequence bodies have {{unsubscribeUrl}} but no
        // address. This check MUST fail for that shape — do not weaken it to pass.
        const steps = [step({
            stepOrder: 1,
            plainBody: 'Hi {{firstName}}, quick note about {{companyName}}.\n\nUnsubscribe: {{unsubscribeUrl}}',
        })]

        const result = assessCampaignActivationCompliance(steps)

        expect(result.hasPhysicalAddress).toBe(false)
        expect(result.unsubscribePresentInEveryStep).toBe(true)
        expect(result.stepsMissingAddress).toEqual([1])
        expect(result.blockers).toEqual([
            expect.objectContaining({ code: 'missing_physical_address' }),
        ])
    })

    it('passes once a real postal address is added alongside the unsubscribe link', () => {
        const steps = [step({
            stepOrder: 1,
            plainBody: 'Hi {{firstName}}.\n\nSkale Club, 75 Main St, Hudson, MA 01749\nUnsubscribe: {{unsubscribeUrl}}',
        })]

        const result = assessCampaignActivationCompliance(steps)

        expect(result.hasPhysicalAddress).toBe(true)
        expect(result.unsubscribePresentInEveryStep).toBe(true)
        expect(result.blockers).toEqual([])
    })

    it('flags a step missing {{unsubscribeUrl}} even with an address present', () => {
        const steps = [step({
            stepOrder: 1,
            plainBody: 'Skale Club, 75 Main St, Hudson, MA 01749 — no unsubscribe link here.',
        })]

        const result = assessCampaignActivationCompliance(steps)

        expect(result.hasPhysicalAddress).toBe(true)
        expect(result.unsubscribePresentInEveryStep).toBe(false)
        expect(result.stepsMissingUnsubscribe).toEqual([1])
        expect(result.blockers).toEqual([
            expect.objectContaining({ code: 'missing_unsubscribe_placeholder' }),
        ])
    })

    it('requires {{unsubscribeUrl}} in BOTH A/B variants, not just variant A', () => {
        const steps = [step({
            stepOrder: 1,
            abTestEnabled: true,
            plainBody: 'Address: Skale Club, 75 Main St, Hudson, MA 01749. {{unsubscribeUrl}}',
            plainBodyB: 'Address: Skale Club, 75 Main St, Hudson, MA 01749. No unsub link in this variant.',
        })]

        const result = assessCampaignActivationCompliance(steps)

        expect(result.unsubscribePresentInEveryStep).toBe(false)
        expect(result.stepsMissingUnsubscribe).toEqual([1])
    })

    it('passes A/B testing when both variants carry the unsubscribe token', () => {
        const steps = [step({
            stepOrder: 1,
            abTestEnabled: true,
            plainBody: 'Skale Club, 75 Main St, Hudson, MA 01749. {{unsubscribeUrl}}',
            plainBodyB: 'Skale Club, 75 Main St, Hudson, MA 01749. Variant B says hi. {{unsubscribeUrl}}',
        })]

        const result = assessCampaignActivationCompliance(steps)

        expect(result.unsubscribePresentInEveryStep).toBe(true)
        expect(result.hasPhysicalAddress).toBe(true)
        expect(result.blockers).toEqual([])
    })

    it('ignores non-email steps (delay/condition carry no content)', () => {
        const steps = [
            step({ stepOrder: 1, type: 'delay', subject: null, plainBody: null }),
            step({
                stepOrder: 2,
                plainBody: 'Skale Club, 75 Main St, Hudson, MA 01749. {{unsubscribeUrl}}',
            }),
        ]

        const result = assessCampaignActivationCompliance(steps)

        expect(result.stepsMissingAddress).toEqual([])
        expect(result.stepsMissingUnsubscribe).toEqual([])
        expect(result.blockers).toEqual([])
    })

    it('reports both blockers with an explanatory message when there are no email steps at all', () => {
        const result = assessCampaignActivationCompliance([])

        expect(result.hasPhysicalAddress).toBe(false)
        expect(result.unsubscribePresentInEveryStep).toBe(false)
        expect(result.blockers).toHaveLength(2)
    })

    it('reports only the offending step order when some steps pass and others do not', () => {
        const steps = [
            step({ stepOrder: 1, plainBody: 'Skale Club, 75 Main St, Hudson, MA 01749. {{unsubscribeUrl}}' }),
            step({ stepOrder: 2, plainBody: 'Just a follow-up, no address or link here.' }),
        ]

        const result = assessCampaignActivationCompliance(steps)

        expect(result.stepsMissingAddress).toEqual([2])
        expect(result.stepsMissingUnsubscribe).toEqual([2])
        expect(result.blockers.find((b) => b.code === 'missing_physical_address')?.message).toContain('2')
    })
})
