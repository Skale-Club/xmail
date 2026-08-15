import { describe, expect, it } from 'vitest'
import { normalizeLeadEmail, resolveImportedAs } from '../email-normalization'

describe('normalizeLeadEmail', () => {
    it('lowercases mixed-case addresses', () => {
        expect(normalizeLeadEmail('John.Smith@Shop.com')).toBe('john.smith@shop.com')
    })

    it('trims surrounding whitespace', () => {
        expect(normalizeLeadEmail('  jane@example.com  ')).toBe('jane@example.com')
    })

    it('produces the same normalized key for the same email in different casing', () => {
        const a = normalizeLeadEmail('John.Smith@Shop.com')
        const b = normalizeLeadEmail('john.smith@shop.com')

        expect(a).toBe(b)
    })

    it('is idempotent', () => {
        const once = normalizeLeadEmail('John.Smith@Shop.com')
        expect(normalizeLeadEmail(once)).toBe(once)
    })
})

describe('resolveImportedAs', () => {
    it('reports "created" when the normalized email is in the inserted set', () => {
        const insertedEmails = new Set(['john.smith@shop.com'])

        expect(resolveImportedAs('john.smith@shop.com', insertedEmails)).toBe('created')
    })

    it('reports "existing" when the normalized email is absent from the inserted set', () => {
        const insertedEmails = new Set<string>()

        expect(resolveImportedAs('john.smith@shop.com', insertedEmails)).toBe('existing')
    })

    it('treats a differently-cased pre-existing lead as "existing" rather than "created"', () => {
        // Apollo returns 'John.Smith@Shop.com'; a lead for 'john.smith@shop.com' already
        // existed, so onConflictDoNothing matched it and nothing new was inserted. Once both
        // the candidate email and the insertedEmails set are run through
        // normalizeLeadEmail, the differently-cased duplicate must resolve to 'existing', not
        // 'created' — this is the exact defect this fix closes.
        const candidateEmail = 'John.Smith@Shop.com'
        const insertedEmails = new Set<string>() // nothing was actually inserted this call

        const normalizedEmail = normalizeLeadEmail(candidateEmail)

        expect(resolveImportedAs(normalizedEmail, insertedEmails)).toBe('existing')
    })

    it('does not normalize its inputs itself (callers are responsible)', () => {
        const insertedEmails = new Set(['john.smith@shop.com'])

        // Passing an un-normalized email against an already-normalized set demonstrates the
        // function trusts its inputs rather than silently re-normalizing them.
        expect(resolveImportedAs('John.Smith@Shop.com', insertedEmails)).toBe('existing')
    })
})
