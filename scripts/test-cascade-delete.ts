// Manual verification script for CRIT-01. Run: tsx scripts/test-cascade-delete.ts.
// NOT a unit test — no test framework configured (see CLAUDE.md).
//
// What this script proves:
//   1. deleteOrganizationCascade removes EVERY row referencing the deleted org
//      across all FK tables (zero orphans).
//   2. The operation is transactional — a mid-flight failure rolls back
//      (Postgres-guaranteed; not re-tested here but you can simulate by
//      killing the connection during the call).
//   3. A user who belongs to TWO orgs keeps their mailbox + passwordHash
//      when ONE of their orgs is deleted.
//   4. A user who belongs to ONLY the deleted org has their mailbox removed
//      AND their passwordHash nulled.
//
// Cleanup strategy: we seed with predictable UUIDs and clean up in `finally`
// regardless of pass/fail. The script does NOT run inside an outer transaction
// because deleteOrganizationCascade opens its own; nesting via savepoints adds
// no extra safety and complicates assertion queries.
//
// IMPORTANT: Run on a DB snapshot first per STATE.md blockers. Never against
// production. The script aborts if any of the sentinel UUIDs already exist.

import 'dotenv/config'
import { db, queryClient } from '../src/db'
import {
    users,
    organizations,
    organizationUsers,
    domains,
    credentials,
    webhooks,
    webhookRequests,
    outlookMailboxes,
    leadLists,
    leads,
    campaigns,
    sequences,
    sequenceSteps,
    campaignLeads,
    emailAccounts,
    outreachEmails,
    outreachAnalytics,
    routes,
    smtpEndpoints,
    httpEndpoints,
    addressEndpoints,
    deliveries,
    messages,
    templates,
    trackDomains,
    suppressions,
    statistics,
    mailboxes,
    mailFolders,
    mailMessages,
    mailFilters,
    signatures,
    contacts,
    userNotifications,
} from '../src/db/schema'
import { eq, or, inArray } from 'drizzle-orm'
import { deleteOrganizationCascade } from '../src/server/lib/cascade'

// Sentinel UUIDs — all start with "cccccccc-" so they are easy to grep / drop.
const SENTINEL_PREFIX = 'cccccccc'
const ORG_KEEP_ID = `${SENTINEL_PREFIX}-0000-0000-0000-000000000001`
const ORG_DELETE_ID = `${SENTINEL_PREFIX}-0000-0000-0000-000000000002`
const USER_MULTI_ID = `${SENTINEL_PREFIX}-0000-0000-0000-000000000003`
const USER_SOLO_ID = `${SENTINEL_PREFIX}-0000-0000-0000-000000000004`
const SENTINEL_PASSWORD_HASH = 'sentinel-hash-do-not-use'

const failures: string[] = []

function assert(cond: unknown, msg: string) {
    if (!cond) {
        failures.push(msg)
        console.error('FAIL:', msg)
    } else {
        console.log('  ok:', msg)
    }
}

async function preflightCheckClean() {
    const collisions = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, [USER_MULTI_ID, USER_SOLO_ID]))
    if (collisions.length > 0) {
        throw new Error(
            `Sentinel UUIDs already exist in DB (${collisions.length} collisions). ` +
                `Aborting to avoid clobbering real data. Run cleanup() manually or pick fresh UUIDs.`,
        )
    }
}

async function cleanup() {
    // Best-effort. Order matters because of FKs.
    try {
        // Outreach leaves
        await db.delete(outreachEmails).where(or(
            eq(outreachEmails.organizationId, ORG_KEEP_ID),
            eq(outreachEmails.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(outreachAnalytics).where(or(
            eq(outreachAnalytics.organizationId, ORG_KEEP_ID),
            eq(outreachAnalytics.organizationId, ORG_DELETE_ID),
        ))
        const camps = await db
            .select({ id: campaigns.id })
            .from(campaigns)
            .where(or(
                eq(campaigns.organizationId, ORG_KEEP_ID),
                eq(campaigns.organizationId, ORG_DELETE_ID),
            ))
        const campIds = camps.map((c) => c.id)
        if (campIds.length > 0) {
            await db.delete(campaignLeads).where(inArray(campaignLeads.campaignId, campIds))
            const seqs = await db.select({ id: sequences.id }).from(sequences).where(inArray(sequences.campaignId, campIds))
            const seqIds = seqs.map((s) => s.id)
            if (seqIds.length > 0) {
                await db.delete(sequenceSteps).where(inArray(sequenceSteps.sequenceId, seqIds))
                await db.delete(sequences).where(inArray(sequences.id, seqIds))
            }
        }
        await db.delete(campaigns).where(or(
            eq(campaigns.organizationId, ORG_KEEP_ID),
            eq(campaigns.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(leads).where(or(
            eq(leads.organizationId, ORG_KEEP_ID),
            eq(leads.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(leadLists).where(or(
            eq(leadLists.organizationId, ORG_KEEP_ID),
            eq(leadLists.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(emailAccounts).where(or(
            eq(emailAccounts.organizationId, ORG_KEEP_ID),
            eq(emailAccounts.organizationId, ORG_DELETE_ID),
        ))

        await db.delete(outlookMailboxes).where(or(
            eq(outlookMailboxes.organizationId, ORG_KEEP_ID),
            eq(outlookMailboxes.organizationId, ORG_DELETE_ID),
        ))

        const wks = await db
            .select({ id: webhooks.id })
            .from(webhooks)
            .where(or(
                eq(webhooks.organizationId, ORG_KEEP_ID),
                eq(webhooks.organizationId, ORG_DELETE_ID),
            ))
        const wkIds = wks.map((w) => w.id)
        if (wkIds.length > 0) {
            await db.delete(webhookRequests).where(inArray(webhookRequests.webhookId, wkIds))
        }
        await db.delete(webhooks).where(or(
            eq(webhooks.organizationId, ORG_KEEP_ID),
            eq(webhooks.organizationId, ORG_DELETE_ID),
        ))

        await db.delete(templates).where(or(
            eq(templates.organizationId, ORG_KEEP_ID),
            eq(templates.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(trackDomains).where(or(
            eq(trackDomains.organizationId, ORG_KEEP_ID),
            eq(trackDomains.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(suppressions).where(or(
            eq(suppressions.organizationId, ORG_KEEP_ID),
            eq(suppressions.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(statistics).where(or(
            eq(statistics.organizationId, ORG_KEEP_ID),
            eq(statistics.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(deliveries).where(or(
            eq(deliveries.organizationId, ORG_KEEP_ID),
            eq(deliveries.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(messages).where(or(
            eq(messages.organizationId, ORG_KEEP_ID),
            eq(messages.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(routes).where(or(
            eq(routes.organizationId, ORG_KEEP_ID),
            eq(routes.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(domains).where(or(
            eq(domains.organizationId, ORG_KEEP_ID),
            eq(domains.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(credentials).where(or(
            eq(credentials.organizationId, ORG_KEEP_ID),
            eq(credentials.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(smtpEndpoints).where(or(
            eq(smtpEndpoints.organizationId, ORG_KEEP_ID),
            eq(smtpEndpoints.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(httpEndpoints).where(or(
            eq(httpEndpoints.organizationId, ORG_KEEP_ID),
            eq(httpEndpoints.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(addressEndpoints).where(or(
            eq(addressEndpoints.organizationId, ORG_KEEP_ID),
            eq(addressEndpoints.organizationId, ORG_DELETE_ID),
        ))

        // Per-user mail rows
        const mboxes = await db
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(inArray(mailboxes.userId, [USER_MULTI_ID, USER_SOLO_ID]))
        const mboxIds = mboxes.map((m) => m.id)
        if (mboxIds.length > 0) {
            await db.delete(mailMessages).where(inArray(mailMessages.mailboxId, mboxIds))
            await db.delete(mailFolders).where(inArray(mailFolders.mailboxId, mboxIds))
            await db.delete(mailFilters).where(inArray(mailFilters.mailboxId, mboxIds))
            await db.delete(signatures).where(inArray(signatures.mailboxId, mboxIds))
            await db.delete(mailboxes).where(inArray(mailboxes.id, mboxIds))
        }
        await db.delete(contacts).where(inArray(contacts.userId, [USER_MULTI_ID, USER_SOLO_ID]))
        await db.delete(userNotifications).where(inArray(userNotifications.userId, [USER_MULTI_ID, USER_SOLO_ID]))

        await db.delete(organizationUsers).where(or(
            eq(organizationUsers.organizationId, ORG_KEEP_ID),
            eq(organizationUsers.organizationId, ORG_DELETE_ID),
        ))
        await db.delete(organizations).where(or(
            eq(organizations.id, ORG_KEEP_ID),
            eq(organizations.id, ORG_DELETE_ID),
        ))
        await db.delete(users).where(inArray(users.id, [USER_MULTI_ID, USER_SOLO_ID]))
    } catch (err) {
        console.warn('[cleanup] non-fatal error during cleanup:', (err as Error).message)
    }
}

async function seed() {
    console.log('Seeding fixtures...')

    // Users (owners + members). organizations.owner_id requires a real user FK.
    await db.insert(users).values([
        {
            id: USER_MULTI_ID,
            email: `multi-${SENTINEL_PREFIX}@cascade-test.local`,
            passwordHash: SENTINEL_PASSWORD_HASH,
            isAdmin: false,
        },
        {
            id: USER_SOLO_ID,
            email: `solo-${SENTINEL_PREFIX}@cascade-test.local`,
            passwordHash: SENTINEL_PASSWORD_HASH,
            isAdmin: false,
        },
    ])

    // Two organisations.
    await db.insert(organizations).values([
        { id: ORG_KEEP_ID, name: 'KeepOrg', slug: `keep-${SENTINEL_PREFIX}`, owner_id: USER_MULTI_ID },
        { id: ORG_DELETE_ID, name: 'DeleteOrg', slug: `del-${SENTINEL_PREFIX}`, owner_id: USER_MULTI_ID },
    ])

    // Memberships: userMulti in BOTH orgs; userSolo only in orgDelete.
    await db.insert(organizationUsers).values([
        { organizationId: ORG_KEEP_ID, userId: USER_MULTI_ID, role: 'admin' },
        { organizationId: ORG_DELETE_ID, userId: USER_MULTI_ID, role: 'admin' },
        { organizationId: ORG_DELETE_ID, userId: USER_SOLO_ID, role: 'member' },
    ])

    // Org-scoped resources in orgDelete.
    const [dom] = await db.insert(domains).values({
        organizationId: ORG_DELETE_ID,
        name: 'cascade-test.example',
    }).returning({ id: domains.id })
    void dom

    await db.insert(credentials).values({
        organizationId: ORG_DELETE_ID,
        name: 'cascade-cred',
        type: 'smtp',
        key: 'k-cascade',
    })

    const [wk] = await db.insert(webhooks).values({
        organizationId: ORG_DELETE_ID,
        name: 'cascade-wh',
        url: 'https://example.com/hook',
        events: ['test'],
    }).returning({ id: webhooks.id })

    await db.insert(webhookRequests).values({
        webhookId: wk.id,
        event: 'test',
        payload: { hello: 'world' },
        success: false,
    })

    await db.insert(outlookMailboxes).values({
        organizationId: ORG_DELETE_ID,
        email: `out-${SENTINEL_PREFIX}@cascade-test.local`,
        microsoftUserId: `ms-${SENTINEL_PREFIX}`,
        accessTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: new Date(Date.now() + 3600_000),
    })

    const [ll] = await db.insert(leadLists).values({
        organizationId: ORG_DELETE_ID,
        name: 'cascade-list',
    }).returning({ id: leadLists.id })

    await db.insert(leads).values({
        organizationId: ORG_DELETE_ID,
        email: `lead-${SENTINEL_PREFIX}@cascade-test.local`,
        leadListId: ll.id,
    })

    const [camp] = await db.insert(campaigns).values({
        organizationId: ORG_DELETE_ID,
        name: 'cascade-campaign',
    }).returning({ id: campaigns.id })

    const [seq] = await db.insert(sequences).values({
        campaignId: camp.id,
        name: 'cascade-seq',
    }).returning({ id: sequences.id })

    await db.insert(sequenceSteps).values({
        sequenceId: seq.id,
        stepOrder: 1,
        type: 'email',
        subject: 'Hello',
    })

    // Mailboxes are user-scoped (NOT org-scoped) in this schema.
    // userMulti gets a mailbox (must SURVIVE because they remain a member of orgKeep).
    const [mboxMulti] = await db.insert(mailboxes).values({
        userId: USER_MULTI_ID,
        email: `mbox-multi-${SENTINEL_PREFIX}@cascade-test.local`,
        smtpHost: 'localhost',
        smtpUsername: 'm',
        smtpPasswordEncrypted: 'enc',
        imapHost: 'localhost',
        imapUsername: 'm',
        imapPasswordEncrypted: 'enc',
    }).returning({ id: mailboxes.id })

    await db.insert(mailFolders).values({
        mailboxId: mboxMulti.id,
        remoteId: 'INBOX',
        name: 'INBOX',
        type: 'inbox',
    })

    // userSolo also gets a mailbox + folder + message — these SHOULD be removed.
    const [mboxSolo] = await db.insert(mailboxes).values({
        userId: USER_SOLO_ID,
        email: `mbox-solo-${SENTINEL_PREFIX}@cascade-test.local`,
        smtpHost: 'localhost',
        smtpUsername: 's',
        smtpPasswordEncrypted: 'enc',
        imapHost: 'localhost',
        imapUsername: 's',
        imapPasswordEncrypted: 'enc',
    }).returning({ id: mailboxes.id })

    const [folder] = await db.insert(mailFolders).values({
        mailboxId: mboxSolo.id,
        remoteId: 'INBOX',
        name: 'INBOX',
        type: 'inbox',
    }).returning({ id: mailFolders.id })

    await db.insert(mailMessages).values({
        mailboxId: mboxSolo.id,
        folderId: folder.id,
        subject: 'cascade test',
        remoteUid: 1,
    })

    await db.insert(userNotifications).values({
        userId: USER_SOLO_ID,
        type: 'test',
        title: 'cascade',
        message: 'should be deleted',
    })

    console.log('Seed complete.\n')
}

async function runAssertions() {
    console.log('Running assertions...')

    // ----- A) Org-scoped tables for orgDelete should be empty -----
    type TableWithOrg = { name: string; rowsForOrg: () => Promise<{ count: number }> }
    const orgScopedChecks: TableWithOrg[] = [
        { name: 'domains', rowsForOrg: async () => ({ count: (await db.select().from(domains).where(eq(domains.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'credentials', rowsForOrg: async () => ({ count: (await db.select().from(credentials).where(eq(credentials.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'webhooks', rowsForOrg: async () => ({ count: (await db.select().from(webhooks).where(eq(webhooks.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'outlook_mailboxes', rowsForOrg: async () => ({ count: (await db.select().from(outlookMailboxes).where(eq(outlookMailboxes.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'leads', rowsForOrg: async () => ({ count: (await db.select().from(leads).where(eq(leads.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'lead_lists', rowsForOrg: async () => ({ count: (await db.select().from(leadLists).where(eq(leadLists.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'campaigns', rowsForOrg: async () => ({ count: (await db.select().from(campaigns).where(eq(campaigns.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'email_accounts', rowsForOrg: async () => ({ count: (await db.select().from(emailAccounts).where(eq(emailAccounts.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'outreach_emails', rowsForOrg: async () => ({ count: (await db.select().from(outreachEmails).where(eq(outreachEmails.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'outreach_analytics', rowsForOrg: async () => ({ count: (await db.select().from(outreachAnalytics).where(eq(outreachAnalytics.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'templates', rowsForOrg: async () => ({ count: (await db.select().from(templates).where(eq(templates.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'track_domains', rowsForOrg: async () => ({ count: (await db.select().from(trackDomains).where(eq(trackDomains.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'suppressions', rowsForOrg: async () => ({ count: (await db.select().from(suppressions).where(eq(suppressions.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'statistics', rowsForOrg: async () => ({ count: (await db.select().from(statistics).where(eq(statistics.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'deliveries', rowsForOrg: async () => ({ count: (await db.select().from(deliveries).where(eq(deliveries.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'messages', rowsForOrg: async () => ({ count: (await db.select().from(messages).where(eq(messages.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'routes', rowsForOrg: async () => ({ count: (await db.select().from(routes).where(eq(routes.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'smtp_endpoints', rowsForOrg: async () => ({ count: (await db.select().from(smtpEndpoints).where(eq(smtpEndpoints.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'http_endpoints', rowsForOrg: async () => ({ count: (await db.select().from(httpEndpoints).where(eq(httpEndpoints.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'address_endpoints', rowsForOrg: async () => ({ count: (await db.select().from(addressEndpoints).where(eq(addressEndpoints.organizationId, ORG_DELETE_ID))).length }) },
        { name: 'organization_users', rowsForOrg: async () => ({ count: (await db.select().from(organizationUsers).where(eq(organizationUsers.organizationId, ORG_DELETE_ID))).length }) },
    ]
    for (const t of orgScopedChecks) {
        const { count } = await t.rowsForOrg()
        assert(count === 0, `orgDelete: zero rows in ${t.name} (got ${count})`)
    }

    // ----- B) Org row itself gone -----
    const orgDelRow = await db.select().from(organizations).where(eq(organizations.id, ORG_DELETE_ID))
    assert(orgDelRow.length === 0, 'orgDelete row deleted from organizations')

    // ----- C) orgKeep untouched -----
    const orgKeepRow = await db.select().from(organizations).where(eq(organizations.id, ORG_KEEP_ID))
    assert(orgKeepRow.length === 1, 'orgKeep row still exists')

    const keepMembership = await db.select().from(organizationUsers).where(eq(organizationUsers.organizationId, ORG_KEEP_ID))
    assert(keepMembership.length === 1 && keepMembership[0].userId === USER_MULTI_ID, 'userMulti still member of orgKeep')

    // ----- D) userMulti preserved -----
    const multiUser = await db.select().from(users).where(eq(users.id, USER_MULTI_ID))
    assert(multiUser.length === 1, 'userMulti row still exists')
    assert(
        multiUser[0]?.passwordHash === SENTINEL_PASSWORD_HASH,
        `userMulti.passwordHash PRESERVED (got "${multiUser[0]?.passwordHash}")`,
    )

    const multiMailbox = await db.select().from(mailboxes).where(eq(mailboxes.userId, USER_MULTI_ID))
    assert(multiMailbox.length === 1, 'userMulti mailbox SURVIVED (cross-org user)')

    // ----- E) userSolo cleaned up -----
    const soloUser = await db.select().from(users).where(eq(users.id, USER_SOLO_ID))
    assert(soloUser.length === 1, 'userSolo row still exists (we do NOT delete users themselves)')
    assert(
        soloUser[0]?.passwordHash === null,
        `userSolo.passwordHash NULLED (got "${soloUser[0]?.passwordHash}")`,
    )

    const soloMailbox = await db.select().from(mailboxes).where(eq(mailboxes.userId, USER_SOLO_ID))
    assert(soloMailbox.length === 0, 'userSolo mailbox deleted')

    const soloNotifs = await db.select().from(userNotifications).where(eq(userNotifications.userId, USER_SOLO_ID))
    assert(soloNotifs.length === 0, 'userSolo user_notifications deleted')
}

async function main() {
    console.log('=== cascade delete verification — CRIT-01 ===\n')
    try {
        await preflightCheckClean()
        await seed()
        console.log(`Calling deleteOrganizationCascade("${ORG_DELETE_ID}")...\n`)
        await deleteOrganizationCascade(ORG_DELETE_ID)
        console.log('cascade call returned successfully.\n')
        await runAssertions()
    } finally {
        console.log('\nCleaning up sentinel data...')
        await cleanup()
        await queryClient.end({ timeout: 5 })
    }

    if (failures.length > 0) {
        console.error(`\n${failures.length} assertion(s) FAILED:`)
        for (const f of failures) console.error(' -', f)
        process.exit(1)
    }
    console.log('\nOK — all assertions passed.')
    process.exit(0)
}

main().catch((err) => {
    console.error('FATAL:', err)
    process.exit(1)
})
