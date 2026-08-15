import { describe, expect, it } from 'vitest'
import { buildAssessmentCostDedupKey, buildEnrichmentCostDedupKey } from '../cost-dedup'

describe('buildEnrichmentCostDedupKey', () => {
    it('is stable for identical input', () => {
        const a = buildEnrichmentCostDedupKey('run-1', 'approval-1')
        const b = buildEnrichmentCostDedupKey('run-1', 'approval-1')

        expect(a).toBe(b)
    })

    it('differs for different runs (same approval id)', () => {
        const a = buildEnrichmentCostDedupKey('run-1', 'approval-1')
        const b = buildEnrichmentCostDedupKey('run-2', 'approval-1')

        expect(a).not.toBe(b)
    })

    it('differs for different approvals (same run id)', () => {
        const a = buildEnrichmentCostDedupKey('run-1', 'approval-1')
        const b = buildEnrichmentCostDedupKey('run-1', 'approval-2')

        expect(a).not.toBe(b)
    })

    it('is deterministic and namespaced (does not depend on call order / has an enrich: prefix)', () => {
        expect(buildEnrichmentCostDedupKey('run-1', 'approval-1')).toBe('enrich:run-1:approval-1')
    })
})

describe('buildAssessmentCostDedupKey', () => {
    it('is stable for identical input', () => {
        expect(buildAssessmentCostDedupKey('assessment-1')).toBe(buildAssessmentCostDedupKey('assessment-1'))
    })

    it('differs for different assessment ids', () => {
        expect(buildAssessmentCostDedupKey('assessment-1')).not.toBe(buildAssessmentCostDedupKey('assessment-2'))
    })

    it('is deterministic and namespaced', () => {
        expect(buildAssessmentCostDedupKey('assessment-1')).toBe('assess:assessment-1')
    })
})
