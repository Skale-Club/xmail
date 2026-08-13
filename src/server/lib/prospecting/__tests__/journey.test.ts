import { describe, expect, it, vi } from 'vitest'
import {
    RUN_EVENT_CODES,
    defaultLevelForCode,
    phaseForCode,
    recordRunEvent,
    recordRunEvents,
    type DbClient,
    type RecordRunEventInput,
    type RunEventCode,
} from '../journey'
import type { ProspectingRunEventLevel, ProspectingRunEventPhase } from '../../../../db/schema'

/** Builds a fake DbClient whose insert().values() is spy-able and can be made to throw. */
function fakeDb(options: { throwOnInsert?: boolean } = {}) {
    const values = vi.fn(async (_rows: unknown) => {
        if (options.throwOnInsert) throw new Error('connection reset')
        return undefined
    })
    const insert = vi.fn(() => ({ values }))
    return { db: { insert } as unknown as DbClient, insert, values }
}

function input(overrides: Partial<RecordRunEventInput> = {}): RecordRunEventInput {
    return {
        organizationId: 'org-1',
        runId: 'run-1',
        code: RUN_EVENT_CODES.search.QUERY_ISSUED,
        ...overrides,
    }
}

describe('RUN_EVENT_CODES phase mapping', () => {
    const expectedPhaseByGroup: Record<keyof typeof RUN_EVENT_CODES, ProspectingRunEventPhase> = {
        search: 'search',
        score: 'score',
        enrich: 'enrich',
        assess: 'assess',
        import: 'import',
        outcome: 'outcome',
    }

    it('maps every code to the phase of its own group, exhaustively', () => {
        const groups = Object.keys(RUN_EVENT_CODES) as (keyof typeof RUN_EVENT_CODES)[]
        expect(groups.sort()).toEqual(['assess', 'enrich', 'import', 'outcome', 'score', 'search'])

        let checked = 0
        for (const group of groups) {
            for (const code of Object.values(RUN_EVENT_CODES[group])) {
                expect(phaseForCode(code as RunEventCode)).toBe(expectedPhaseByGroup[group])
                checked += 1
            }
        }
        // 5 + 3 + 5 + 2 + 4 + 4 = 23 codes across the six phases.
        expect(checked).toBe(23)
    })

    it('codes are frozen and cannot be mutated', () => {
        expect(Object.isFrozen(RUN_EVENT_CODES)).toBe(true)
        expect(Object.isFrozen(RUN_EVENT_CODES.search)).toBe(true)
        expect(() => {
            (RUN_EVENT_CODES.search as Record<string, string>).QUERY_ISSUED = 'nope'
        }).toThrow()
    })
})

describe('defaultLevelForCode', () => {
    it.each<[RunEventCode, ProspectingRunEventLevel]>([
        [RUN_EVENT_CODES.search.RATE_LIMITED, 'error'],
        [RUN_EVENT_CODES.search.FAILED, 'error'],
        [RUN_EVENT_CODES.enrich.FAILED, 'error'],
        [RUN_EVENT_CODES.search.ZERO_RESULTS, 'warn'],
        [RUN_EVENT_CODES.enrich.NO_EMAIL, 'warn'],
        [RUN_EVENT_CODES.score.CANDIDATE_BELOW_THRESHOLD, 'warn'],
        [RUN_EVENT_CODES.enrich.CREDIT_CEILING_REACHED, 'warn'],
    ])('defaults %s to %s', (code, level) => {
        expect(defaultLevelForCode(code)).toBe(level)
    })

    it.each<RunEventCode>([
        RUN_EVENT_CODES.search.QUERY_ISSUED,
        RUN_EVENT_CODES.search.PARTIAL_PAGE,
        RUN_EVENT_CODES.score.CANDIDATE_QUALIFIED,
        RUN_EVENT_CODES.score.NO_CRITERIA,
        RUN_EVENT_CODES.enrich.REQUESTED,
        RUN_EVENT_CODES.enrich.EMAIL_UNVERIFIABLE,
        RUN_EVENT_CODES.assess.RECORDED,
        RUN_EVENT_CODES.assess.REJECTED,
        RUN_EVENT_CODES.import.LEAD_CREATED,
        RUN_EVENT_CODES.import.LEAD_EXISTING,
        RUN_EVENT_CODES.import.SKIPPED_INELIGIBLE,
        RUN_EVENT_CODES.import.EXTERNAL_RUN_REGISTERED,
        RUN_EVENT_CODES.outcome.EMAILED,
        RUN_EVENT_CODES.outcome.REPLIED,
        RUN_EVENT_CODES.outcome.BOUNCED,
        RUN_EVENT_CODES.outcome.UNSUBSCRIBED,
    ])('defaults everything else, e.g. %s, to info', (code) => {
        expect(defaultLevelForCode(code)).toBe('info')
    })
})

describe('recordRunEvent', () => {
    it('inserts a single row with the derived phase and default level', async () => {
        const { db, insert, values } = fakeDb()

        await recordRunEvent(db, input({ code: RUN_EVENT_CODES.enrich.NO_EMAIL, summary: 'no email found' }))

        expect(insert).toHaveBeenCalledTimes(1)
        expect(values).toHaveBeenCalledTimes(1)
        expect(values).toHaveBeenCalledWith({
            organizationId: 'org-1',
            runId: 'run-1',
            candidateId: null,
            phase: 'enrich',
            level: 'warn',
            code: 'enrich.no_email',
            summary: 'no email found',
            detail: {},
        })
    })

    it('honors an explicit level override instead of the default', async () => {
        const { db, values } = fakeDb()

        await recordRunEvent(db, input({ code: RUN_EVENT_CODES.search.QUERY_ISSUED, level: 'error' }))

        expect(values).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }))
    })

    it('swallows a DB error instead of throwing', async () => {
        const { db } = fakeDb({ throwOnInsert: true })

        await expect(recordRunEvent(db, input())).resolves.toBeUndefined()
    })

    it('does not throw even when db.insert itself throws synchronously', async () => {
        const db = {
            insert: () => {
                throw new Error('pool exhausted')
            },
        } as unknown as DbClient

        await expect(recordRunEvent(db, input())).resolves.toBeUndefined()
    })
})

describe('recordRunEvents', () => {
    it('writes a batch of events in a single round-trip', async () => {
        const { db, insert, values } = fakeDb()
        const inputs = [
            input({ candidateId: 'cand-1', code: RUN_EVENT_CODES.score.CANDIDATE_QUALIFIED }),
            input({ candidateId: 'cand-2', code: RUN_EVENT_CODES.score.CANDIDATE_BELOW_THRESHOLD }),
        ]

        await recordRunEvents(db, inputs)

        expect(insert).toHaveBeenCalledTimes(1)
        expect(values).toHaveBeenCalledTimes(1)
        const rows = values.mock.calls[0][0] as Array<Record<string, unknown>>
        expect(rows).toHaveLength(2)
        expect(rows[0]).toMatchObject({ candidateId: 'cand-1', phase: 'score', level: 'info' })
        expect(rows[1]).toMatchObject({ candidateId: 'cand-2', phase: 'score', level: 'warn' })
    })

    it('is a no-op for an empty batch (no insert call at all)', async () => {
        const { db, insert } = fakeDb()

        await recordRunEvents(db, [])

        expect(insert).not.toHaveBeenCalled()
    })

    it('swallows a DB error instead of throwing', async () => {
        const { db } = fakeDb({ throwOnInsert: true })

        await expect(recordRunEvents(db, [input()])).resolves.toBeUndefined()
    })
})
