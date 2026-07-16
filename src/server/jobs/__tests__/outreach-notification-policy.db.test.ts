import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'
import { sendXphereOutreachEvent } from '../../lib/xphere-events'

// The three inbound event paths are wired to per-organization notification settings; assert the
// gate on the transport itself, so a decorative toggle cannot pass by leaving the DB writes intact.
vi.mock('../../lib/xphere-events', () => ({ sendXphereOutreachEvent: vi.fn() }))

const emit = vi.mocked(sendXphereOutreachEvent)
const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

// ORG_A notifies on reply + unsubscribe, NOT bounce. ORG_B is the mirror image.
const OWNER = 'c3000000-0000-4000-8000-0000000000f0'
const ORG_A = 'c3000000-0000-4000-8000-000000000001'
const ORG_B = 'c3000000-0000-4000-8000-000000000002'
const ACC_A = 'c3000000-0000-4000-8000-000000000003'
const ACC_B = 'c3000000-0000-4000-8000-000000000004'
const CAMP_A = 'c3000000-0000-4000-8000-000000000005'
const CAMP_B = 'c3000000-0000-4000-8000-000000000006'
const SEQ_A = 'c3000000-0000-4000-8000-000000000007'
const SEQ_B = 'c3000000-0000-4000-8000-000000000008'
const STEP_A = 'c3000000-0000-4000-8000-000000000009'
const STEP_B = 'c3000000-0000-4000-8000-00000000000a'

let sql: ReturnType<typeof postgres>
let closeApplicationDatabase: (() => Promise<void>) | undefined
let markAsReplied: typeof import('../processReplies')['markAsReplied']
let markAsBounced: typeof import('../processBounces')['markAsBounced']
let processUnsubscribe: typeof import('../../routes/outreach/unsubscribe')['processUnsubscribe']

let seq = 0
async function seedScenario(org: string, campaign: string, account: string, step: string, status: string) {
    seq += 1
    const suffix = String(seq).padStart(11, '0')
    const leadId = `c3000000-0000-4000-8000-1${suffix}`
    const campaignLeadId = `c3000000-0000-4000-8000-2${suffix}`
    const emailId = `c3000000-0000-4000-8000-3${suffix}`
    await sql`INSERT INTO leads (id, organization_id, email, status) VALUES (${leadId}::uuid, ${org}::uuid, ${'notif-' + seq + '@example.test'}, ${status}::lead_status)`
    await sql`
        INSERT INTO campaign_leads (id, campaign_id, lead_id, status)
        VALUES (${campaignLeadId}::uuid, ${campaign}::uuid, ${leadId}::uuid, ${status}::lead_status)
    `
    await sql`
        INSERT INTO outreach_emails (id, organization_id, campaign_id, campaign_lead_id, sequence_step_id, email_account_id, subject, tracking_token, idempotency_key, to_address, sent_at)
        VALUES (${emailId}::uuid, ${org}::uuid, ${campaign}::uuid, ${campaignLeadId}::uuid, ${step}::uuid, ${account}::uuid, 'Hi', ${emailId}, ${emailId}, 'to@example.test', NOW())
    `
    return { leadId, campaignLeadId, emailId }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    // This suite is self-contained: it applies every migration its seed depends on, in
    // order, rather than relying on another .db suite having applied them to the shared
    // database first (that hidden cross-suite dependency only held while files ran
    // concurrently in nondeterministic order). 024 adds outreach_settings; 038 adds
    // outreach_emails.idempotency_key, which seedScenario writes. applyMigrationFile is
    // idempotent under the shared advisory lock, so re-applying an already-applied
    // migration is a no-op.
    const migrationTarget = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(
        migrationTarget,
        path.join(process.cwd(), 'supabase', 'migrations', '024_outreach_settings.sql'),
    )
    await applyMigrationFile(
        migrationTarget,
        path.join(process.cwd(), 'supabase', 'migrations', '038_outreach_dispatch_state_machine.sql'),
    )
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    // The disposable baseline bootstraps `suppressions` from an old server-scoped Drizzle
    // snapshot; the org-scoping DDL is absent from the repo's migration history (a known
    // local/CI vs. production schema gap). Bring it to the shape the outreach code writes so the
    // bounce/unsubscribe suppression insert exercises the real path. 027 already added `source`.
    await sql`ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS organization_id uuid`
    await sql`ALTER TABLE suppressions ALTER COLUMN server_id DROP NOT NULL`

    markAsReplied = (await import('../processReplies')).markAsReplied
    markAsBounced = (await import('../processBounces')).markAsBounced
    processUnsubscribe = (await import('../../routes/outreach/unsubscribe')).processUnsubscribe
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection

    await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'notif-owner@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG_A}::uuid, 'Notif A', 'notif-a', ${OWNER}::uuid),
        (${ORG_B}::uuid, 'Notif B', 'notif-b', ${OWNER}::uuid) ON CONFLICT (id) DO NOTHING`
    await sql`
        INSERT INTO outreach_settings (organization_id, notify_on_reply, notify_on_bounce, notify_on_unsubscribe) VALUES
            (${ORG_A}::uuid, TRUE, FALSE, TRUE),
            (${ORG_B}::uuid, FALSE, TRUE, FALSE)
    `
    await sql`
        INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status) VALUES
            (${ACC_A}::uuid, ${ORG_A}::uuid, 'notif-a-sender@example.test', 'localhost', 'u', 'x', 'verified'),
            (${ACC_B}::uuid, ${ORG_B}::uuid, 'notif-b-sender@example.test', 'localhost', 'u', 'x', 'verified')
        ON CONFLICT (id) DO NOTHING
    `
    await sql`INSERT INTO campaigns (id, organization_id, name, status) VALUES
        (${CAMP_A}::uuid, ${ORG_A}::uuid, 'Camp A', 'active'),
        (${CAMP_B}::uuid, ${ORG_B}::uuid, 'Camp B', 'active') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO sequences (id, campaign_id, name) VALUES
        (${SEQ_A}::uuid, ${CAMP_A}::uuid, 'S'), (${SEQ_B}::uuid, ${CAMP_B}::uuid, 'S') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO sequence_steps (id, sequence_id, step_order, type, subject, plain_body, delay_hours) VALUES
        (${STEP_A}::uuid, ${SEQ_A}::uuid, 1, 'email', 'Hi', 'Body', 0),
        (${STEP_B}::uuid, ${SEQ_B}::uuid, 1, 'email', 'Hi', 'Body', 0) ON CONFLICT (id) DO NOTHING`
})

afterAll(async () => {
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

beforeEach(() => {
    emit.mockClear()
})

function eventNames(): string[] {
    return emit.mock.calls.map((c) => c[0] as string)
}

describe('reply notification policy', () => {
    it('emits exactly once when enabled and never when disabled', async () => {
        const a = await seedScenario(ORG_A, CAMP_A, ACC_A, STEP_A, 'contacted')
        await markAsReplied(a.emailId, a.campaignLeadId, a.leadId, CAMP_A, ACC_A, ORG_A, { messageId: 'm1', text: 'hi' })
        expect(eventNames().filter((e) => e === 'replied')).toHaveLength(1)

        emit.mockClear()
        const b = await seedScenario(ORG_B, CAMP_B, ACC_B, STEP_B, 'contacted')
        await markAsReplied(b.emailId, b.campaignLeadId, b.leadId, CAMP_B, ACC_B, ORG_B, { messageId: 'm2', text: 'hi' })
        expect(eventNames().filter((e) => e === 'replied')).toHaveLength(0)
    })

    it('does not re-notify on a replayed reply', async () => {
        const a = await seedScenario(ORG_A, CAMP_A, ACC_A, STEP_A, 'contacted')
        await markAsReplied(a.emailId, a.campaignLeadId, a.leadId, CAMP_A, ACC_A, ORG_A, { messageId: 'm3', text: 'hi' })
        await markAsReplied(a.emailId, a.campaignLeadId, a.leadId, CAMP_A, ACC_A, ORG_A, { messageId: 'm3', text: 'hi' })
        expect(eventNames().filter((e) => e === 'replied')).toHaveLength(1)
    })
})

describe('bounce notification policy', () => {
    it('emits exactly once when enabled and never when disabled, and not on replay', async () => {
        const b = await seedScenario(ORG_B, CAMP_B, ACC_B, STEP_B, 'contacted')
        const first = await markAsBounced(b.emailId, b.campaignLeadId, b.leadId, CAMP_B, ACC_B, ORG_B, 'hard bounce 550 user unknown')
        expect(first).toBe(true)
        const second = await markAsBounced(b.emailId, b.campaignLeadId, b.leadId, CAMP_B, ACC_B, ORG_B, 'hard bounce 550 user unknown')
        expect(second).toBe(false)
        expect(eventNames().filter((e) => e === 'bounced')).toHaveLength(1)

        emit.mockClear()
        const a = await seedScenario(ORG_A, CAMP_A, ACC_A, STEP_A, 'contacted')
        await markAsBounced(a.emailId, a.campaignLeadId, a.leadId, CAMP_A, ACC_A, ORG_A, 'soft bounce mailbox full')
        expect(eventNames().filter((e) => e === 'bounced')).toHaveLength(0)
    })
})

describe('unsubscribe notification policy', () => {
    it('emits exactly once when enabled and never when disabled, and not on replay', async () => {
        const a = await seedScenario(ORG_A, CAMP_A, ACC_A, STEP_A, 'contacted')
        const first = await processUnsubscribe(a.campaignLeadId, CAMP_A)
        expect(first.success).toBe(true)
        await processUnsubscribe(a.campaignLeadId, CAMP_A)
        expect(eventNames().filter((e) => e === 'unsubscribed')).toHaveLength(1)

        emit.mockClear()
        const b = await seedScenario(ORG_B, CAMP_B, ACC_B, STEP_B, 'contacted')
        await processUnsubscribe(b.campaignLeadId, CAMP_B)
        expect(eventNames().filter((e) => e === 'unsubscribed')).toHaveLength(0)
    })
})
