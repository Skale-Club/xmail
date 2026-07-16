import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const ADMIN = 'c4000000-0000-4000-8000-000000000001'
const ORG = 'c4000000-0000-4000-8000-000000000002'
const ACCOUNT = 'c4000000-0000-4000-8000-000000000003'
const CAMPAIGN = 'c4000000-0000-4000-8000-000000000004'
const SEQ = 'c4000000-0000-4000-8000-000000000005'
const STEP = 'c4000000-0000-4000-8000-000000000006'

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let closeApplicationDatabase: (() => Promise<void>) | undefined

async function call(pathname: string) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers: { 'x-user-id': ADMIN } })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

let leadSeq = 0
async function seedLead(status: string, opts: { opens?: number; clicks?: number; replies?: number; sends?: number; openedFirst?: boolean; repliedFirst?: boolean; bouncedFirst?: boolean } = {}) {
    leadSeq += 1
    const s = String(leadSeq).padStart(11, '0')
    const leadId = `c4000000-0000-4000-8000-1${s}`
    const campaignLeadId = `c4000000-0000-4000-8000-2${s}`
    await sql`INSERT INTO leads (id, organization_id, email, status) VALUES (${leadId}::uuid, ${ORG}::uuid, ${'m-' + leadSeq + '@example.test'}, ${status}::lead_status)`
    await sql`
        INSERT INTO campaign_leads (id, campaign_id, lead_id, status, total_opens, total_clicks, total_replies)
        VALUES (${campaignLeadId}::uuid, ${CAMPAIGN}::uuid, ${leadId}::uuid, ${status}::lead_status, ${opts.opens ?? 0}, ${opts.clicks ?? 0}, ${opts.replies ?? 0})
    `
    for (let i = 0; i < (opts.sends ?? 0); i++) {
        const emailId = `c4000000-0000-4000-8000-3${s.slice(0, 9)}${String(i).padStart(2, '0')}`
        await sql`
            INSERT INTO outreach_emails (id, organization_id, campaign_id, campaign_lead_id, sequence_step_id, email_account_id, subject, sent_at, opened_at, replied_at, bounced_at)
            VALUES (${emailId}::uuid, ${ORG}::uuid, ${CAMPAIGN}::uuid, ${campaignLeadId}::uuid, ${STEP}::uuid, ${ACCOUNT}::uuid, 'Hi', NOW(),
                ${opts.openedFirst && i === 0 ? sql`NOW()` : null}, ${opts.repliedFirst && i === 0 ? sql`NOW()` : null}, ${opts.bouncedFirst && i === 0 ? sql`NOW()` : null})
        `
    }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email) VALUES (${ADMIN}::uuid, 'metrics-route-admin@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES (${ORG}::uuid, 'Metrics Route Org', 'metrics-route-org', ${ADMIN}::uuid) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role) VALUES (${ORG}::uuid, ${ADMIN}::uuid, 'admin') ON CONFLICT (organization_id, user_id) DO NOTHING`
    await sql`INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status) VALUES (${ACCOUNT}::uuid, ${ORG}::uuid, 'metrics-route-sender@example.test', 'localhost', 'u', 'x', 'verified') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO campaigns (id, organization_id, name, status) VALUES (${CAMPAIGN}::uuid, ${ORG}::uuid, 'Metrics Route Campaign', 'active') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO sequences (id, campaign_id, name) VALUES (${SEQ}::uuid, ${CAMPAIGN}::uuid, 'Seq') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO sequence_steps (id, sequence_id, step_order, type, subject, delay_hours) VALUES (${STEP}::uuid, ${SEQ}::uuid, 1, 'email', 'Hi', 0) ON CONFLICT (id) DO NOTHING`

    await seedLead('new')
    await seedLead('unsubscribed') // pre-send suppressed
    await seedLead('contacted', { opens: 3, clicks: 1, sends: 2, openedFirst: true })
    await seedLead('replied', { replies: 1, sends: 1, repliedFirst: true })
    await seedLead('bounced', { sends: 1, bouncedFirst: true })

    const campaignsRouter = (await import('../campaigns')).default
    closeApplicationDatabase = (await import('../../../../db')).closeDatabaseConnection
    const app = express()
    app.use(express.json())
    app.use('/', campaignsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('campaign metric cohorts are identical across every surface', () => {
    it('list, /stats, /:id/stats, and /analytics report the same named denominators and rates', async () => {
        const list = await call(`/?organizationId=${ORG}`)
        const stats = await call(`/stats?organizationId=${ORG}`)
        const detail = await call(`/${CAMPAIGN}/stats`)
        const analytics = await call(`/analytics?organizationId=${ORG}`)

        expect(list.status).toBe(200)
        expect(stats.status).toBe(200)
        expect(detail.status).toBe(200)
        expect(analytics.status).toBe(200)

        const listRow = (list.body.campaigns as any[]).find((c) => c.id === CAMPAIGN)
        const d = detail.body.stats

        // Named denominators — contacted excludes the pre-send unsubscribed lead.
        expect(d.contactedLeads).toBe(3)
        expect(d.sentEmails).toBe(4)
        expect(d.eligibleLeads).toBe(4)
        expect(d.totalLeads).toBe(5)

        // Every surface agrees on emails sent.
        expect(listRow.sentEmails).toBe(4)
        expect(stats.body.sentEmails).toBe(4)
        expect(stats.body.totalEmails).toBe(4)
        expect(analytics.body.overview.totalEmailsSent).toBe(4)

        // Every surface agrees on the contacted-denominator rates.
        const round = (n: number) => Math.round(Number(n))
        expect(round(d.openRate)).toBe(33)
        expect(round(listRow.openRate)).toBe(33)
        expect(round(stats.body.openRate)).toBe(33)
        expect(round(analytics.body.overview.avgOpenRate)).toBe(33)

        expect(round(d.replyRate)).toBe(33)
        expect(round(listRow.replyRate)).toBe(33)
        expect(round(stats.body.replyRate)).toBe(33)
    })
})
