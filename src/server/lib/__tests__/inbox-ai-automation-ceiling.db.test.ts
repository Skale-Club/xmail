import path from 'node:path'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
    applyHandWrittenMigrations,
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'
import { createAiRun, createDrizzleAiRunStore, type AiRunRecord } from '../inbox-ai-audit'
import {
    processAutonomousAiRun,
    type AutonomousRunResolution,
    type CreateAutonomousCommandArgs,
    type EffectiveAutonomyInputs,
    type ProcessAutonomousAiRunDeps,
} from '../inbox-ai-automation'
import type { BuildInboxAiContextInput, InboxAiContextMessage } from '../inbox-ai-context'
import type { AiDraftProposalResult } from '../outreach-followup'
import type { ResolvedSendCommand } from '../inbox-command-dispatch'

// ============================================================
// Phase 23 (AI-03/04) — C-1: the per-thread autonomous follow-up ceiling must be enforced against an
// ACTUALLY-ADVANCING source, not the dead `campaign_leads.follow_up_count` column (which nothing on
// the durable-command send path increments, so it is frozen at 0 forever — making any positive
// `max_autonomous_follow_ups` silently UNLIMITED).
//
// This suite drives N GENUINE successful autonomous sends through the REAL counting path — the real
// `createDrizzleAiRunStore` audit lifecycle over a real Postgres, counted by the real
// `countAutonomousSends` query — and proves the (N+1)th autonomous decision is `no_action` because the
// ceiling engages. It is a true RED for the shipped bug: under the old code the (N+1)th resolution read
// `follow_up_count = 0`, so `0 >= N` stayed false and the send went through. This suite also asserts
// that after N genuine sends the frozen column is STILL 0 while the audit-derived count is N.
//
// Only the Phase 18 protected disposable Postgres URL is ever touched; the app DATABASE_URL is never
// read. This suite is SELF-CONTAINED: it applies migration 043 (idempotent) so the outreach_ai_runs
// FKs are present deterministically regardless of sibling suite order, and seeds every referenced row.
// ============================================================

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
const M = (name: string) => path.join(migrationsDir, name)

// Distinct id space so this suite never collides with sibling .db suites on the shared database.
const U = (n: string) => `23c10000-0000-4000-8000-${n.padStart(12, '0')}`
const OWNER = U('1')
const ORG = U('10')
const ACCOUNT = U('20')
const CONV = U('30')
const CMD = U('40')
const LEAD = U('50')
const LEAD2 = U('51')
const CAMP = U('60')
const CL = U('70') // the campaign-lead under test
const CL_OTHER = U('71') // a sibling campaign-lead (proves per-lead scoping)

const ACCOUNT_ADDRESS = 'ceiling-seller@skale.club'
const PROSPECT = 'ceiling-prospect@acme.test'

let sql: ReturnType<typeof postgres>
let closeApplicationDatabase: (() => Promise<void>) | undefined
let countAutonomousSends: (organizationId: string, campaignLeadId: string) => Promise<number>

// ------------------------------------------------------------
// Fixtures that mirror what production resolves (except autonomousFollowUpsSent, which comes from the
// REAL count query — that is the whole point of the fix).
// ------------------------------------------------------------

function enabledAutonomy(): EffectiveAutonomyInputs {
    return {
        orgAutonomousEnabled: true,
        orgAutonomyPausedAt: null,
        campaignAiAutonomousEnabled: true,
        campaignActive: true,
        outreachEnabled: true,
    }
}

function contextMessage(): InboxAiContextMessage {
    return {
        id: randomUUID(),
        organizationId: ORG,
        conversationId: CONV,
        direction: 'inbound',
        subject: 'Re: quote',
        fromAddress: PROSPECT,
        fromName: 'Pat Prospect',
        toAddresses: [{ address: ACCOUNT_ADDRESS, name: 'Seller' }],
        ccAddresses: [],
        plainBody: 'Please tell me more about pricing.',
        htmlBody: null,
        sentAt: null,
        receivedAt: new Date('2026-07-10T10:00:00Z'),
        createdAt: new Date('2026-07-10T10:00:00Z'),
    }
}

function contextInput(): BuildInboxAiContextInput {
    return {
        organizationId: ORG,
        conversationId: CONV,
        accountAddress: ACCOUNT_ADDRESS,
        messages: [contextMessage()],
        campaign: { id: CAMP, name: 'Q3 Outbound' },
        lead: { email: PROSPECT, firstName: 'Pat', company: 'Acme' },
        sellerName: 'Sam Seller',
    }
}

function resolvedSend(): ResolvedSendCommand {
    return {
        sourceMessageId: randomUUID(),
        to: [{ address: PROSPECT, name: 'Pat Prospect' }],
        cc: [],
        bcc: [],
        subject: 'Re: quote',
        inReplyTo: '<inbound-1@acme.test>',
        references: '<inbound-1@acme.test>',
    }
}

function draftProposal(): AiDraftProposalResult {
    return {
        ok: true,
        proposal: { action: 'draft', subject: 'Re: quote', body: 'Happy to share pricing.', outcome: null, followUpMinutes: null },
        provider: 'xphere', model: 'kimi-coder', latencyMs: 5, promptTokens: 100, completionTokens: 20, totalTokens: 120,
    }
}

/**
 * Production-shaped deps for the pure processor. `store` is the REAL Drizzle store, and `resolveRun`
 * feeds `autonomousFollowUpsSent` from the REAL `countAutonomousSends` query (never an injected value)
 * — exactly like `resolveAutonomousRun` in production. `createCommand`/`dispatchCommand` are faked at
 * the durable-command boundary (the command id is a real seeded row so the send_command_id FK holds),
 * which keeps this a focused ceiling test without standing up the full Phase 18/22 dispatch stack.
 */
function processDeps(
    campaignLeadId: string,
    maxAutonomousFollowUps: number,
    overrides: Partial<ProcessAutonomousAiRunDeps> = {},
): ProcessAutonomousAiRunDeps {
    return {
        store: createDrizzleAiRunStore(),
        resolveRun: async (): Promise<AutonomousRunResolution> => ({
            autonomy: enabledAutonomy(),
            contextInput: contextInput(),
            conversationId: CONV,
            emailAccountId: ACCOUNT,
            resolvedSend: resolvedSend(),
            // THE REAL COUNTING PATH: derived from the append-only audit trail, not a dead column.
            autonomousFollowUpsSent: await countAutonomousSends(ORG, campaignLeadId),
            maxAutonomousFollowUps,
            toneGoal: null,
        }),
        requestProposal: async () => draftProposal(),
        createCommand: async (_args: CreateAutonomousCommandArgs) => ({ commandId: CMD, created: true }),
        dispatchCommand: async () => ({ outcome: 'sent', outreachEmailId: null }),
        reloadAutonomy: async () => enabledAutonomy(),
        ...overrides,
    }
}

let runSeq = 0
async function seedPendingAutonomousRun(campaignLeadId: string): Promise<AiRunRecord> {
    runSeq += 1
    const { run } = await createAiRun(createDrizzleAiRunStore(), {
        organizationId: ORG,
        runKind: 'autonomous',
        idempotencyKey: `ceiling:${campaignLeadId}:${runSeq}`,
        campaignId: CAMP,
        campaignLeadId,
        promptVersion: 'inbox-autonomous@1',
        provider: 'xphere',
    })
    return run
}

/** Drive ONE genuine autonomous send end-to-end through the real processor + real store. */
async function driveGenuineSend(campaignLeadId: string, max: number): Promise<void> {
    const run = await seedPendingAutonomousRun(campaignLeadId)
    const outcome = await processAutonomousAiRun(processDeps(campaignLeadId, max), run)
    expect(outcome.status).toBe('sent')
}

/** Insert a run row directly (for non-counting edge cases). All CHECK constraints are satisfied. */
async function insertRunRow(fields: {
    org?: string
    campaignLeadId: string
    runKind: 'autonomous' | 'draft'
    status: string
    action: string | null
    sendCommandId: string | null
}): Promise<void> {
    runSeq += 1
    await sql`
        INSERT INTO outreach_ai_runs
            (organization_id, campaign_id, campaign_lead_id, run_kind, status, action, send_command_id, idempotency_key)
        VALUES (
            ${fields.org ?? ORG}::uuid, ${CAMP}::uuid, ${fields.campaignLeadId}::uuid,
            ${fields.runKind}, ${fields.status}, ${fields.action}, ${fields.sendCommandId}::uuid,
            ${'edge:' + runSeq}
        )`
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl as string, runGuard }

    // Self-contained: apply the Phase 21/22/23 migrations so outreach_ai_runs carries its real FKs
    // (org, campaign, campaign_lead, send_command) regardless of sibling order. All idempotent.
    await applyHandWrittenMigrations(target)
    await applyMigrationFile(target, M('038_outreach_dispatch_state_machine.sql'))
    await applyMigrationFile(target, M('039_outreach_provider_events.sql'))
    await applyMigrationFile(target, M('041_unified_inbox_foundation.sql'))
    await applyMigrationFile(target, M('042_unified_inbox_operator_workflows.sql'))
    await applyMigrationFile(target, M('043_ai_inbox_automation_audit.sql'))

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl as string, { max: 4, prepare: false })

    // inbox-ai-automation-runtime statically imports the app db, so import it only after DATABASE_URL
    // points at the disposable container.
    countAutonomousSends = (await import('../inbox-ai-automation-runtime')).countAutonomousSends
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection

    await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'ceiling-owner@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES (${ORG}::uuid, 'Ceiling Org', 'ceiling-org', ${OWNER}::uuid) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role) VALUES (${ORG}::uuid, ${OWNER}::uuid, 'admin') ON CONFLICT (organization_id, user_id) DO NOTHING`
    await sql`INSERT INTO email_accounts (id, organization_id, email, status) VALUES (${ACCOUNT}::uuid, ${ORG}::uuid, ${ACCOUNT_ADDRESS}, 'verified') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO leads (id, organization_id, email) VALUES
        (${LEAD}::uuid, ${ORG}::uuid, ${PROSPECT}),
        (${LEAD2}::uuid, ${ORG}::uuid, 'ceiling-prospect2@acme.test')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO campaigns (id, organization_id, name, status) VALUES (${CAMP}::uuid, ${ORG}::uuid, 'Ceiling Camp', 'active') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO campaign_leads (id, campaign_id, lead_id) VALUES
        (${CL}::uuid, ${CAMP}::uuid, ${LEAD}::uuid),
        (${CL_OTHER}::uuid, ${CAMP}::uuid, ${LEAD2}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO outreach_conversations (id, organization_id, email_account_id, thread_key, last_message_at, last_inbound_at)
        VALUES (${CONV}::uuid, ${ORG}::uuid, ${ACCOUNT}::uuid, ${'rfc:ceiling'}, now(), now()) ON CONFLICT (id) DO NOTHING`
    // One real durable command so the send_command_id composite FK holds for the linked runs.
    await sql`INSERT INTO inbox_send_commands (id, organization_id, actor_user_id, conversation_id, email_account_id, mode, idempotency_key, due_at)
        VALUES (${CMD}::uuid, ${ORG}::uuid, ${OWNER}::uuid, ${CONV}::uuid, ${ACCOUNT}::uuid, 'reply', 'ceiling-cmd', now()) ON CONFLICT (id) DO NOTHING`
})

afterAll(async () => {
    if (sql) {
        await sql`DELETE FROM outreach_ai_runs WHERE organization_id = ${ORG}::uuid`
        await sql`DELETE FROM inbox_send_commands WHERE organization_id = ${ORG}::uuid`
        await sql`DELETE FROM outreach_conversations WHERE organization_id = ${ORG}::uuid`
        await sql`DELETE FROM campaign_leads WHERE campaign_id = ${CAMP}::uuid`
        await sql`DELETE FROM campaigns WHERE organization_id = ${ORG}::uuid`
        await sql`DELETE FROM leads WHERE organization_id = ${ORG}::uuid`
        await sql`DELETE FROM email_accounts WHERE organization_id = ${ORG}::uuid`
        await sql`DELETE FROM organization_users WHERE organization_id = ${ORG}::uuid`
        await sql`DELETE FROM organizations WHERE id = ${ORG}::uuid`
        await sql`DELETE FROM users WHERE id = ${OWNER}::uuid`
    }
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('countAutonomousSends — the advancing, tenant-scoped ceiling source (C-1)', () => {
    it('counts ONLY genuinely-sent autonomous runs and advances once per send, ignoring the dead follow_up_count column', async () => {
        // Start clean for this campaign-lead.
        await sql`DELETE FROM outreach_ai_runs WHERE campaign_lead_id = ${CL}::uuid`
        expect(await countAutonomousSends(ORG, CL)).toBe(0)

        const N = 3
        for (let i = 0; i < N; i += 1) {
            await driveGenuineSend(CL, 100 /* high ceiling so these all send */)
            // The audit-derived count advances by exactly one per genuine send.
            expect(await countAutonomousSends(ORG, CL)).toBe(i + 1)
        }
        expect(await countAutonomousSends(ORG, CL)).toBe(N)

        // The frozen column the OLD code trusted never moved — it is STILL 0 after N real sends. That
        // is precisely why the old `0 >= max` check could never fire for a positive ceiling.
        const [{ follow_up_count: frozen }] = await sql<{ follow_up_count: number }[]>`
            SELECT follow_up_count FROM campaign_leads WHERE id = ${CL}::uuid`
        expect(Number(frozen)).toBe(0)

        // Non-send / non-autonomous / other-lead runs must NOT inflate the count.
        await insertRunRow({ campaignLeadId: CL, runKind: 'autonomous', status: 'deferred', action: null, sendCommandId: CMD }) // held
        await insertRunRow({ campaignLeadId: CL, runKind: 'autonomous', status: 'failed', action: null, sendCommandId: null })
        await insertRunRow({ campaignLeadId: CL, runKind: 'autonomous', status: 'completed', action: 'complete', sendCommandId: CMD }) // no-action
        await insertRunRow({ campaignLeadId: CL, runKind: 'autonomous', status: 'completed', action: 'none', sendCommandId: null }) // paused
        await insertRunRow({ campaignLeadId: CL, runKind: 'draft', status: 'completed', action: 'draft', sendCommandId: CMD }) // draft-kind, not autonomous
        await insertRunRow({ campaignLeadId: CL_OTHER, runKind: 'autonomous', status: 'completed', action: 'draft', sendCommandId: CMD }) // other lead
        expect(await countAutonomousSends(ORG, CL)).toBe(N)

        // Scoping: per-lead and per-org predicates.
        expect(await countAutonomousSends(ORG, CL_OTHER)).toBe(1)
        expect(await countAutonomousSends(randomUUID(), CL)).toBe(0)
    })
})

describe('processAutonomousAiRun — the ceiling engages against the real count (C-1 RED)', () => {
    it('blocks the (N+1)th autonomous send once N genuine sends are recorded (old code would send)', async () => {
        await sql`DELETE FROM outreach_ai_runs WHERE campaign_lead_id = ${CL}::uuid`
        const N = 2

        // Drive N genuine sends with the ceiling set to N. Each proceeds because the real count is < N.
        for (let i = 0; i < N; i += 1) {
            await driveGenuineSend(CL, N)
        }
        expect(await countAutonomousSends(ORG, CL)).toBe(N)

        // The (N+1)th run: the real count now reports N, so `N >= N` fires → no_action, NO command.
        const createCommand = vi.fn(async (_a: CreateAutonomousCommandArgs) => ({ commandId: CMD, created: true }))
        const dispatchCommand = vi.fn(async () => ({ outcome: 'sent' as const, outreachEmailId: null }))
        const run = await seedPendingAutonomousRun(CL)
        const outcome = await processAutonomousAiRun(processDeps(CL, N, { createCommand, dispatchCommand }), run)

        expect(outcome.status).toBe('no_action')
        expect(createCommand).not.toHaveBeenCalled()
        expect(dispatchCommand).not.toHaveBeenCalled()
        const [{ status, action, output_outcome }] = await sql<{ status: string; action: string; output_outcome: string }[]>`
            SELECT status, action, output_outcome FROM outreach_ai_runs WHERE id = ${run.id}::uuid`
        expect(status).toBe('completed')
        expect(action).toBe('complete')
        expect(output_outcome).toBe('max_follow_ups')
        // No further genuine send was recorded — the count is still exactly N.
        expect(await countAutonomousSends(ORG, CL)).toBe(N)
    })

    it('treats max_autonomous_follow_ups = 0 as fully blocked (disable still works)', async () => {
        await sql`DELETE FROM outreach_ai_runs WHERE campaign_lead_id = ${CL_OTHER}::uuid`
        expect(await countAutonomousSends(ORG, CL_OTHER)).toBe(0)

        const dispatchCommand = vi.fn(async () => ({ outcome: 'sent' as const, outreachEmailId: null }))
        const run = await seedPendingAutonomousRun(CL_OTHER)
        const outcome = await processAutonomousAiRun(processDeps(CL_OTHER, 0, { dispatchCommand }), run)

        expect(outcome.status).toBe('no_action')
        expect(dispatchCommand).not.toHaveBeenCalled()
        expect(await countAutonomousSends(ORG, CL_OTHER)).toBe(0)
    })
})
