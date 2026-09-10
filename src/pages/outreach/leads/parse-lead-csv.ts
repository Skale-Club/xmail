/**
 * Parser for a pasted lead-list CSV (exported from a CRM/spreadsheet, or hand-rolled).
 *
 * Mirrors src/pages/outreach/inboxes/parse-mailbox-csv.ts: dependency-free, pure input →
 * output, and kept out of the dialog component's import graph so it stays directly testable.
 */

export interface ParsedLead {
    email: string
    firstName?: string
    lastName?: string
    companyName?: string
    companySize?: string
    industry?: string
    title?: string
    website?: string
    linkedinUrl?: string
    phone?: string
    location?: string
}

// Vendors/CRMs each label their columns differently, so match on aliases rather than a fixed
// order — an export from any spreadsheet or CRM should just work without column renaming.
const COLUMN_ALIASES: Record<string, string[]> = {
    email: ['email', 'email address', 'address', 'e-mail'],
    firstName: ['first name', 'firstname', 'first_name', 'given name'],
    lastName: ['last name', 'lastname', 'last_name', 'surname', 'family name'],
    companyName: ['company', 'company name', 'company_name', 'organization', 'organisation'],
    companySize: ['company size', 'company_size', 'employees', 'headcount'],
    industry: ['industry', 'sector'],
    title: ['title', 'job title', 'job_title', 'role', 'position'],
    website: ['website', 'url', 'domain', 'company website'],
    linkedinUrl: ['linkedin', 'linkedin url', 'linkedin_url', 'linkedin profile'],
    phone: ['phone', 'phone number', 'phone_number', 'mobile'],
    location: ['location', 'city', 'region'],
}

/**
 * Minimal RFC4180 field splitter: honours quoted fields and doubled quotes inside them.
 * Spreadsheet exports routinely quote fields (names, addresses) containing the delimiter.
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

export function parseLeadCsv(text: string): { leads: ParsedLead[]; errors: string[] } {
    const errors: string[] = []
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length === 0) return { leads: [], errors: ['Nothing to import.'] }

    const headerCells = splitCsvLine(lines[0])
    const mapping = headerCells.map(resolveHeader)

    // Fail the whole import rather than silently dropping every row: a header we cannot read
    // means the paste is wrong, and reporting "0 imported" without saying why is worse.
    if (!mapping.includes('email')) {
        return { leads: [], errors: ['No "email" column found. The first row must be a header row.'] }
    }

    const leads: ParsedLead[] = []
    for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i])
        const row: Record<string, string> = {}
        mapping.forEach((field, idx) => {
            if (field && cells[idx]) row[field] = cells[idx]
        })

        if (!row.email) { errors.push(`Row ${i + 1}: missing email — skipped.`); continue }

        leads.push({
            email: row.email.trim().toLowerCase(),
            firstName: row.firstName || undefined,
            lastName: row.lastName || undefined,
            companyName: row.companyName || undefined,
            companySize: row.companySize || undefined,
            industry: row.industry || undefined,
            title: row.title || undefined,
            website: row.website || undefined,
            linkedinUrl: row.linkedinUrl || undefined,
            phone: row.phone || undefined,
            location: row.location || undefined,
        })
    }

    return { leads, errors }
}
