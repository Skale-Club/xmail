/**
 * Warm-up traffic discrimination for the Unified Inbox.
 *
 * The warm-up mesh (jobs/processWarmup.ts) makes our own mailboxes write to each other so they
 * build reputation. That mail is synthetic by design and must NEVER become an operator-facing
 * conversation: in production it was 97% of the inbox (8,770 of 9,008 conversations), 0 of them
 * campaign replies, which buried the 238 real `info@` conversations.
 *
 * Why there is no `X-Warmup` header check: migration 058 deliberately sends warm-up mail WITHOUT
 * a marker header, because a marker would flag the traffic as synthetic to the very spam filters
 * the mesh is trying to convince. The discriminators that actually exist are:
 *
 *   0. MEMBERSHIP (the gate) - every rule below applies ONLY when the mailbox that OWNS the
 *      conversation is itself in the mesh (`warmup_source = 'internal'` or `warmup_only`). An
 *      `info@` mailbox (`warmup_source = 'none'`) is a working mailbox that people read: if
 *      someone writes to it from a mesh address, or forwards a prospect reply into it, that is
 *      real mail and is never classified as warm-up.
 *   1. ACCOUNT - `email_accounts.warmup_only = true` (native seed boxes): nothing that arrives
 *      there is ever operator mail, so the whole account is excluded from ingestion.
 *   2. COUNTERPART - the other side of the message is a mesh address. This is what catches the
 *      Icemail campaign senders (`warmup_only = false`, `warmup_source = 'internal'`), which also
 *      carry ~500 mesh conversations each.
 *   3. MESSAGE-ID SHAPE - the engine mints every Message-ID as `w.<uuid>@<domain>` (see
 *      processWarmup.ts), and warm-up replies reference them via In-Reply-To/References. A
 *      UUID-shaped `w.` id is a robust signal when the counterpart header was rewritten, and it
 *      is what identifies a DSN (mailer-daemon) answering a warm-up send.
 *
 * Mesh definition: `warmup_source = 'internal' OR warmup_only = true`. 'vendor' and 'provider'
 * accounts are warmed by an external tool or arrive pre-warmed (migration 058 COMMENT: only
 * 'internal' participates in the mesh), so their addresses are NOT mesh addresses.
 *
 * The mesh address set is deliberately NOT scoped by organization: processWarmup builds the mesh
 * across organizations on purpose ("o mesh e global do operador"; the value is crossing domains,
 * and a seed's organization comes from its domain). Scoping the set per tenant would let most
 * warm-up traffic through. Tenant safety comes from gate 0 instead: a tenant's working mailbox
 * is never in the mesh, so nothing in it can match.
 *
 * Everything in this module is pure except {@link loadMeshAddresses} and
 * {@link supportsSkippedStatus}; the predicate is the part the tests pin down.
 */
import type { NormalizedInboundMessage } from '../outreach-inbound'
import type { UnifiedInboxSql } from './ingest'
import { normalizeAddress, normalizeMessageId, normalizeReferences } from './normalize'

/** `w.<uuid>@domain`, with or without angle brackets. Mirrors `w.${randomUUID()}@${domain}` in processWarmup. */
export const WARMUP_MESSAGE_ID_PATTERN =
    /^<?w\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@/i

export function isWarmupMessageId(value: string | null | undefined): boolean {
    if (!value) return false
    return WARMUP_MESSAGE_ID_PATTERN.test(value.trim())
}

/** The set of lower-cased addresses that belong to the warm-up mesh. */
export type MeshAddressSet = ReadonlySet<string>

/** Whether an account takes part in the mesh (see the definition in the file header). */
export function isMeshAccount(account: { warmupSource?: string | null; warmupOnly?: boolean | null }): boolean {
    return account.warmupSource === 'internal' || account.warmupOnly === true
}

export interface WarmupTrafficInput {
    /** The mailbox that owns the conversation is a warm-up-only seed box. */
    accountWarmupOnly: boolean
    /**
     * The owning mailbox is a mesh member (`internal` or `warmup_only`). When false the
     * counterpart and Message-ID rules never apply. Defaults to `accountWarmupOnly`.
     */
    accountInMesh?: boolean
    /** The other side of the message: `from` for inbound, the recipients for outbound. */
    counterpartAddresses: ReadonlyArray<string | null | undefined>
    /** Message-ID / In-Reply-To / References tokens of the message. Optional. */
    messageIds?: ReadonlyArray<string | null | undefined>
    meshAddresses: MeshAddressSet
}

/**
 * True when the message is warm-up mesh traffic and must not reach the Unified Inbox.
 *
 * The counterpart rule is deliberately "every counterpart is a mesh address (and there is at
 * least one)": a message that ALSO involves someone outside the mesh is real mail and must
 * survive, so an unlucky cc can never hide an operator conversation.
 */
export function isWarmupTraffic(input: WarmupTrafficInput): boolean {
    if (input.accountWarmupOnly) return true

    // Gate: a working mailbox (info@) is never warm-up, whoever wrote to it.
    const inMesh = input.accountInMesh ?? false
    if (!inMesh) return false

    const counterparts = input.counterpartAddresses
        .map((address) => normalizeAddress(address ?? null))
        .filter((address): address is string => address !== null)
    if (counterparts.length > 0 && counterparts.every((address) => input.meshAddresses.has(address))) {
        return true
    }

    return (input.messageIds ?? []).some((id) => isWarmupMessageId(id))
}

/** Flattens Message-ID, In-Reply-To and References into one list for {@link isWarmupTraffic}. */
export function warmupMessageIdTokens(input: {
    messageId?: string | null
    inReplyTo?: string | null
    references?: string | string[] | null
}): string[] {
    const tokens: string[] = []
    const messageId = normalizeMessageId(input.messageId ?? null)
    if (messageId) tokens.push(messageId)
    const inReplyTo = normalizeMessageId(input.inReplyTo ?? null)
    if (inReplyTo) tokens.push(inReplyTo)
    tokens.push(...normalizeReferences(input.references ?? null))
    return tokens
}

/**
 * The per-message filter handed to `ingestInboundPage` FOR A MESH ACCOUNT. The caller must only
 * use it for accounts that are in the mesh (gate 0); `accountWarmupOnly` is false on purpose:
 * warmup_only accounts are removed before this runs (loadIngestableAccounts).
 */
export function createWarmupExclusion(meshAddresses: MeshAddressSet) {
    return (message: NormalizedInboundMessage): boolean => isWarmupTraffic({
        accountWarmupOnly: false,
        accountInMesh: true,
        counterpartAddresses: [message.fromAddress],
        messageIds: warmupMessageIdTokens({
            messageId: message.messageId,
            inReplyTo: message.inReplyTo,
            references: message.references,
        }),
        meshAddresses,
    })
}

/**
 * Loads every mesh address (`warmup_source = 'internal' OR warmup_only`). Global across
 * organizations on purpose, see the file header.
 */
export async function loadMeshAddresses(sql: UnifiedInboxSql): Promise<Set<string>> {
    const rows = await sql<{ email: string }>`
        SELECT LOWER(email) AS email
        FROM email_accounts
        WHERE warmup_source = 'internal' OR warmup_only = true
    `
    return new Set(rows.map((row) => row.email))
}

// ------------------------------------------------------------
// Migration-068 tolerance
// ------------------------------------------------------------

const SKIPPED_STATUS_RECHECK_MS = 60_000
let skippedStatusCache: { supported: boolean; checkedAt: number } | null = null

/** Test seam: forget the cached constraint probe. */
export function resetSkippedStatusCache(): void {
    skippedStatusCache = null
}

/**
 * Whether `outreach_provider_events.materialization_status` accepts 'skipped' (migration 068).
 * The deploy can land before the migration; writing 'skipped' then violates the CHECK and, inside
 * the materialization transaction, would abort it and park the event as failed. Callers use this
 * to fall back to the pre-068 behavior (materialize normally) until the migration is applied.
 * A positive answer is cached for the life of the process; a negative one is re-probed every
 * minute so the exclusion switches on by itself once the migration lands.
 */
export async function supportsSkippedStatus(sql: UnifiedInboxSql, now: number = Date.now()): Promise<boolean> {
    if (skippedStatusCache?.supported) return true
    if (skippedStatusCache && now - skippedStatusCache.checkedAt < SKIPPED_STATUS_RECHECK_MS) return false
    const rows = await sql<{ def: string }>`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conname = 'outreach_provider_events_materialization_status_check'
          AND conrelid = 'public.outreach_provider_events'::regclass
    `
    // No constraint at all means nothing can reject the value.
    const supported = rows.length === 0 || rows.some((row) => row.def.includes("'skipped'"))
    skippedStatusCache = { supported, checkedAt: now }
    return supported
}
