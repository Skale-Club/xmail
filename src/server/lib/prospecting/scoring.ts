import type { NormalizedProspect, ProspectScore, ProspectScoringCriteria } from './types'

function normalized(value: string | undefined): string {
    return value?.trim().toLowerCase() ?? ''
}

function includesAny(value: string | undefined, targets: string[] | undefined): boolean {
    if (!targets?.length) return false
    const candidate = normalized(value)
    return targets.some((target) => candidate.includes(normalized(target)))
}

function exactAny(value: string | undefined, targets: string[] | undefined): boolean {
    if (!targets?.length) return false
    const candidate = normalized(value)
    return targets.some((target) => candidate === normalized(target))
}

/** Deterministic, explainable ICP scoring. Missing criteria neither reward nor punish. */
export function scoreProspect(prospect: NormalizedProspect, criteria: ProspectScoringCriteria): ProspectScore {
    const availableWeights = {
        title: criteria.targetTitles?.length ? 25 : 0,
        seniority: criteria.targetSeniorities?.length ? 20 : 0,
        industry: criteria.targetIndustries?.length ? 20 : 0,
        location: criteria.targetLocations?.length ? 10 : 0,
        employees: criteria.minEmployees !== undefined || criteria.maxEmployees !== undefined ? 15 : 0,
        domain: criteria.requiredCompanyDomains?.length ? 10 : 0,
    }
    const totalWeight = Object.values(availableWeights).reduce((sum, value) => sum + value, 0)
    if (totalWeight === 0) {
        return { score: 50, tier: 'c', breakdown: { baseline: 50, reason: 'no_scoring_criteria' } }
    }

    const titleMatch = includesAny(prospect.title, criteria.targetTitles)
    const seniorityMatch = exactAny(prospect.seniority, criteria.targetSeniorities)
    const industryMatch = includesAny(prospect.companyIndustry, criteria.targetIndustries)
    const locationMatch = includesAny(prospect.location, criteria.targetLocations)
    const domainMatch = exactAny(prospect.companyDomain, criteria.requiredCompanyDomains)
    const employeeCount = prospect.companyEmployeeCount
    const employeeMatch = employeeCount !== undefined
        && (criteria.minEmployees === undefined || employeeCount >= criteria.minEmployees)
        && (criteria.maxEmployees === undefined || employeeCount <= criteria.maxEmployees)

    const earned = (titleMatch ? availableWeights.title : 0)
        + (seniorityMatch ? availableWeights.seniority : 0)
        + (industryMatch ? availableWeights.industry : 0)
        + (locationMatch ? availableWeights.location : 0)
        + (employeeMatch ? availableWeights.employees : 0)
        + (domainMatch ? availableWeights.domain : 0)
    const score = Math.round((earned / totalWeight) * 100)
    const tier = score >= 80 ? 'a' : score >= 60 ? 'b' : score >= 40 ? 'c' : 'disqualified'
    return {
        score,
        tier,
        breakdown: {
            titleMatch,
            seniorityMatch,
            industryMatch,
            locationMatch,
            employeeMatch,
            domainMatch,
            earnedWeight: earned,
            availableWeight: totalWeight,
        },
    }
}
