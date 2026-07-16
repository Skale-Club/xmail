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
 * C-3 — a native outreach account must never read a mailbox outside its own tenant.
 *
 * createNativeInboundSource resolved its mailbox with getNativeMailboxByEmail(email),
 * which matches on email + isNative and nothing else. The Outlook sibling re-checks
 * outlookMailboxes.organizationId for exactly this reason; the native path trusted a
 * membership check that only ever ran at create time.
 *
 * The scenario: bob@ is a member of Org A and Org B. Org A creates a native outreach
 * account for bob (the create gate passes). Bob is later removed from Org A —
 * DELETE /:id/members/:userId removes only the organization_users row, and the
 * email_accounts row survives, still verified. From that tick on, bob's entire personal
 * INBOX — including classification='other' mail with full text/html bodies, which 039
 * retains for Phase 21 — is staged under organization_id = Org A, whose RLS SELECT policy
 * is is_org_member(organization_id).
 *
 * Tenant isolation here is JS-side (CLAUDE.md): the app's Postgres role bypasses RLS, so
 * there is no database safety net behind this check.
 */

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '039_outreach_provider_events.sql',
)

const IDS = {
    bob: '60000000-0000-4000-8000-000000000001',
    ownerA: '60000000-0000-4000-8000-000000000002',
    orgA: '60000000-0000-4000-8000-000000000011',
    orgB: '60000000-0000-4000-8000-000000000012',
    accountA: '60000000-0000-4000-8000-000000000021',
    mailbox: '60000000-0000-4000-8000-000000000031',
    folder: '60000000-0000-4000-8000-000000000041',
    message: '60000000-0000-4000-8000-000000000051',
}

let closeApplicationDatabase: (() => Promise<void>) | undefined

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    await applyMigrationFile({ databaseUrl: testDatabaseUrl, runGuard }, migrationPath)
    process.env.DATABASE_URL = testDatabaseUrl

    const sql = postgres(testDatabaseUrl, { max: 1, prepare: false })
    try {
        await sql`
            INSERT INTO users (id, email) VALUES
                (${IDS.bob}::uuid, 'bob@skale.test'),
                (${IDS.ownerA}::uuid, 'owner-a@skale.test')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO organizations (id, name, slug, owner_id) VALUES
                (${IDS.orgA}::uuid, 'Tenancy A', 'tenancy-a', ${IDS.ownerA}::uuid),
                (${IDS.orgB}::uuid, 'Tenancy B', 'tenancy-b', ${IDS.bob}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
        // Bob is a member of both organizations, which is what makes the create-time gate
        // pass for Org A in the first place.
        await sql`
            INSERT INTO organization_users (organization_id, user_id, role) VALUES
                (${IDS.orgA}::uuid, ${IDS.bob}::uuid, 'member'),
                (${IDS.orgB}::uuid, ${IDS.bob}::uuid, 'admin')
            ON CONFLICT DO NOTHING
        `
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, provider, status)
            VALUES (${IDS.accountA}::uuid, ${IDS.orgA}::uuid, 'bob@skale.test', 'native', 'verified')
            ON CONFLICT (id) DO NOTHING
        `
        // Bob's personal native mailbox. It belongs to bob the user, not to any org.
        await sql`
            INSERT INTO mailboxes (
                id, user_id, email, smtp_host, smtp_username, smtp_password_encrypted,
                imap_host, imap_username, imap_password_encrypted, is_native
            ) VALUES (
                ${IDS.mailbox}::uuid, ${IDS.bob}::uuid, 'bob@skale.test',
                'localhost', 'bob', 'not-a-real-secret',
                'localhost', 'bob', 'not-a-real-secret', true
            )
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO mail_folders (id, mailbox_id, remote_id, name, type)
            VALUES (${IDS.folder}::uuid, ${IDS.mailbox}::uuid, 'INBOX', 'INBOX', 'inbox')
            ON CONFLICT (id) DO NOTHING
        `
        // A private message that has nothing to do with Org A's outreach.
        await sql`
            INSERT INTO mail_messages (
                id, folder_id, mailbox_id, message_id, subject, from_address,
                plain_body, received_at
            ) VALUES (
                ${IDS.message}::uuid, ${IDS.folder}::uuid, ${IDS.mailbox}::uuid,
                'private-1@elsewhere.test', 'My salary review', 'hr@elsewhere.test',
                'Confidential body that Org A must never stage.', now()
            )
            ON CONFLICT (id) DO NOTHING
        `
    } finally {
        await sql.end({ timeout: 1 })
    }

    const database = await import('../../../db')
    closeApplicationDatabase = database.closeDatabaseConnection
})

afterAll(async () => {
    await closeApplicationDatabase?.()
})

function connect() {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl, { max: 1, prepare: false })
}

async function setMembership(present: boolean): Promise<void> {
    const sql = connect()
    try {
        if (present) {
            await sql`
                INSERT INTO organization_users (organization_id, user_id, role)
                VALUES (${IDS.orgA}::uuid, ${IDS.bob}::uuid, 'member')
                ON CONFLICT DO NOTHING
            `
        } else {
            // Exactly what DELETE /:id/members/:userId does: the membership row goes, the
            // verified email_accounts row stays.
            await sql`
                DELETE FROM organization_users
                WHERE organization_id = ${IDS.orgA}::uuid AND user_id = ${IDS.bob}::uuid
            `
        }
    } finally {
        await sql.end({ timeout: 1 })
    }
}

describe('native inbound source tenancy', () => {
    it('reads the mailbox while the owner is still a member of the account organization', async () => {
        await setMembership(true)
        const { createNativeInboundSource } = await import('../outreach-inbound-sources')

        const source = await createNativeInboundSource({
            id: IDS.accountA,
            email: 'bob@skale.test',
            organizationId: IDS.orgA,
        })

        expect(source).not.toBeNull()
        const page = await source!.fetchPage(null, 10)
        expect(page.messages.map((message) => message.subject)).toContain('My salary review')
    })

    it('refuses to read the mailbox once the owner is no longer a member', async () => {
        await setMembership(false)
        const { createNativeInboundSource } = await import('../outreach-inbound-sources')

        const source = await createNativeInboundSource({
            id: IDS.accountA,
            email: 'bob@skale.test',
            organizationId: IDS.orgA,
        })

        // No source at all: the ex-member's private inbox must not be staged under Org A,
        // bodies and all. Returning null is what ingestOutreachInbound already treats as
        // "skip this account".
        expect(source).toBeNull()
    })

    it('resolves nothing for the verify path once the owner has left, so re-verify cannot pass', async () => {
        // The same hole one level up: /verify re-checked that the user and mailbox still
        // existed but not that the membership did, so an operator could re-verify an
        // ex-member's account and see a green tick.
        await setMembership(false)
        const { getNativeMailboxForOrganization, getNativeMailboxByEmail } =
            await import('../native-send')

        // The mailbox itself still exists — this is why the old check passed.
        expect(await getNativeMailboxByEmail('bob@skale.test')).not.toBeNull()
        expect(await getNativeMailboxForOrganization('bob@skale.test', IDS.orgA)).toBeUndefined()

        // ...and Org B, where bob is still a member, is unaffected.
        await setMembership(true)
        expect(await getNativeMailboxForOrganization('bob@skale.test', IDS.orgB)).toBeDefined()
    })

    it('refuses a native mailbox belonging to a user with no membership anywhere near the org', async () => {
        await setMembership(true)
        const { createNativeInboundSource } = await import('../outreach-inbound-sources')

        // Bob is a member of Org B, but this account claims Org A's id paired with an
        // organization Bob's mailbox has no relationship to. The mailbox is resolved from
        // the account's organization, never from the email alone.
        const source = await createNativeInboundSource({
            id: IDS.accountA,
            email: 'bob@skale.test',
            organizationId: '60000000-0000-4000-8000-0000000000ff',
        })

        expect(source).toBeNull()
    })
})
