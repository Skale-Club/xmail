/**
 * Fase 1 (docs/outbound-authentication-audit.md) — defensive parser for DMARC aggregate
 * reports (RFC 7489 section 7). This module is PURE: no `db`, no network, no filesystem —
 * everything here is a synchronous or in-memory transform, testable without a database, the
 * same split `outreach-silence.ts` documents for `buildAlerts`/`buildSilenceAlerts`.
 *
 * Threat model, stated once because it shapes every choice below: a DMARC report is XML
 * authored by a third party and delivered to an inbox anyone on the internet can write to
 * (`dmarc@skale.club`, once it exists — see `scripts/seed-dmarc-mailbox.ts`). Nothing here may
 * throw on attacker input, execute anything the document contains, or resolve external
 * entities. Concretely:
 *
 *   - No general-purpose XML library is used. A DTD-capable parser can be tricked into
 *     resolving external entities (XXE) or expanding nested self-referential entities
 *     (billion-laughs); a hand-rolled extractor that only ever looks for a fixed, known set of
 *     tag names and never interprets `<!DOCTYPE`/`<!ENTITY` cannot be tricked into either,
 *     because it never implements entity expansion beyond the five predefined XML entities
 *     and numeric character references (`decodeXmlEntities` below).
 *   - Every extraction step returns `null`/skips on anything unexpected instead of throwing.
 *     `parseDmarcXml` and `parseDmarcAttachment` each wrap their body in try/catch as a second
 *     line of defense, but the real guarantee is that nothing inside them is allowed to throw
 *     in the first place — a malformed report is a `null`/`{ ok: false }` result, never an
 *     exception that could take down the ingest job mid-batch.
 *   - Sizes are capped BEFORE the expensive work happens: the compressed attachment is
 *     rejected by its trusted size (captured by our own inbound mailparser at receipt time,
 *     see `mx-server.ts`'s `persistInboundAttachments`) before it is even decompressed, and
 *     decompression itself is streamed with a hard byte ceiling so a crafted gzip/zip bomb
 *     (a small compressed payload expanding to gigabytes) is aborted mid-stream instead of
 *     exhausted into memory. See `MAX_COMPRESSED_ATTACHMENT_BYTES`/`MAX_DECOMPRESSED_XML_BYTES`.
 *   - `MAX_RECORDS_PER_REPORT` bounds how many `<record>` blocks are scanned, so an attacker
 *     cannot force unbounded regex work or unbounded DB writes from one message.
 */

import { createGunzip, createInflateRaw } from 'node:zlib'
import type { Gunzip, InflateRaw } from 'node:zlib'

/**
 * A real DMARC aggregate report for a domain our size sends is a few KB to a few hundred KB
 * compressed, even for the biggest reporters (Google/Microsoft/Yahoo). 5 MB is two-plus orders
 * of magnitude of headroom over anything legitimate we would ever receive for the 9 domains
 * in play, while still being small enough that decompressing it (even adversarially) is cheap
 * to bound — see MAX_DECOMPRESSED_XML_BYTES.
 */
export const MAX_COMPRESSED_ATTACHMENT_BYTES = 5 * 1024 * 1024

/**
 * Hard ceiling on decompressed bytes, enforced by aborting the decompression STREAM the moment
 * cumulative output crosses this line — not by decompressing fully and checking the result,
 * which would already have paid the memory cost a zip/gzip bomb is designed to inflict. 25 MB
 * is generous for the largest plausible legitimate aggregate XML (a huge sender reporting
 * thousands of distinct source IPs) while keeping a single malicious attachment's worst-case
 * memory cost bounded to roughly this figure, not gigabytes.
 */
export const MAX_DECOMPRESSED_XML_BYTES = 25 * 1024 * 1024

/**
 * Caps how many `<record>` blocks a single report contributes. Bounds both the regex-scanning
 * cost of a maliciously repetitive document and the number of rows one message could write to
 * `dmarc_report_records`. A legitimate report for our traffic volume has single or low-double
 * digit records (one per distinct sending source IP); 10,000 is far beyond any real report
 * while still being small enough that hitting the cap is itself a signal something is off.
 */
export const MAX_RECORDS_PER_REPORT = 10_000

/** Sanity ceiling on a single record's `<count>` — guards against a corrupted/adversarial value
 *  overflowing downstream aggregation, not a real limit any legitimate report would approach. */
const MAX_MESSAGE_COUNT_PER_RECORD = 1_000_000_000

export interface DmarcParsedRecord {
    sourceIp: string | null
    messageCount: number
    /** `policy_evaluated/disposition` — none | quarantine | reject, untrusted free text otherwise. */
    disposition: string | null
    /** `auth_results/dkim/result` — the RAW (pre-alignment) DKIM validation result. */
    dkimResult: string | null
    /** `auth_results/dkim/domain` — the domain that actually signed, may differ from header_from. */
    dkimDomain: string | null
    /** `auth_results/spf/result` — the RAW (pre-alignment) SPF validation result. */
    spfResult: string | null
    /** `auth_results/spf/domain` — the domain SPF was checked against. */
    spfDomain: string | null
    /** `identifiers/header_from` — the domain that actually matters for DMARC alignment. */
    headerFrom: string | null
    /** `policy_evaluated/dkim` — the ALIGNED DKIM verdict DMARC itself used, distinct from dkimResult. */
    policyDkimAligned: string | null
    /** `policy_evaluated/spf` — the ALIGNED SPF verdict DMARC itself used, distinct from spfResult. */
    policySpfAligned: string | null
}

export interface DmarcParsedReport {
    reportId: string
    reportingOrg: string
    /** `policy_published/domain` — the domain whose DMARC policy this report is about. */
    domain: string
    dateRangeBegin: Date
    dateRangeEnd: Date
    records: DmarcParsedRecord[]
}

export type DmarcAttachmentParseResult =
    | { ok: true; report: DmarcParsedReport }
    | { ok: false; reason: string }

/** Decodes only the five predefined XML entities plus numeric character references. Anything
 *  else (a custom `&name;` entity, which would require a DOCTYPE this parser never reads) is
 *  left untouched rather than guessed at — see the module header for why that is the point. */
function decodeXmlEntities(input: string): string {
    return input.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (whole, ent: string) => {
        switch (ent) {
            case 'amp': return '&'
            case 'lt': return '<'
            case 'gt': return '>'
            case 'quot': return '"'
            case 'apos': return "'"
            default: {
                const isHex = ent.startsWith('#x')
                const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
                if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
                try {
                    return String.fromCodePoint(code)
                } catch {
                    return whole
                }
            }
        }
    })
}

/** First `<tagName>...</tagName>` match's TEXT content, trimmed and entity-decoded, or null. */
function extractTag(xml: string, tagName: string): string | null {
    const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i')
    const match = re.exec(xml)
    if (!match) return null
    return decodeXmlEntities(match[1].trim())
}

/** First `<tagName>...</tagName>` match's RAW inner XML (not entity-decoded — used to scope
 *  further extraction to a sub-block), or null. */
function extractBlock(xml: string, tagName: string): string | null {
    const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i')
    const match = re.exec(xml)
    return match ? match[1] : null
}

/** Every `<tagName>...</tagName>` match's raw inner XML, capped at `max` matches. */
function extractAllBlocks(xml: string, tagName: string, max: number): string[] {
    const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi')
    const blocks: string[] = []
    let match: RegExpExecArray | null
    while (blocks.length < max && (match = re.exec(xml)) !== null) {
        blocks.push(match[1])
        if (match.index === re.lastIndex) re.lastIndex += 1 // never spin on a zero-length match
    }
    return blocks
}

/** `<begin>`/`<end>` are epoch seconds per RFC 7489. Rejects anything outside a sane calendar
 *  range (year 2000 through one day in the future) rather than trusting an arbitrary integer —
 *  a report is never legitimately about a date outside that range. */
function parseEpochSeconds(raw: string | null): Date | null {
    if (!raw) return null
    const seconds = Number(raw)
    if (!Number.isFinite(seconds)) return null
    const date = new Date(seconds * 1000)
    const minMs = Date.UTC(2000, 0, 1)
    const maxMs = Date.now() + 24 * 60 * 60 * 1000
    if (date.getTime() < minMs || date.getTime() > maxMs) return null
    return date
}

/** Untrusted free-text result/disposition fields: lowercased, trimmed, length-capped. Never
 *  validated against an enum here — an unexpected value (a reporter's typo, a future RFC
 *  addition) is stored as-is rather than discarded, so the query layer decides what counts as
 *  "pass" and everything else is visible for debugging instead of silently vanishing. */
function normalizeShortField(raw: string | null, maxLen: number): string | null {
    if (!raw) return null
    const trimmed = raw.trim().toLowerCase()
    return trimmed.length > 0 ? trimmed.slice(0, maxLen) : null
}

function parseMessageCount(raw: string | null): number | null {
    if (!raw) return null
    const count = Number(raw)
    if (!Number.isFinite(count) || count <= 0) return null
    return Math.min(Math.floor(count), MAX_MESSAGE_COUNT_PER_RECORD)
}

/**
 * Parses a decompressed DMARC aggregate XML document. Pure and synchronous — never throws
 * (a try/catch is the second line of defense; every extraction step already degrades to null
 * on its own). Returns null for anything missing report-level required fields
 * (org name/report id/domain/date range) — a report the parser cannot identify is not
 * ingestable regardless of how many `<record>` blocks it contains.
 */
export function parseDmarcXml(xml: string): DmarcParsedReport | null {
    try {
        if (typeof xml !== 'string' || xml.trim().length === 0) return null

        const metadataBlock = extractBlock(xml, 'report_metadata')
        const orgName = metadataBlock ? extractTag(metadataBlock, 'org_name') : null
        const reportId = metadataBlock ? extractTag(metadataBlock, 'report_id') : null
        const dateRangeBlock = metadataBlock ? extractBlock(metadataBlock, 'date_range') : null
        const dateRangeBegin = parseEpochSeconds(dateRangeBlock ? extractTag(dateRangeBlock, 'begin') : null)
        const dateRangeEnd = parseEpochSeconds(dateRangeBlock ? extractTag(dateRangeBlock, 'end') : null)

        const policyBlock = extractBlock(xml, 'policy_published')
        const domain = normalizeShortField(policyBlock ? extractTag(policyBlock, 'domain') : null, 253)

        if (!orgName || !reportId || !domain || !dateRangeBegin || !dateRangeEnd) {
            return null
        }

        const recordBlocks = extractAllBlocks(xml, 'record', MAX_RECORDS_PER_REPORT)
        const records: DmarcParsedRecord[] = []

        for (const block of recordBlocks) {
            const rowBlock = extractBlock(block, 'row')
            const sourceIp = normalizeShortField(rowBlock ? extractTag(rowBlock, 'source_ip') : null, 64)
            const messageCount = parseMessageCount(rowBlock ? extractTag(rowBlock, 'count') : null)
            if (messageCount === null) continue // unusable row — skip it, do not fail the whole report

            const policyEvaluatedBlock = rowBlock ? extractBlock(rowBlock, 'policy_evaluated') : null
            const disposition = normalizeShortField(policyEvaluatedBlock ? extractTag(policyEvaluatedBlock, 'disposition') : null, 32)
            const policyDkimAligned = normalizeShortField(policyEvaluatedBlock ? extractTag(policyEvaluatedBlock, 'dkim') : null, 16)
            const policySpfAligned = normalizeShortField(policyEvaluatedBlock ? extractTag(policyEvaluatedBlock, 'spf') : null, 16)

            const identifiersBlock = extractBlock(block, 'identifiers')
            const headerFrom = normalizeShortField(identifiersBlock ? extractTag(identifiersBlock, 'header_from') : null, 253)

            const authResultsBlock = extractBlock(block, 'auth_results')
            const dkimBlock = authResultsBlock ? extractBlock(authResultsBlock, 'dkim') : null
            const spfBlock = authResultsBlock ? extractBlock(authResultsBlock, 'spf') : null

            records.push({
                sourceIp,
                messageCount,
                disposition,
                dkimResult: normalizeShortField(dkimBlock ? extractTag(dkimBlock, 'result') : null, 16),
                dkimDomain: normalizeShortField(dkimBlock ? extractTag(dkimBlock, 'domain') : null, 253),
                spfResult: normalizeShortField(spfBlock ? extractTag(spfBlock, 'result') : null, 16),
                spfDomain: normalizeShortField(spfBlock ? extractTag(spfBlock, 'domain') : null, 253),
                headerFrom,
                policyDkimAligned,
                policySpfAligned,
            })
        }

        return {
            reportId: reportId.slice(0, 512),
            reportingOrg: orgName.slice(0, 256),
            domain,
            dateRangeBegin,
            dateRangeEnd,
            records,
        }
    } catch {
        return null
    }
}

type CappableStream = Gunzip | InflateRaw

/** Streams `input` through `stream`, aborting (destroying the stream, discarding buffered
 *  output) the instant cumulative output exceeds `capBytes`. This is what makes the size cap
 *  real against a decompression bomb: the cost of an oversized result is bounded to ~capBytes,
 *  not to however large the attacker made the fully-decompressed content. Never rejects/throws
 *  — always resolves, with null standing for "could not decompress within the cap". */
function decompressStreamCapped(stream: CappableStream, input: Buffer, capBytes: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = []
        let total = 0
        let failed = false

        stream.on('data', (chunk: Buffer) => {
            if (failed) return
            total += chunk.length
            if (total > capBytes) {
                failed = true
                stream.destroy()
                return
            }
            chunks.push(chunk)
        })
        stream.on('error', () => { failed = true })
        stream.on('close', () => resolve(failed ? null : Buffer.concat(chunks)))

        try {
            stream.end(input)
        } catch {
            failed = true
        }
    })
}

function decompressGzipCapped(bytes: Buffer, capBytes: number): Promise<Buffer | null> {
    return decompressStreamCapped(createGunzip(), bytes, capBytes)
}

/** Reads just enough of a ZIP local-file-header (PK\x03\x04) to locate ONE entry's compressed
 *  bytes and compression method. Deliberately narrow: DMARC reporters that use zip send a
 *  single XML file per archive, so this never attempts to walk a central directory or handle
 *  multiple entries. Anything shaped differently (streamed data-descriptor entries, a missing
 *  compressed-size field, a truncated header) returns null rather than guessing. */
function readZipSingleLocalEntry(bytes: Buffer): { method: number; compressedData: Buffer } | null {
    if (bytes.length < 30) return null
    if (bytes.readUInt32LE(0) !== 0x04034b50) return null

    const generalPurposeFlag = bytes.readUInt16LE(6)
    const method = bytes.readUInt16LE(8)
    const compressedSize = bytes.readUInt32LE(18)
    const filenameLength = bytes.readUInt16LE(26)
    const extraLength = bytes.readUInt16LE(28)

    // Bit 3 set means sizes live in a trailing data descriptor instead of the local header —
    // a shape this narrow reader does not support. Reject rather than mis-slice the data.
    if ((generalPurposeFlag & 0x0008) !== 0) return null
    if (compressedSize === 0) return null

    const dataStart = 30 + filenameLength + extraLength
    if (dataStart + compressedSize > bytes.length) return null

    return { method, compressedData: bytes.subarray(dataStart, dataStart + compressedSize) }
}

async function decompressZipSingleEntryCapped(bytes: Buffer, capBytes: number): Promise<Buffer | null> {
    const entry = readZipSingleLocalEntry(bytes)
    if (!entry) return null

    if (entry.method === 0) { // stored (no compression)
        return entry.compressedData.length <= capBytes ? entry.compressedData : null
    }
    if (entry.method === 8) { // deflate
        return decompressStreamCapped(createInflateRaw(), entry.compressedData, capBytes)
    }
    return null // unsupported method (e.g. bzip2/lzma) — no attempt to guess
}

type AttachmentFormat = 'gzip' | 'zip' | 'xml' | 'unknown'

/** Sniffs the actual bytes rather than trusting the third party's filename/Content-Type,
 *  which are exactly the untrusted fields the module header warns about. */
function detectAttachmentFormat(bytes: Buffer): AttachmentFormat {
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip'
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return 'zip'
    const head = bytes.subarray(0, 256).toString('utf8').trimStart()
    if (head.startsWith('<?xml') || head.startsWith('<feedback')) return 'xml'
    return 'unknown'
}

export interface DmarcAttachmentMeta {
    filename?: string | null
    contentType?: string | null
    /** Trusted byte length captured by OUR OWN inbound mailparser at receipt time (see
     *  `mx-server.ts`'s `persistInboundAttachments`) — checked before `bytes` is even read, so
     *  an oversized attachment is rejected without decompressing anything. */
    sizeBytes: number
}

/**
 * Full pipeline: cap check -> format sniff -> capped decompression -> pure XML parse. Never
 * throws — every failure path returns `{ ok: false, reason }` with a reason safe to log
 * (it never echoes attacker-controlled content, only sizes/formats this code itself computed).
 */
export async function parseDmarcAttachment(bytes: Buffer, meta: DmarcAttachmentMeta): Promise<DmarcAttachmentParseResult> {
    try {
        if (meta.sizeBytes > MAX_COMPRESSED_ATTACHMENT_BYTES || bytes.length > MAX_COMPRESSED_ATTACHMENT_BYTES) {
            return {
                ok: false,
                reason: `attachment exceeds ${MAX_COMPRESSED_ATTACHMENT_BYTES}-byte compressed cap (reported ${meta.sizeBytes}, actual ${bytes.length})`,
            }
        }

        const format = detectAttachmentFormat(bytes)
        let xmlBuffer: Buffer | null

        switch (format) {
            case 'gzip':
                xmlBuffer = await decompressGzipCapped(bytes, MAX_DECOMPRESSED_XML_BYTES)
                break
            case 'zip':
                xmlBuffer = await decompressZipSingleEntryCapped(bytes, MAX_DECOMPRESSED_XML_BYTES)
                break
            case 'xml':
                xmlBuffer = bytes.length <= MAX_DECOMPRESSED_XML_BYTES ? bytes : null
                break
            default:
                return { ok: false, reason: `unrecognized attachment format (filename=${meta.filename ?? 'n/a'})` }
        }

        if (!xmlBuffer) {
            return { ok: false, reason: `attachment could not be decompressed within the ${MAX_DECOMPRESSED_XML_BYTES}-byte cap` }
        }

        const report = parseDmarcXml(xmlBuffer.toString('utf8'))
        if (!report) {
            return { ok: false, reason: 'decompressed XML did not contain the expected DMARC aggregate report fields' }
        }

        return { ok: true, report }
    } catch (err) {
        return { ok: false, reason: `unexpected parse error: ${err instanceof Error ? err.message : String(err)}` }
    }
}
