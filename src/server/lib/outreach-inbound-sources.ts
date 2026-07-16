/**
 * Provider sources for outreach inbound staging (Phase 19, PROV-04).
 *
 * Each source turns one provider's paging model into the same bounded
 * `{ messages, nextCursor }` shape that ingestInboundPage consumes. Kept out of
 * outreach-inbound.ts so the classifier/ingestion core stays free of imapflow and db
 * imports and can be unit-tested without either.
 *
 * The rule every source obeys: progress is expressed in the cursor, never in the
 * user's read state. Nothing here reads isRead/\Seen and nothing here writes them.
 */

import { ImapFlow } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
    emailAccounts,
    mailFolders,
    mailMessages,
    outlookMailboxes,
    type OutlookMailbox,
    type OutreachProviderAttachment,
} from '../../db/schema'
import { decryptSecret } from './crypto'
import { createLogger } from './logger'
import { getNativeMailboxForOrganization } from './native-send'
import {
    fetchOutlookInboxDelta,
    type OutlookGraphMessage,
} from './outlook'
import {
    graphProviderMessageId,
    imapProviderMessageId,
    ingestInboundPage,
    nativeProviderMessageId,
    normalizeMessageId,
    resolveImapCursor,
    type InboundEventStore,
    type InboundSource,
    type IngestResult,
    type NormalizedInboundMessage,
    type ProviderCursorState,
} from './outreach-inbound'

const log = createLogger('outreach.inbound')

const MAX_BODY_LENGTH = 100_000

function truncate(value: string | null | undefined, max = MAX_BODY_LENGTH): string | null {
    if (!value) return null
    return value.length > max ? value.slice(0, max) : value
}

function addressList(value: unknown): string[] {
    if (!value) return []
    if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean)
    if (typeof value === 'string') {
        return value.split(',').map((entry) => entry.trim()).filter(Boolean)
    }
    return []
}

// ============================================================
// Native
// ============================================================

/**
 * Reads the account owner's native INBOX rows directly.
 *
 * The organization is re-checked on every tick rather than trusted from the account row:
 * a native mailbox belongs to a user, and membership is revocable. Removing someone from
 * an organization deletes only their organization_users row — the verified email_accounts
 * row survives — so resolving the mailbox by email alone would keep staging an ex-member's
 * entire private inbox, bodies included, under an organization they had left. Mirrors the
 * Graph path's organization re-check below. Tenant isolation is JS-side here (the app's
 * Postgres role bypasses RLS), so this is the boundary itself.
 *
 * Cursor: (received_at, id). A timestamp alone is not enough — several messages can
 * share one received_at, so a `> last_received_at` scan would skip the rest of that
 * second, while `>=` would re-read them forever. The id tie breaker resolves both.
 */
export async function createNativeInboundSource(account: {
    id: string
    email: string
    organizationId: string
}): Promise<InboundSource | null> {
    const mailbox = await getNativeMailboxForOrganization(account.email, account.organizationId)
    if (!mailbox) {
        log.warn({
            action: 'outreach.inbound.native_mailbox_unavailable',
            emailAccountId: account.id,
        }, 'verified native account has no native mailbox owned by a member of its organization')
        return null
    }

    const inbox = await db.query.mailFolders.findFirst({
        where: and(eq(mailFolders.mailboxId, mailbox.id), eq(mailFolders.type, 'inbox')),
    })
    if (!inbox) return null

    // received_at is nullable on mail_messages. Writers always populate it today, but a
    // null would sort NULLS LAST and never satisfy a `>` cursor, so such a row would be
    // silently un-ingestable forever. COALESCE onto created_at (NOT NULL) closes that.
    const orderKey = sql`COALESCE(${mailMessages.receivedAt}, ${mailMessages.createdAt})`

    return {
        provider: 'native',
        async fetchPage(cursor, pageSize) {
            const after = cursor?.lastReceivedAt ?? null
            const afterId = cursor?.lastProviderMessageId ?? null

            const candidates = await db.query.mailMessages.findMany({
                where: and(
                    eq(mailMessages.folderId, inbox.id),
                    // Row-value comparison is the tie breaker: several messages can share
                    // one timestamp, so `>` alone would skip the rest of that instant and
                    // `>=` would re-read them forever.
                    after
                        ? sql`(${orderKey}, ${mailMessages.id}::text) > (${after}::timestamp, ${afterId ?? ''}::text)`
                        : undefined,
                    // Never filtered by isRead: the human's read state is not our cursor.
                ),
                orderBy: [sql`${orderKey} ASC`, asc(mailMessages.id)],
                limit: pageSize,
            })

            const messages: NormalizedInboundMessage[] = candidates.map((row) => {
                const headers = (row.headers as Record<string, string> | null) ?? {}
                const attachments = ((row.attachments as unknown[] | null) ?? []).map((entry) => {
                    const item = (entry ?? {}) as Record<string, unknown>
                    const attachment: OutreachProviderAttachment = {
                        providerId: item.id ? String(item.id) : null,
                        name: item.filename ? String(item.filename) : null,
                        mimeType: item.contentType ? String(item.contentType) : null,
                        size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
                        inline: item.contentDisposition === 'inline' || Boolean(item.cid),
                        contentId: item.cid ? String(item.cid) : null,
                    }
                    return attachment
                })

                return {
                    provider: 'native',
                    providerMessageId: nativeProviderMessageId(row.id),
                    messageId: normalizeMessageId(row.messageId),
                    inReplyTo: row.inReplyTo,
                    references: row.references,
                    fromAddress: row.fromAddress,
                    toAddresses: addressList(row.toAddresses),
                    ccAddresses: addressList(row.ccAddresses),
                    subject: row.subject,
                    textBody: truncate(row.plainBody),
                    htmlBody: truncate(row.htmlBody),
                    headers,
                    attachments,
                    receivedAt: row.receivedAt ?? row.createdAt,
                }
            })

            const last = candidates[candidates.length - 1]
            const nextCursor: ProviderCursorState = last
                ? {
                    deltaCursor: null,
                    uidValidity: null,
                    lastUid: null,
                    // Must match the COALESCE ordering key, or the next page would be
                    // computed from a value the query never ordered by.
                    lastReceivedAt: last.receivedAt ?? last.createdAt,
                    lastProviderMessageId: last.id,
                }
                : {
                    deltaCursor: null,
                    uidValidity: null,
                    lastUid: null,
                    lastReceivedAt: after,
                    lastProviderMessageId: afterId,
                }

            return { messages, nextCursor }
        },
    }
}

// ============================================================
// IMAP
// ============================================================

export interface ImapInboundAccount {
    id: string
    email: string
    imapHost: string
    imapPort: number | null
    imapUsername: string
    imapPassword: string
    imapSecure: boolean | null
}

function headerRecord(parsed: ParsedMail): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const name of [
        'auto-submitted',
        'precedence',
        'x-auto-response-suppress',
        'content-type',
        'return-path',
        'list-unsubscribe',
    ]) {
        const value = parsed.headers.get(name)
        if (typeof value === 'string') headers[name] = value
        else if (value && typeof value === 'object' && 'value' in (value as object)) {
            const structured = value as { value?: unknown }
            if (typeof structured.value === 'string') headers[name] = structured.value
        }
    }
    // mailparser exposes the structured content type separately from the raw header.
    if (!headers['content-type'] && parsed.headers.get('content-type')) {
        headers['content-type'] = String(parsed.headers.get('content-type'))
    }
    return headers
}

function normalizeParsed(
    parsed: ParsedMail,
    uid: number,
    uidValidity: number,
): NormalizedInboundMessage {
    const references = Array.isArray(parsed.references)
        ? parsed.references.join(' ')
        : (parsed.references ?? null)

    return {
        provider: 'smtp',
        providerMessageId: imapProviderMessageId({
            messageId: parsed.messageId ?? null,
            uidValidity,
            uid,
        }),
        messageId: normalizeMessageId(parsed.messageId),
        inReplyTo: parsed.inReplyTo ?? null,
        references,
        fromAddress: parsed.from?.value?.[0]?.address ?? null,
        toAddresses: Array.isArray(parsed.to)
            ? parsed.to.flatMap((entry) => entry.value.map((address) => address.address ?? '')).filter(Boolean)
            : (parsed.to?.value?.map((address) => address.address ?? '').filter(Boolean) ?? []),
        ccAddresses: Array.isArray(parsed.cc)
            ? parsed.cc.flatMap((entry) => entry.value.map((address) => address.address ?? '')).filter(Boolean)
            : (parsed.cc?.value?.map((address) => address.address ?? '').filter(Boolean) ?? []),
        subject: parsed.subject ?? null,
        textBody: truncate(parsed.text),
        htmlBody: truncate(typeof parsed.html === 'string' ? parsed.html : null),
        headers: headerRecord(parsed),
        attachments: (parsed.attachments ?? []).map((attachment) => ({
            providerId: attachment.checksum ?? null,
            name: attachment.filename ?? null,
            mimeType: attachment.contentType ?? null,
            size: attachment.size ?? null,
            inline: attachment.contentDisposition === 'inline' || Boolean(attachment.cid),
            contentId: attachment.cid ?? null,
        })),
        receivedAt: parsed.date ?? new Date(),
    }
}

/**
 * UID-driven IMAP source.
 *
 * Replaces the old `search({ seen: false })` scan. Unseen was never a cursor: the reply
 * job flipped \Seen as a side effect, which is precisely how a DSN became invisible to
 * the bounce job. UIDs are monotonic within a UIDVALIDITY, so `UID <high-water>:*` is
 * both bounded and resumable, and nothing here touches message flags.
 */
export function createImapInboundSource(account: ImapInboundAccount): InboundSource {
    return {
        provider: 'smtp',
        async fetchPage(cursor, pageSize) {
            const client = new ImapFlow({
                host: account.imapHost,
                port: account.imapPort || 993,
                secure: account.imapSecure !== false,
                auth: { user: account.imapUsername, pass: decryptSecret(account.imapPassword) },
                logger: false,
            })

            await client.connect()
            try {
                const lock = await client.getMailboxLock('INBOX')
                try {
                    const mailbox = client.mailbox
                    const uidValidity = mailbox && typeof mailbox !== 'boolean'
                        ? Number(mailbox.uidValidity)
                        : 0
                    const resolved = resolveImapCursor(cursor, uidValidity)

                    if (resolved.reset) {
                        log.warn({
                            action: 'outreach.inbound.uidvalidity_reset',
                            emailAccountId: account.id,
                            storedUidValidity: cursor?.uidValidity ?? null,
                            mailboxUidValidity: uidValidity,
                        }, 'IMAP UIDVALIDITY changed; restarting from the beginning of the mailbox')
                    }

                    // Strictly greater than the high-water mark: `startUid:*` would
                    // re-fetch the last message forever on an idle mailbox.
                    const searchFrom = resolved.startUid + 1
                    const found = await client.search({ uid: `${searchFrom}:*` }, { uid: true })
                    // imapflow returns false (not an empty array) when a search matches
                    // nothing, and `n:*` always returns the last message even when its UID
                    // is below n — hence the explicit floor.
                    const pending = (found || [])
                        .filter((uid: number) => uid >= searchFrom)
                        .sort((a: number, b: number) => a - b)
                        .slice(0, pageSize)

                    const messages: NormalizedInboundMessage[] = []
                    let highWater = resolved.startUid

                    for (const uid of pending) {
                        try {
                            const fetched = await client.fetchOne(uid.toString(), { source: true }, { uid: true })
                            if (!fetched || typeof fetched === 'boolean' || !fetched.source) {
                                highWater = Math.max(highWater, uid)
                                continue
                            }
                            const parsed = await simpleParser(fetched.source)
                            messages.push(normalizeParsed(parsed, uid, resolved.uidValidity))
                            highWater = Math.max(highWater, uid)
                        } catch (error) {
                            const err = error instanceof Error ? error : new Error(String(error))
                            log.error({
                                action: 'outreach.inbound.imap_fetch_error',
                                uid,
                                emailAccountId: account.id,
                                error: { message: err.message },
                            }, 'failed to fetch IMAP message')
                            // Do NOT advance past a message we could not read — a
                            // permanent parse failure would otherwise silently vanish.
                            break
                        }
                    }

                    return {
                        messages,
                        nextCursor: {
                            deltaCursor: null,
                            uidValidity: resolved.uidValidity,
                            lastUid: highWater,
                            lastReceivedAt: null,
                            lastProviderMessageId: null,
                        },
                    }
                } finally {
                    lock.release()
                }
            } finally {
                try {
                    await client.logout()
                } catch {
                    // Ignore logout errors.
                }
            }
        },
    }
}

// ============================================================
// Outlook / Microsoft Graph
// ============================================================

/**
 * Cap on retained headers. Graph hands back every internet header the message arrived with,
 * and these land in a jsonb column — a mail with a long Received chain would otherwise write
 * kilobytes per event.
 */
const MAX_RETAINED_HEADERS = 100
const MAX_HEADER_VALUE_LENGTH = 1_000

/**
 * Keep ALL headers (bounded), not the IMAP source's fixed subset.
 *
 * The IMAP path can afford a subset because mailparser re-reads the raw source on demand.
 * Here the delta response is the only view of the message we will ever have, and the
 * classifier needs Content-Type (DSN detection), Auto-Submitted/Precedence (auto-replies)
 * and In-Reply-To/References (threading) — dropping anything else is a decision we cannot
 * revisit later.
 */
function graphHeaderRecord(message: OutlookGraphMessage): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const header of (message.internetMessageHeaders ?? []).slice(0, MAX_RETAINED_HEADERS)) {
        if (!header?.name) continue
        headers[header.name.toLowerCase()] = String(header.value ?? '').slice(0, MAX_HEADER_VALUE_LENGTH)
    }
    return headers
}

function graphAddresses(
    recipients: Array<{ emailAddress?: { address?: string | null } | null }> | null | undefined,
): string[] {
    return (recipients ?? [])
        .map((entry) => entry?.emailAddress?.address ?? '')
        .filter((address): address is string => Boolean(address))
}

/**
 * Map a Graph message onto the shared normalized shape.
 *
 * Returns null for anything with no usable identity — the reader already drops tombstones and
 * drafts, so this is the last guard rather than the first.
 */
export function normalizeGraphMessage(message: OutlookGraphMessage): NormalizedInboundMessage | null {
    if (!message?.id) return null

    const headers = graphHeaderRecord(message)
    const isHtml = (message.body?.contentType ?? '').toLowerCase() === 'html'
    const content = message.body?.content ?? null

    // Graph exposes exactly one body. Whichever it is, the reply/bounce consumers already
    // fall back across text/html, so nothing is lost by leaving the other side null rather
    // than inventing a conversion here.
    const textBody = isHtml ? null : truncate(content)
    const htmlBody = isHtml ? truncate(content) : null

    const receivedMs = message.receivedDateTime ? Date.parse(message.receivedDateTime) : NaN

    return {
        provider: 'outlook',
        providerMessageId: graphProviderMessageId({
            messageId: message.internetMessageId ?? null,
            graphId: message.id,
        }),
        messageId: normalizeMessageId(message.internetMessageId),
        inReplyTo: headers['in-reply-to'] ?? null,
        references: headers['references'] ?? null,
        fromAddress: message.from?.emailAddress?.address ?? null,
        toAddresses: graphAddresses(message.toRecipients),
        ccAddresses: graphAddresses(message.ccRecipients),
        subject: message.subject ?? null,
        textBody,
        htmlBody,
        headers,
        attachments: (message.attachments ?? []).map((attachment) => {
            const normalized: OutreachProviderAttachment = {
                providerId: attachment.id ? String(attachment.id) : null,
                name: attachment.name ? String(attachment.name) : null,
                mimeType: attachment.contentType ? String(attachment.contentType) : null,
                size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : null,
                inline: Boolean(attachment.isInline),
                contentId: attachment.contentId ? String(attachment.contentId) : null,
            }
            return normalized
        }),
        receivedAt: Number.isFinite(receivedMs) ? new Date(receivedMs) : new Date(),
    }
}

/**
 * Delta-driven Graph source.
 *
 * Outlook had no inbound path at all before this: replies and DSNs landed in the mailbox and
 * were never read, so an Outlook-assigned lead could hard-bounce and keep receiving the
 * sequence. The reader itself (outlook.ts) owns the budgets, the 410 resync and the
 * all-or-nothing page rule; this adapter only translates shapes.
 */
export function createGraphInboundSource(input: {
    account: { id: string; email: string }
    mailbox: OutlookMailbox
    now?: () => number
}): InboundSource {
    return {
        provider: 'outlook',
        async fetchPage(cursor, pageSize) {
            const result = await fetchOutlookInboxDelta({
                mailbox: input.mailbox,
                cursor: cursor?.deltaCursor ?? null,
                maxEvents: pageSize,
                now: input.now,
            })

            if (result.reset) {
                log.warn({
                    action: 'outreach.inbound.delta_reset',
                    emailAccountId: input.account.id,
                }, 'Graph expired the stored delta token; resynced with a bounded lookback')
            }

            const messages = result.messages
                .map((message) => normalizeGraphMessage(message))
                .filter((message): message is NormalizedInboundMessage => message !== null)

            return {
                messages,
                nextCursor: {
                    deltaCursor: result.cursor,
                    uidValidity: null,
                    lastUid: null,
                    lastReceivedAt: null,
                    lastProviderMessageId: null,
                },
                retryAfter: result.retryAfter,
                // The reader returns rather than throws on a throttle, so this is the only
                // signal distinguishing "read an empty inbox" from "never got a response".
                pagesFetched: result.pagesFetched,
            }
        },
    }
}

/**
 * One bounded inbound page for a single Outlook mailbox.
 *
 * This is the probe behind the activation gate (PROV-02): it proves read capability against
 * the live mailbox and leaves a durable cursor behind, so "verified" means an initial sync
 * actually happened rather than that a token merely existed. Deliberately small — the caller
 * is a synchronous HTTP request, not a cron tick.
 */
export async function syncOutlookInboundOnce(input: {
    account: { id: string; email: string; organizationId: string }
    mailbox: OutlookMailbox
    store: InboundEventStore
    pageSize?: number
}): Promise<IngestResult> {
    return ingestInboundPage({
        store: input.store,
        source: createGraphInboundSource({
            account: { id: input.account.id, email: input.account.email },
            mailbox: input.mailbox,
        }),
        account: { id: input.account.id, organizationId: input.account.organizationId },
        pageSize: input.pageSize ?? 25,
        isKnownCorrespondent: createKnownCorrespondentLookup(input.account.id),
    })
}

// ============================================================
// Ingestion orchestrator
// ============================================================

/**
 * Stages one bounded page per verified account. Safe to call from both the reply and
 * the bounce job: ingestion is cursor-driven and deduplicated, so a double run stages
 * nothing twice. Both jobs call it because either may be the first to run on a tick,
 * and neither may consume a classification that was never staged.
 */
export async function ingestOutreachInbound(deps: {
    store: InboundEventStore
    pageSize?: number
}): Promise<{ accounts: number; recorded: number; duplicates: number; errors: number }> {
    const result = { accounts: 0, recorded: 0, duplicates: 0, errors: 0 }

    const accounts = await db.query.emailAccounts.findMany({
        where: and(
            eq(emailAccounts.status, 'verified'),
            or(
                eq(emailAccounts.provider, 'native'),
                // PROV-02: Outlook accounts were excluded here entirely, which is what made
                // the provider send-only. A verified Outlook account now has a linked
                // mailbox by construction (the verify gate refuses otherwise).
                and(
                    eq(emailAccounts.provider, 'outlook'),
                    isNotNull(emailAccounts.outlookMailboxId),
                ),
                and(
                    isNotNull(emailAccounts.imapHost),
                    isNotNull(emailAccounts.imapUsername),
                    isNotNull(emailAccounts.imapPassword),
                ),
            ),
        ),
    })

    for (const account of accounts) {
        try {
            const source = account.provider === 'native'
                ? await createNativeInboundSource({
                    id: account.id,
                    email: account.email,
                    organizationId: account.organizationId,
                })
                : account.provider === 'outlook'
                    ? await createOutlookInboundSourceForAccount(account)
                    : createImapInboundSource({
                        id: account.id,
                        email: account.email,
                        imapHost: account.imapHost!,
                        imapPort: account.imapPort,
                        imapUsername: account.imapUsername!,
                        imapPassword: account.imapPassword!,
                        imapSecure: account.imapSecure,
                    })

            if (!source) continue

            const ingested = await ingestInboundPage({
                store: deps.store,
                source,
                account: { id: account.id, organizationId: account.organizationId },
                pageSize: deps.pageSize,
                isKnownCorrespondent: createKnownCorrespondentLookup(account.id),
            })

            result.accounts++
            result.recorded += ingested.recorded
            result.duplicates += ingested.duplicates

            await db.update(emailAccounts)
                .set({ lastSyncAt: new Date() })
                .where(eq(emailAccounts.id, account.id))
        } catch (error) {
            result.errors++
            const err = error instanceof Error ? error : new Error(String(error))
            log.error({
                action: 'outreach.inbound.account_error',
                emailAccountId: account.id,
                provider: account.provider,
                error: { message: err.message, stack: err.stack },
            }, 'inbound ingestion failed for account')
        }
    }

    return result
}

/**
 * Resolve the Graph mailbox backing an Outlook outreach account.
 *
 * The organization is re-checked in the composite lookup rather than trusted from the FK:
 * tenant isolation is JS-side here (the app's Postgres role bypasses RLS), so an account
 * whose outlook_mailbox_id pointed at another tenant's mailbox would otherwise read that
 * tenant's inbox.
 */
async function createOutlookInboundSourceForAccount(account: {
    id: string
    email: string
    organizationId: string
    outlookMailboxId: string | null
}): Promise<InboundSource | null> {
    if (!account.outlookMailboxId) return null

    const mailbox = await db.query.outlookMailboxes.findFirst({
        where: and(
            eq(outlookMailboxes.id, account.outlookMailboxId),
            eq(outlookMailboxes.organizationId, account.organizationId),
        ),
    })

    if (!mailbox) {
        log.warn({
            action: 'outreach.inbound.outlook_mailbox_missing',
            emailAccountId: account.id,
        }, 'verified Outlook account has no reachable mailbox in its own organization')
        return null
    }

    return createGraphInboundSource({
        account: { id: account.id, email: account.email },
        mailbox,
    })
}

/**
 * Tier-3 fallback resolver: does this sender belong to a lead we emailed from this
 * account in the last 30 days? Mirrors matchReplyToOutreach's from-address tier so a
 * reply whose client stripped In-Reply-To is still classified as a reply rather than
 * staged as 'other'.
 */
export function createKnownCorrespondentLookup(accountId: string) {
    return async (fromAddress: string): Promise<boolean> => {
        const rows = await db.execute(sql`
            SELECT 1
            FROM outreach_emails oe
            JOIN campaign_leads cl ON cl.id = oe.campaign_lead_id
            JOIN leads l ON l.id = cl.lead_id
            WHERE oe.email_account_id = ${accountId}
              AND LOWER(l.email) = LOWER(${fromAddress})
              AND oe.sent_at >= now() - interval '30 days'
            LIMIT 1
        `)
        return Array.isArray(rows) ? rows.length > 0 : false
    }
}

