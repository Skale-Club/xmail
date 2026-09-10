import { afterEach, describe, expect, it, vi } from 'vitest'

// mail-auth.ts calls out to the `mailauth` package and to `./mail-tls`'s hasMailTLS() (used
// only to decide whether a 'reject' verdict gets downgraded to 'quarantine' in dev). Mock
// both so each test controls exactly what mailauth resolves/throws and which "environment"
// (dev vs prod-with-TLS) is in effect, without touching real certs or doing real DNS lookups.
const authenticateMock = vi.fn()
vi.mock('mailauth', () => ({ authenticate: (...args: unknown[]) => authenticateMock(...args) }))

const hasMailTLSMock = vi.fn()
vi.mock('../mail-tls', () => ({ hasMailTLS: () => hasMailTLSMock() }))

import { verifyInbound } from '../mail-auth'

function ctx() {
    return { ip: '203.0.113.9', helo: 'mail.example.test', sender: 'sender@example.test', recipients: ['rcpt@skale.club'] }
}

describe('verifyInbound', () => {
    afterEach(() => {
        authenticateMock.mockReset()
        hasMailTLSMock.mockReset()
    })

    it('accepts a message that passes SPF/DKIM/DMARC', async () => {
        hasMailTLSMock.mockReturnValue(true)
        authenticateMock.mockResolvedValue({
            headers: 'Authentication-Results: mx.skale.club; spf=pass dkim=pass dmarc=pass',
            spf: { status: { result: 'pass' } },
            dmarc: { status: { result: 'pass' }, policy: 'reject' },
            dkim: { results: [{ status: { result: 'pass' } }] },
        })

        const outcome = await verifyInbound(Buffer.from('From: a@b.test\r\n\r\nhi'), ctx())

        expect(outcome.verdict).toBe('accept')
        expect(outcome.spfPass).toBe(true)
        expect(outcome.dkimPass).toBe(true)
        expect(outcome.dmarcPass).toBe(true)
        // The "Authentication-Results: " prefix is stripped since sealWithAuthHeader adds it back.
        expect(outcome.headers).not.toMatch(/^Authentication-Results:/i)
    })

    it('rejects on a failing DMARC policy=reject outside dev', async () => {
        hasMailTLSMock.mockReturnValue(true) // TLS present → treated as prod, no downgrade
        authenticateMock.mockResolvedValue({
            headers: 'Authentication-Results: mx.skale.club; dmarc=fail',
            spf: { status: { result: 'fail' } },
            dmarc: { status: { result: 'fail' }, policy: 'reject' },
            dkim: { results: [] },
        })

        const outcome = await verifyInbound(Buffer.from('From: a@b.test\r\n\r\nhi'), ctx())

        expect(outcome.verdict).toBe('reject')
        expect(outcome.reason).toMatch(/DMARC fail, policy=reject/)
    })

    it('downgrades a reject verdict to quarantine when no mail TLS is configured (dev)', async () => {
        hasMailTLSMock.mockReturnValue(false)
        authenticateMock.mockResolvedValue({
            headers: 'Authentication-Results: mx.skale.club; dmarc=fail',
            spf: { status: { result: 'fail' } },
            dmarc: { status: { result: 'fail' }, policy: 'reject' },
            dkim: { results: [] },
        })

        const outcome = await verifyInbound(Buffer.from('From: a@b.test\r\n\r\nhi'), ctx())

        expect(outcome.verdict).toBe('quarantine')
        expect(outcome.reason).toMatch(/downgraded reject→quarantine/)
    })

    it('fails CLOSED — a thrown verification error resolves to a quarantine outcome, never null', async () => {
        hasMailTLSMock.mockReturnValue(true)
        authenticateMock.mockRejectedValue(new Error('boom: malformed header block'))

        const outcome = await verifyInbound(Buffer.from('garbage'), ctx())

        // Must always be a real object — mx-server.ts no longer has a null-auth branch to
        // fall back on; if this ever becomes null/undefined again the message would land in
        // INBOX unmarked exactly like the original bug.
        expect(outcome).toBeTruthy()
        expect(outcome.verdict).toBe('quarantine')
        expect(outcome.spfPass).toBe(false)
        expect(outcome.dkimPass).toBe(false)
        expect(outcome.dmarcPass).toBe(false)
        expect(outcome.reason).toMatch(/^verification_error: boom: malformed header block$/)
        expect(outcome.headers).toBe('none (verification error)')
    })
})
