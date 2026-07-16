import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

/**
 * W-2 — a terminal lead status is never reverted.
 *
 * processReplies and processBounces take *different* advisory locks and run on the same
 * tick, so their writes interleave in nondeterministic order. markAsReplied set
 * campaign_leads.status = 'replied' with no CAS, and its leads.status guard preserved only
 * ('replied','interested','not_interested') — not bounced/unsubscribed. markAsBounced left
 * next_follow_up_at alone, and its "already bounced" early return was a non-atomic
 * read-then-write.
 *
 * Lead X hard-bounces on step 2 while a human at the same address replied to step 1. If
 * the reply write lands last the lead reads as engaged: bounced -> replied on both rows,
 * next_follow_up_at = now, while campaigns.totalBounces was already incremented. Stats and
 * lead state disagree. Suppression blocks a resend only for a *hard* bounce; a soft bounce
 * writes no suppression row, outreach-delivery-policy.ts never consults
 * campaign_leads.status, and processFollowUps ships to a lead whose row says bounced.
 *
 * Phase 19 made this routinely reachable: a DSN used to be misrouted into the reply path
 * (the bug 19-03 fixed), so reply-and-bounce for one lead rarely coexisted. They are now
 * disjoint classifications applied in nondeterministic order by two concurrent jobs.
 *
 * Ordering here is explicit rather than raced: the defect is the missing CAS, and a test
 * that depends on scheduler luck to expose it would be worth nothing.
 */

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const IDS = {
    user: '70000000-0000-4000-8000-000000000001',
    org: '70000000-0000-4000-8000-000000000002',
    account: '70000000-0000-4000-8000-000000000003',
}

let sql: ReturnType<typeof postgres>
let closeApplicationDatabase: (() => Promise<void>) | undefined

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    // 038 owns outreach_emails.origin/idempotency_key, which the dispatcher writes and this
    // fixture must satisfy.
    await applyMigrationFile(target, path.join(process.cwd(), 'supabase', 'migrations', '038_outreach_dispatch_state_machine.sql'))
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'

    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })
    await sql`INSERT INTO users (id, email) VALUES (${IDS.user}::uuid, 'terminal@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id)
        VALUES (${IDS.org}::uuid, 'Terminal', 'terminal-state', ${IDS.user}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO email_accounts (id, organization_id, email, status, smtp_host, smtp_username, smtp_password)
        VALUES (${IDS.account}::uuid, ${IDS.org}::uuid, 'sender@example.test', 'verified', 'localhost', 's', 'x')
        ON CONFLICT (id) DO NOTHING
    `
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection
})

afterAll(async () => {
    // next_follow_up_at is a *global* work queue: processFollowUps picks up every due
    // campaign_lead regardless of organization. Leaving one armed here hands another
    // suite's assertion an extra lead to complete.
    await sql`
        UPDATE campaign_leads SET next_follow_up_at = NULL
        WHERE campaign_id IN (SELECT id FROM campaigns WHERE organization_id = ${IDS.org}::uuid)
    `
    await closeApplicationDatabase?.()
    await sql.end({ timeout: 1 })
})

interface Fixture {
    campaignId: string
    leadId: string
    campaignLeadId: string
    outreachEmailId: string
    sequenceId: string
    stepId: string
}

let seq = 0

/** One campaign + lead + campaign_lead + sent outreach email, agentic follow-up enabled. */
async function seedLead(status: string): Promise<Fixture> {
    const suffix = (++seq).toString(16).padStart(4, '0')
    const fixture: Fixture = {
        campaignId: `70000000-0000-4000-8000-0001${suffix}0001`,
        leadId: `70000000-0000-4000-8000-0001${suffix}0002`,
        campaignLeadId: `70000000-0000-4000-8000-0001${suffix}0003`,
        outreachEmailId: `70000000-0000-4000-8000-0001${suffix}0004`,
        sequenceId: `70000000-0000-4000-8000-0001${suffix}0005`,
        stepId: `70000000-0000-4000-8000-0001${suffix}0006`,
    }

    await sql`
        INSERT INTO campaigns (id, organization_id, name, status, agentic_followup_enabled)
        VALUES (${fixture.campaignId}::uuid, ${IDS.org}::uuid, ${'Terminal ' + suffix}, 'active', TRUE)
    `
    await sql`
        INSERT INTO leads (id, organization_id, email)
        VALUES (${fixture.leadId}::uuid, ${IDS.org}::uuid, ${'lead-' + suffix + '@prospect.test'})
    `
    // origin='campaign' requires a sequence step (038's origin shape check).
    await sql`
        INSERT INTO sequences (id, campaign_id, name)
        VALUES (${fixture.sequenceId}::uuid, ${fixture.campaignId}::uuid, ${'Sequence ' + suffix})
    `
    await sql`
        INSERT INTO sequence_steps (id, sequence_id, step_order, subject, plain_body)
        VALUES (${fixture.stepId}::uuid, ${fixture.sequenceId}::uuid, 1, 'Quick question', 'body')
    `
    await sql`
        INSERT INTO campaign_leads (id, campaign_id, lead_id, status, next_scheduled_at)
        VALUES (
            ${fixture.campaignLeadId}::uuid, ${fixture.campaignId}::uuid, ${fixture.leadId}::uuid,
            ${status}::lead_status, now()
        )
    `
    await sql`
        INSERT INTO outreach_emails (
            id, organization_id, origin, idempotency_key, to_address,
            campaign_id, campaign_lead_id, sequence_step_id, email_account_id,
            tracking_token, subject, message_id, status, sent_at
        ) VALUES (
            ${fixture.outreachEmailId}::uuid, ${IDS.org}::uuid, 'campaign',
            ${'terminal:' + suffix}, ${'lead-' + suffix + '@prospect.test'},
            ${fixture.campaignId}::uuid, ${fixture.campaignLeadId}::uuid,
            ${fixture.stepId}::uuid, ${IDS.account}::uuid,
            ${'terminal-token-' + suffix}, 'Quick question',
            ${'xmail-' + suffix + '@example.test'}, 'sent', now()
        )
    `
    return fixture
}

async function readState(fixture: Fixture) {
    const [campaignLead] = await sql<{
        status: string
        next_follow_up_at: Date | null
        next_scheduled_at: Date | null
        last_reply_text: string | null
    }[]>`
        SELECT status::text AS status, next_follow_up_at, next_scheduled_at, last_reply_text
        FROM campaign_leads WHERE id = ${fixture.campaignLeadId}::uuid
    `
    const [lead] = await sql<{ status: string }[]>`
        SELECT status::text AS status FROM leads WHERE id = ${fixture.leadId}::uuid
    `
    const [campaign] = await sql<{ total_bounces: number; total_replies: number }[]>`
        SELECT total_bounces, total_replies FROM campaigns WHERE id = ${fixture.campaignId}::uuid
    `
    return { campaignLead, lead, campaign }
}

/**
 * Deliberately a SOFT bounce ('mailbox full'). It is the dangerous case the review names:
 * a hard bounce writes an org-wide suppression row that blocks a resend anyway, whereas a
 * soft bounce writes nothing, outreach-delivery-policy.ts never consults
 * campaign_leads.status, and so the lead's own row is the only thing standing between a
 * bouncing address and the next send. It also keeps this fixture off the suppressions
 * table, whose test-baseline shape still predates the org-scoped schema.
 */
async function bounce(fixture: Fixture, reason = 'mailbox full'): Promise<boolean> {
    const { markAsBounced } = await import('../processBounces')
    return markAsBounced(
        fixture.outreachEmailId,
        fixture.campaignLeadId,
        fixture.leadId,
        fixture.campaignId,
        IDS.account,
        IDS.org,
        reason,
    )
}

async function reply(fixture: Fixture): Promise<void> {
    const { markAsReplied } = await import('../processReplies')
    await markAsReplied(
        fixture.outreachEmailId,
        fixture.campaignLeadId,
        fixture.leadId,
        fixture.campaignId,
        IDS.account,
        IDS.org,
        { messageId: 'inbound-reply@prospect.test', text: 'Actually, I am interested' },
    )
}

describe('terminal lead state under concurrent reply and bounce', () => {
    it('does not let a reply landing last revive a bounced lead', async () => {
        const fixture = await seedLead('contacted')

        await bounce(fixture)
        await reply(fixture)

        const state = await readState(fixture)
        // The lead hard-bounced. Whatever arrived afterwards, it is not deliverable.
        expect(state.campaignLead.status).toBe('bounced')
        expect(state.lead.status).toBe('bounced')
        // ...and it must not be queued for an agentic follow-up, which is what
        // next_follow_up_at = now would do on the very next processFollowUps tick.
        expect(state.campaignLead.next_follow_up_at).toBeNull()
        expect(state.campaignLead.next_scheduled_at).toBeNull()

        // Bookkeeping still records what actually happened — Phase 18's rule is that a
        // terminal status is never reverted, not that later facts are discarded.
        expect(state.campaignLead.last_reply_text).toBe('Actually, I am interested')
        expect(state.campaign.total_replies).toBe(1)
        expect(state.campaign.total_bounces).toBe(1)
    })

    it('does not let a bounce landing last revive an unsubscribed lead', async () => {
        // unsubscribed is terminal for the same reason and was equally unguarded.
        const fixture = await seedLead('unsubscribed')
        await sql`UPDATE leads SET status = 'unsubscribed' WHERE id = ${fixture.leadId}::uuid`

        await reply(fixture)

        const state = await readState(fixture)
        expect(state.campaignLead.status).toBe('unsubscribed')
        expect(state.lead.status).toBe('unsubscribed')
        expect(state.campaignLead.next_follow_up_at).toBeNull()
    })

    it('still marks a live lead replied and arms the agentic follow-up', async () => {
        // The positive control: the guard must not break the ordinary path.
        const fixture = await seedLead('contacted')

        await reply(fixture)

        const state = await readState(fixture)
        expect(state.campaignLead.status).toBe('replied')
        expect(state.lead.status).toBe('replied')
        expect(state.campaignLead.next_follow_up_at).not.toBeNull()

        // Disarm immediately: this row is now in processFollowUps' global due-work queue.
        await sql`UPDATE campaign_leads SET next_follow_up_at = NULL WHERE id = ${fixture.campaignLeadId}::uuid`
    })

    it('clears a pending follow-up when the lead bounces', async () => {
        const fixture = await seedLead('contacted')
        await sql`UPDATE campaign_leads SET next_follow_up_at = now() WHERE id = ${fixture.campaignLeadId}::uuid`

        await bounce(fixture)

        const state = await readState(fixture)
        // processFollowUps selects on next_follow_up_at alone; leaving it set ships another
        // email to an address that just hard-bounced.
        expect(state.campaignLead.next_follow_up_at).toBeNull()
        expect(state.campaignLead.status).toBe('bounced')
    })

    it('counts one bounce per lead even when two DSNs are applied concurrently', async () => {
        const fixture = await seedLead('contacted')

        // The early return that used to prevent this read campaign_leads.status and then
        // wrote, with no lock between: two DSNs for one lead both passed the check.
        await Promise.all([bounce(fixture), bounce(fixture)])

        const state = await readState(fixture)
        expect(state.campaign.total_bounces).toBe(1)
        expect(state.campaignLead.status).toBe('bounced')
    })
})
