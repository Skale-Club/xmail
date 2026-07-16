import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const OWNER = 'c2000000-0000-4000-8000-0000000000f0'
const ORG = 'c2000000-0000-4000-8000-000000000001'
const OTHER_ORG = 'c2000000-0000-4000-8000-000000000009'
const ACCOUNT = 'c2000000-0000-4000-8000-000000000002'
const OTHER_ACCOUNT = 'c2000000-0000-4000-8000-00000000000a'
const CAMPAIGN_1 = 'c2000000-0000-4000-8000-000000000003'
const CAMPAIGN_2 = 'c2000000-0000-4000-8000-000000000004'
const CAMPAIGN_3 = 'c2000000-0000-4000-8000-00000000000c'
const OTHER_CAMPAIGN = 'c2000000-0000-4000-8000-00000000000b'
const SEQ_1 = 'c2000000-0000-4000-8000-000000000005'
const STEP_1 = 'c2000000-0000-4000-8000-000000000006'
// A lead can hold at most one outreach email per step (unique index), so a second send for the
// same lead uses a second step.
const STEP_2 = 'c2000000-0000-4000-8000-000000000007'

let sql: ReturnType<typeof postgres>
let closeApplicationDatabase: (() => Promise<void>) | undefined
let computeCampaignMetrics: typeof import('../outreach-campaign-metrics')['computeCampaignMetrics']
let computeCampaignMetricsByCampaign: typeof import('../outreach-campaign-metrics')['computeCampaignMetricsByCampaign']

let leadSeq = 0
async function seedLead(opts: {
    campaignId: string
    status: string
    opens?: number
    clicks?: number
    replies?: number
    sends?: number
    openedFirst?: boolean
    repliedFirst?: boolean
    bouncedFirst?: boolean
    org?: string
    account?: string
}) {
    const org = opts.org ?? ORG
    const account = opts.account ?? ACCOUNT
    leadSeq += 1
    const suffix = String(leadSeq).padStart(12, '0')
    const leadId = `c2000000-0000-4000-8000-1${suffix.slice(1)}`
    const campaignLeadId = `c2000000-0000-4000-8000-2${suffix.slice(1)}`
    await sql`
        INSERT INTO leads (id, organization_id, email, status)
        VALUES (${leadId}::uuid, ${org}::uuid, ${'lead-' + leadSeq + '@example.test'}, ${opts.status}::lead_status)
    `
    await sql`
        INSERT INTO campaign_leads (id, campaign_id, lead_id, status, total_opens, total_clicks, total_replies)
        VALUES (
            ${campaignLeadId}::uuid, ${opts.campaignId}::uuid, ${leadId}::uuid, ${opts.status}::lead_status,
            ${opts.opens ?? 0}, ${opts.clicks ?? 0}, ${opts.replies ?? 0}
        )
    `
    const sends = opts.sends ?? 0
    for (let i = 0; i < sends; i++) {
        const emailId = `c2000000-0000-4000-8000-3${String(leadSeq).padStart(9, '0')}${String(i).padStart(2, '0')}`
        const opened = opts.openedFirst && i === 0
        const replied = opts.repliedFirst && i === 0
        const bounced = opts.bouncedFirst && i === 0
        await sql`
            INSERT INTO outreach_emails (
                id, organization_id, campaign_id, campaign_lead_id, sequence_step_id, email_account_id,
                subject, tracking_token, idempotency_key, to_address, sent_at, opened_at, replied_at, bounced_at
            ) VALUES (
                ${emailId}::uuid, ${org}::uuid, ${opts.campaignId}::uuid, ${campaignLeadId}::uuid,
                ${i === 0 ? STEP_1 : STEP_2}::uuid, ${account}::uuid, 'Hi', ${emailId}, ${emailId}, 'to@example.test', NOW(),
                ${opened ? sql`NOW()` : null}, ${replied ? sql`NOW()` : null}, ${bounced ? sql`NOW()` : null}
            )
        `
    }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    // 038 provides outreach_emails.origin/idempotency_key/to_address for the send fixtures.
    // Idempotent + advisory-locked, so it is safe when a sibling suite already applied it.
    await applyMigrationFile(
        { databaseUrl: testDatabaseUrl, runGuard },
        path.join(process.cwd(), 'supabase', 'migrations', '038_outreach_dispatch_state_machine.sql'),
    )
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    const metrics = await import('../outreach-campaign-metrics')
    computeCampaignMetrics = metrics.computeCampaignMetrics
    computeCampaignMetricsByCampaign = metrics.computeCampaignMetricsByCampaign
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection

    await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'metrics-owner@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG}::uuid, 'Metrics Org', 'metrics-org', ${OWNER}::uuid),
        (${OTHER_ORG}::uuid, 'Other Org', 'metrics-other-org', ${OWNER}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`
        INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status) VALUES
            (${ACCOUNT}::uuid, ${ORG}::uuid, 'metrics-sender@example.test', 'localhost', 'u', 'x', 'verified'),
            (${OTHER_ACCOUNT}::uuid, ${OTHER_ORG}::uuid, 'other-sender@example.test', 'localhost', 'u', 'x', 'verified')
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO campaigns (id, organization_id, name, status) VALUES
            (${CAMPAIGN_1}::uuid, ${ORG}::uuid, 'Campaign One', 'active'),
            (${CAMPAIGN_2}::uuid, ${ORG}::uuid, 'Campaign Two', 'active'),
            (${CAMPAIGN_3}::uuid, ${ORG}::uuid, 'Campaign Three', 'active'),
            (${OTHER_CAMPAIGN}::uuid, ${OTHER_ORG}::uuid, 'Other Campaign', 'active')
        ON CONFLICT (id) DO NOTHING
    `
    await sql`INSERT INTO sequences (id, campaign_id, name) VALUES (${SEQ_1}::uuid, ${CAMPAIGN_1}::uuid, 'Seq') ON CONFLICT (id) DO NOTHING`
    await sql`
        INSERT INTO sequence_steps (id, sequence_id, step_order, type, subject, plain_body, delay_hours) VALUES
            (${STEP_1}::uuid, ${SEQ_1}::uuid, 1, 'email', 'Hi', 'Body', 0),
            (${STEP_2}::uuid, ${SEQ_1}::uuid, 2, 'email', 'Hi again', 'Body 2', 24)
        ON CONFLICT (id) DO NOTHING
    `

    // Campaign 1 cohorts.
    await seedLead({ campaignId: CAMPAIGN_1, status: 'new' }) // A: never sent
    await seedLead({ campaignId: CAMPAIGN_1, status: 'unsubscribed' }) // B: pre-send suppressed, never sent
    await seedLead({ campaignId: CAMPAIGN_1, status: 'contacted', opens: 3, clicks: 1, sends: 2, openedFirst: true }) // C
    await seedLead({ campaignId: CAMPAIGN_1, status: 'replied', replies: 1, sends: 1, repliedFirst: true }) // D
    await seedLead({ campaignId: CAMPAIGN_1, status: 'bounced', sends: 1, bouncedFirst: true }) // E

    // Campaign 2: 1 contacted lead, 1 sent email.
    await seedLead({ campaignId: CAMPAIGN_2, status: 'contacted', sends: 1 })

    // Campaign 3 (N-1 sent-gate): a bounced lead that was NEVER sent must not inflate bouncedLeads
    // (which would push bounceRate over its contactedLeads denominator, breaking the 0-100 invariant).
    await seedLead({ campaignId: CAMPAIGN_3, status: 'bounced', sends: 0 }) // bounced, never sent
    await seedLead({ campaignId: CAMPAIGN_3, status: 'bounced', sends: 1, bouncedFirst: true }) // bounced after a send

    // Other org (cross-tenant): must never bleed into ORG metrics.
    await seedLead({ campaignId: OTHER_CAMPAIGN, status: 'contacted', opens: 9, sends: 1, org: OTHER_ORG, account: OTHER_ACCOUNT })
})

afterAll(async () => {
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('computeCampaignMetrics cohorts', () => {
    it('excludes pre-send suppressed leads from contacted and sent, and uses contacted as the rate denominator', async () => {
        const m = await computeCampaignMetrics([CAMPAIGN_1])
        expect(m.totalLeads).toBe(5)
        expect(m.preSendExcludedLeads).toBe(1) // B
        expect(m.eligibleLeads).toBe(4)
        expect(m.contactedLeads).toBe(3) // C, D, E — A(new) and B(unsub) never sent
        expect(m.sentEmails).toBe(4) // C(2) + D(1) + E(1)
        expect(m.uniqueOpeners).toBe(1)
        expect(m.uniqueClickers).toBe(1)
        expect(m.repliedLeads).toBe(1)
        expect(m.bouncedLeads).toBe(1)
        expect(m.totalOpens).toBe(3)
        // Denominator is contactedLeads (3), not "status != new" (which would be 4).
        expect(Math.round(m.openRate)).toBe(33)
        expect(Math.round(m.replyRate)).toBe(33)
        expect(Math.round(m.bounceRate)).toBe(33)
    })

    it('aggregates across campaigns and returns empty for no ids', async () => {
        const agg = await computeCampaignMetrics([CAMPAIGN_1, CAMPAIGN_2])
        expect(agg.totalLeads).toBe(6)
        expect(agg.contactedLeads).toBe(4)
        expect(agg.sentEmails).toBe(5)

        const empty = await computeCampaignMetrics([])
        expect(empty.totalLeads).toBe(0)
        expect(empty.contactedLeads).toBe(0)
        expect(empty.sentEmails).toBe(0)
    })
})

describe('bounceRate sent-gate (N-1)', () => {
    it('a bounced lead with no sent email does not inflate bouncedLeads or push bounceRate over 100', async () => {
        const m = await computeCampaignMetrics([CAMPAIGN_3])
        // Two bounced leads exist, but only one was ever sent to.
        expect(m.contactedLeads).toBe(1)
        expect(m.bouncedLeads).toBe(1) // the never-sent bounce is excluded, matching contactedLeads' gate
        expect(m.bounceRate).toBeLessThanOrEqual(100)
        expect(Math.round(m.bounceRate)).toBe(100)
    })
})

describe('computeCampaignMetricsByCampaign', () => {
    it('returns the same cohort math per campaign as the aggregate', async () => {
        const byCampaign = await computeCampaignMetricsByCampaign([CAMPAIGN_1, CAMPAIGN_2])
        const one = byCampaign.get(CAMPAIGN_1)!
        const two = byCampaign.get(CAMPAIGN_2)!
        expect(one.contactedLeads).toBe(3)
        expect(one.sentEmails).toBe(4)
        expect(two.contactedLeads).toBe(1)
        expect(two.sentEmails).toBe(1)
        // Cross-tenant campaign is never present in this org's map.
        expect(byCampaign.has(OTHER_CAMPAIGN)).toBe(false)
    })
})
