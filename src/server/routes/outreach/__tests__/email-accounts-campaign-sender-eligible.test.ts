import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. Covers `campaignSenderEligible` on GET /api/outreach/email-accounts
 * (the listing xphere's xmailListEmailAccounts consumes — see xphere's
 * src/lib/xmail/client.ts). Xphere enrolls leads without being told which inbox to use and
 * falls back to "the first account this listing returns"; that first account can be a
 * protected-domain `info@` (rejected with 422 at enrollment, but the enrollment itself then
 * just fails instead of picking a valid inbox). Xmail is the only place that knows the three
 * eligibility rules — verified, not warmup-only, not on a protected sending domain (see
 * CLAUDE.md "Regras do processo de prospecção") — so the listing states the verdict directly.
 *
 * Deliberately does NOT mock `checkProtectedSendingDomains` (imported from ../campaigns): the
 * whole point is one source of truth, so these tests drive the real function through
 * MAIL_DOMAIN / OUTREACH_PROTECTED_DOMAINS env vars, same as production.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111'

const findManyMock = vi.hoisted(() => vi.fn())
const selectCountMock = vi.hoisted(() => vi.fn())
const requireOutreachReadMock = vi.hoisted(() => vi.fn())
const getEffectiveDailySendLimitMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({
    db: {
        query: {
            emailAccounts: { findMany: findManyMock },
        },
        select: () => ({ from: () => ({ where: selectCountMock }) }),
    },
}))

vi.mock('../../../lib/outreach-access', () => ({
    requireOutreachRead: requireOutreachReadMock,
    requireOutreachWrite: vi.fn(),
}))

vi.mock('../../../lib/outreach-sender', () => ({
    getEffectiveDailySendLimit: getEffectiveDailySendLimitMock,
}))

let server: http.Server
let baseUrl: string

async function get(pathname: string) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        headers: { 'x-user-id': 'user-1' },
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

function baseAccount(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: 'acc-1',
        organizationId: ORG_ID,
        email: 'vanildo@tryskaleclub.com',
        displayName: null,
        provider: 'smtp',
        status: 'verified',
        dailySendLimit: 50,
        currentDailySent: 0,
        warmupEnabled: true,
        warmupDays: 14,
        warmupCurrentDay: 14,
        warmupOnly: false,
        warmupSource: 'internal',
        createdAt: new Date(),
        smtpPassword: 'encrypted',
        imapPassword: null,
        ...overrides,
    }
}

beforeEach(async () => {
    // email-accounts.ts now imports checkProtectedSendingDomains from ./campaigns, whose module
    // graph runs through outreach-approval-preview -> unsubscribe -> outreach-tokens, which
    // throws at load time if neither ENCRYPTION_KEY nor JWT_SECRET is set. Never touches a real
    // secret; this only satisfies that load-time guard.
    process.env.ENCRYPTION_KEY ||= 'test-encryption-key'
    delete process.env.MAIL_DOMAIN
    delete process.env.OUTREACH_PROTECTED_DOMAINS

    vi.clearAllMocks()
    requireOutreachReadMock.mockResolvedValue({ role: 'member' })
    selectCountMock.mockResolvedValue([{ count: '1' }])
    getEffectiveDailySendLimitMock.mockImplementation((account: { dailySendLimit: number }) => account.dailySendLimit)

    const emailAccountsRouter = (await import('../email-accounts')).default
    const app = express()
    app.use(express.json())
    app.use('/', emailAccountsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 20_000)

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

describe('GET /api/outreach/email-accounts — campaignSenderEligible', () => {
    it('is true for a verified Icemail account that is not warmup-only', async () => {
        findManyMock.mockResolvedValueOnce([
            baseAccount({ email: 'vanildo@tryskaleclub.com', status: 'verified', warmupOnly: false }),
        ])

        const result = await get(`/?organizationId=${ORG_ID}`)

        expect(result.status).toBe(200)
        expect(result.body.emailAccounts).toHaveLength(1)
        expect(result.body.emailAccounts[0].campaignSenderEligible).toBe(true)
        // Additive: existing fields must survive untouched.
        expect(result.body.emailAccounts[0].email).toBe('vanildo@tryskaleclub.com')
        expect(result.body.emailAccounts[0].status).toBe('verified')
    })

    it('is false for info@ on a domain listed in OUTREACH_PROTECTED_DOMAINS, even when verified', async () => {
        process.env.OUTREACH_PROTECTED_DOMAINS = 'xkedule.com'
        findManyMock.mockResolvedValueOnce([
            baseAccount({ email: 'info@xkedule.com', status: 'verified', warmupOnly: false }),
        ])

        const result = await get(`/?organizationId=${ORG_ID}`)

        expect(result.status).toBe(200)
        expect(result.body.emailAccounts[0].campaignSenderEligible).toBe(false)
    })

    it('is false for a warmup-only seed inbox (contato@xphere.app), even when verified', async () => {
        findManyMock.mockResolvedValueOnce([
            baseAccount({
                email: 'contato@xphere.app',
                status: 'verified',
                warmupOnly: true,
                warmupSource: 'internal',
            }),
        ])

        const result = await get(`/?organizationId=${ORG_ID}`)

        expect(result.status).toBe(200)
        expect(result.body.emailAccounts[0].campaignSenderEligible).toBe(false)
    })

    it('is false for an unverified account', async () => {
        findManyMock.mockResolvedValueOnce([
            baseAccount({ email: 'vanildo@tryskaleclub.com', status: 'pending', warmupOnly: false }),
        ])

        const result = await get(`/?organizationId=${ORG_ID}`)

        expect(result.status).toBe(200)
        expect(result.body.emailAccounts[0].campaignSenderEligible).toBe(false)
    })
})
