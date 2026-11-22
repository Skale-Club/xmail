/**
 * Drizzle implementation of ProvisioningStore (see microsite-provisioning.ts for the rules).
 *
 * Convergence under concurrency:
 *  - domains has no unique constraint on name, so domain creation runs in a transaction holding a
 *    per-name advisory lock; the second caller waits, sees the row and reports `created: false`.
 *  - microsite_mail_domains.domain, users.email, the native-mailbox unique index (migration 026),
 *    the folder unique index and mailbox_delegates(mailbox_id, user_id) make every other step an
 *    ON CONFLICT DO NOTHING upsert.
 * No password is ever generated or stored: the mailbox user has a null password_hash, so
 * authenticateNativeUser (SMTP/IMAP) rejects it and nobody can sign in as it.
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../../db'
import {
    domains,
    mailboxDelegates,
    mailboxes,
    mailFolders,
    mailMessages,
    micrositeMailDomains,
    micrositeProvisioningAudit,
    organizationUsers,
    users,
} from '../../db/schema'
import { DEFAULT_DKIM_SELECTOR, generateDkimKeyPair } from './domain-dns'
import { createUserMailbox } from './native-mail'
import { addMicrositeProtectedDomain, setMicrositeProtectedDomains } from './microsite-protected-domains'
import {
    ProvisioningError,
    type DomainRecord,
    type ProvisioningStore,
} from './microsite-provisioning'

type DomainRow = typeof domains.$inferSelect

function toRecord(row: DomainRow): DomainRecord {
    return {
        id: row.id,
        organizationId: row.organizationId,
        name: row.name,
        verificationToken: row.verificationToken,
        dkimSelector: row.dkimSelector,
        dkimPublicKey: row.dkimPublicKey,
        verificationStatus: row.verificationStatus,
        mxStatus: row.mxStatus,
        spfStatus: row.spfStatus,
        dkimStatus: row.dkimStatus,
        dmarcStatus: row.dmarcStatus,
    }
}

/** Load the provisioned microsite domains into the in-memory sending-guard set. */
export async function refreshMicrositeProtectedDomains(): Promise<number> {
    const rows = await db.select({ domain: micrositeMailDomains.domain }).from(micrositeMailDomains)
    setMicrositeProtectedDomains(rows.map((r) => r.domain))
    return rows.length
}

/**
 * Keep the guard set fresh. Runs at boot and every five minutes; a failure is logged and the
 * previous set stays in force (it only ever grows between refreshes, via the provisioning calls).
 */
export function startMicrositeProtectedDomainRefresh(intervalMs = 5 * 60 * 1000): () => void {
    const run = () => refreshMicrositeProtectedDomains().catch((error) => {
        console.error('[provisioning] protected-domain refresh failed:', error instanceof Error ? error.message : 'unknown')
    })
    void run()
    const timer = setInterval(run, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
}

export function createDrizzleProvisioningStore(): ProvisioningStore {
    return {
        async lookupDomain(name, organizationId) {
            const rows = await db.select().from(domains).where(eq(domains.name, name))
            if (rows.length === 0) return { kind: 'none' }
            const own = rows.find((row) => row.organizationId === organizationId)
            if (!own) return { kind: 'foreign' }
            const site = await db.query.micrositeMailDomains.findFirst({
                where: eq(micrositeMailDomains.domain, name),
                columns: { siteRef: true, organizationId: true },
            })
            return {
                kind: 'own',
                domain: toRecord(own),
                siteRef: site && site.organizationId === organizationId ? site.siteRef : null,
            }
        },

        async ensureDomain({ name, organizationId, siteRef }) {
            return db.transaction(async (tx) => {
                await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`xmail:provisioning:domain:${name}`}))`)
                const rows = await tx.select().from(domains).where(eq(domains.name, name))
                let row = rows.find((r) => r.organizationId === organizationId)
                if (!row && rows.length > 0) return { kind: 'foreign' as const }

                let created = false
                if (!row) {
                    const { privateKey, publicKey } = generateDkimKeyPair()
                    const [inserted] = await tx.insert(domains).values({
                        organizationId,
                        name,
                        verificationMethod: 'dns',
                        verificationToken: uuidv4(),
                        dkimSelector: DEFAULT_DKIM_SELECTOR,
                        dkimPrivateKey: privateKey,
                        dkimPublicKey: publicKey,
                    }).returning()
                    row = inserted
                    created = true
                }

                await tx.insert(micrositeMailDomains).values({
                    domain: name,
                    organizationId,
                    domainId: row.id,
                    siteRef,
                }).onConflictDoUpdate({
                    target: micrositeMailDomains.domain,
                    set: { domainId: row.id, siteRef, updatedAt: new Date() },
                    setWhere: eq(micrositeMailDomains.organizationId, organizationId),
                })
                return { kind: 'ok' as const, domain: toRecord(row), created }
            })
        },

        async ensureMailbox({ domain, address, organizationId, delegateUserIds }) {
            // 1. The mailbox user: no password, never admin. A pre-existing login-capable or
            //    admin account with this address is not adopted.
            await db.insert(users).values({
                email: address,
                firstName: 'Info',
                lastName: domain.name,
                passwordHash: null,
                isAdmin: false,
                emailVerified: true,
            }).onConflictDoNothing()
            const owner = await db.query.users.findFirst({ where: eq(users.email, address) })
            if (!owner) throw new Error('mailbox user missing after upsert')
            if (owner.passwordHash || owner.isAdmin) throw new ProvisioningError(409, 'mailbox_user_conflict')

            // 2. Membership in the bound organization ("Owned Microsites"): this is what groups the
            //    mailbox in the delegates' webmail (classifyMailboxes uses the owner's org name).
            await db.insert(organizationUsers).values({
                organizationId,
                userId: owner.id,
                role: 'viewer',
            }).onConflictDoNothing()

            // 3. Native mailbox + default folders (idempotent, race-safe).
            const before = await db.query.mailboxes.findFirst({
                where: and(eq(mailboxes.userId, owner.id), eq(mailboxes.email, address), eq(mailboxes.isNative, true)),
                columns: { id: true },
            })
            const mailboxId = await createUserMailbox(owner.id, address)
            if (!mailboxId) throw new Error('native mailbox missing after create')

            // 4. Delegates: the env list is the source of truth; unknown user ids are skipped and
            //    revoked grants are pruned.
            const existingUsers = delegateUserIds.length === 0
                ? []
                : await db.select({ id: users.id }).from(users).where(inArray(users.id, delegateUserIds))
            const validIds = existingUsers.map((u) => u.id)
            if (validIds.length > 0) {
                await db.insert(mailboxDelegates)
                    .values(validIds.map((userId) => ({ mailboxId, userId })))
                    .onConflictDoNothing()
                await db.delete(mailboxDelegates).where(and(
                    eq(mailboxDelegates.mailboxId, mailboxId),
                    notInArray(mailboxDelegates.userId, validIds),
                ))
            } else {
                await db.delete(mailboxDelegates).where(eq(mailboxDelegates.mailboxId, mailboxId))
            }

            await db.update(micrositeMailDomains)
                .set({ mailboxId, mailboxUserId: owner.id, updatedAt: new Date() })
                .where(and(eq(micrositeMailDomains.domain, domain.name), eq(micrositeMailDomains.organizationId, organizationId)))

            return {
                mailboxId,
                created: !before,
                delegatesGranted: validIds.length,
                delegatesSkipped: delegateUserIds.length - validIds.length,
            }
        },

        async readMailboxState(address) {
            const mailbox = await db.query.mailboxes.findFirst({
                where: and(eq(mailboxes.email, address), eq(mailboxes.isNative, true)),
                columns: { id: true, isActive: true },
            })
            if (!mailbox) return null
            const [stats] = await db
                .select({
                    count: sql<number>`count(*)::int`,
                    last: sql<Date | null>`max(${mailMessages.receivedAt})`,
                })
                .from(mailMessages)
                .innerJoin(mailFolders, eq(mailFolders.id, mailMessages.folderId))
                .where(and(
                    eq(mailMessages.mailboxId, mailbox.id),
                    // Inbound only: anything outside the sent and drafts folders came in over MX.
                    sql`${mailFolders.type} NOT IN ('sent', 'drafts')`,
                ))
            return {
                mailboxId: mailbox.id,
                isActive: mailbox.isActive,
                messageCount: stats?.count ?? 0,
                lastInboundAt: stats?.last ? new Date(stats.last) : null,
            }
        },

        async saveVerification(domainId, update) {
            const [row] = await db.update(domains)
                .set({ ...update, updatedAt: new Date() })
                .where(eq(domains.id, domainId))
                .returning()
            return toRecord(row)
        },

        registerProtectedDomain(name) {
            addMicrositeProtectedDomain(name)
        },

        async audit(entry) {
            try {
                await db.insert(micrositeProvisioningAudit).values({
                    action: entry.action,
                    domain: entry.domain,
                    siteRef: entry.siteRef,
                    outcome: entry.outcome,
                    detail: entry.detail ?? {},
                })
            } catch (error) {
                // Audit must not turn a successful, idempotent write into an error the caller retries.
                console.error('[provisioning] audit write failed:', error instanceof Error ? error.message : 'unknown')
            }
        },
    }
}
