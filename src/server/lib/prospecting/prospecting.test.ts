import { describe, expect, it, vi } from 'vitest'
import { ApolloProspectProvider, MAX_APOLLO_CREDITS_PER_PERSON } from './apollo'
import { scoreProspect } from './scoring'
import type { NormalizedProspect } from './types'

const baseProspect: NormalizedProspect = {
    externalPersonId: 'person-1',
    title: 'VP of Sales',
    seniority: 'vp',
    location: 'Boston, Massachusetts, United States',
    companyDomain: 'example.com',
    companyIndustry: 'Software',
    companyEmployeeCount: 120,
    emailStatus: 'unavailable',
    rawPayload: {},
}

describe('deterministic ICP scoring', () => {
    it('scores a full ICP match at 100 with an explainable breakdown', () => {
        const result = scoreProspect(baseProspect, {
            targetTitles: ['sales'],
            targetSeniorities: ['vp'],
            targetIndustries: ['software'],
            targetLocations: ['boston'],
            minEmployees: 50,
            maxEmployees: 500,
            requiredCompanyDomains: ['example.com'],
        })
        expect(result).toMatchObject({
            score: 100,
            tier: 'a',
            breakdown: {
                titleMatch: true,
                seniorityMatch: true,
                industryMatch: true,
                locationMatch: true,
                employeeMatch: true,
                domainMatch: true,
            },
        })
    })

    it('uses a neutral baseline when no scoring criteria are supplied', () => {
        expect(scoreProspect(baseProspect, {})).toMatchObject({ score: 50, tier: 'c' })
    })
})

describe('Apollo provider adapter', () => {
    it('maps bounded search filters and normalizes provider data', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
            people: [{
                id: 'apollo-1',
                first_name: 'Ada',
                last_name: 'Lovelace',
                title: 'VP Engineering',
                seniority: 'vp',
                linkedin_url: 'https://linkedin.example/ada',
                city: 'Boston',
                state: 'Massachusetts',
                country: 'United States',
                email: null,
                email_status: null,
                organization: {
                    name: 'Analytical Engines',
                    primary_domain: 'engines.example',
                    industry: 'Software',
                    estimated_num_employees: 80,
                },
            }],
            pagination: { total_entries: 250 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        const provider = new ApolloProspectProvider('secret-key', fetchMock)

        const result = await provider.search({
            page: 2,
            limit: 25,
            filters: { personTitles: ['VP Engineering'], seniorities: ['vp'], organizationDomains: ['engines.example'] },
        })

        expect(result.totalAvailable).toBe(250)
        expect(result.prospects[0]).toMatchObject({
            externalPersonId: 'apollo-1',
            firstName: 'Ada',
            // No email + no email_status: normalizePerson now maps a blank email to 'unknown'
            // (same as the locked "email_not_unlocked@" placeholder) rather than 'unavailable' —
            // see the dedicated test below.
            emailStatus: 'unknown',
            companyDomain: 'engines.example',
            companyEmployeeCount: 80,
        })
        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toBe('https://api.apollo.io/api/v1/mixed_people/api_search')
        expect(init?.headers).toMatchObject({ 'X-Api-Key': 'secret-key' })
        expect(JSON.parse(String(init?.body))).toMatchObject({ page: 2, per_page: 25, person_titles: ['VP Engineering'] })
    })

    it('disables personal email and phone revelation and returns a worst-case credit estimate', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
            matches: [{ id: 'apollo-1', email: 'ada@engines.example', email_status: 'verified' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        const provider = new ApolloProspectProvider('secret-key', fetchMock)

        const result = await provider.enrich(['apollo-1'])

        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toContain('/people/bulk_match?reveal_personal_emails=false&reveal_phone_number=false')
        expect(JSON.parse(String(init?.body))).toEqual({ details: [{ id: 'apollo-1' }] })
        expect(result.maximumCreditEstimate).toBe(MAX_APOLLO_CREDITS_PER_PERSON)
        expect(result.prospects[0]).toMatchObject({ email: 'ada@engines.example', emailStatus: 'verified' })
    })

    it('rejects oversized enrichment batches before any provider request', async () => {
        const fetchMock = vi.fn<typeof fetch>()
        const provider = new ApolloProspectProvider('secret-key', fetchMock)
        await expect(provider.enrich(Array.from({ length: 11 }, (_, index) => `person-${index}`)))
            .rejects.toThrow('1-10 people')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('treats a locked "email_not_unlocked@" placeholder (and a blank email) as no email with status unknown', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
            matches: [
                { id: 'apollo-locked', email: 'email_not_unlocked@engines.example', email_status: 'verified' },
                { id: 'apollo-blank', email: null, email_status: null },
            ],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        const provider = new ApolloProspectProvider('secret-key', fetchMock)

        const result = await provider.enrich(['apollo-locked', 'apollo-blank'])

        expect(result.prospects).toHaveLength(2)
        for (const prospect of result.prospects) {
            expect(prospect.email).toBeUndefined()
            expect(prospect.emailStatus).toBe('unknown')
        }
    })
})
