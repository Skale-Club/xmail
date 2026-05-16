import { db } from '../../db'
import {
    // Outreach (org-scoped + parent-scoped leaves)
    outreachEmails,
    outreachAnalytics,
    campaignLeads,
    sequenceSteps,
    sequences,
    campaigns,
    leads,
    leadLists,
    emailAccounts,
    // Outlook mailboxes (org-scoped)
    outlookMailboxes,
    // Routing / messages
    deliveries,
    messages,
    webhookRequests,
    webhooks,
    credentials,
    routes,
    smtpEndpoints,
    httpEndpoints,
    addressEndpoints,
    domains,
    // Templates / tracking
    templates,
    trackDomains,
    suppressions,
    statistics,
    // User-scoped (mail module — NOT org-scoped, cleaned up per-user when user has no remaining orgs)
    mailboxes,
    mailFolders,
    mailMessages,
    mailFilters,
    signatures,
    contacts,
    userNotifications,
    // Membership + org + users
    organizationUsers,
    organizations,
    users,
} from '../../db/schema'
import { eq, inArray, ne, and } from 'drizzle-orm'

/**
 * Delete an organisation and EVERY row that references it, atomically.
 *
 * Requirement: CRIT-01 (see ROADMAP.md / .planning/debug/system-wide-audit-2026-05-16.md).
 *
 * Contract:
 *   1. Runs inside a single `db.transaction` — killing the connection mid-call
 *      leaves zero partial state (Postgres rolls back).
 *   2. Deletes are performed leaf-first to respect FK dependencies.
 *   3. Org-scoped tables: deleted via `eq(table.organizationId, organizationId)`.
 *   4. Parent-scoped tables (sequences/sequenceSteps/campaignLeads): rows are
 *      collected via parent IDs (campaign/sequence) then deleted with `inArray`.
 *   5. User-scoped tables (mailboxes, mail_folders, mail_messages, mail_filters,
 *      signatures, contacts, user_notifications): only touched for a member when
 *      the deleted org was their LAST organisation. Users still in another org
 *      keep their mailbox AND `passwordHash` untouched.
 *
 * Notes about schema vs. the audit's original table list:
 *   - `mailboxes` is keyed by `userId` (not `organizationId`); it is therefore
 *     handled in the per-user cleanup pass, not as an org-scoped delete.
 *   - `user_notifications` likewise has only `userId`; same per-user policy.
 *   - `sequences`, `sequence_steps`, and `campaign_leads` have no
 *     `organizationId` column — they are deleted via their parent FK chains.
 */
export async function deleteOrganizationCascade(organizationId: string): Promise<void> {
    await db.transaction(async (tx) => {
        // 1. Collect members BEFORE we drop organization_users so we can decide
        //    later whether each user still belongs to another org.
        const members = await tx
            .select({ userId: organizationUsers.userId })
            .from(organizationUsers)
            .where(eq(organizationUsers.organizationId, organizationId))
        const memberIds = members.map((m) => m.userId)

        // 2. Outreach module — leaves first.
        //    outreach_emails has organizationId → safe direct delete.
        await tx.delete(outreachEmails).where(eq(outreachEmails.organizationId, organizationId))
        await tx.delete(outreachAnalytics).where(eq(outreachAnalytics.organizationId, organizationId))

        //    Collect campaigns for this org so we can clean up parent-scoped
        //    children (campaign_leads, sequences, sequence_steps).
        const orgCampaigns = await tx
            .select({ id: campaigns.id })
            .from(campaigns)
            .where(eq(campaigns.organizationId, organizationId))
        const campaignIds = orgCampaigns.map((c) => c.id)

        if (campaignIds.length > 0) {
            // campaign_leads → scoped by campaignId
            await tx.delete(campaignLeads).where(inArray(campaignLeads.campaignId, campaignIds))

            // sequences → scoped by campaignId. Collect them to delete their steps first.
            const orgSequences = await tx
                .select({ id: sequences.id })
                .from(sequences)
                .where(inArray(sequences.campaignId, campaignIds))
            const sequenceIds = orgSequences.map((s) => s.id)

            if (sequenceIds.length > 0) {
                await tx.delete(sequenceSteps).where(inArray(sequenceSteps.sequenceId, sequenceIds))
                await tx.delete(sequences).where(inArray(sequences.id, sequenceIds))
            }
        }

        await tx.delete(campaigns).where(eq(campaigns.organizationId, organizationId))
        await tx.delete(leads).where(eq(leads.organizationId, organizationId))
        await tx.delete(leadLists).where(eq(leadLists.organizationId, organizationId))
        await tx.delete(emailAccounts).where(eq(emailAccounts.organizationId, organizationId))

        // 3. Outlook mailboxes (org-scoped).
        await tx.delete(outlookMailboxes).where(eq(outlookMailboxes.organizationId, organizationId))

        // 4. Webhook leaves — webhook_requests references webhooks.id, not org directly.
        const orgWebhooks = await tx
            .select({ id: webhooks.id })
            .from(webhooks)
            .where(eq(webhooks.organizationId, organizationId))
        const webhookIds = orgWebhooks.map((w) => w.id)
        if (webhookIds.length > 0) {
            await tx.delete(webhookRequests).where(inArray(webhookRequests.webhookId, webhookIds))
        }
        await tx.delete(webhooks).where(eq(webhooks.organizationId, organizationId))

        // 5. Templates, tracking, statistics, suppressions.
        await tx.delete(templates).where(eq(templates.organizationId, organizationId))
        await tx.delete(trackDomains).where(eq(trackDomains.organizationId, organizationId))
        await tx.delete(suppressions).where(eq(suppressions.organizationId, organizationId))
        await tx.delete(statistics).where(eq(statistics.organizationId, organizationId))

        // 6. Routing / messages.
        await tx.delete(deliveries).where(eq(deliveries.organizationId, organizationId))
        await tx.delete(messages).where(eq(messages.organizationId, organizationId))
        await tx.delete(routes).where(eq(routes.organizationId, organizationId))
        await tx.delete(domains).where(eq(domains.organizationId, organizationId))
        await tx.delete(credentials).where(eq(credentials.organizationId, organizationId))
        await tx.delete(smtpEndpoints).where(eq(smtpEndpoints.organizationId, organizationId))
        await tx.delete(httpEndpoints).where(eq(httpEndpoints.organizationId, organizationId))
        await tx.delete(addressEndpoints).where(eq(addressEndpoints.organizationId, organizationId))

        // 7. Drop org-side membership rows. Per-user mailbox/passwordHash decisions
        //    happen below using the snapshot we took in step 1.
        await tx.delete(organizationUsers).where(eq(organizationUsers.organizationId, organizationId))

        // 8. For each former member, decide whether they still belong to another org.
        for (const userId of memberIds) {
            const stillMember = await tx
                .select({ id: organizationUsers.id })
                .from(organizationUsers)
                .where(
                    and(
                        eq(organizationUsers.userId, userId),
                        ne(organizationUsers.organizationId, organizationId),
                    ),
                )
                .limit(1)

            if (stillMember.length === 0) {
                // Last org for this user → drop personal data + null the password.
                // mailboxes are user-scoped; collect ids to wipe their children.
                const userMailboxes = await tx
                    .select({ id: mailboxes.id })
                    .from(mailboxes)
                    .where(eq(mailboxes.userId, userId))
                const mboxIds = userMailboxes.map((m) => m.id)

                if (mboxIds.length > 0) {
                    await tx.delete(mailMessages).where(inArray(mailMessages.mailboxId, mboxIds))
                    await tx.delete(mailFolders).where(inArray(mailFolders.mailboxId, mboxIds))
                    await tx.delete(mailFilters).where(inArray(mailFilters.mailboxId, mboxIds))
                    await tx.delete(signatures).where(inArray(signatures.mailboxId, mboxIds))
                    await tx.delete(mailboxes).where(inArray(mailboxes.id, mboxIds))
                }

                await tx.delete(contacts).where(eq(contacts.userId, userId))
                await tx.delete(userNotifications).where(eq(userNotifications.userId, userId))

                await tx.update(users).set({ passwordHash: null }).where(eq(users.id, userId))
            }
            // else: user still belongs to another org → leave mailbox, passwordHash untouched.
        }

        // 9. Finally, the org row itself.
        await tx.delete(organizations).where(eq(organizations.id, organizationId))
    })
}
