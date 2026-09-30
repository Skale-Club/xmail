import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. Defeito 2 (2026-09-30): single lead creation (POST /) must reject a
 * scheduling/marketplace platform's own address the same way bulk-import does — see
 * ../../../lib/platform-emails.ts and leads-bulk-import-guards.test.ts for the bulk-import half.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111'

const leadsFindFirstMock = vi.hoisted(() => vi.fn())
const insertReturningMock = vi.hoisted(() => vi.fn())
const requireOutreachWriteMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({
    db: {
        query: {
            leads: { findFirst: leadsFindFirstMock },
            leadLists: { findFirst: vi.fn() },
        },
        insert: () => ({
            values: () => ({
                returning: insertReturningMock,
            }),
        }),
        update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
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

    const leadsRouter = (await import('../leads')).default
    const app = express()
    app.use(express.json())
    app.use('/', leadsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // Loading leads.ts's whole module graph cold can take longer than the default 10s hook
    // timeout on a loaded machine — this only pays that cost once per file.
}, 20_000)

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

describe('POST /leads — platform-email rejection', () => {
    it('rejects help.us@booksy.com with 422 and never touches the DB', async () => {
        const result = await post(`/?organizationId=${ORG_ID}`, {
            email: 'help.us@booksy.com',
            companyName: 'Some Barbershop',
        })

        expect(result.status).toBe(422)
        expect(result.body.code).toBe('platform_email_rejected')
        expect(leadsFindFirstMock).not.toHaveBeenCalled()
        expect(insertReturningMock).not.toHaveBeenCalled()
    })

    it('rejects a platform email on a subdomain too (mail.vagaro.com)', async () => {
        const result = await post(`/?organizationId=${ORG_ID}`, {
            email: 'noreply@mail.vagaro.com',
        })

        expect(result.status).toBe(422)
        expect(result.body.code).toBe('platform_email_rejected')
    })

    it('rejects the pocketsuite.io platform email observed on 2026-09-30 (privacy@pocketsuite.io)', async () => {
        const result = await post(`/?organizationId=${ORG_ID}`, {
            email: 'privacy@pocketsuite.io',
            companyName: 'Some Barbershop',
        })

        expect(result.status).toBe(422)
        expect(result.body.code).toBe('platform_email_rejected')
    })

    it('still creates a lead with a legitimate business email', async () => {
        leadsFindFirstMock.mockResolvedValueOnce(null)
        insertReturningMock.mockResolvedValueOnce([
            { id: 'lead-legit', email: 'owner@realbarbershop.test' },
        ])

        const result = await post(`/?organizationId=${ORG_ID}`, {
            email: 'owner@realbarbershop.test',
            companyName: 'Real Barbershop',
        })

        expect(result.status).toBe(201)
        expect(result.body.lead.id).toBe('lead-legit')
    })
})
