import { hasMxRecord } from './recipient-mx'

// Maps Xphere's bulk-import `customFields` verification signals onto the EXISTING
// `leads.emailVerificationStatus` / `emailVerificationProvider` / `emailVerifiedAt` columns
// (migration 046) instead of adding new columns. Shared by every lead-import path:
//   - src/server/routes/outreach/leads.ts (bulk-import + single-create, human/UI path)
//   - src/server/routes/agent-outreach.ts (POST /prospects/import, Xphere machine path)

export type EmailVerificationStatus = 'unknown' | 'verified' | 'likely' | 'unavailable' | 'invalid'

// email_status -> emailVerificationStatus (the contract mapping table):
//   ok                              -> verified
//   catch_all | unknown             -> likely
//   invalid | disposable | bounced  -> invalid
//   absent / unrecognized           -> left untouched (column keeps its 'unknown' default)
const EMAIL_STATUS_TO_VERIFICATION_STATUS: Record<string, Extract<EmailVerificationStatus, 'verified' | 'likely' | 'invalid'>> = {
    ok: 'verified',
    catch_all: 'likely',
    unknown: 'likely',
    invalid: 'invalid',
    disposable: 'invalid',
    bounced: 'invalid',
}

export interface MappedVerificationFields {
    emailVerificationStatus?: EmailVerificationStatus
    emailVerificationProvider?: string
    emailVerifiedAt?: Date
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readDate(value: unknown): Date | undefined {
    if (typeof value !== 'string') return undefined
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function readCustomFields(customFields: unknown): Record<string, unknown> | undefined {
    return customFields && typeof customFields === 'object' && !Array.isArray(customFields)
        ? customFields as Record<string, unknown>
        : undefined
}

/**
 * Maps `customFields.email_status` / `email_verified_at` / `email_verification_provider` onto
 * the existing verification columns. `email_risk` is intentionally NOT mapped — there is no risk
 * column on `leads`; it stays available to readers via the raw `customFields` blob, which every
 * import path continues to persist unmodified alongside these derived columns.
 */
export function mapEmailVerificationCustomFields(customFields: unknown): MappedVerificationFields {
    const fields = readCustomFields(customFields)
    if (!fields) return {}

    const result: MappedVerificationFields = {}

    const rawStatus = readString(fields.email_status)
    if (rawStatus && rawStatus in EMAIL_STATUS_TO_VERIFICATION_STATUS) {
        result.emailVerificationStatus = EMAIL_STATUS_TO_VERIFICATION_STATUS[rawStatus]
    }

    const provider = readString(fields.email_verification_provider)
    if (provider) result.emailVerificationProvider = provider

    const verifiedAt = readDate(fields.email_verified_at)
    if (verifiedAt) result.emailVerifiedAt = verifiedAt

    return result
}

/**
 * True when `customFields.email_status` is missing/blank or explicitly `'unknown'` — the only
 * situations where the free MX pre-filter (step 4) is allowed to run. Any other recognized status
 * is a real verification signal from Xphere and must not be second-guessed by a bare MX lookup.
 */
export function isEmailStatusAbsentOrUnknown(customFields: unknown): boolean {
    const fields = readCustomFields(customFields)
    const rawStatus = fields ? readString(fields.email_status) : undefined
    return !rawStatus || rawStatus === 'unknown'
}

/**
 * Applies the free recipient-domain MX pre-filter on top of an already-mapped result. Fails
 * open: a DNS error/timeout (hasMxRecord returning `null`) never marks a lead invalid.
 */
async function applyMxFallback(email: string, mapped: MappedVerificationFields): Promise<MappedVerificationFields> {
    const domain = email.split('@')[1]?.trim().toLowerCase()
    if (!domain) return mapped
    const hasMx = await hasMxRecord(domain)
    if (hasMx === false) {
        return { ...mapped, emailVerificationStatus: 'invalid', emailVerificationProvider: 'mx' }
    }
    return mapped
}

/**
 * Full per-lead resolution used at import time: map the contract fields, then — only when
 * Xphere gave no strong signal (email_status absent/unknown) — apply the free MX pre-filter.
 * Never throws: any unexpected failure in the pre-filter falls back to the plain mapped result
 * rather than blocking or corrupting an import.
 */
export async function resolveLeadVerificationFields(
    email: string,
    customFields: unknown,
): Promise<MappedVerificationFields> {
    const mapped = mapEmailVerificationCustomFields(customFields)
    if (!isEmailStatusAbsentOrUnknown(customFields)) return mapped
    try {
        return await applyMxFallback(email, mapped)
    } catch {
        return mapped
    }
}
