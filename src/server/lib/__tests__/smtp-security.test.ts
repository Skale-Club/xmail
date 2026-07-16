import { describe, expect, it } from 'vitest'
import {
    buildSmtpTransportOptions,
    describeSmtpSecurityMode,
    isStandardSmtpPort,
    resolveSmtpSecurity,
    type SmtpSecurityInput,
} from '../smtp-security'

describe('resolveSmtpSecurity', () => {
    describe('port 465 — implicit TLS', () => {
        it('treats a bare 465 as implicit TLS', () => {
            const r = resolveSmtpSecurity({ port: 465 })
            expect(r.mode).toBe('implicit_tls')
            expect(r.secure).toBe(true)
            expect(r.requireTLS).toBe(false)
            expect(r.normalized).toBe(false)
            expect(r.warning).toBeNull()
        })

        it('accepts an explicit secure=true on 465 without normalizing', () => {
            const r = resolveSmtpSecurity({ port: 465, secure: true })
            expect(r.mode).toBe('implicit_tls')
            expect(r.secure).toBe(true)
            expect(r.normalized).toBe(false)
        })

        it('normalizes secure=false on 465 back to implicit TLS and warns', () => {
            const r = resolveSmtpSecurity({ port: 465, secure: false })
            expect(r.mode).toBe('implicit_tls')
            expect(r.secure).toBe(true)
            expect(r.normalized).toBe(true)
            expect(r.warning).toContain('465')
        })
    })

    describe('port 587 — STARTTLS', () => {
        it('treats a bare 587 as required STARTTLS, not implicit TLS', () => {
            const r = resolveSmtpSecurity({ port: 587 })
            expect(r.mode).toBe('starttls_required')
            expect(r.secure).toBe(false)
            expect(r.requireTLS).toBe(true)
            expect(r.normalized).toBe(false)
            expect(r.warning).toBeNull()
        })

        it('accepts an explicit secure=false on 587 without normalizing', () => {
            const r = resolveSmtpSecurity({ port: 587, secure: false })
            expect(r.mode).toBe('starttls_required')
            expect(r.secure).toBe(false)
            expect(r.requireTLS).toBe(true)
            expect(r.normalized).toBe(false)
        })

        // This is the legacy shape: email_accounts.smtp_secure defaults to true while
        // smtp_port defaults to 587, so historical rows claim implicit TLS on a STARTTLS
        // port. Those rows must still send — normalized, not rejected.
        it('normalizes the legacy secure=true + port 587 combination to STARTTLS and warns', () => {
            const r = resolveSmtpSecurity({ port: 587, secure: true })
            expect(r.mode).toBe('starttls_required')
            expect(r.secure).toBe(false)
            expect(r.requireTLS).toBe(true)
            expect(r.normalized).toBe(true)
            expect(r.warning).toContain('587')
        })
    })

    describe('port 25 — STARTTLS, required whenever credentials are sent', () => {
        it('treats a bare 25 as required STARTTLS, since submission authenticates', () => {
            const r = resolveSmtpSecurity({ port: 25 })
            expect(r.mode).toBe('starttls_required')
            expect(r.secure).toBe(false)
            expect(r.requireTLS).toBe(true)
            expect(r.normalized).toBe(false)
        })

        it('drops to opportunistic only for an unauthenticated MX relay', () => {
            const r = resolveSmtpSecurity({ port: 25, authenticated: false })
            expect(r.mode).toBe('starttls_opportunistic')
            expect(r.requireTLS).toBe(false)
        })

        it('normalizes secure=true on 25 to STARTTLS and warns', () => {
            const r = resolveSmtpSecurity({ port: 25, secure: true })
            expect(r.mode).toBe('starttls_required')
            expect(r.secure).toBe(false)
            expect(r.requireTLS).toBe(true)
            // The 422-vs-normalize split is unchanged: canonical `secure` for 25 is still
            // false, so a stored secure=true is still the only thing that can contradict.
            expect(r.normalized).toBe(true)
            expect(r.warning).toContain('25')
        })
    })

    describe('nonstandard ports — the stored flag is the only signal', () => {
        it('preserves explicit implicit-TLS configuration on a nonstandard port', () => {
            const r = resolveSmtpSecurity({ port: 2525, secure: true })
            expect(r.mode).toBe('implicit_tls')
            expect(r.secure).toBe(true)
            expect(r.normalized).toBe(false)
            expect(r.warning).toBeNull()
        })

        it('uses required STARTTLS on a nonstandard port with secure=false', () => {
            const r = resolveSmtpSecurity({ port: 2525, secure: false })
            expect(r.mode).toBe('starttls_required')
            expect(r.secure).toBe(false)
            expect(r.requireTLS).toBe(true)
            expect(r.normalized).toBe(false)
        })

        it('defaults an unset flag on a nonstandard port to required STARTTLS', () => {
            const r = resolveSmtpSecurity({ port: 2525, secure: null })
            expect(r.mode).toBe('starttls_required')
            expect(r.secure).toBe(false)
            expect(r.requireTLS).toBe(true)
        })
    })

    describe('port fallbacks', () => {
        it.each([
            ['null', null],
            ['undefined', undefined],
        ])('falls back to the 587 submission default when port is %s', (_label, port) => {
            const r = resolveSmtpSecurity({ port: port as number | null | undefined })
            expect(r.port).toBe(587)
            expect(r.mode).toBe('starttls_required')
        })

        it.each([0, -1, 70000, Number.NaN])('falls back to 587 for out-of-range port %s', (port) => {
            const r = resolveSmtpSecurity({ port })
            expect(r.port).toBe(587)
            expect(r.mode).toBe('starttls_required')
        })
    })

    it('always supplies a safe minimum TLS version', () => {
        const inputs: SmtpSecurityInput[] = [
            { port: 465 },
            { port: 587 },
            { port: 25 },
            { port: 2525, secure: true },
        ]
        for (const input of inputs) {
            expect(resolveSmtpSecurity(input).tls.minVersion).toBe('TLSv1.2')
        }
    })

    it('is deterministic for a given input', () => {
        const input: SmtpSecurityInput = { port: 587, secure: true }
        expect(resolveSmtpSecurity(input)).toEqual(resolveSmtpSecurity(input))
    })
})

describe('isStandardSmtpPort', () => {
    it.each([465, 587, 25])('treats %s as a standard port whose TLS mode is implied', (port) => {
        expect(isStandardSmtpPort(port)).toBe(true)
    })

    it.each([2525, 1025, 8025])('treats %s as nonstandard, so the stored flag matters', (port) => {
        expect(isStandardSmtpPort(port)).toBe(false)
    })

    it('treats an unset port as standard, since it falls back to 587', () => {
        expect(isStandardSmtpPort(null)).toBe(true)
    })
})

describe('describeSmtpSecurityMode', () => {
    it('labels every mode for operator-facing UI', () => {
        expect(describeSmtpSecurityMode('implicit_tls')).toMatch(/implicit TLS/i)
        expect(describeSmtpSecurityMode('starttls_required')).toMatch(/STARTTLS/i)
        expect(describeSmtpSecurityMode('starttls_opportunistic')).toMatch(/STARTTLS/i)
    })
})

// C-1 — credentials must never be submitted without a TLS guarantee.
//
// The concrete attack: on port 25 the old resolver returned requireTLS:false, so an
// on-path attacker who strips `250-STARTTLS` from the EHLO response leaves nodemailer
// with nothing to object to. It proceeds in cleartext and sends `AUTH LOGIN` with the
// decrypted mailbox password. Every caller of buildSmtpTransportOptions is authenticated
// submission — it attaches `auth` unconditionally — so no port may be opportunistic here.
describe('TLS guarantee for authenticated submission', () => {
    const base = {
        host: 'smtp.example.com',
        username: 'user@example.com',
        password: 'super-secret-password',
    }

    it.each([25, 465, 587, 2525, null, undefined])(
        'never attaches credentials to a cleartext-capable transport on port %s',
        (port) => {
            const { options } = buildSmtpTransportOptions({
                ...base,
                port: port as number | null | undefined,
            })

            expect(options.auth).toEqual({ user: base.username, pass: base.password })
            // Implicit TLS, or STARTTLS that fails closed. Never "TLS if the peer offers it".
            expect(
                options.secure || options.requireTLS,
                `port ${port} would submit AUTH over a connection an attacker can keep in cleartext`,
            ).toBe(true)
        },
    )

    it('requires STARTTLS on port 25 when the connection authenticates', () => {
        // Authenticated submission on 25 is nonstandard but real. The module already
        // treats an *unknown* port as required-STARTTLS ("the safe reading"); a known
        // port carrying the same credentials cannot be weaker.
        const r = resolveSmtpSecurity({ port: 25, authenticated: true })
        expect(r.mode).toBe('starttls_required')
        expect(r.secure).toBe(false)
        expect(r.requireTLS).toBe(true)
    })

    it('keeps opportunistic STARTTLS for unauthenticated port 25 MX relay', () => {
        // An MX peer that does not advertise STARTTLS must still receive mail — there are
        // no credentials to expose. This is the only case opportunistic is defensible.
        const r = resolveSmtpSecurity({ port: 25, authenticated: false })
        expect(r.mode).toBe('starttls_opportunistic')
        expect(r.secure).toBe(false)
        expect(r.requireTLS).toBe(false)
    })

    it('defaults to the authenticated reading, since every caller stores submission creds', () => {
        expect(resolveSmtpSecurity({ port: 25 })).toEqual(resolveSmtpSecurity({ port: 25, authenticated: true }))
    })
})

describe('buildSmtpTransportOptions', () => {
    const base = {
        host: 'smtp.example.com',
        username: 'user@example.com',
        password: 'super-secret-password',
    }

    it('derives STARTTLS transport options for a standard 587 account', () => {
        const { options } = buildSmtpTransportOptions({ ...base, port: 587, secure: true })
        expect(options).toMatchObject({
            host: 'smtp.example.com',
            port: 587,
            secure: false,
            requireTLS: true,
            auth: { user: 'user@example.com', pass: 'super-secret-password' },
        })
    })

    it('derives implicit TLS transport options for a 465 account', () => {
        const { options } = buildSmtpTransportOptions({ ...base, port: 465, secure: true })
        expect(options.secure).toBe(true)
        expect(options.requireTLS).toBe(false)
    })

    // The core of PROV-01: verification and delivery must not be able to disagree.
    it('produces identical options for verification and delivery of the same account', () => {
        const account = { ...base, port: 587, secure: true }
        const verify = buildSmtpTransportOptions({ ...account, connectionTimeoutMs: 10_000, greetingTimeoutMs: 10_000 })
        const send = buildSmtpTransportOptions(account)

        const { connectionTimeout, greetingTimeout, ...verifyTransport } = verify.options
        expect(connectionTimeout).toBe(10_000)
        expect(greetingTimeout).toBe(10_000)
        expect(verifyTransport).toEqual(send.options)
        expect(verify.resolution).toEqual(send.resolution)
    })

    it('surfaces the normalization warning without leaking credentials', () => {
        const { resolution } = buildSmtpTransportOptions({ ...base, port: 587, secure: true })
        expect(resolution.normalized).toBe(true)
        expect(resolution.warning).not.toBeNull()
        expect(resolution.warning).not.toContain('super-secret-password')
        expect(resolution.warning).not.toContain('user@example.com')
    })

    it('omits timeouts when they are not requested', () => {
        const { options } = buildSmtpTransportOptions({ ...base, port: 465 })
        expect(options.connectionTimeout).toBeUndefined()
        expect(options.greetingTimeout).toBeUndefined()
    })
})
