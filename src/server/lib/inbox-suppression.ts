// ============================================================
// Unified Inbox suppression service (Phase 22 UIX-04, locked decision #8)
// ============================================================
// Suppression is a DESTRUCTIVE, organization-wide safety action. Every function here takes an
// already-authorized `organizationId` (the route ran requireOutreachWrite) and writes it into
// the tenant-scoped `suppressions` table. Two scopes:
//   - 'sender': block one exact address (stored lowercased). Enforced by the delivery policy's
//     exact-match check.
//   - 'domain': block every address at a domain, stored as an `@domain` sentinel row. The
//     delivery policy also matches this sentinel (see outreach-delivery-policy loadSnapshot).
//     A public/free-mail domain is REFUSED — a domain block there would suppress countless
//     unrelated recipients — forcing the operator to the safe sender scope.
// Idempotent throughout: re-suppressing an address/domain is a no-op that reports
// `alreadySuppressed: true`, never a duplicate row or an error.

import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { suppressions } from '../../db/schema'
import { InboxOperatorError } from './inbox-operator'
import { isPublicEmailDomain } from './public-email-domains'

export type SuppressionScope = 'sender' | 'domain'

export interface SuppressionPreview {
    email: string
    domain: string
    scope: SuppressionScope
    isPublicDomain: boolean
    alreadySuppressed: boolean
    warnings: string[]
}

export interface SuppressionResult {
    suppressed: boolean
    scope: SuppressionScope
    email: string
    domain: string
    alreadySuppressed: boolean
}

const badRequest = (code: string) => new InboxOperatorError(400, code, 'Bad request')

/** Normalize + split an address into `{ email, domain }`, rejecting anything that is not one address. */
function parseAddress(raw: string): { email: string; domain: string } {
    const email = raw.trim().toLowerCase()
    const at = email.lastIndexOf('@')
    if (at <= 0 || at === email.length - 1 || email.indexOf('@') !== at) {
        throw badRequest('suppression_invalid_email')
    }
    const domain = email.slice(at + 1)
    if (!domain.includes('.')) throw badRequest('suppression_invalid_email')
    return { email, domain }
}

/** The sentinel stored for a domain-scope block (matched by the delivery policy). */
export function domainSuppressionKey(domain: string): string {
    return `@${domain.trim().toLowerCase()}`
}

async function isSenderSuppressed(organizationId: string, email: string): Promise<boolean> {
    const rows = await db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(and(
            eq(suppressions.organizationId, organizationId),
            sql`lower(${suppressions.emailAddress}) = ${email}`,
        ))
        .limit(1)
    return rows.length > 0
}

async function isDomainSuppressed(organizationId: string, domain: string): Promise<boolean> {
    const key = domainSuppressionKey(domain)
    const rows = await db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(and(
            eq(suppressions.organizationId, organizationId),
            sql`lower(${suppressions.emailAddress}) = ${key}`,
        ))
        .limit(1)
    return rows.length > 0
}

/**
 * Classify a suppression target server-side BEFORE any confirmation. Never mutates. Reports the
 * exact address/domain, whether the domain is public/free-mail (so the client can gate the
 * destructive domain confirm), whether it is already suppressed, and human-readable warnings.
 */
export async function previewSuppression(
    organizationId: string,
    rawEmail: string,
    scope: SuppressionScope,
): Promise<SuppressionPreview> {
    const { email, domain } = parseAddress(rawEmail)
    const isPublicDomain = isPublicEmailDomain(domain)
    const alreadySuppressed = scope === 'domain'
        ? await isDomainSuppressed(organizationId, domain)
        : await isSenderSuppressed(organizationId, email)

    const warnings: string[] = []
    if (scope === 'domain' && isPublicDomain) {
        warnings.push(`${domain} is a public or free-mail provider; a domain-wide block is not permitted.`)
    } else if (scope === 'domain') {
        warnings.push(`This blocks every address at ${domain} for the whole organization.`)
    }
    if (alreadySuppressed) {
        warnings.push(scope === 'domain' ? `${domain} is already blocked.` : `${email} is already blocked.`)
    }

    return { email, domain, scope, isPublicDomain, alreadySuppressed, warnings }
}

/**
 * Execute a suppression. A public/free-mail domain block is REFUSED (400 suppression_public_domain).
 * Idempotent: an existing suppression is reported as `alreadySuppressed` without inserting a
 * duplicate. The write is org-scoped so it can only ever affect the authorized tenant.
 */
export async function applySuppression(
    organizationId: string,
    rawEmail: string,
    scope: SuppressionScope,
): Promise<SuppressionResult> {
    const { email, domain } = parseAddress(rawEmail)

    if (scope === 'domain') {
        if (isPublicEmailDomain(domain)) throw badRequest('suppression_public_domain')
        const already = await isDomainSuppressed(organizationId, domain)
        if (!already) {
            await db
                .insert(suppressions)
                .values({ organizationId, emailAddress: domainSuppressionKey(domain), source: 'manual', reason: 'operator_domain_block' })
                .onConflictDoNothing()
        }
        return { suppressed: true, scope, email, domain, alreadySuppressed: already }
    }

    const already = await isSenderSuppressed(organizationId, email)
    if (!already) {
        await db
            .insert(suppressions)
            .values({ organizationId, emailAddress: email, source: 'manual', reason: 'operator_sender_block' })
            .onConflictDoNothing()
    }
    return { suppressed: true, scope, email, domain, alreadySuppressed: already }
}
