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
import { simpleParser } from 'mailparser'
import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
    emailAccounts,
    mailFolders,
    mailMessages,
    outlookMailboxes,
    type OutlookMailbox,
} from '../../db/schema'
import { decryptSecret } from './crypto'
import { sqlTimestamp } from './sql-timestamp'
import { createLogger } from './logger'
import { getNativeMailboxForOrganization } from './native-send'
import { fetchOutlookInboxDelta } from './outlook'
import { nativeEventFromMailRow } from './unified-inbox/providers/native'
import { imapEventFromParsedMail } from './unified-inbox/providers/imap'
import { outlookEventFromGraphMessage } from './unified-inbox/providers/outlook'
import {
    ingestInboundPage,
    resolveImapCursor,
    type InboundEventStore,
    type InboundSource,
    type IngestResult,
    type NormalizedInboundMessage,
    type ProviderCursorState,
} from './outreach-inbound'

const log = createLogger('outreach.inbound')

// The provider-neutral field mapping for every provider now lives in the Phase 21 adapters
// (unified-inbox/providers/*), so native mail, raw IMAP MIME, and Graph delta messages produce
// EQUIVALENT normalized fields. Re-exported here for existing importers (outlook-inbound.test.ts).
export { outlookEventFromGraphMessage as normalizeGraphMessage } from './unified-inbox/providers/outlook'

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
                        ? sql`(${orderKey}, ${mailMessages.id}::text) > (${sqlTimestamp(after)}, ${afterId ?? ''}::text)`
                        : undefined,
                    // Never filtered by isRead: the human's read state is not our cursor.
                ),
                orderBy: [sql`${orderKey} ASC`, asc(mailMessages.id)],
                limit: pageSize,
            })

            const messages: NormalizedInboundMessage[] = candidates.map((row) => nativeEventFromMailRow(row))

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
                            messages.push(imapEventFromParsedMail(parsed, uid, resolved.uidValidity))
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
                .map((message) => outlookEventFromGraphMessage(message))
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
/**
 * Verified accounts with an inbound source, minus any the provider told us to back off from.
 *
 * The retry_at predicate is W-5: recordCursorRetry persists Graph's Retry-After against the
 * cursor row, but nothing read it, so a throttled account was re-hammered on the very next
 * tick and the backoff was pure bookkeeping. Honouring it also shrinks the throttle window
 * that W-1 turned into a bogus activation.
 *
 * Self-healing by construction: saveCursor clears retry_at on every success, so a stuck
 * value can only ever delay one account until the timestamp it already carries.
 *
 * Exported for the DB test — the predicate is the whole behaviour, and it only exists in SQL.
 */
export async function loadIngestableAccounts(now = new Date()) {
    return db.query.emailAccounts.findMany({
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
            // Not scoped by provider: an account has exactly one, and any cursor of that
            // account asking for a pause speaks for the account.
            sql`NOT EXISTS (
                SELECT 1 FROM outreach_provider_cursors cursor_row
                WHERE cursor_row.email_account_id = ${emailAccounts.id}
                  AND cursor_row.retry_at IS NOT NULL
                  AND cursor_row.retry_at > ${sqlTimestamp(now)}
            )`,
        ),
    })
}

export async function ingestOutreachInbound(deps: {
    store: InboundEventStore
    pageSize?: number
    now?: () => Date
}): Promise<{ accounts: number; recorded: number; duplicates: number; errors: number }> {
    const result = { accounts: 0, recorded: 0, duplicates: 0, errors: 0 }

    const accounts = await loadIngestableAccounts(deps.now?.() ?? new Date())

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

