/**
 * Shared normalization for Unified Inbox ingestion (Phase 21 UIF-02/03).
 *
 * Every provider — native mail, IMAP, Microsoft Graph — funnels its raw fields through
 * this ONE module before anything is looked up or persisted. Centralizing it here is the
 * point: address casing, angle-bracket stripping, Message-ID/References tokenization,
 * subject roots, previews, and source keys are computed identically for matching and for
 * storage, so a reply threads onto the same conversation no matter which provider carried
 * it. Nothing here logs; callers pass already-parsed values.
 */
import { randomUUID } from 'node:crypto'
import type { OutreachProviderName } from '@/db/schema'
import type { NormalizedInboxAddress } from './types'

const MAX_MESSAGE_ID_LENGTH = 500
const MAX_SUBJECT_LENGTH = 500

// ------------------------------------------------------------
// Addresses
// ------------------------------------------------------------

function parseOneAddress(raw: string): NormalizedInboxAddress | null {
    const trimmed = raw.trim()
    if (!trimmed) return null

    let name: string | null = null
    let addressPart = trimmed

    const angle = trimmed.match(/<([^>]*)>/)
    if (angle) {
        addressPart = angle[1]
        const namePart = trimmed.slice(0, angle.index).trim().replace(/^"(.*)"$/, '$1').trim()
        name = namePart || null
    }

    const address = addressPart.trim().toLowerCase()
    // An address token that is not shaped like an address (no @, or embedded whitespace) is
    // dropped rather than stored — a garbage participant row helps nobody.
    if (!address.includes('@') || /\s/.test(address)) return null
    return { address, name }
}

/** Lower-cased, angle-bracket-stripped address, or null if the token is not an address. */
export function normalizeAddress(raw: string | null | undefined): string | null {
    if (!raw) return null
    return parseOneAddress(raw)?.address ?? null
}

/** Normalized address plus any display name the provider supplied. */
export function normalizeAddressEntry(raw: string | null | undefined): NormalizedInboxAddress | null {
    if (!raw) return null
    return parseOneAddress(raw)
}

/** Splits a header address list on top-level commas (ignoring commas inside quotes/angles). */
function splitAddressList(raw: string): string[] {
    const parts: string[] = []
    let current = ''
    let inQuote = false
    let inAngle = false
    for (const ch of raw) {
        if (ch === '"') inQuote = !inQuote
        else if (ch === '<') inAngle = true
        else if (ch === '>') inAngle = false
        if (ch === ',' && !inQuote && !inAngle) {
            parts.push(current)
            current = ''
            continue
        }
        current += ch
    }
    if (current.trim()) parts.push(current)
    return parts
}

/**
 * Normalizes a header address list (comma string or array) into de-duplicated entries.
 * The first occurrence of an address wins its display name.
 */
export function normalizeAddressList(raw: string | string[] | null | undefined): NormalizedInboxAddress[] {
    if (!raw) return []
    const tokens = Array.isArray(raw) ? raw : splitAddressList(raw)
    const seen = new Map<string, NormalizedInboxAddress>()
    for (const token of tokens) {
        const entry = parseOneAddress(token)
        if (entry && !seen.has(entry.address)) seen.set(entry.address, entry)
    }
    return [...seen.values()]
}

// ------------------------------------------------------------
// Message-IDs and References
// ------------------------------------------------------------

/** Strips angle brackets and trims a single Message-ID, preserving its case for storage. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
    const normalized = raw?.replace(/[<>]/g, '').trim()
    return normalized ? normalized.slice(0, MAX_MESSAGE_ID_LENGTH) : null
}

/** Tokenizes a References header (string or array) into normalized ids, order preserved. */
export function normalizeReferences(raw: string | string[] | null | undefined): string[] {
    if (!raw) return []
    const tokens = Array.isArray(raw) ? raw : raw.split(/\s+/)
    const seen = new Set<string>()
    const out: string[] = []
    for (const token of tokens) {
        const normalized = normalizeMessageId(token)
        if (normalized && !seen.has(normalized)) {
            seen.add(normalized)
            out.push(normalized)
        }
    }
    return out
}

// ------------------------------------------------------------
// Subjects
// ------------------------------------------------------------

/** Trimmed subject, capped; null when blank. */
export function normalizeSubject(raw: string | null | undefined): string | null {
    const trimmed = raw?.trim()
    return trimmed ? trimmed.slice(0, MAX_SUBJECT_LENGTH) : null
}

// Reply/forward prefixes across EN/PT/ES that must be peeled to reach the thread root.
const SUBJECT_PREFIX_RE = /^\s*(re|res|fw|fwd|enc|encaminhada|rv)\s*(\[\d+\])?\s*:\s*/i

/** Lower-cased subject with reply/forward prefixes removed — the thread-root form. */
export function normalizeSubjectRoot(raw: string | null | undefined): string | null {
    let subject = raw?.trim() ?? ''
    if (!subject) return null
    // Peel repeatedly: "Re: Fwd: x" has two prefixes.
    let previous: string
    do {
        previous = subject
        subject = subject.replace(SUBJECT_PREFIX_RE, '')
    } while (subject !== previous)
    const root = subject.trim().toLowerCase()
    return root || null
}

// ------------------------------------------------------------
// Source keys and thread keys
// ------------------------------------------------------------

/**
 * The per-account dedupe identity of a normalized message. It is derived from the provider's
 * immutable identity, NOT the RFC Message-ID (which is neither globally unique nor
 * trustworthy). Replay of the same provider item resolves to the same source key and conflicts.
 */
export function buildSourceKey(provider: OutreachProviderName, providerMessageId: string): string {
    return `${provider}:${providerMessageId}`
}

/** Thread key rooted at an RFC Message-ID, lower-cased for case-insensitive convergence. */
export function rfcThreadKey(rootMessageId: string): string {
    return `rfc:${(normalizeMessageId(rootMessageId) ?? rootMessageId).toLowerCase()}`
}

/** Address-heuristic conversations converge per lead so header-less replies do not fan out. */
export function leadThreadKey(leadId: string): string {
    return `lead:${leadId}`
}

/** A brand-new thread key for a message that carries no threading information at all. */
export function generatedThreadKey(): string {
    return `gen:${randomUUID()}`
}

/**
 * The thread key for an unmatched message: the reference root if any threading exists
 * (so every reply in a chain converges on the same key), otherwise a fresh generated key.
 */
export function deriveThreadKey(input: {
    references: string[]
    inReplyTo: string | null
    internetMessageId: string | null
}): string {
    const root = input.references[0] ?? input.inReplyTo ?? input.internetMessageId
    return root ? rfcThreadKey(root) : generatedThreadKey()
}

// ------------------------------------------------------------
// Previews and safe headers
// ------------------------------------------------------------

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function stripHtml(html: string): string {
    return collapseWhitespace(html.replace(/<[^>]+>/g, ' '))
}

/** A short, whitespace-collapsed, tag-free preview from whichever body exists. */
export function bodyPreview(
    text: string | null | undefined,
    html: string | null | undefined,
    maxLength = 200,
): string | null {
    const fromText = text?.trim() ? collapseWhitespace(text) : ''
    const preview = fromText || (html?.trim() ? stripHtml(html) : '')
    if (!preview) return null
    return preview.slice(0, maxLength)
}

// Only headers safe to persist and expose. Credential/token-bearing headers never appear
// here, so a stored conversation can never leak an auth secret through its header blob.
// Exported so provider adapters (e.g. the IMAP raw-MIME parser) can extract the SAME set at
// staging time, keeping the retained headers equivalent across native/IMAP/Graph.
export const SAFE_HEADER_ALLOW_LIST = new Set([
    'subject',
    'date',
    'message-id',
    'in-reply-to',
    'references',
    'from',
    'to',
    'cc',
    'reply-to',
    'return-path',
    'content-type',
    'auto-submitted',
    'precedence',
    'x-auto-response-suppress',
    'x-priority',
    'importance',
    'list-unsubscribe',
    'list-id',
])

/** Keeps only the safe-header allow-list, dropping anything credential-bearing. */
export function sanitizeHeaders(headers: Record<string, string> | null | undefined): Record<string, string> {
    if (!headers) return {}
    const safe: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase()
        if (SAFE_HEADER_ALLOW_LIST.has(lower) && typeof value === 'string') {
            safe[lower] = value
        }
    }
    return safe
}
