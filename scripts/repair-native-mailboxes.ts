import 'dotenv/config'
import { eq, and, sql } from 'drizzle-orm'
import { db } from '../src/db/index'
import { users, mailboxes, mailFolders, mailMessages, mailFilters, signatures } from '../src/db/schema'
import { recomputeFolderCounts } from '../src/server/lib/folder-counts'
import { createUserMailbox, deleteMailboxById } from '../src/server/lib/native-mail'

const APPLY = process.argv.includes('--apply')
const ENFORCE_INDEX = process.argv.includes('--enforce-index')

type DbUser = typeof users.$inferSelect
type DbMailbox = typeof mailboxes.$inferSelect
type DbFolder = typeof mailFolders.$inferSelect
type DbMessage = typeof mailMessages.$inferSelect

function normalizeEmail(email: string | null | undefined) {
    return (email || '').trim().toLowerCase()
}

function describeMailbox(mailbox: DbMailbox, ownerEmail: string | null | undefined) {
    const flags = [
        mailbox.isDefault ? 'default' : null,
        mailbox.isActive ? 'active' : 'inactive',
        mailbox.isNative ? 'native' : 'external',
    ].filter(Boolean).join(', ')

    return `${mailbox.email} [mailbox=${mailbox.id}] owner=${ownerEmail || mailbox.userId} (${flags})`
}

async function ensureCanonicalMailbox(owner: DbUser): Promise<DbMailbox | null> {
    let canonical = await db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.userId, owner.id),
            eq(mailboxes.email, normalizeEmail(owner.email)),
            eq(mailboxes.isNative, true)
        ),
    })

    if (!canonical && APPLY) {
        await createUserMailbox(owner.id, owner.email)
        canonical = await db.query.mailboxes.findFirst({
            where: and(
                eq(mailboxes.userId, owner.id),
                eq(mailboxes.email, normalizeEmail(owner.email)),
                eq(mailboxes.isNative, true)
            ),
        })
    }

    return canonical || null
}

async function ensureFolderMap(duplicateMailboxId: string, canonicalMailboxId: string) {
    const [duplicateFolders, canonicalFolders] = await Promise.all([
        db.query.mailFolders.findMany({
            where: eq(mailFolders.mailboxId, duplicateMailboxId),
        }),
        db.query.mailFolders.findMany({
            where: eq(mailFolders.mailboxId, canonicalMailboxId),
        }),
    ])

    const byRemoteId = new Map(canonicalFolders.map(folder => [folder.remoteId, folder]))
    const byType = new Map(canonicalFolders.map(folder => [folder.type, folder]))
    const folderMap = new Map<string, string>()
    const touchedDestinationFolderIds = new Set<string>()

    for (const duplicateFolder of duplicateFolders) {
        let destination = byRemoteId.get(duplicateFolder.remoteId) || byType.get(duplicateFolder.type)

        if (!destination) {
            const [created] = await db.insert(mailFolders).values({
                mailboxId: canonicalMailboxId,
                remoteId: duplicateFolder.remoteId,
                name: duplicateFolder.name,
                type: duplicateFolder.type,
                unreadCount: 0,
                totalCount: 0,
                uidValidity: duplicateFolder.uidValidity,
                uidNext: duplicateFolder.uidNext,
            }).returning()

            destination = created
            byRemoteId.set(created.remoteId, created)
            byType.set(created.type, created)
        }

        folderMap.set(duplicateFolder.id, destination.id)
        touchedDestinationFolderIds.add(destination.id)
    }

    return { folderMap, touchedDestinationFolderIds }
}

async function moveMessages(duplicateMailboxId: string, canonicalMailboxId: string, folderMap: Map<string, string>) {
    const [duplicateMessages, canonicalMessages] = await Promise.all([
        db.query.mailMessages.findMany({
            where: eq(mailMessages.mailboxId, duplicateMailboxId),
        }),
        db.query.mailMessages.findMany({
            where: eq(mailMessages.mailboxId, canonicalMailboxId),
            columns: {
                id: true,
                remoteUid: true,
            },
        }),
    ])

    const existingRemoteUids = new Set(
        canonicalMessages
            .map(message => message.remoteUid)
            .filter((uid): uid is number => uid !== null)
    )

    for (const message of duplicateMessages) {
        const nextFolderId = folderMap.get(message.folderId)
        if (!nextFolderId) {
            throw new Error(`Missing destination folder for message ${message.id}`)
        }

        const nextRemoteUid = message.remoteUid !== null && existingRemoteUids.has(message.remoteUid)
            ? null
            : message.remoteUid

        if (nextRemoteUid !== null) {
            existingRemoteUids.add(nextRemoteUid)
        }

        await db.update(mailMessages)
            .set({
                mailboxId: canonicalMailboxId,
                folderId: nextFolderId,
                remoteUid: nextRemoteUid,
                updatedAt: new Date(),
            })
            .where(eq(mailMessages.id, message.id))
    }

    return duplicateMessages.length
}

async function moveMailboxSettings(duplicateMailboxId: string, canonicalMailboxId: string) {
    await db.update(mailFilters)
        .set({
            mailboxId: canonicalMailboxId,
            updatedAt: new Date(),
        })
        .where(eq(mailFilters.mailboxId, duplicateMailboxId))

    const canonicalHasDefaultSignature = await db.query.signatures.findFirst({
        where: and(
            eq(signatures.mailboxId, canonicalMailboxId),
            eq(signatures.isDefault, true)
        ),
    })

    const duplicateSignatures = await db.query.signatures.findMany({
        where: eq(signatures.mailboxId, duplicateMailboxId),
        orderBy: [sql`${signatures.createdAt} asc`],
    })

    let defaultAlreadyAssigned = Boolean(canonicalHasDefaultSignature)
    for (const signature of duplicateSignatures) {
        const nextIsDefault = signature.isDefault && !defaultAlreadyAssigned
        if (nextIsDefault) {
            defaultAlreadyAssigned = true
        }

        await db.update(signatures)
            .set({
                mailboxId: canonicalMailboxId,
                isDefault: nextIsDefault,
                updatedAt: new Date(),
            })
            .where(eq(signatures.id, signature.id))
    }
}

async function ensureOwnerHasDefaultMailbox(ownerId: string, canonicalMailboxId: string) {
    const existingDefault = await db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.userId, ownerId),
            eq(mailboxes.isDefault, true)
        ),
    })

    if (!existingDefault) {
        await db.update(mailboxes)
            .set({
                isDefault: true,
                updatedAt: new Date(),
            })
            .where(eq(mailboxes.id, canonicalMailboxId))
    }
}

async function enforceUniqueNativeMailboxIndex() {
    await db.execute(sql.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_native_email_unique
        ON mailboxes (lower(email))
        WHERE is_native = true
    `))
}

async function main() {
    const [allUsers, nativeMailboxes] = await Promise.all([
        db.query.users.findMany(),
        db.query.mailboxes.findMany({
            where: eq(mailboxes.isNative, true),
            orderBy: [mailboxes.createdAt],
        }),
    ])

    const usersById = new Map(allUsers.map(user => [user.id, user]))
    const mailboxesByEmail = new Map<string, DbMailbox[]>()

    for (const mailbox of nativeMailboxes) {
        const key = normalizeEmail(mailbox.email)
        const existing = mailboxesByEmail.get(key) || []
        existing.push(mailbox)
        mailboxesByEmail.set(key, existing)
    }

    const issues = [...mailboxesByEmail.entries()]
        .map(([email, groupedMailboxes]) => {
            const owner = allUsers.find(user => !user.isAdmin && normalizeEmail(user.email) === email) || null
            const canonicalMailbox = owner
                ? groupedMailboxes.find(mailbox => mailbox.userId === owner.id) || null
                : null
            const duplicates = owner
                ? groupedMailboxes.filter(mailbox => mailbox.id !== canonicalMailbox?.id)
                : groupedMailboxes

            const hasInvalidOwner = groupedMailboxes.some(mailbox => mailbox.userId !== owner?.id)
            if (!owner || groupedMailboxes.length > 1 || hasInvalidOwner) {
                return { email, owner, canonicalMailbox, duplicates, groupedMailboxes }
            }
            return null
        })
        .filter((issue): issue is NonNullable<typeof issue> => issue !== null)

    console.log(`Native mailbox audit found ${issues.length} issue group(s).`)

    for (const issue of issues) {
        console.log(`\n${issue.email}`)
        console.log(`  owner: ${issue.owner?.email || 'missing'}`)
        console.log(`  mailboxes:`)
        for (const mailbox of issue.groupedMailboxes) {
            console.log(`    - ${describeMailbox(mailbox, usersById.get(mailbox.userId)?.email)}`)
        }
    }

    if (!APPLY) {
        console.log('\nDry run only. Re-run with --apply to repair and --enforce-index to add the unique index.')
        return
    }

    for (const issue of issues) {
        if (!issue.owner) {
            console.warn(`Skipping ${issue.email}: no non-admin owner exists for this native mailbox.`)
            continue
        }

        const canonicalMailbox = await ensureCanonicalMailbox(issue.owner)
        if (!canonicalMailbox) {
            console.warn(`Skipping ${issue.email}: could not create or locate the canonical mailbox.`)
            continue
        }

        const duplicates = issue.groupedMailboxes.filter(mailbox => mailbox.id !== canonicalMailbox.id)
        for (const duplicate of duplicates) {
            console.log(`\nRepairing ${describeMailbox(duplicate, usersById.get(duplicate.userId)?.email)}`)
            const { folderMap, touchedDestinationFolderIds } = await ensureFolderMap(duplicate.id, canonicalMailbox.id)
            const movedMessages = await moveMessages(duplicate.id, canonicalMailbox.id, folderMap)
            await moveMailboxSettings(duplicate.id, canonicalMailbox.id)
            await deleteMailboxById(duplicate.id)

            for (const folderId of touchedDestinationFolderIds) {
                await recomputeFolderCounts(folderId)
            }

            console.log(`  moved ${movedMessages} message(s) into canonical mailbox ${canonicalMailbox.id}`)
        }

        await ensureOwnerHasDefaultMailbox(issue.owner.id, canonicalMailbox.id)
    }

    if (ENFORCE_INDEX) {
        await enforceUniqueNativeMailboxIndex()
        console.log('\nUnique native mailbox index is in place.')
    }

    console.log('\nRepair complete.')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
