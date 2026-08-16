/**
 * Shared native mail send machinery.
 *
 * Extracted from src/server/routes/mail/send.ts (the webmail compose route) so any
 * caller — webmail compose, outreach sender, background jobs — can relay a message
 * through the native mail model (user-as-mailbox, no stored SMTP/IMAP password) and
 * file a copy in a native mailbox's folder without importing a route file.
 *
 * relayMessage() mirrors smtp-server.ts's relay (DKIM-signs using the sender domain's
 * key when one is configured, falls back to unsigned + a warning log otherwise). The
 * previous copy of this function inlined in mail/send.ts did NOT DKIM-sign — that was
 * a gap relative to smtp-server.ts's outbound path. Fixed here during extraction since
 * this lib is now also the outbound path for outreach sending, where deliverability
 * (SPF/DKIM alignment) is critical. See PR description for details.
 */

import { db } from '../../db'
import { mailboxes, mailFolders, mailMessages } from '../../db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { allocateUidForNewMessage } from './move-messages'
import { getDkimConfigForEmail, toNodemailerDkim } from './dkim'
import { shouldSkipOwnDkimForRelay } from './relay-dkim-policy'
import { describeOutbound, isRelayConfigured, sendOutbound } from './outbound-transport'
import { jsonbParam } from './jsonb'

export interface StoreMessageData {
    messageId: string
    inReplyTo?: string
    references?: string
    subject: string
    fromAddress: string
    fromName: string | null
    toAddresses: object[]
    ccAddresses: object[]
    bccAddresses: object[]
    plainBody?: string
    htmlBody?: string
    hasAttachments: boolean
    attachments: object[]
}

/**
 * Relay outbound email through the configured system SMTP relay, or attempt direct
 * delivery when none is configured. DKIM-signs using the sender domain's key when
 * available (mirrors smtp-server.ts's relayMessage).
 */
export async function relayMessage(
    fromAddress: string,
    toAddresses: string[],
    rawEmail: Buffer
): Promise<void> {
    const usingRelay = isRelayConfigured()
    const skipOwnDkim = usingRelay && shouldSkipOwnDkimForRelay(process.env.SMTP_HOST)
    const dkimConfig = skipOwnDkim ? null : await getDkimConfigForEmail(fromAddress)
    const dkim = dkimConfig ? toNodemailerDkim(dkimConfig) : undefined
    if (skipOwnDkim) {
        console.log(`[Send:Relay] Own DKIM skipped: relay ${process.env.SMTP_HOST} rewrites the body and signs on its own (NATIVE_DKIM_SIGN=always to override)`)
    } else if (dkim) {
        console.log(`[Send:Relay] DKIM enabled: selector=${dkim.keySelector} domain=${dkim.domainName}`)
    } else {
        console.warn(`[Send:Relay] ⚠️  No DKIM key for ${fromAddress} — message will be unsigned`)
    }

    console.log(`[Send:Relay] Using ${describeOutbound()}`)
    console.log(`[Send:Relay] Envelope: from=${fromAddress} to=[${toAddresses.join(', ')}]`)
    try {
        const result = await sendOutbound(
            { envelope: { from: fromAddress, to: toAddresses }, raw: rawEmail },
            toAddresses,
            dkim,
        )
        console.log(`[Send:Relay] SUCCESS via ${result.via}:`, result.response)
    } catch (sendErr) {
        // Entrega direta falha por porta 25 bloqueada, PTR errado ou recusa do destino. Propagar
        // é essencial: quem chama grava o erro e o alerta de silêncio enxerga a queda.
        console.error(`[Send:Relay] FAILED via ${describeOutbound()}:`, sendErr)
        throw sendErr
    }
}

/**
 * Store a message in a folder for a mailbox (mirrors smtp-server.ts's storeMessage).
 *
 * These copies are composed locally rather than synced from a remote IMAP server, but
 * they still need a folder-scoped UID: our own IMAP server serves this folder to
 * Thunderbird, and a row with remote_uid = NULL cannot be addressed by UID at all —
 * `UID EXPUNGE` skips it, so the message becomes impossible to delete over IMAP once
 * it reaches Trash. See lib/move-messages.ts.
 */
export async function storeMessage(
    mailboxId: string,
    folderType: string,
    data: StoreMessageData,
    isRead = false
): Promise<void> {
    const folder = await db.query.mailFolders.findFirst({
        where: and(
            eq(mailFolders.mailboxId, mailboxId),
            eq(mailFolders.type, folderType)
        ),
    })

    if (!folder) {
        console.warn(`[Send] storeMessage: folder type '${folderType}' not found for mailbox ${mailboxId}`)
        return
    }

    const assignedUid = await allocateUidForNewMessage(mailboxId, folder.id)

    await db.insert(mailMessages).values({
        mailboxId,
        folderId: folder.id,
        messageId: data.messageId,
        inReplyTo: data.inReplyTo,
        references: data.references,
        subject: data.subject,
        fromAddress: data.fromAddress,
        fromName: data.fromName,
        // jsonbParam: ver lib/jsonb.ts — o cast via text impede a segunda codificação do pooler.
        toAddresses: jsonbParam(data.toAddresses ?? []),
        ccAddresses: jsonbParam(data.ccAddresses ?? []),
        bccAddresses: jsonbParam(data.bccAddresses ?? []),
        plainBody: data.plainBody,
        htmlBody: data.htmlBody,
        headers: jsonbParam({}),
        hasAttachments: data.hasAttachments,
        attachments: jsonbParam(data.attachments ?? []),
        isRead,
        isDraft: false,
        remoteUid: assignedUid,
        remoteDate: new Date(),
        receivedAt: new Date(),
    }).onConflictDoNothing()
}

/**
 * Resolve a user's native mailbox by email address. Used by outreach account
 * creation/verification and the reply/bounce processors to route through the native
 * mail model instead of stored IMAP credentials.
 *
 * Deliberately NOT tenant-scoped: a native mailbox belongs to a user, not to an
 * organization, and the create-time gate in routes/outreach/email-accounts.ts checks
 * membership separately. Anything that READS a mailbox on a recurring basis must use
 * getNativeMailboxForOrganization instead — membership is revocable, so a check that only
 * ran at create time is not a check.
 */
export async function getNativeMailboxByEmail(email: string) {
    return db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.email, email.toLowerCase()),
            eq(mailboxes.isNative, true)
        ),
    })
}

/**
 * Resolve a native mailbox only if its owner is still a member of `organizationId`.
 *
 * C-3: the inbound scanner used getNativeMailboxByEmail, which matches on email +
 * isNative alone. Removing a user from an organization deletes their organization_users
 * row but leaves any verified email_accounts row behind, so the scanner kept staging that
 * person's entire private INBOX — full bodies, retained for Phase 21 — under an
 * organization they had left. The Outlook path re-checks outlook_mailboxes.organization_id
 * for the same reason.
 *
 * Tenant isolation is JS-side (CLAUDE.md): the app's Postgres role bypasses RLS, so this
 * predicate is the boundary, not a second opinion about one.
 */
export async function getNativeMailboxForOrganization(email: string, organizationId: string) {
    return db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.email, email.toLowerCase()),
            eq(mailboxes.isNative, true),
            // The mailbox's owner — not the address — must still be a member.
            sql`EXISTS (
                SELECT 1 FROM organization_users membership
                WHERE membership.user_id = ${mailboxes.userId}
                  AND membership.organization_id = ${organizationId}
            )`,
        ),
    })
}
