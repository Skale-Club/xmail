import type { ProspectImportedAs } from '../../../db/schema'

/**
 * Canonical normalization for a lead email address at the prospecting import boundary.
 *
 * The human lead-creation path (`src/server/routes/outreach/leads.ts`) has always
 * lowercased+trimmed emails in its Zod schema. The agent/prospecting import path
 * (`src/server/routes/agent-prospecting.ts`) historically wrote `prospect_candidates`/
 * `leads.email` straight from the provider payload. `leads (organization_id, email)` is a
 * case-SENSITIVE unique index, so a differently-cased duplicate of an existing lead (e.g.
 * Apollo returning `John.Smith@shop.com` when `john.smith@shop.com` already exists) would
 * bypass `onConflictDoNothing` and create a duplicate row for the same human — and make
 * `prospect_candidates.imported_as` report 'created' when the truth is 'existing'.
 *
 * Kept as a small pure function (no DB, no framework) so the normalization contract is
 * unit-testable, and so every write/lookup site in the import route can compute the value
 * once and share it instead of re-deriving `.trim().toLowerCase()` ad hoc at each call site.
 */
export function normalizeLeadEmail(email: string): string {
    return email.trim().toLowerCase()
}

/**
 * Resolves whether a candidate's matched lead row came from this import call's own insert
 * ('created') or from an already-existing lead matched via `onConflictDoNothing`
 * ('existing'). Both `normalizedEmail` and the members of `insertedEmails` must already be
 * normalized with `normalizeLeadEmail` — this function does no normalization itself so a
 * casing mismatch between the two inputs fails loudly (via a wrong answer) rather than
 * silently, which is exactly what happens today if callers forget to normalize consistently.
 */
export function resolveImportedAs(normalizedEmail: string, insertedEmails: ReadonlySet<string>): ProspectImportedAs {
    return insertedEmails.has(normalizedEmail) ? 'created' : 'existing'
}
