/**
 * Parser for vendor mailbox-credential exports (IceMail, Primeforge, or a hand-rolled sheet).
 *
 * Deliberately dependency-free and separate from the dialog that uses it: it is pure input →
 * output, it is where every real-world CSV quirk lands, and keeping it out of the component's
 * import graph is what makes it directly testable.
 */

import { resolveSmtpSecurity } from '../../../server/lib/smtp-security'

export interface ParsedMailbox {
    email: string
    smtpHost: string
    smtpPort: number
    smtpUsername: string
    smtpPassword: string
    smtpSecure: boolean
    imapHost?: string
    imapPort: number
    imapUsername?: string
    imapPassword?: string
    imapSecure: boolean
}

// Vendors each label their columns differently, so match on aliases rather than a fixed order —
// an IceMail export and a Primeforge export should both just work without the user editing them.
const COLUMN_ALIASES: Record<string, string[]> = {
    email: ['email', 'email address', 'address', 'username', 'user'],
    smtpHost: ['smtp host', 'smtp server', 'smtp_host', 'smtphost', 'outgoing server'],
    smtpPort: ['smtp port', 'smtp_port', 'smtpport'],
    smtpUsername: ['smtp username', 'smtp user', 'smtp_username', 'smtp login'],
    smtpPassword: ['smtp password', 'password', 'smtp_password', 'smtp pass', 'app password'],
    imapHost: ['imap host', 'imap server', 'imap_host', 'imaphost', 'incoming server'],
    imapPort: ['imap port', 'imap_port', 'imapport'],
    imapUsername: ['imap username', 'imap user', 'imap_username', 'imap login'],
    imapPassword: ['imap password', 'imap_password', 'imap pass'],
}

/**
 * Minimal RFC4180 field splitter: honours quoted fields and doubled quotes inside them.
 * Vendor exports quote passwords, which routinely contain the delimiter.
 */
function splitCsvLine(line: string): string[] {
    const out: string[] = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
            } else cur += ch
        } else if (ch === '"') inQuotes = true
        else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur); cur = '' }
        else cur += ch
    }
    out.push(cur)
    return out.map((s) => s.trim())
}

function resolveHeader(header: string): string | null {
    const h = header.trim().toLowerCase()
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (aliases.includes(h)) return field
    }
    return null
}

export function parseMailboxCsv(text: string): { mailboxes: ParsedMailbox[]; errors: string[] } {
    const errors: string[] = []
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length === 0) return { mailboxes: [], errors: ['Nothing to import.'] }

    const headerCells = splitCsvLine(lines[0])
    const mapping = headerCells.map(resolveHeader)

    // Fail the whole import rather than silently dropping every row: a header we cannot read
    // means the paste is wrong, and reporting "0 imported" without saying why is worse.
    if (!mapping.includes('email')) {
        return { mailboxes: [], errors: ['No "email" column found. The first row must be a header row.'] }
    }
    if (!mapping.includes('smtpPassword')) {
        return { mailboxes: [], errors: ['No password column found. Expected a header like "SMTP Password" or "Password".'] }
    }

    const mailboxes: ParsedMailbox[] = []
    for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i])
        const row: Record<string, string> = {}
        mapping.forEach((field, idx) => {
            if (field && cells[idx]) row[field] = cells[idx]
        })

        if (!row.email) { errors.push(`Row ${i + 1}: missing email — skipped.`); continue }
        if (!row.smtpPassword) { errors.push(`Row ${i + 1}: missing password — skipped.`); continue }
        if (!row.smtpHost) { errors.push(`Row ${i + 1}: missing SMTP host — skipped.`); continue }

        const smtpPort = Number(row.smtpPort) || 587
        const imapPort = Number(row.imapPort) || 993
        // The server lowercases the address for dedup, so a derived username must come from the
        // same normalized value — otherwise a sheet with "Erin@ACME.com" yields an inbox whose
        // email and smtpUsername disagree in case for no reason. An explicitly supplied username
        // is passed through untouched: that one is the vendor's to define, not ours to normalize.
        const email = row.email.toLowerCase()

        mailboxes.push({
            email,
            smtpHost: row.smtpHost,
            smtpPort,
            // Vendors commonly omit the username when it is the address.
            smtpUsername: row.smtpUsername || email,
            smtpPassword: row.smtpPassword,
            // Derived from the port by the same resolver the API validates against and the
            // sender dials with, so an import cannot produce a row the server would 422
            // (or, worse, one that verifies and then fails to send).
            smtpSecure: resolveSmtpSecurity({ port: smtpPort }).secure,
            imapHost: row.imapHost || undefined,
            imapPort,
            imapUsername: row.imapHost ? (row.imapUsername || email) : undefined,
            imapPassword: row.imapHost ? (row.imapPassword || row.smtpPassword) : undefined,
            imapSecure: true,
        })
    }

    return { mailboxes, errors }
}
