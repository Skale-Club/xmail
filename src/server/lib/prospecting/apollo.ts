import { z } from 'zod'
import type {
    NormalizedProspect,
    ProspectEnrichmentResult,
    ProspectProvider,
    ProspectSearchInput,
    ProspectSearchResult,
} from './types'

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1'
const MAX_RETRIES = 2
const MAX_BULK_ENRICHMENT = 10
// Apollo documents a range up to nine credits/person when enrichment waterfalls are used.
// We disable waterfalls but retain the documented worst-case ceiling as a fail-safe budget guard.
export const MAX_APOLLO_CREDITS_PER_PERSON = 9

type FetchLike = typeof fetch

const organizationSchema = z.object({
    name: z.string().nullish(),
    website_url: z.string().nullish(),
    primary_domain: z.string().nullish(),
    industry: z.string().nullish(),
    estimated_num_employees: z.number().int().nonnegative().nullish(),
}).passthrough()

const personSchema = z.object({
    id: z.string().min(1),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    title: z.string().nullish(),
    seniority: z.string().nullish(),
    linkedin_url: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    country: z.string().nullish(),
    email: z.string().nullish(),
    email_status: z.string().nullish(),
    organization: organizationSchema.nullish(),
}).passthrough()

const searchResponseSchema = z.object({
    people: z.array(personSchema).default([]),
    pagination: z.object({ total_entries: z.number().int().nonnegative().optional() }).passthrough().optional(),
}).passthrough()

const enrichmentResponseSchema = z.object({
    matches: z.array(personSchema.nullable()).default([]),
}).passthrough()

function compactRecord(value: unknown): Record<string, unknown> {
    const parsed = personSchema.parse(value)
    return {
        id: parsed.id,
        first_name: parsed.first_name ?? null,
        last_name: parsed.last_name ?? null,
        title: parsed.title ?? null,
        seniority: parsed.seniority ?? null,
        linkedin_url: parsed.linkedin_url ?? null,
        city: parsed.city ?? null,
        state: parsed.state ?? null,
        country: parsed.country ?? null,
        email_status: parsed.email_status ?? null,
        organization: parsed.organization ? {
            name: parsed.organization.name ?? null,
            website_url: parsed.organization.website_url ?? null,
            primary_domain: parsed.organization.primary_domain ?? null,
            industry: parsed.organization.industry ?? null,
            estimated_num_employees: parsed.organization.estimated_num_employees ?? null,
        } : null,
    }
}

function normalizeEmailStatus(status: string | null | undefined, email: string | null | undefined): NormalizedProspect['emailStatus'] {
    const value = status?.trim().toLowerCase()
    if (value === 'verified') return 'verified'
    if (value === 'guessed' || value === 'likely') return 'likely'
    if (value === 'invalid' || value === 'bounced') return 'invalid'
    if (!email) return 'unavailable'
    return 'unknown'
}

function normalizePerson(input: z.infer<typeof personSchema>): NormalizedProspect {
    const location = [input.city, input.state, input.country].filter(Boolean).join(', ') || undefined
    const email = input.email?.trim().toLowerCase()
    return {
        externalPersonId: input.id,
        firstName: input.first_name ?? undefined,
        lastName: input.last_name ?? undefined,
        title: input.title ?? undefined,
        seniority: input.seniority ?? undefined,
        linkedinUrl: input.linkedin_url ?? undefined,
        location,
        companyName: input.organization?.name ?? undefined,
        companyDomain: input.organization?.primary_domain ?? undefined,
        companyIndustry: input.organization?.industry ?? undefined,
        companyEmployeeCount: input.organization?.estimated_num_employees ?? undefined,
        email: email || undefined,
        emailStatus: normalizeEmailStatus(input.email_status, email),
        rawPayload: compactRecord(input),
    }
}

function retryDelayMs(attempt: number, response?: Response): number {
    const retryAfter = response?.headers.get('retry-after')
    const retrySeconds = retryAfter ? Number(retryAfter) : Number.NaN
    if (Number.isFinite(retrySeconds) && retrySeconds >= 0) return Math.min(retrySeconds * 1_000, 10_000)
    return 250 * (2 ** attempt)
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ApolloProspectProvider implements ProspectProvider {
    readonly name = 'apollo' as const

    constructor(
        private readonly apiKey: string,
        private readonly fetchImpl: FetchLike = fetch,
    ) {
        if (!apiKey.trim()) throw new Error('APOLLO_API_KEY is required')
    }

    private async request(path: string, body: Record<string, unknown>): Promise<unknown> {
        let lastError: Error | undefined
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
            try {
                const response = await this.fetchImpl(`${APOLLO_BASE_URL}${path}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(15_000),
                })
                if (response.ok) return await response.json()
                const retryable = response.status === 429 || response.status >= 500
                const details = (await response.text()).slice(0, 500)
                lastError = new Error(`Apollo request failed (${response.status}): ${details || response.statusText}`)
                if (!retryable || attempt === MAX_RETRIES) throw lastError
                await sleep(retryDelayMs(attempt, response))
            } catch (error) {
                lastError = error instanceof Error ? error : new Error('Apollo request failed')
                if (attempt === MAX_RETRIES || !['AbortError', 'TimeoutError', 'TypeError'].includes(lastError.name)) throw lastError
                await sleep(retryDelayMs(attempt))
            }
        }
        throw lastError ?? new Error('Apollo request failed')
    }

    async search(input: ProspectSearchInput): Promise<ProspectSearchResult> {
        const response = searchResponseSchema.parse(await this.request('/mixed_people/api_search', {
            page: input.page,
            per_page: input.limit,
            person_titles: input.filters.personTitles,
            include_similar_titles: input.filters.includeSimilarTitles ?? true,
            q_keywords: input.filters.keywords,
            person_locations: input.filters.personLocations,
            person_seniorities: input.filters.seniorities,
            organization_locations: input.filters.organizationLocations,
            q_organization_domains_list: input.filters.organizationDomains,
        }))
        return {
            prospects: response.people.map(normalizePerson),
            totalAvailable: response.pagination?.total_entries,
        }
    }

    async enrich(externalPersonIds: string[]): Promise<ProspectEnrichmentResult> {
        if (externalPersonIds.length < 1 || externalPersonIds.length > MAX_BULK_ENRICHMENT) {
            throw new Error(`Apollo bulk enrichment requires 1-${MAX_BULK_ENRICHMENT} people`)
        }
        const query = new URLSearchParams({ reveal_personal_emails: 'false', reveal_phone_number: 'false' })
        const response = enrichmentResponseSchema.parse(await this.request(`/people/bulk_match?${query}`, {
            details: externalPersonIds.map((id) => ({ id })),
        }))
        return {
            prospects: response.matches.filter((person): person is z.infer<typeof personSchema> => person !== null).map(normalizePerson),
            maximumCreditEstimate: externalPersonIds.length * MAX_APOLLO_CREDITS_PER_PERSON,
        }
    }
}

export function createProspectProvider(name: 'apollo' = 'apollo'): ProspectProvider {
    if (name !== 'apollo') throw new Error(`Unsupported prospect provider: ${String(name)}`)
    return new ApolloProspectProvider(process.env.APOLLO_API_KEY ?? '')
}
