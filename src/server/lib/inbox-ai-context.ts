// ============================================================
// Deterministic persisted-message AI context builder (Phase 23 AI-01)
// ============================================================
// buildInboxAiContext produces a DETERMINISTIC, BOUNDED projection of the PERSISTED
// outreach_conversation_messages (the full normalized bodies Phase 21 stores) for a single
// organization + conversation. It is the ONLY reasoning source an AI draft/decision may use.
//
// Locked decision #2: persisted inbox messages are the only conversation source. This module NEVER
// reads campaign_leads.lastReplyText (a compatibility cache that cannot authorize or construct AI
// context). It also FAILS CLOSED — if the latest inbound message has no usable body it throws an
// InboxAiContextError instead of inventing a reply from headers.
//
// Determinism: messages are ordered oldest→newest by (received/sent/created time, then id as a
// stable tiebreak); selection is a fixed budget; each body is normalized to plain text; and a
// SHA-256 hash is computed over a canonical serialization. The same input always yields the same
// ordered message ids, serialized context, and hash — so an audit run can be reproduced and a
// stored context hash verified.
//
// Safety: the builder is a PURE function (no DB, no network) that asserts every message belongs to
// the verified organization + conversation (fails closed on any cross-tenant / cross-conversation
// row), treats all body content as UNTRUSTED DATA inside a non-forgeable fence (prompt-injection
// text is preserved as data but can never break the structure), and never includes attachment
// bytes, credentials, provider tokens, raw headers, or hidden/system prompts.

import { createHash } from 'node:crypto'
import { htmlToPlainText } from './html-to-text'

/** The reasoning role of a message relative to the sending (seller) account. */
export type InboxAiContextRole = 'seller' | 'prospect'

/** A normalized address token (mirrors OutreachConversationAddress without importing the DB layer). */
export interface InboxAiContextAddress {
    address: string
    name: string | null
}

/**
 * A persisted conversation message projected for context building. This is the ALLOWLISTED subset
 * of outreach_conversation_messages — deliberately no headers, attachments, tokens, or provider
 * credentials. Bodies are the full normalized bodies Phase 21 persists.
 */
export interface InboxAiContextMessage {
    id: string
    organizationId: string
    conversationId: string
    direction: 'inbound' | 'outbound'
    subject: string | null
    fromAddress: string | null
    fromName: string | null
    toAddresses: InboxAiContextAddress[]
    ccAddresses: InboxAiContextAddress[]
    plainBody: string | null
    htmlBody: string | null
    sentAt: Date | null
    receivedAt: Date | null
    createdAt: Date
}

/** Optional campaign/lead/seller facts. Metadata only — NEVER a cached reply body. */
export interface InboxAiContextFactsInput {
    campaign?: { id: string; name?: string | null } | null
    lead?: { email?: string | null; firstName?: string | null; company?: string | null } | null
    sellerName?: string | null
}

export interface InboxAiContextBudget {
    /** Max messages selected into the context window. */
    maxMessages: number
    /** Max characters of normalized text kept per message. */
    maxCharsPerMessage: number
    /** Max total characters of normalized message text across the whole window. */
    maxTotalChars: number
}

export interface BuildInboxAiContextInput extends InboxAiContextFactsInput {
    /** The verified organization scope (from requireOutreachRead / a claimed job row). */
    organizationId: string
    /** The verified conversation scope. */
    conversationId: string
    /** The sending account's address (used to derive seller/prospect role). */
    accountAddress: string
    /** The persisted thread messages, any order (the builder sorts deterministically). */
    messages: InboxAiContextMessage[]
    /** Optional budget override (defaults to DEFAULT_INBOX_AI_CONTEXT_BUDGET). */
    budget?: Partial<InboxAiContextBudget>
}

export interface InboxAiContextTurn {
    id: string
    direction: 'inbound' | 'outbound'
    role: InboxAiContextRole
    from: string | null
    to: string[]
    subject: string | null
    /** ISO timestamp of the message (received/sent/created), or null. */
    timestamp: string | null
    /** Normalized, bounded plain text with any fence token neutralized. */
    text: string
    /** True when the body was truncated by the per-message budget. */
    truncated: boolean
}

export interface InboxAiContextFacts {
    campaignId: string | null
    campaignName: string | null
    leadEmail: string | null
    leadFirstName: string | null
    leadCompany: string | null
    sellerName: string | null
}

export interface InboxAiContextResult {
    organizationId: string
    conversationId: string
    /** The latest inbound message with a usable body — the message the AI is answering. */
    latestInboundMessageId: string
    /** Ordered (oldest→newest) ids of the selected window. */
    messageIds: string[]
    messageCount: number
    /** True when messages were dropped or bodies truncated by the budget. */
    truncated: boolean
    messages: InboxAiContextTurn[]
    facts: InboxAiContextFacts
    /** The canonical serialized context the hash is computed over. */
    serialized: string
    /** SHA-256 (hex) of the canonical serialization. */
    contextHash: string
}

export const DEFAULT_INBOX_AI_CONTEXT_BUDGET: InboxAiContextBudget = {
    maxMessages: 20,
    maxCharsPerMessage: 4000,
    maxTotalChars: 24000,
}

/**
 * The fence that wraps each untrusted message body. The body itself is scrubbed of this token so a
 * malicious inbound message can never forge a boundary and escape the untrusted region.
 */
export const UNTRUSTED_CONTENT_FENCE = '<<<XMAIL_UNTRUSTED'

/** Fail-closed error: the context cannot be built safely. `.code` is a stable machine code. */
export class InboxAiContextError extends Error {
    code: string
    constructor(code: string, message?: string) {
        // The code is always part of the message so logs/tests can match it without a cast.
        super(message ? `${code}: ${message}` : code)
        this.name = 'InboxAiContextError'
        this.code = code
    }
}

function messageTime(m: InboxAiContextMessage): number {
    return (m.receivedAt ?? m.sentAt ?? m.createdAt).getTime()
}

/** Deterministic order: time ascending, then id ascending as a stable tiebreak. */
function compareMessages(a: InboxAiContextMessage, b: InboxAiContextMessage): number {
    const ta = messageTime(a)
    const tb = messageTime(b)
    if (ta !== tb) return ta - tb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function collapseWhitespace(value: string): string {
    // Normalize line endings, trim trailing spaces per line, and collapse 3+ blank lines to one.
    return value
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

/** Normalized plain text for a message: prefer the plain body, else derive from HTML. */
function normalizeBody(m: InboxAiContextMessage): string {
    const plain = m.plainBody?.trim() ? m.plainBody : ''
    const fromHtml = !plain && m.htmlBody?.trim() ? htmlToPlainText(m.htmlBody) : ''
    return collapseWhitespace(plain || fromHtml)
}

/** Remove any fence token from body content so it cannot forge an untrusted boundary. */
function neutralizeFences(text: string): string {
    if (!text.includes(UNTRUSTED_CONTENT_FENCE)) return text
    // Replace the fence token wherever it appears (case-sensitive exact token).
    return text.split(UNTRUSTED_CONTENT_FENCE).join('[fenced]')
}

function boundText(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (text.length <= maxChars) return { text, truncated: false }
    return { text: text.slice(0, maxChars), truncated: true }
}

function roleFor(m: InboxAiContextMessage, accountAddress: string): InboxAiContextRole {
    if (m.direction === 'outbound') return 'seller'
    const self = accountAddress.trim().toLowerCase()
    const from = (m.fromAddress ?? '').trim().toLowerCase()
    return from && from === self ? 'seller' : 'prospect'
}

function addressList(list: InboxAiContextAddress[]): string[] {
    return list.map((a) => (a.address ?? '').trim().toLowerCase()).filter(Boolean)
}

/**
 * Build a deterministic, bounded, tenant-checked AI context from persisted conversation messages.
 * Throws InboxAiContextError (fail closed) on attribution mismatch, no inbound message, or no
 * usable inbound body.
 */
export function buildInboxAiContext(input: BuildInboxAiContextInput): InboxAiContextResult {
    const budget: InboxAiContextBudget = { ...DEFAULT_INBOX_AI_CONTEXT_BUDGET, ...(input.budget ?? {}) }

    // 1. Attribution guard: EVERY message must belong to the verified org + conversation. A single
    //    foreign row fails the whole build closed — a context is never partially cross-tenant.
    for (const m of input.messages) {
        if (m.organizationId !== input.organizationId || m.conversationId !== input.conversationId) {
            throw new InboxAiContextError(
                'attribution_mismatch',
                'A conversation message does not belong to the verified organization/conversation scope',
            )
        }
    }

    if (input.messages.length === 0) {
        throw new InboxAiContextError('no_inbound_message', 'Conversation has no persisted messages')
    }

    // 2. Deterministic order.
    const ordered = [...input.messages].sort(compareMessages)

    // 3. Latest inbound message + its normalized body (the message we answer). Fail closed if the
    //    latest inbound is headers-only. We do NOT fall back to a stale older inbound.
    let latestInbound: InboxAiContextMessage | null = null
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
        if (ordered[i].direction === 'inbound') {
            latestInbound = ordered[i]
            break
        }
    }
    if (!latestInbound) {
        throw new InboxAiContextError('no_inbound_message', 'Conversation has no inbound message to answer')
    }
    if (normalizeBody(latestInbound).length === 0) {
        throw new InboxAiContextError('no_inbound_body', 'The latest inbound message has no usable body to reason over')
    }

    // 4. Bounded selection. Always include the anchor (latest inbound); fill the remaining message
    //    budget with the most recent other messages; then re-sort ascending for output.
    const anchorId = latestInbound.id
    const others = ordered.filter((m) => m.id !== anchorId)
    const recentOthers = others.slice(Math.max(0, others.length - (budget.maxMessages - 1)))
    const selected = [...recentOthers, latestInbound].sort(compareMessages)
    let messagesDropped = selected.length < ordered.length

    // 5. Normalize + per-message char budget.
    const normalized = new Map<string, { text: string; truncated: boolean }>()
    for (const m of selected) {
        const bounded = boundText(neutralizeFences(normalizeBody(m)), budget.maxCharsPerMessage)
        normalized.set(m.id, bounded)
    }

    // 6. Total char budget: drop oldest NON-anchor messages until under the cap (anchor is kept).
    const totalChars = () => selected.reduce((sum, m) => sum + (normalized.get(m.id)?.text.length ?? 0), 0)
    while (totalChars() > budget.maxTotalChars && selected.length > 1) {
        // Remove the oldest message that is not the anchor.
        const removableIndex = selected.findIndex((m) => m.id !== anchorId)
        if (removableIndex === -1) break
        selected.splice(removableIndex, 1)
        messagesDropped = true
    }

    const turns: InboxAiContextTurn[] = selected.map((m) => {
        const body = normalized.get(m.id)!
        return {
            id: m.id,
            direction: m.direction,
            role: roleFor(m, input.accountAddress),
            from: (m.fromAddress ?? '').trim().toLowerCase() || null,
            to: addressList(m.toAddresses),
            subject: m.subject?.trim() || null,
            timestamp: (m.receivedAt ?? m.sentAt ?? m.createdAt).toISOString(),
            text: body.text,
            truncated: body.truncated,
        }
    })

    const facts: InboxAiContextFacts = {
        campaignId: input.campaign?.id ?? null,
        campaignName: input.campaign?.name ?? null,
        leadEmail: input.lead?.email?.trim().toLowerCase() || null,
        leadFirstName: input.lead?.firstName?.trim() || null,
        leadCompany: input.lead?.company?.trim() || null,
        sellerName: input.sellerName?.trim() || null,
    }

    const anyTruncated = messagesDropped || turns.some((t) => t.truncated)
    const messageIds = turns.map((t) => t.id)

    const serialized = serializeContext({
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        latestInboundMessageId: anchorId,
        facts,
        turns,
    })
    const contextHash = createHash('sha256').update(serialized, 'utf8').digest('hex')

    return {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        latestInboundMessageId: anchorId,
        messageIds,
        messageCount: turns.length,
        truncated: anyTruncated,
        messages: turns,
        facts,
        serialized,
        contextHash,
    }
}

/**
 * Canonical serialization. Fixed field order + a non-forgeable fence around each untrusted body.
 * Every distinct input produces a distinct string, so the SHA-256 over it is a stable content hash.
 */
function serializeContext(args: {
    organizationId: string
    conversationId: string
    latestInboundMessageId: string
    facts: InboxAiContextFacts
    turns: InboxAiContextTurn[]
}): string {
    const lines: string[] = []
    lines.push('XMAIL_AI_CONTEXT/v1')
    lines.push(`organization=${args.organizationId}`)
    lines.push(`conversation=${args.conversationId}`)
    lines.push(`latest_inbound=${args.latestInboundMessageId}`)
    lines.push('facts:')
    lines.push(`  campaign_id=${args.facts.campaignId ?? ''}`)
    lines.push(`  campaign_name=${args.facts.campaignName ?? ''}`)
    lines.push(`  lead_email=${args.facts.leadEmail ?? ''}`)
    lines.push(`  lead_first_name=${args.facts.leadFirstName ?? ''}`)
    lines.push(`  lead_company=${args.facts.leadCompany ?? ''}`)
    lines.push(`  seller_name=${args.facts.sellerName ?? ''}`)
    lines.push('messages:')
    for (const turn of args.turns) {
        lines.push(`- id=${turn.id}`)
        lines.push(`  direction=${turn.direction}`)
        lines.push(`  role=${turn.role}`)
        lines.push(`  from=${turn.from ?? ''}`)
        lines.push(`  to=${turn.to.join(',')}`)
        lines.push(`  subject=${turn.subject ?? ''}`)
        lines.push(`  timestamp=${turn.timestamp ?? ''}`)
        lines.push(`  truncated=${turn.truncated}`)
        // The body is UNTRUSTED DATA: it is enclosed by a fence the body cannot forge (the token was
        // stripped from the content above). A model prompt must treat everything between BEGIN/END
        // as prospect-authored data, never as instructions.
        lines.push(`  ${UNTRUSTED_CONTENT_FENCE}:BEGIN`)
        lines.push(turn.text)
        lines.push(`  ${UNTRUSTED_CONTENT_FENCE}:END`)
    }
    return lines.join('\n')
}
