/**
 * Fase 1 Part A.2 (docs/outbound-authentication-audit.md) — I/O half of DMARC ingestion.
 * Reads unread mail in the DMARC reporting mailbox (`scripts/seed-dmarc-mailbox.ts` provisions
 * it), extracts each attachment, hands it to the PURE parser (`dmarc-parser.ts`), and persists
 * deduplicated rows. Kept separate from the parser for the same reason `outreach-silence.ts`/
 * `outreach-silence-query.ts` are split: everything that touches `db` lives here, untested
 * directly (see that file's own header); everything that decides what a report MEANS is pure
 * and lives in dmarc-parser.ts, tested directly against fixtures.
 */

import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import {
    domains,
    dmarcReportRecords,
    dmarcReports,
    INBOX_ATTACHMENTS_BUCKET,
    mailFolders,
    mailMessages,
    mailboxes,
} from '../../db/schema'
import { createObjectStorage } from './object-storage'
import { parseDmarcAttachment, type DmarcParsedReport } from './dmarc-parser'
import { createLogger } from './logger'

const log = createLogger('dmarc.ingest')

/**
 * The mailbox `scripts/seed-dmarc-mailbox.ts` provisions and `skale.club`'s DMARC `rua` now
 * names. Overridable so a different environment (or a future additional reporting domain)
 * does not require a code change, but defaults to the actual address this Fase 1 pass wires up.
 */
export const DMARC_MAILBOX_ADDRESS = (process.env.DMARC_REPORT_MAILBOX || 'dmarc@skale.club').toLowerCase()

/** Bounds how many unread messages one tick processes, so a burst of mail (legitimate or a
 *  mailbox anyone can write to being abused) cannot make a single tick unbounded. Reports
 *  arrive roughly daily per reporting org (see DMARC_REPORT_GAP_HOURS in outreach-silence.ts);
 *  100 is far above any plausible daily volume across the 9 domains in play. */
const MAX_MESSAGES_PER_TICK = 100

interface InboundAttachmentMeta {
    filename?: string
    contentType?: string
    size?: number
    storageKey?: string
}

/** Sniffs by filename/content-type ONLY to decide whether an attachment is worth downloading
 *  at all — the actual format used to decide HOW to decompress it is the magic-byte sniff
 *  inside dmarc-parser.ts, never this. Saves a storage round-trip for attachments that are
 *  obviously not a DMARC report (an inline image, a PDF) without trusting these fields for
 *  anything security-relevant. */
function looksLikeDmarcAttachment(att: InboundAttachmentMeta): boolean {
    const name = (att.filename || '').toLowerCase()
    const type = (att.contentType || '').toLowerCase()
    return name.endsWith('.xml') || name.endsWith('.xml.gz') || name.endsWith('.gz') || name.endsWith('.zip')
        || type.includes('gzip') || type.includes('zip') || type.includes('xml')
}

export interface DmarcIngestResult {
    mailboxFound: boolean
    messagesScanned: number
    reportsIngested: number
    reportsDuplicate: number
    attachmentsRejected: number
}

/**
 * Inserts one `dmarc_reports` row (ON CONFLICT DO NOTHING on reporting_org+report_id+domain —
 * see migration 067) and, only if that insert actually happened, its `dmarc_report_records`
 * children. This ordering is the whole dedup guarantee: a report already seen never reaches the
 * records insert, so re-reading a message (a retried tick, a message that was never marked
 * read for some other reason) can never double-count. Returns true iff this call was the one
 * that actually stored the report.
 */
async function persistReport(report: DmarcParsedReport, sourceMessageId: string): Promise<boolean> {
    const domainRow = await db.query.domains.findFirst({ where: eq(domains.name, report.domain) })

    const inserted = await db.insert(dmarcReports).values({
        organizationId: domainRow?.organizationId ?? null,
        domain: report.domain,
        reportingOrg: report.reportingOrg,
        reportId: report.reportId,
        dateRangeBegin: report.dateRangeBegin,
        dateRangeEnd: report.dateRangeEnd,
        sourceMessageId,
        recordCount: report.records.length,
    })
        .onConflictDoNothing({ target: [dmarcReports.reportingOrg, dmarcReports.reportId, dmarcReports.domain] })
        .returning({ id: dmarcReports.id })

    const row = inserted[0]
    if (!row) return false // already ingested — records were already written the first time

    if (report.records.length > 0) {
        await db.insert(dmarcReportRecords).values(report.records.map((record) => ({
            reportId: row.id,
            sourceIp: record.sourceIp,
            messageCount: record.messageCount,
            disposition: record.disposition,
            dkimResult: record.dkimResult,
            dkimDomain: record.dkimDomain,
            spfResult: record.spfResult,
            spfDomain: record.spfDomain,
            headerFrom: record.headerFrom,
            policyDkimAligned: record.policyDkimAligned,
            policySpfAligned: record.policySpfAligned,
        })))
    }

    return true
}

/**
 * Reads unread mail from the DMARC mailbox, parses every plausible attachment, and persists
 * deduplicated report rows. Every message is marked read at the end of its own processing loop
 * regardless of outcome — including a message that produced zero valid reports — because the
 * alternative (leave it unread on any failure) would retry a permanently-malformed message on
 * every tick forever. Rejections are logged (see dmarc-parser.ts's reasons) for a human to
 * find; nothing here throws on a single bad message, so one poisoned message cannot stop the
 * rest of the batch from being ingested.
 */
export async function ingestDmarcReports(): Promise<DmarcIngestResult> {
    const result: DmarcIngestResult = {
        mailboxFound: false,
        messagesScanned: 0,
        reportsIngested: 0,
        reportsDuplicate: 0,
        attachmentsRejected: 0,
    }

    const mailbox = await db.query.mailboxes.findFirst({
        where: and(eq(mailboxes.email, DMARC_MAILBOX_ADDRESS), eq(mailboxes.isNative, true)),
    })
    if (!mailbox) {
        log.warn(
            { action: 'dmarc.ingest.mailbox_missing', address: DMARC_MAILBOX_ADDRESS },
            'DMARC reporting mailbox does not exist yet — run scripts/seed-dmarc-mailbox.ts',
        )
        return result
    }
    result.mailboxFound = true

    const inbox = await db.query.mailFolders.findFirst({
        where: and(eq(mailFolders.mailboxId, mailbox.id), eq(mailFolders.type, 'inbox')),
    })
    if (!inbox) return result

    const unread = await db.query.mailMessages.findMany({
        where: and(
            eq(mailMessages.mailboxId, mailbox.id),
            eq(mailMessages.folderId, inbox.id),
            eq(mailMessages.isRead, false),
        ),
        orderBy: [mailMessages.receivedAt],
        limit: MAX_MESSAGES_PER_TICK,
    })

    const storage = createObjectStorage()

    for (const message of unread) {
        result.messagesScanned += 1
        const attachments = Array.isArray(message.attachments)
            ? (message.attachments as InboundAttachmentMeta[])
            : []

        for (const attachment of attachments) {
            if (!attachment?.storageKey || !looksLikeDmarcAttachment(attachment)) continue

            let bytes: Buffer
            try {
                bytes = await storage.download(INBOX_ATTACHMENTS_BUCKET, attachment.storageKey)
            } catch (err) {
                log.warn(
                    { action: 'dmarc.ingest.download_failed', messageId: message.id, error: err instanceof Error ? err.message : String(err) },
                    'could not download DMARC attachment',
                )
                result.attachmentsRejected += 1
                continue
            }

            const parsed = await parseDmarcAttachment(bytes, {
                filename: attachment.filename ?? null,
                contentType: attachment.contentType ?? null,
                sizeBytes: attachment.size ?? bytes.length,
            })

            if (!parsed.ok) {
                log.warn(
                    { action: 'dmarc.ingest.parse_rejected', messageId: message.id, reason: parsed.reason },
                    'DMARC attachment rejected',
                )
                result.attachmentsRejected += 1
                continue
            }

            const stored = await persistReport(parsed.report, message.id)
            if (stored) result.reportsIngested += 1
            else result.reportsDuplicate += 1
        }

        await db.update(mailMessages)
            .set({ isRead: true, updatedAt: new Date() })
            .where(eq(mailMessages.id, message.id))
    }

    log.info(
        {
            action: 'dmarc.ingest.tick_complete',
            messagesScanned: result.messagesScanned,
            reportsIngested: result.reportsIngested,
            reportsDuplicate: result.reportsDuplicate,
            attachmentsRejected: result.attachmentsRejected,
        },
        `DMARC ingest processed ${result.messagesScanned} message(s), stored ${result.reportsIngested} new report(s)`,
    )

    return result
}
