/**
 * Native mailbox that receives aggregate DMARC reports for server-side ingestion.
 * It is a technical sink, not an interactive webmail inbox.
 */
export const DMARC_MAILBOX_ADDRESS = (
    process.env.DMARC_REPORT_MAILBOX || 'dmarc@skale.club'
).trim().toLowerCase()
