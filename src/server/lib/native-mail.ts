/**
 * Shared helpers for the user-as-mailbox model.
 *
 * Every non-admin user on the platform has a native mailbox scoped to their
 * organisation's verified domain. Authentication for SMTP/IMAP uses
 * users.passwordHash (bcrypt) - the same credential used for the web login.
 */

import bcrypt from 'bcrypt'
import { eq, and } from 'drizzle-orm'
import { db } from '../../db'
import { users, domains, mailboxes, mailFolders, mailMessages, mailFilters, signatures } from '../../db/schema'
import { encryptSecret } from './crypto'

const BCRYPT_ROUNDS = 12
// QUA-06 — see audit M11. Gate PII-bearing debug logs behind this flag so production
// logs do not leak user emails / domain dumps. Use !isProd to print in dev only.
const isProd = process.env.NODE_ENV === 'production'

/**
 * Authenticate a user for SMTP/IMAP access.
 * Returns the user record on success, null on failure.
 *
 * Both regular users and platform admins can authenticate via SMTP/IMAP
 * against their own native mailbox — admins still have a native mailbox
 * tied to their email and may use webmail/SMTP/IMAP normally.
 */
export async function authenticateNativeUser(email: string, password: string) {
    const user = await db.query.users.findFirst({
        where: eq(users.email, email.toLowerCase()),
    })

    if (!user || !user.passwordHash) return null

    const valid = await bcrypt.compare(password, user.passwordHash)
    return valid ? user : null
}

/**
 * Hash a plaintext password with bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS)
}

/**
 * Create a native mailbox entry (mailboxes row + default folders) for a user.
 * Safe to call multiple times - checks for an existing native mailbox first.
 */
export async function createUserMailbox(userId: string, _email: string): Promise<string | null> {
    const owner = await db.query.users.findFirst({
        where: eq(users.id, userId),
    })

    if (!owner) {
        return null
    }

    const normalizedEmail = owner.email.toLowerCase()
    const existing = await db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.userId, userId),
            eq(mailboxes.email, normalizedEmail),
            eq(mailboxes.isNative, true)
        ),
    })

    if (existing) return existing.id

    const mailHost = process.env.MAIL_HOST || 'localhost'
    const smtpPort = parseInt(process.env.SMTP_SUBMISSION_PORT || '2587')
    const imapPort = parseInt(process.env.IMAP_PORT || '2993')
    const placeholder = encryptSecret('__NATIVE__')

    const [companion] = await db.insert(mailboxes).values({
        userId,
        email: normalizedEmail,
        smtpHost: mailHost,
        smtpPort,
        smtpUsername: normalizedEmail,
        smtpPasswordEncrypted: placeholder,
        smtpSecure: false,
        imapHost: mailHost,
        imapPort,
        imapUsername: normalizedEmail,
        imapPasswordEncrypted: placeholder,
        imapSecure: false,
        isDefault: true,
        isNative: true,
    }).returning()

    const uidValidity = Math.floor(Date.now() / 1000)
    await db.insert(mailFolders).values([
        { mailboxId: companion.id, remoteId: 'INBOX', name: 'Inbox', type: 'inbox', uidValidity },
        { mailboxId: companion.id, remoteId: 'Sent', name: 'Sent', type: 'sent', uidValidity },
        { mailboxId: companion.id, remoteId: 'Drafts', name: 'Drafts', type: 'drafts', uidValidity },
        { mailboxId: companion.id, remoteId: 'Archive', name: 'Archive', type: 'archive', uidValidity },
        { mailboxId: companion.id, remoteId: 'Trash', name: 'Trash', type: 'trash', uidValidity },
        { mailboxId: companion.id, remoteId: 'Spam', name: 'Spam', type: 'spam', uidValidity },
    ])

    return companion.id
}

export async function deleteMailboxById(mailboxId: string): Promise<void> {
    await db.delete(mailMessages).where(eq(mailMessages.mailboxId, mailboxId))
    await db.delete(mailFilters).where(eq(mailFilters.mailboxId, mailboxId))
    await db.delete(signatures).where(eq(signatures.mailboxId, mailboxId))
    await db.delete(mailFolders).where(eq(mailFolders.mailboxId, mailboxId))
    await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId))
}

/**
 * Delete a user's native mailbox and all its messages/folders.
 */
export async function deleteUserMailbox(userId: string): Promise<void> {
    const owner = await db.query.users.findFirst({
        where: eq(users.id, userId),
    })

    if (!owner) return

    const companion = await db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.userId, userId),
            eq(mailboxes.email, owner.email.toLowerCase()),
            eq(mailboxes.isNative, true)
        ),
    })

    if (!companion) return

    await deleteMailboxById(companion.id)
}

/**
 * Validate that an email's domain matches a verified domain in an organisation.
 */
export async function validateEmailDomainForOrg(email: string, organizationId: string): Promise<boolean> {
    const emailDomain = email.split('@')[1]?.toLowerCase()
    if (!emailDomain) return false

    const verifiedDomain = await db.query.domains.findFirst({
        where: and(
            eq(domains.organizationId, organizationId),
            eq(domains.name, emailDomain),
            eq(domains.verificationStatus, 'verified')
        ),
    })

    return !!verifiedDomain
}

/**
 * Check if an email address belongs to a local (native) user on this server.
 * Returns the user's ID if found, null otherwise.
 */
export async function findLocalUser(email: string): Promise<{ userId: string } | null> {
    const emailDomain = email.split('@')[1]?.toLowerCase()
    if (!emailDomain) {
        if (!isProd) console.log(`[NativeMail] findLocalUser("${email}") → NO DOMAIN PART`)
        return null
    }

    if (!isProd) console.log(`[NativeMail] findLocalUser("${email}") → checking domain "${emailDomain}"...`)

    const verifiedDomain = await db.query.domains.findFirst({
        where: and(
            eq(domains.name, emailDomain),
            eq(domains.verificationStatus, 'verified')
        ),
    })
    if (!verifiedDomain) {
        if (!isProd) {
            // Diagnostic listing — only useful for local dev debugging. The findMany()
            // roundtrip is INSIDE the guard so production never pays for it.
            const allDomains = await db.query.domains.findMany()
            console.log(`[NativeMail] findLocalUser("${email}") → domain "${emailDomain}" NOT VERIFIED`)
            console.log(`[NativeMail]   All domains in DB:`, allDomains.map(d => `${d.name} (status=${d.verificationStatus}, orgId=${d.organizationId})`))
        }
        return null
    }

    if (!isProd) console.log(`[NativeMail] findLocalUser("${email}") → domain "${emailDomain}" VERIFIED (orgId=${verifiedDomain.organizationId})`)

    const user = await db.query.users.findFirst({
        where: eq(users.email, email.toLowerCase()),
    })

    if (!user) {
        if (!isProd) console.log(`[NativeMail] findLocalUser("${email}") → USER NOT FOUND in users table`)
        return null
    }

    if (!isProd) console.log(`[NativeMail] findLocalUser("${email}") → FOUND userId=${user.id} isAdmin=${user.isAdmin}`)
    return { userId: user.id }
}
