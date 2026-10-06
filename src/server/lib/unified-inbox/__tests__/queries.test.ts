import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// The queries module imports the db client at load time; the shape tests below never touch it.
const dbMock = vi.hoisted(() => ({
    queue: [] as unknown[][],
    selections: [] as Array<Record<string, unknown>>,
}))
vi.mock('../../../../db', () => {
    const makeChain = () => {
        const chain: Record<string, unknown> = {}
        for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin']) {
            chain[method] = () => chain
        }
        chain.then = (resolve: (rows: unknown[]) => unknown) => resolve(dbMock.queue.shift() ?? [])
        return chain
    }
    return {
        db: {
            select: (selection: Record<string, unknown>) => {
                dbMock.selections.push(selection)
                return makeChain()
            },
            execute: async () => [],
        },
    }
})

import {
    LAST_INBOUND_CLASSIFICATION,
    getInboxCounts,
    listConversations,
    reminderPredicate,
    viewConditions,
} from '../queries'

const dialect = new PgDialect()
const USER = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'

function render(fragment: SQL): string {
    return dialect.sqlToQuery(fragment).sql.replace(/\s+/g, ' ')
}

describe('reminder predicates', () => {
    it('active = scheduled OR notified, with no time condition (what the Reminders view lists)', () => {
        const text = render(reminderPredicate(USER, 'active'))
        expect(text).toContain("r.status IN ('scheduled', 'notified')")
        expect(text).not.toContain('remind_at')
    })

    it('due = notified, or scheduled and past due (what reminderDue and remindersDue use)', () => {
        const text = render(reminderPredicate(USER, 'due'))
        expect(text).toContain("r.status = 'notified'")
        expect(text).toContain("r.status = 'scheduled' AND r.remind_at <= now()")
    })

    it('the reminders view uses the ACTIVE predicate, so a notified reminder stays listed', () => {
        const [condition] = viewConditions('reminders', USER, false)
        expect(render(condition)).toContain("'notified'")
    })
})

describe('view conditions', () => {
    it('inbox requires an inbound message, except for an explicit lookup (search / campaign)', () => {
        expect(viewConditions('inbox', USER, false).map(render).join(' ')).toContain('last_inbound_at IS NOT NULL')
        expect(viewConditions('inbox', USER, true).map(render).join(' ')).not.toContain('last_inbound_at')
    })

    it('archived is the only view that lists archived conversations (besides reminders)', () => {
        expect(viewConditions('archived', USER, false).map(render).join(' ')).toContain('archived_at IS NOT NULL')
        for (const view of ['inbox', 'needs_reply', 'awaiting', 'unread'] as const) {
            expect(viewConditions(view, USER, false).map(render).join(' ')).toContain('archived_at IS NULL')
        }
        expect(viewConditions('reminders', USER, false).map(render).join(' ')).not.toContain('archived_at')
    })

    it('needs_reply only counts a real reply that arrived after our last outbound', () => {
        const text = viewConditions('needs_reply', USER, false).map(render).join(' ')
        expect(text).toContain("m.classification = 'reply'")
        expect(text).toContain("status = 'open'")
    })
})

describe('last inbound classification subquery', () => {
    it('is a correlated scalar over inbound messages, newest first, tenant-scoped', () => {
        const text = render(LAST_INBOUND_CLASSIFICATION)
        expect(text).toContain('m.organization_id = outreach_conversations.organization_id')
        expect(text).toContain("m.direction = 'inbound'")
        expect(text).toContain('ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC')
        expect(text).toContain('LIMIT 1')
    })
})

describe('listConversations list item fields', () => {
    it('selects lastInboundClassification and reminderDue in the single list query and maps them', async () => {
        dbMock.queue = [
            [{
                id: '33333333-3333-4333-8333-333333333333',
                emailAccountId: '44444444-4444-4444-8444-444444444444',
                leadId: null,
                campaignId: null,
                campaignLeadId: null,
                status: 'open',
                subject: 'Hello',
                preview: 'p',
                lastMessageAt: new Date('2026-10-06T12:00:00Z'),
                lastInboundAt: new Date('2026-10-06T12:00:00Z'),
                lastOutboundAt: null,
                archivedAt: null,
                cursorTs: '2026-10-06 12:00:00',
                unread: true,
                lastInboundClassification: 'auto_reply',
                reminderDue: true,
            }],
            [], // participants
            [], // labels
        ]
        dbMock.selections = []

        const result = await listConversations({
            organizationId: ORG,
            userId: USER,
            filters: {
                unread: false, status: null, campaignId: null, emailAccountId: null, search: null,
                labelId: null, reminderState: null, archived: null, view: 'inbox',
            },
            limit: 25,
            cursor: null,
        })

        expect(Object.keys(dbMock.selections[0])).toEqual(
            expect.arrayContaining(['lastInboundClassification', 'reminderDue']),
        )
        expect(result.conversations[0]).toMatchObject({ lastInboundClassification: 'auto_reply', reminderDue: true })
    })

    it('maps a missing inbound classification to null and a missing flag to false', async () => {
        dbMock.queue = [
            [{
                id: '33333333-3333-4333-8333-333333333333',
                emailAccountId: '44444444-4444-4444-8444-444444444444',
                leadId: null, campaignId: null, campaignLeadId: null, status: 'open', subject: null, preview: null,
                lastMessageAt: null, lastInboundAt: null, lastOutboundAt: null, archivedAt: null,
                cursorTs: null, unread: false, lastInboundClassification: null, reminderDue: false,
            }],
            [], [],
        ]
        const result = await listConversations({
            organizationId: ORG,
            userId: USER,
            filters: {
                unread: false, status: null, campaignId: null, emailAccountId: null, search: null,
                labelId: null, reminderState: null, archived: null, view: null,
            },
            limit: 25,
            cursor: null,
        })
        expect(result.conversations[0]).toMatchObject({ lastInboundClassification: null, reminderDue: false })
    })
})

describe('getInboxCounts', () => {
    it('returns the five counters as numbers', async () => {
        dbMock.queue = [[{ needsReply: '3', awaiting: '2', unread: '5', remindersActive: '4', remindersDue: '1' }]]
        dbMock.selections = []
        const counts = await getInboxCounts({ organizationId: ORG, userId: USER })
        expect(counts).toEqual({ needsReply: 3, awaiting: 2, unread: 5, remindersActive: 4, remindersDue: 1 })
    })
})
