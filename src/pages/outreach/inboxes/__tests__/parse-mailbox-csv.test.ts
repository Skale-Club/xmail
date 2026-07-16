import { describe, expect, it } from 'vitest'
import { parseMailboxCsv } from '../parse-mailbox-csv'

const header = 'email,smtp host,smtp port,smtp password'

describe('parseMailboxCsv — SMTP security derivation (PROV-01)', () => {
    it('does not mark a standard 587 mailbox as implicit TLS', () => {
        const { mailboxes, errors } = parseMailboxCsv(`${header}\nerin@acme.com,smtp.acme.com,587,pw`)
        expect(errors).toEqual([])
        expect(mailboxes[0].smtpPort).toBe(587)
        expect(mailboxes[0].smtpSecure).toBe(false)
    })

    it('marks a 465 mailbox as implicit TLS', () => {
        const { mailboxes } = parseMailboxCsv(`${header}\nerin@acme.com,smtp.acme.com,465,pw`)
        expect(mailboxes[0].smtpPort).toBe(465)
        expect(mailboxes[0].smtpSecure).toBe(true)
    })

    it('does not mark a port 25 mailbox as implicit TLS', () => {
        const { mailboxes } = parseMailboxCsv(`${header}\nerin@acme.com,smtp.acme.com,25,pw`)
        expect(mailboxes[0].smtpSecure).toBe(false)
    })

    it('defaults an omitted port to 587 and STARTTLS', () => {
        const { mailboxes } = parseMailboxCsv('email,smtp host,smtp password\nerin@acme.com,smtp.acme.com,pw')
        expect(mailboxes[0].smtpPort).toBe(587)
        expect(mailboxes[0].smtpSecure).toBe(false)
    })

    it('treats an unknown port as STARTTLS rather than guessing implicit TLS', () => {
        const { mailboxes } = parseMailboxCsv(`${header}\nerin@acme.com,smtp.acme.com,2525,pw`)
        expect(mailboxes[0].smtpPort).toBe(2525)
        expect(mailboxes[0].smtpSecure).toBe(false)
    })
})
