import { beforeAll, describe, expect, it } from 'vitest'

let buildDeliverableOutreachEventsQuery: typeof import('../deliverOutreachEvents').buildDeliverableOutreachEventsQuery

beforeAll(async () => {
    process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused'
    ;({ buildDeliverableOutreachEventsQuery } = await import('../deliverOutreachEvents'))
})

describe('buildDeliverableOutreachEventsQuery', () => {
    it('correlates the prior-event subquery with valid, explicit table aliases', () => {
        const query = buildDeliverableOutreachEventsQuery(new Date('2026-09-05T12:00:00.000Z')).toSQL()
        const normalizedSql = query.sql.replace(/\s+/g, ' ')

        expect(normalizedSql).toContain(
            'from "outreach_event_outbox" "prior_outreach_event"',
        )
        expect(normalizedSql).toContain(
            '"prior_outreach_event"."organization_id" = "outreach_event_outbox"."organization_id"',
        )
        expect(normalizedSql).toContain(
            '"prior_outreach_event"."sequence_number" < "outreach_event_outbox"."sequence_number"',
        )
        expect(query.params).toContain('2026-09-05T12:00:00.000Z')
    })
})
