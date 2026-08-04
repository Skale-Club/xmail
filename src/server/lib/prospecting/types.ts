import type { ProspectEmailStatus, ProspectScoreTier } from '../../../db/schema'

export const PROSPECT_SENIORITIES = [
    'owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern',
] as const

export type ProspectSeniority = typeof PROSPECT_SENIORITIES[number]

export interface ProspectSearchFilters {
    personTitles?: string[]
    includeSimilarTitles?: boolean
    keywords?: string
    personLocations?: string[]
    seniorities?: ProspectSeniority[]
    organizationLocations?: string[]
    organizationDomains?: string[]
}

export interface ProspectScoringCriteria {
    targetTitles?: string[]
    targetSeniorities?: ProspectSeniority[]
    targetIndustries?: string[]
    targetLocations?: string[]
    minEmployees?: number
    maxEmployees?: number
    requiredCompanyDomains?: string[]
}

export interface NormalizedProspect {
    externalPersonId: string
    firstName?: string
    lastName?: string
    title?: string
    seniority?: string
    linkedinUrl?: string
    location?: string
    companyName?: string
    companyDomain?: string
    companyIndustry?: string
    companyEmployeeCount?: number
    email?: string
    emailStatus: ProspectEmailStatus
    rawPayload: Record<string, unknown>
}

export interface ProspectScore {
    score: number
    tier: ProspectScoreTier
    breakdown: Record<string, number | boolean | string>
}

export interface ProspectSearchInput {
    filters: ProspectSearchFilters
    page: number
    limit: number
}

export interface ProspectSearchResult {
    prospects: NormalizedProspect[]
    totalAvailable?: number
}

export interface ProspectEnrichmentResult {
    prospects: NormalizedProspect[]
    maximumCreditEstimate: number
}

export interface ProspectProvider {
    readonly name: 'apollo'
    search(input: ProspectSearchInput): Promise<ProspectSearchResult>
    enrich(externalPersonIds: string[]): Promise<ProspectEnrichmentResult>
}
