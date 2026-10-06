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
 *   1. ACCOUNT  — `email_accounts.warmup_only = true` (native seed boxes): nothing that arrives
 *      there is ever operator mail, so the whole account is excluded.
 *   2. COUNTERPART — the other side of the message is a mesh address (any `email_accounts.email`
 *      whose `warmup_source <> 'none'` or `warmup_only`). This is what catches the Icemail
 *      campaign senders (`warmup_only = false`), which also carry ~500 mesh conversations each.
 *      `info@` mailboxes have `warmup_source = 'none'` and talk to prospects/customers outside
 *      the mesh, so they pass untouched.
 *   3. MESSAGE-ID SHAPE — the engine mints every Message-ID as `w.<uuid>@<domain>` (see
 *      processWarmup.ts), and warm-up replies reference them via In-Reply-To/References. A
 *      UUID-shaped `w.` id is a robust secondary signal when the counterpart header was
 *      rewritten (forwarding, alias) and the address match alone would miss it.
 *
 * Everything in this module is pure except {@link loadMeshAddresses}; the predicate is the part
 * the tests pin down.
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

export interface WarmupTrafficInput {
    /** The mailbox that owns the conversation is a warm-up-only seed box. */
    accountWarmupOnly: boolean
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
 * The per-message filter handed to `ingestInboundPage`. `accountWarmupOnly` is false on purpose:
 * warmup_only accounts are removed before this runs (loadIngestableAccounts), so what is left to
 * decide here is the counterpart and Message-ID signals for the remaining accounts.
 */
export function createWarmupExclusion(meshAddresses: MeshAddressSet) {
    return (message: NormalizedInboundMessage): boolean => isWarmupTraffic({
        accountWarmupOnly: false,
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
 * Loads every mesh address. Global on purpose: the mesh is the operator's own mailboxes across
 * organizations (processWarmup builds it from all verified `internal` accounts), so a mesh
 * address from another tenant's org is still "our own box" and still synthetic.
 */
export async function loadMeshAddresses(sql: UnifiedInboxSql): Promise<Set<string>> {
    const rows = await sql<{ email: string }>`
        SELECT LOWER(email) AS email
        FROM email_accounts
        WHERE warmup_source <> 'none' OR warmup_only = true
    `
    return new Set(rows.map((row) => row.email))
}
