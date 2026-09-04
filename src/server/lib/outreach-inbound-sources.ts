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
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
    emailAccounts,
    mailFolders,
    mailMessages,
    outlookMailboxes,
    outreachProviderEvents,
    type OutlookMailbox,
} from '../../db/schema'
import { decryptSecret } from './crypto'
import { sqlTimestamp } from './sql-timestamp'
import { createLogger } from './logger'
import { runWithLock } from './cron-lock'
import { getNativeMailboxForOrganization } from './native-send'
import { fetchOutlookInboxDelta } from './outlook'
import { nativeEventFromMailRow } from './unified-inbox/providers/native'
import { imapEventFromParsedMail } from './unified-inbox/providers/imap'
import { outlookEventFromGraphMessage } from './unified-inbox/providers/outlook'
import {
    INGEST_FAILURE_BACKOFF_MINUTES,
    ingestInboundPage,
    resolveImapCursor,
    type InboundEventStore,
    type InboundSource,
    type InboundSourcePage,
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

            // Metadata first, bodies last (2026-08 egress overrun): the previous version
            // fetched FULL rows — plain_body, html_body, headers, attachments, ~37KB each —
            // for every candidate, including ones already staged, and any failure before
            // saveCursor re-transmitted the same page on every tick. The candidate scan now
            // moves only the ordering key; bodies are fetched below, and only for rows that
            // outreach_provider_events does not already hold.
            const candidates = await db
                .select({
                    id: mailMessages.id,
                    receivedAt: mailMessages.receivedAt,
                    createdAt: mailMessages.createdAt,
                })
                .from(mailMessages)
                .where(and(
                    eq(mailMessages.folderId, inbox.id),
                    // Row-value comparison is the tie breaker: several messages can share
                    // one timestamp, so `>` alone would skip the rest of that instant and
                    // `>=` would re-read them forever.
                    after
                        ? sql`(${orderKey}, ${mailMessages.id}::text) > (${sqlTimestamp(after)}, ${afterId ?? ''}::text)`
                        : undefined,
                    // Never filtered by isRead: the human's read state is not our cursor.
                ))
                .orderBy(sql`${orderKey} ASC`, asc(mailMessages.id))
                .limit(pageSize)

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

            if (candidates.length === 0) return { messages: [], nextCursor }

            // Native provider_message_id IS the mail_messages row id, so already-staged
            // rows are knowable from ids alone — their bodies never leave Postgres again.
            const staged = await db
                .select({ providerMessageId: outreachProviderEvents.providerMessageId })
                .from(outreachProviderEvents)
                .where(and(
                    eq(outreachProviderEvents.organizationId, account.organizationId),
                    eq(outreachProviderEvents.emailAccountId, account.id),
                    eq(outreachProviderEvents.provider, 'native'),
                    inArray(outreachProviderEvents.providerMessageId, candidates.map((row) => row.id)),
                ))
            const stagedIds = new Set(staged.map((row) => row.providerMessageId))
            const pendingIds = candidates
                .filter((row) => !stagedIds.has(row.id))
                .map((row) => row.id)

            let messages: NormalizedInboundMessage[] = []
            if (pendingIds.length > 0) {
                const fullRows = await db.query.mailMessages.findMany({
                    where: inArray(mailMessages.id, pendingIds),
                    orderBy: [sql`${orderKey} ASC`, asc(mailMessages.id)],
                })
                messages = fullRows.map((row) => nativeEventFromMailRow(row))
            }

            return {
                messages,
                nextCursor,
                alreadyStaged: stagedIds.size,
                // Per-message resume point. receivedAt in the normalized message is already
                // COALESCE(received_at, created_at) (nativeEventFromMailRow), matching the
                // ordering key, and providerMessageId is the row id — so a failure mid-page
                // resumes after the last staged message instead of re-reading the page.
                // Duplicates skipped between two staged messages are covered: they are
                // already in outreach_provider_events, which is what excluded them here.
                getMessageCursor: (index) => {
                    const staged = messages[index]
                    if (!staged) return null
                    return {
                        deltaCursor: null,
                        uidValidity: null,
                        lastUid: null,
                        lastReceivedAt: staged.receivedAt,
                        lastProviderMessageId: staged.providerMessageId,
                    }
                },
            }
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

// Every ImapFlow option below is confirmed present on the pinned version (imapflow
// ^1.2.16 in package.json; 1.2.17 installed) via node_modules/imapflow/lib/imap-flow.d.ts
// (ImapFlowOptions: connectionTimeout, greetingTimeout, socketTimeout) and cross-checked
// against the implementation in node_modules/imapflow/lib/imap-flow.js, which also
// confirms the error `.code` each one produces: 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT',
// and 'ETIMEOUT' (socket inactivity — this is the "Command failed" hang signature: the
// server stops responding mid-command and the socket goes idle) respectively.
//
// Measured in production: a healthy pass over ~34 accounts (native + outlook + imap)
// completes in 55-61s total, so a single IMAP account's page fetch is normally well
// under a second once connected. The bounds below are generous enough for a
// slow-but-working server yet far below the job's own 600s budget, so one hung account
// fails on its own instead of the whole run riding it out to the timeout:
//   - connect/greeting: ~10s is >10x a healthy fetch and still leaves headroom before
//     the per-account deadline below.
//   - socket inactivity: 15s catches a stalled command well before the account deadline.
//   - account deadline: 20s is a backstop over the WHOLE fetchPage (connect through the
//     last fetchOne), for a hang that isn't purely socket-level — e.g. anything that
//     resolves at the TCP layer but never completes the awaited command. 600s / 20s = 30,
//     so even a pathological run of simultaneous hangs fails close to (not past) budget
//     rather than silently eating it one account at a time as the un-bounded client did.
const IMAP_CONNECT_TIMEOUT_MS = 10_000
const IMAP_GREETING_TIMEOUT_MS = 10_000
const IMAP_SOCKET_TIMEOUT_MS = 15_000
const IMAP_ACCOUNT_DEADLINE_MS = 20_000

export type ImapInboundTimeoutPhase = 'connect' | 'greeting' | 'command' | 'overall_deadline'

/**
 * Thrown when an IMAP operation for one account is aborted by a timeout — either
 * ImapFlow's own connect/greeting/socket bounds, or the overall per-account deadline
 * wrapping the whole fetchPage. Names the account and the phase so an incident points
 * straight at the culprit instead of requiring log archaeology (the 2026-09
 * `outreach-replies-processor` hangs this replaces: 55-61s normally, 600s job timeout
 * 7-8x/day with no error naming which account or step was stuck).
 */
export class ImapInboundTimeoutError extends Error {
    readonly emailAccountId: string
    readonly email: string
    readonly phase: ImapInboundTimeoutPhase

    constructor(
        account: { id: string; email: string },
        phase: ImapInboundTimeoutPhase,
        cause?: unknown,
    ) {
        super(`IMAP ${phase} timed out for account ${account.email} (${account.id})`)
        this.name = 'ImapInboundTimeoutError'
        this.emailAccountId = account.id
        this.email = account.email
        this.phase = phase
        if (cause !== undefined) {
            // Non-standard-lib-typed but supported by Node/TS's Error since ES2022;
            // set defensively rather than via the constructor options bag for wider
            // TS-lib-target compatibility.
            (this as { cause?: unknown }).cause = cause
        }
    }
}

/** Maps ImapFlow's own timeout error codes to the phase that produced them. */
function classifyImapTimeout(error: unknown): ImapInboundTimeoutPhase | null {
    const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
    if (code === 'CONNECT_TIMEOUT') return 'connect'
    if (code === 'GREETING_TIMEOUT') return 'greeting'
    if (code === 'ETIMEOUT') return 'command'
    return null
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
                connectionTimeout: IMAP_CONNECT_TIMEOUT_MS,
                greetingTimeout: IMAP_GREETING_TIMEOUT_MS,
                socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
            })

            const runFetch = async (): Promise<InboundSourcePage> => {
                try {
                    await client.connect()
                } catch (error) {
                    const phase = classifyImapTimeout(error)
                    if (phase) throw new ImapInboundTimeoutError(account, phase, error)
                    throw error
                }

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
                        // Aligned with `messages`: the cursor that is safe once messages[i] is
                        // staged. Skipped-unfetchable UIDs below a message are covered by its
                        // own UID, so resuming from it never re-reads staged mail.
                        const messageCursors: ProviderCursorState[] = []
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
                                messageCursors.push({
                                    deltaCursor: null,
                                    uidValidity: resolved.uidValidity,
                                    lastUid: uid,
                                    lastReceivedAt: null,
                                    lastProviderMessageId: null,
                                })
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
                            getMessageCursor: (index) => messageCursors[index] ?? null,
                        }
                    } finally {
                        lock.release()
                    }
                } catch (error) {
                    if (error instanceof ImapInboundTimeoutError) throw error
                    const phase = classifyImapTimeout(error)
                    if (phase) throw new ImapInboundTimeoutError(account, phase, error)
                    throw error
                }
            }

            const fetchPromise = runFetch()
            let deadlineTimer: ReturnType<typeof setTimeout>
            const deadline = new Promise<never>((_resolve, reject) => {
                deadlineTimer = setTimeout(() => {
                    // Force the socket closed so runFetch's pending command actually
                    // settles instead of leaking a connection that nothing is awaiting
                    // any more. close() is synchronous and safe to call more than once.
                    try {
                        client.close()
                    } catch {
                        // Already closing/closed.
                    }
                    reject(new ImapInboundTimeoutError(account, 'overall_deadline'))
                }, IMAP_ACCOUNT_DEADLINE_MS)
            })

            try {
                return await Promise.race([fetchPromise, deadline])
            } finally {
                clearTimeout(deadlineTimer!)
                // If the deadline won the race, runFetch's promise is still settling in
                // the background (Promise.race does not cancel the loser) — observe it
                // so its eventual rejection never surfaces as an unhandled rejection.
                fetchPromise.catch(() => {})
                // The client must always be closed, on every path: success, a thrown
                // error, or the deadline above. logout() is a graceful LOGOUT command;
                // if the socket is already gone (deadline path, or a connect failure
                // ImapFlow already tore down) it rejects immediately rather than
                // hanging, so the fallback close() below is a fast no-op in that case.
                try {
                    await client.logout()
                } catch {
                    try {
                        client.close()
                    } catch {
                        // Nothing left to close.
                    }
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

            // Persist the failure as a backoff. Without this, a repeatedly failing account
            // was retried at full page weight by BOTH calling jobs on every tick — for a
            // month, in the 2026-08 incident. recordCursorRetry upserts, so it also works
            // for an account that failed before its first successful page (no cursor row).
            // Runs AFTER any partial-progress saveCursor inside ingestInboundPage, which is
            // required: saveCursor clears the retry bookkeeping.
            const retryAt = new Date(
                (deps.now?.() ?? new Date()).getTime() + INGEST_FAILURE_BACKOFF_MINUTES * 60_000,
            )
            try {
                await deps.store.recordCursorRetry?.(
                    account.id,
                    account.provider,
                    { error: err.message.slice(0, 500), retryAt },
                )
            } catch {
                // Backoff bookkeeping is best-effort; the error below is still logged.
            }

            log.error({
                action: 'outreach.inbound.account_error',
                emailAccountId: account.id,
                provider: account.provider,
                retryAt: retryAt.toISOString(),
                error: { message: err.message, stack: err.stack },
            }, 'inbound ingestion failed for account; backing off')
        }
    }

    return result
}

/**
 * Advisory-locked entry point for the cron jobs. Replies (every 15 min) and bounces
 * (every 30 min) both stage before consuming, so on colliding ticks the same provider
 * scan used to run twice back-to-back — half of the 8k-query volume in the 2026-08
 * incident. With one shared lock, whichever job arrives second skips ingestion and goes
 * straight to consuming events the first one is staging; events are durable, so nothing
 * is lost by skipping.
 *
 * Returns null when ingestion was skipped because the lock is held elsewhere.
 */
export async function ingestOutreachInboundExclusive(deps: {
    store: InboundEventStore
    pageSize?: number
    now?: () => Date
}): Promise<{ accounts: number; recorded: number; duplicates: number; errors: number } | null> {
    let result: { accounts: number; recorded: number; duplicates: number; errors: number } | null = null
    await runWithLock('outreach-inbound-ingest', async () => {
        result = await ingestOutreachInbound(deps)
    })
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

