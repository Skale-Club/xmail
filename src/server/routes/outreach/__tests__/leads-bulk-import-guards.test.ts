import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. Covers the two real defects found importing the first 69 verified
 * prospects from Xphere on 2026-09-30:
 *
 *   Defeito 1: two entries for the SAME email in one bulk-import payload (a case variant counts
 *   — createLeadSchema already lowercases at the Zod boundary) reached one INSERT statement and
 *   Postgres's `lead_org_email_unique` constraint 500'd the WHOLE batch, importing zero.
 *
 *   Defeito 2: a scheduling/marketplace platform's own address (Booksy support etc — see
 *   ../../../lib/platform-emails.ts) scraped off a business's booking page passed straight
 *   through as the "company email".
 *
 * `db`, `requireOutreachWrite`/`requireOutreachRead` and `mapEmailVerificationCustomFields`'s
 * MX fallback are all avoided by supplying `email_status: 'ok'` on every fixture lead (see
 * resolveLeadVerificationFields — an explicit status skips the real DNS lookup).
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111'

const leadsFindManyMock = vi.hoisted(() => vi.fn())
const leadListsFindManyMock = vi.hoisted(() => vi.fn())
const insertReturningMock = vi.hoisted(() => vi.fn())
const insertValuesSpy = vi.hoisted(() => vi.fn())
const requireOutreachWriteMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({
    db: {
        query: {
            leads: { findMany: leadsFindManyMock },
            leadLists: { findMany: leadListsFindManyMock },
        },
        insert: () => ({
            values: (rows: unknown) => {
                insertValuesSpy(rows)
                return {
                    onConflictDoNothing: () => ({
                        returning: insertReturningMock,
                    }),
                }
            },
        }),
        update: () => ({
            set: () => ({ where: () => Promise.resolve(undefined) }),
        }),
    },
}))

vi.mock('../../../lib/outreach-access', () => ({
    requireOutreachWrite: requireOutreachWriteMock,
    requireOutreachRead: vi.fn(),
}))

let server: http.Server
let baseUrl: string

async function post(pathname: string, body: unknown) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user-1' },
        body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeEach(async () => {
    vi.clearAllMocks()
    requireOutreachWriteMock.mockResolvedValue({ role: 'admin' })
    leadListsFindManyMock.mockResolvedValue([])

    const leadsRouter = (await import('../leads')).default
    const app = express()
    app.use(express.json())
    app.use('/', leadsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // Loading leads.ts's whole module graph (email-verification-mapping, recipient-mx,
    // jsonb, prospecting/source-run-id, platform-emails, ...) cold can take longer than the
    // default 10s hook timeout on a loaded machine — this only pays that cost once per file.
}, 20_000)

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

describe('POST /bulk-import — platform-email and in-payload-duplicate guards', () => {
    it('Defeito 2: skips platform emails (2x help.us@booksy.com) and imports the one legitimate lead, no 500', async () => {
        leadsFindManyMock.mockResolvedValueOnce([]) // existingLeads: none of the legit emails exist yet
        insertReturningMock.mockResolvedValueOnce([
            { id: 'lead-legit', email: 'owner@realbarbershop.test' },
        ])

        const result = await post(`/bulk-import?organizationId=${ORG_ID}`, {
            leads: [
                { email: 'help.us@booksy.com', customFields: { email_status: 'ok' } },
                { email: 'help.us@booksy.com', customFields: { email_status: 'ok' } },
                { email: 'owner@realbarbershop.test', customFields: { email_status: 'ok' } },
            ],
        })

        expect(result.status).toBe(201)
        expect(result.body.imported).toBe(1)
        expect(result.body.skippedPlatformEmails).toEqual(['help.us@booksy.com', 'help.us@booksy.com'])
        expect(result.body.duplicatesInPayload).toBe(0)
        expect(result.body.leadIds).toEqual(['lead-legit'])

        // The platform emails never reached the INSERT statement at all.
        const insertedRows = insertValuesSpy.mock.calls[0][0] as Array<{ email: string }>
        expect(insertedRows).toHaveLength(1)
        expect(insertedRows[0].email).toBe('owner@realbarbershop.test')
    })

    it('Defeito 1: dedupes two same-batch entries for the same email in different casing (A@x.com / a@x.com), imports one, reports one in-payload duplicate', async () => {
        leadsFindManyMock.mockResolvedValueOnce([]) // existingLeads: not in the DB yet
        insertReturningMock.mockResolvedValueOnce([
            { id: 'lead-a', email: 'a@x.com' },
        ])

        const result = await post(`/bulk-import?organizationId=${ORG_ID}`, {
            leads: [
                { email: 'A@x.com', customFields: { email_status: 'ok' } },
                { email: 'a@x.com', customFields: { email_status: 'ok' } },
            ],
        })

        expect(result.status).toBe(201)
        expect(result.body.imported).toBe(1)
        expect(result.body.duplicatesInPayload).toBe(1)
        expect(result.body.skippedPlatformEmails).toEqual([])
        expect(result.body.leadIds).toEqual(['lead-a'])

        // Only ONE row for the email ever reached the INSERT statement — this is exactly what
        // used to violate lead_org_email_unique and 500 the whole batch.
        const insertedRows = insertValuesSpy.mock.calls[0][0] as Array<{ email: string }>
        expect(insertedRows).toHaveLength(1)
        expect(insertedRows[0].email).toBe('a@x.com')
    })

    it('never 500s and reports every submitted email accounted for when platform + in-payload duplicates + a genuine DB duplicate all appear in one batch', async () => {
        // owner@realbarbershop.test already exists in the org.
        leadsFindManyMock.mockResolvedValueOnce([{ id: 'lead-existing', email: 'owner@realbarbershop.test' }])
        insertReturningMock.mockResolvedValueOnce([
            { id: 'lead-new', email: 'newshop@example.test' },
        ])

        const result = await post(`/bulk-import?organizationId=${ORG_ID}`, {
            leads: [
                { email: 'help.us@booksy.com', customFields: { email_status: 'ok' } },
                { email: 'owner@realbarbershop.test', customFields: { email_status: 'ok' } },
                { email: 'OWNER@realbarbershop.test', customFields: { email_status: 'ok' } },
                { email: 'newshop@example.test', customFields: { email_status: 'ok' } },
            ],
        })

        expect(result.status).toBe(201)
        expect(result.body.imported).toBe(1)
        expect(result.body.skippedPlatformEmails).toEqual(['help.us@booksy.com'])
        expect(result.body.duplicatesInPayload).toBe(1) // the OWNER@ case-variant repeat
        expect(result.body.duplicates).toBe(1) // owner@realbarbershop.test already existed
        expect(result.body.leadIds.sort()).toEqual(['lead-existing', 'lead-new'])
    })

    it('resolves ids for a same-email import that races a concurrent request instead of losing the lead (onConflictDoNothing safety net)', async () => {
        leadsFindManyMock
            .mockResolvedValueOnce([]) // existingLeads: nothing at select time
            .mockResolvedValueOnce([{ id: 'lead-raced' }]) // resolved after the concurrent insert won

        // A concurrent request inserted the same org+email between our existence check and this
        // INSERT — onConflictDoNothing means Postgres skips it silently instead of a duplicate-key 500.
        insertReturningMock.mockResolvedValueOnce([])

        const result = await post(`/bulk-import?organizationId=${ORG_ID}`, {
            leads: [{ email: 'raced@example.test', customFields: { email_status: 'ok' } }],
        })

        expect(result.status).toBe(201)
        expect(result.body.imported).toBe(0)
        expect(result.body.leadIds).toEqual(['lead-raced'])
    })
})
