import path from 'node:path'
import postgres from 'postgres'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'

// Only the harness-provisioned disposable database is ever touched here. The
// application DATABASE_URL is never read and never fallen back to —
// assertSafeTestDatabaseUrl rejects non-loopback hosts, databases without a test
// marker, and the configured application URL itself.
const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
// Phase 21 EXTENDS the Phase 19 provider-event table, so 039 must exist before 041
// adds the materialization lifecycle columns to it.
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')

// Distinct id space so parallel .db suites sharing the one disposable database do
// not collide on seeded rows.
const ORG_A = '21000000-0000-4000-8000-000000000001'
const ORG_B = '21000000-0000-4000-8000-000000000002'
const ACCOUNT_A = '21000000-0000-4000-8000-000000000011'
const ACCOUNT_B = '21000000-0000-4000-8000-000000000012'
const LEAD_A = '21000000-0000-4000-8000-000000000021'
const LEAD_B = '21000000-0000-4000-8000-000000000022'
const CAMPAIGN_A = '21000000-0000-4000-8000-000000000031'
const CAMPAIGN_A2 = '21000000-0000-4000-8000-000000000032'
const CAMPAIGN_LEAD_A = '21000000-0000-4000-8000-000000000041'
const OWNER = '21000000-0000-4000-8000-000000000051'
const READER = '21000000-0000-4000-8000-000000000052'

function connect(max = 1) {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl, { max, prepare: false, onnotice: () => {} })
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }

    // 039 first (creates outreach_provider_events); then 041 twice, which proves the
    // hand-written migration is re-runnable — a partially applied production run must
    // be safe to repeat.
    await applyMigrationFile(target, providerEventsMigration)
    await applyMigrationFile(target, unifiedInboxMigration)
    await applyMigrationFile(target, unifiedInboxMigration)

    const sql = connect()
    try {
        await sql`
            INSERT INTO users (id, email) VALUES
                (${OWNER}::uuid, 'inbox-owner@example.test'),
                (${READER}::uuid, 'inbox-reader@example.test')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO organizations (id, name, slug, owner_id) VALUES
                (${ORG_A}::uuid, 'Inbox Test A', 'inbox-test-a', ${OWNER}::uuid),
                (${ORG_B}::uuid, 'Inbox Test B', 'inbox-test-b', ${OWNER}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status) VALUES
                (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'inbox-a@example.test', 'localhost', 'inbox-a', 'not-a-real-secret', 'verified'),
                (${ACCOUNT_B}::uuid, ${ORG_B}::uuid, 'inbox-b@example.test', 'localhost', 'inbox-b', 'not-a-real-secret', 'verified')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO leads (id, organization_id, email) VALUES
                (${LEAD_A}::uuid, ${ORG_A}::uuid, 'lead-a@prospect.test'),
                (${LEAD_B}::uuid, ${ORG_B}::uuid, 'lead-b@prospect.test')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO campaigns (id, organization_id, name) VALUES
                (${CAMPAIGN_A}::uuid, ${ORG_A}::uuid, 'Inbox Campaign A'),
                (${CAMPAIGN_A2}::uuid, ${ORG_A}::uuid, 'Inbox Campaign A2')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id) VALUES
                (${CAMPAIGN_LEAD_A}::uuid, ${CAMPAIGN_A}::uuid, ${LEAD_A}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
    } finally {
        await sql.end({ timeout: 1 })
    }
})

beforeEach(async () => {
    const sql = connect()
    try {
        // CASCADE from conversations clears messages/participants/reads; provider events
        // are cleared for the materialization suite. Scoped to this suite's orgs.
        await sql`DELETE FROM outreach_provider_events WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
        await sql`DELETE FROM outreach_conversations WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    } finally {
        await sql.end({ timeout: 1 })
    }
})

async function insertConversation(
    sql: postgres.Sql,
    overrides: {
        id?: string
        organizationId?: string
        emailAccountId?: string
        threadKey?: string
        leadId?: string | null
        campaignId?: string | null
        campaignLeadId?: string | null
    } = {},
): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO outreach_conversations (
            id, organization_id, email_account_id, thread_key,
            lead_id, campaign_id, campaign_lead_id
        ) VALUES (
            COALESCE(${overrides.id ?? null}::uuid, gen_random_uuid()),
            ${overrides.organizationId ?? ORG_A}::uuid,
            ${overrides.emailAccountId ?? ACCOUNT_A}::uuid,
            ${overrides.threadKey ?? `thread-${Math.random().toString(16).slice(2)}`},
            ${overrides.leadId ?? null}::uuid,
            ${overrides.campaignId ?? null}::uuid,
            ${overrides.campaignLeadId ?? null}::uuid
        )
        RETURNING id
    `
    return rows[0].id
}

async function insertMessage(
    sql: postgres.Sql,
    conversationId: string,
    overrides: {
        sourceKey: string
        direction?: string
        provider?: string
        classification?: string
        internetMessageId?: string | null
        organizationId?: string
    },
): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO outreach_conversation_messages (
            organization_id, conversation_id, email_account_id, source_key,
            direction, provider, classification, internet_message_id, received_at
        ) VALUES (
            ${overrides.organizationId ?? ORG_A}::uuid, ${conversationId}::uuid, ${ACCOUNT_A}::uuid,
            ${overrides.sourceKey}, ${overrides.direction ?? 'inbound'}, ${overrides.provider ?? 'native'},
            ${overrides.classification ?? 'reply'}, ${overrides.internetMessageId ?? null}, now()
        )
        RETURNING id
    `
    return rows[0].id
}

async function insertEvent(sql: postgres.Sql, key: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO outreach_provider_events (
            organization_id, email_account_id, provider, provider_message_id,
            classification, received_at
        ) VALUES (
            ${ORG_A}::uuid, ${ACCOUNT_A}::uuid, 'native', ${key}, 'reply', now()
        )
        RETURNING id
    `
    return rows[0].id
}

async function claimForMaterialization(sql: postgres.Sql, token: string): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        WITH candidate AS (
            SELECT id FROM outreach_provider_events
            WHERE organization_id = ${ORG_A}::uuid
              AND (
                  materialization_status = 'pending'
                  OR (materialization_status = 'processing' AND materialization_lease_expires_at < now())
              )
            ORDER BY received_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE outreach_provider_events e
        SET materialization_status = 'processing',
            materialization_lease_token = ${token}::uuid,
            materialization_lease_expires_at = now() + interval '5 minutes',
            materialization_attempts = e.materialization_attempts + 1,
            updated_at = now()
        FROM candidate
        WHERE e.id = candidate.id
        RETURNING e.id
    `
    return rows.map((row) => row.id)
}

describe('unified inbox foundation — tenant scope and identifiers', () => {
    it('gives every foundation table a non-null organization_id', async () => {
        const sql = connect()
        try {
            const cols = await sql<{ table_name: string; column_name: string; is_nullable: string }[]>`
                SELECT table_name, column_name, is_nullable
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name IN (
                    'outreach_conversations', 'outreach_conversation_messages',
                    'outreach_conversation_participants', 'outreach_conversation_reads'
                  )
                  AND column_name = 'organization_id'
            `
            expect(cols).toHaveLength(4)
            for (const col of cols) {
                expect(col.is_nullable, col.table_name).toBe('NO')
            }
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('leads all list/thread/attribution/source indexes with tenant scope', async () => {
        const sql = connect()
        try {
            const indexes = await sql<{ indexname: string; indexdef: string }[]>`
                SELECT indexname, indexdef FROM pg_indexes
                WHERE schemaname = 'public'
                  AND tablename IN (
                    'outreach_conversations', 'outreach_conversation_messages',
                    'outreach_conversation_participants', 'outreach_conversation_reads',
                    'outreach_provider_events'
                  )
            `
            const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]))

            const threadKey = byName.get('outreach_conversations_thread_key_unique')
            expect(threadKey).toContain('UNIQUE')
            expect(threadKey).toContain('organization_id')
            expect(threadKey).toContain('email_account_id')
            expect(threadKey).toContain('thread_key')

            const list = byName.get('idx_outreach_conversations_list')
            expect(list).toContain('organization_id')
            expect(list).toContain('last_message_at')

            const sourceKey = byName.get('outreach_conversation_messages_source_key_unique')
            expect(sourceKey).toContain('UNIQUE')
            expect(sourceKey).toContain('organization_id')
            expect(sourceKey).toContain('email_account_id')
            expect(sourceKey).toContain('source_key')

            const thread = byName.get('idx_outreach_conversation_messages_thread')
            expect(thread).toContain('organization_id')
            expect(thread).toContain('conversation_id')

            const rfc = byName.get('idx_outreach_conversation_messages_internet_message_id')
            expect(rfc).toContain('organization_id')
            expect(rfc).toContain('internet_message_id')

            const participant = byName.get('outreach_conversation_participants_unique')
            expect(participant).toContain('UNIQUE')
            expect(participant).toContain('organization_id')
            expect(participant).toContain('conversation_id')
            expect(participant).toContain('address')
            expect(participant).toContain('role')

            const read = byName.get('outreach_conversation_reads_unique')
            expect(read).toContain('UNIQUE')
            expect(read).toContain('organization_id')
            expect(read).toContain('conversation_id')
            expect(read).toContain('user_id')

            // Materialization claim queue is a global worker index (like the Phase 19
            // classification queue), partial over the reclaimable states.
            const claim = byName.get('idx_outreach_provider_events_materialization_claim')
            expect(claim).toContain('materialization_status')

            const materializedLink = byName.get('outreach_provider_events_materialized_message_unique')
            expect(materializedLink).toContain('UNIQUE')
            expect(materializedLink).toContain('conversation_message_id')
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})

describe('unified inbox foundation — source identity and RFC threading', () => {
    it('deduplicates a normalized message on (organization, account, source_key)', async () => {
        const sql = connect()
        try {
            const conversationId = await insertConversation(sql)
            await insertMessage(sql, conversationId, { sourceKey: 'native:dup-1' })
            await expect(
                insertMessage(sql, conversationId, { sourceKey: 'native:dup-1' }),
            ).rejects.toThrow(/outreach_conversation_messages_source_key_unique/)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('allows a duplicate RFC Message-ID across distinct source keys (it is not globally unique)', async () => {
        const sql = connect()
        try {
            const conversationId = await insertConversation(sql)
            await insertMessage(sql, conversationId, {
                sourceKey: 'native:rfc-1',
                internetMessageId: '<shared@mail.test>',
            })
            // Same RFC Message-ID, different provider identity — a provider replay or a
            // forwarded duplicate must not be rejected on the RFC id.
            const second = await insertMessage(sql, conversationId, {
                sourceKey: 'imap:1:99',
                internetMessageId: '<shared@mail.test>',
            })
            expect(second).toBeTruthy()
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('enforces one conversation per (organization, account, thread_key)', async () => {
        const sql = connect()
        try {
            await insertConversation(sql, { threadKey: 'shared-thread' })
            await expect(
                insertConversation(sql, { threadKey: 'shared-thread' }),
            ).rejects.toThrow(/outreach_conversations_thread_key_unique/)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('enforces participant and read-state uniqueness', async () => {
        const sql = connect()
        try {
            const conversationId = await insertConversation(sql)
            await sql`
                INSERT INTO outreach_conversation_participants (organization_id, conversation_id, address, role)
                VALUES (${ORG_A}::uuid, ${conversationId}::uuid, 'p@prospect.test', 'from')
            `
            await expect(sql`
                INSERT INTO outreach_conversation_participants (organization_id, conversation_id, address, role)
                VALUES (${ORG_A}::uuid, ${conversationId}::uuid, 'p@prospect.test', 'from')
            `).rejects.toThrow(/outreach_conversation_participants_unique/)

            await sql`
                INSERT INTO outreach_conversation_reads (organization_id, conversation_id, user_id)
                VALUES (${ORG_A}::uuid, ${conversationId}::uuid, ${READER}::uuid)
            `
            await expect(sql`
                INSERT INTO outreach_conversation_reads (organization_id, conversation_id, user_id)
                VALUES (${ORG_A}::uuid, ${conversationId}::uuid, ${READER}::uuid)
            `).rejects.toThrow(/outreach_conversation_reads_unique/)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})

describe('unified inbox foundation — value domains', () => {
    it('rejects unknown direction, provider, classification, status, and role', async () => {
        const sql = connect()
        try {
            const conversationId = await insertConversation(sql)

            await expect(
                insertMessage(sql, conversationId, { sourceKey: 'x:1', direction: 'sideways' }),
            ).rejects.toThrow(/outreach_conversation_messages_direction_check/)

            await expect(
                insertMessage(sql, conversationId, { sourceKey: 'x:2', provider: 'carrier-pigeon' }),
            ).rejects.toThrow(/outreach_conversation_messages_provider_check/)

            await expect(
                insertMessage(sql, conversationId, { sourceKey: 'x:3', classification: 'spam' }),
            ).rejects.toThrow(/outreach_conversation_messages_classification_check/)

            await expect(sql`
                UPDATE outreach_conversations SET status = 'nonsense' WHERE id = ${conversationId}::uuid
            `).rejects.toThrow(/outreach_conversations_status_check/)

            await expect(sql`
                INSERT INTO outreach_conversation_participants (organization_id, conversation_id, address, role)
                VALUES (${ORG_A}::uuid, ${conversationId}::uuid, 'p@prospect.test', 'archivist')
            `).rejects.toThrow(/outreach_conversation_participants_role_check/)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})

describe('unified inbox foundation — cross-tenant integrity', () => {
    it('refuses a conversation that links another organization\'s account, lead, or campaign', async () => {
        const sql = connect()
        try {
            await expect(
                insertConversation(sql, { organizationId: ORG_B, emailAccountId: ACCOUNT_A }),
            ).rejects.toThrow(/outreach_conversations_account_org_fkey/)

            await expect(
                insertConversation(sql, { organizationId: ORG_A, emailAccountId: ACCOUNT_A, leadId: LEAD_B }),
            ).rejects.toThrow(/outreach_conversations_lead_org_fkey/)

            // CAMPAIGN_A2 is org A, but pairing it with CAMPAIGN_LEAD_A (which belongs to
            // CAMPAIGN_A) must fail — a campaign_lead can only attach under its own campaign.
            await expect(
                insertConversation(sql, {
                    organizationId: ORG_A,
                    campaignId: CAMPAIGN_A2,
                    campaignLeadId: CAMPAIGN_LEAD_A,
                }),
            ).rejects.toThrow(/outreach_conversations_campaign_lead_campaign_fkey/)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('requires a campaign whenever a campaign_lead is attributed', async () => {
        const sql = connect()
        try {
            await expect(
                insertConversation(sql, { organizationId: ORG_A, campaignLeadId: CAMPAIGN_LEAD_A }),
            ).rejects.toThrow(/outreach_conversations_campaign_lead_requires_campaign/)

            // The matching campaign+campaign_lead pair is accepted.
            const ok = await insertConversation(sql, {
                organizationId: ORG_A,
                campaignId: CAMPAIGN_A,
                campaignLeadId: CAMPAIGN_LEAD_A,
                threadKey: 'attributed-ok',
            })
            expect(ok).toBeTruthy()
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('refuses read state and messages whose organization does not match the conversation', async () => {
        const sql = connect()
        try {
            const conversationId = await insertConversation(sql, { organizationId: ORG_A })

            // A read row claiming ORG_B against an ORG_A conversation has no matching
            // (id, organization_id) parent and is rejected in the database.
            await expect(sql`
                INSERT INTO outreach_conversation_reads (organization_id, conversation_id, user_id)
                VALUES (${ORG_B}::uuid, ${conversationId}::uuid, ${READER}::uuid)
            `).rejects.toThrow(/outreach_conversation_reads_conversation_org_fkey/)

            await expect(
                insertMessage(sql, conversationId, { sourceKey: 'native:xt-1', organizationId: ORG_B }),
            ).rejects.toThrow(/outreach_conversation_messages_conversation_org_fkey/)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})

describe('provider-event materialization lifecycle (independent of processed_at)', () => {
    it('defaults new events to pending materialization with zero attempts', async () => {
        const sql = connect()
        try {
            await insertEvent(sql, 'mat-default-1')
            const rows = await sql<{
                materialization_status: string
                materialization_attempts: number
                materialized_at: Date | null
                conversation_message_id: string | null
            }[]>`
                SELECT materialization_status, materialization_attempts, materialized_at, conversation_message_id
                FROM outreach_provider_events WHERE provider_message_id = 'mat-default-1'
            `
            expect(rows[0].materialization_status).toBe('pending')
            expect(rows[0].materialization_attempts).toBe(0)
            expect(rows[0].materialized_at).toBeNull()
            expect(rows[0].conversation_message_id).toBeNull()
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('keeps processed_at and materialization_status fully independent', async () => {
        const sql = connect()
        try {
            // Classification side effect finished, but the inbox has not materialized yet.
            await insertEvent(sql, 'independent-1')
            await sql`
                UPDATE outreach_provider_events SET processed_at = now()
                WHERE provider_message_id = 'independent-1'
            `
            const stillClaimable = await claimForMaterialization(sql, '21000000-0000-4000-8000-0000000000a1')
            expect(stillClaimable).toHaveLength(1)

            // And the reverse: an event fully materialized while its classification is
            // still pending (processed_at NULL) is a legal state.
            const conversationId = await insertConversation(sql, { threadKey: 'independent-thread' })
            const messageId = await insertMessage(sql, conversationId, { sourceKey: 'native:independent-1' })
            await sql`
                UPDATE outreach_provider_events
                SET materialization_status = 'materialized',
                    materialized_at = now(),
                    conversation_message_id = ${messageId}::uuid,
                    materialization_lease_token = NULL,
                    materialization_lease_expires_at = NULL
                WHERE provider_message_id = 'independent-1'
            `
            const after = await sql<{ processed_at: Date | null; materialization_status: string }[]>`
                SELECT processed_at, materialization_status FROM outreach_provider_events
                WHERE provider_message_id = 'independent-1'
            `
            expect(after[0].materialization_status).toBe('materialized')
            expect(after[0].processed_at).not.toBeNull()
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('hands a pending event to exactly one of two concurrent claimers', async () => {
        const seeder = connect()
        try {
            await insertEvent(seeder, 'race-mat-1')
        } finally {
            await seeder.end({ timeout: 1 })
        }

        const a = connect()
        const b = connect()
        try {
            const [claimedA, claimedB] = await Promise.all([
                claimForMaterialization(a, '21000000-0000-4000-8000-0000000000b1'),
                claimForMaterialization(b, '21000000-0000-4000-8000-0000000000b2'),
            ])
            expect(claimedA.length + claimedB.length).toBe(1)
        } finally {
            await a.end({ timeout: 1 })
            await b.end({ timeout: 1 })
        }
    })

    it('reclaims a processing event only after its lease expires', async () => {
        const sql = connect()
        try {
            await insertEvent(sql, 'lease-1')
            const first = await claimForMaterialization(sql, '21000000-0000-4000-8000-0000000000c1')
            expect(first).toHaveLength(1)

            // Lease still valid → not reclaimable.
            const blocked = await claimForMaterialization(sql, '21000000-0000-4000-8000-0000000000c2')
            expect(blocked).toHaveLength(0)

            // Expire the lease → the row becomes reclaimable and attempts increments.
            await sql`
                UPDATE outreach_provider_events
                SET materialization_lease_expires_at = now() - interval '1 minute'
                WHERE provider_message_id = 'lease-1'
            `
            const reclaimed = await claimForMaterialization(sql, '21000000-0000-4000-8000-0000000000c3')
            expect(reclaimed).toHaveLength(1)

            const attempts = await sql<{ materialization_attempts: number }[]>`
                SELECT materialization_attempts FROM outreach_provider_events
                WHERE provider_message_id = 'lease-1'
            `
            expect(attempts[0].materialization_attempts).toBe(2)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('forbids materialized without a linked message and treats failed as a terminal state', async () => {
        const sql = connect()
        try {
            await insertEvent(sql, 'terminal-1')

            // materialized must carry both a timestamp and a normalized-message link.
            await expect(sql`
                UPDATE outreach_provider_events
                SET materialization_status = 'materialized'
                WHERE provider_message_id = 'terminal-1'
            `).rejects.toThrow(/outreach_provider_events_materialized_requires_message/)

            // A failed row after exhausted attempts is legal and is NOT reclaimed.
            await sql`
                UPDATE outreach_provider_events
                SET materialization_status = 'failed',
                    materialization_attempts = 5,
                    materialization_error = 'permanent parse failure',
                    materialization_lease_token = NULL,
                    materialization_lease_expires_at = NULL
                WHERE provider_message_id = 'terminal-1'
            `
            const claimed = await claimForMaterialization(sql, '21000000-0000-4000-8000-0000000000d1')
            expect(claimed).toHaveLength(0)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('links a materialized event to exactly one normalized message', async () => {
        const sql = connect()
        try {
            const conversationId = await insertConversation(sql, { threadKey: 'link-thread' })
            const messageId = await insertMessage(sql, conversationId, { sourceKey: 'native:link-1' })
            await insertEvent(sql, 'link-1')
            await insertEvent(sql, 'link-2')

            await sql`
                UPDATE outreach_provider_events
                SET materialization_status = 'materialized', materialized_at = now(),
                    conversation_message_id = ${messageId}::uuid
                WHERE provider_message_id = 'link-1'
            `
            // A second event cannot claim the same normalized message.
            await expect(sql`
                UPDATE outreach_provider_events
                SET materialization_status = 'materialized', materialized_at = now(),
                    conversation_message_id = ${messageId}::uuid
                WHERE provider_message_id = 'link-2'
            `).rejects.toThrow(/outreach_provider_events_materialized_message_unique/)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})
