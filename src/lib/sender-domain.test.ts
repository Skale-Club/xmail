import { describe, expect, it } from 'vitest'
import { normalizeTrustedDomain, senderRegistrableDomain } from './sender-domain'

describe('senderRegistrableDomain', () => {
    it('collapses subdomains to the registrable domain', () => {
        expect(senderRegistrableDomain('hello@account.dataforseo.com')).toBe('dataforseo.com')
        expect(senderRegistrableDomain('info@dataforseo.com')).toBe('dataforseo.com')
    })

    it('is public-suffix aware (multi-label suffixes)', () => {
        expect(senderRegistrableDomain('x@montecarlopostos.com.br')).toBe('montecarlopostos.com.br')
        expect(senderRegistrableDomain('x@mail.montecarlopostos.com.br')).toBe('montecarlopostos.com.br')
    })

    it('lowercases and accepts a "Name <addr>" form', () => {
        expect(senderRegistrableDomain('Ana <ANA@Mail.Client.COM>')).toBe('client.com')
    })

    it('returns null for missing, malformed or non-domain input', () => {
        expect(senderRegistrableDomain(null)).toBeNull()
        expect(senderRegistrableDomain(undefined)).toBeNull()
        expect(senderRegistrableDomain('')).toBeNull()
        expect(senderRegistrableDomain('no-at-sign')).toBeNull()
        expect(senderRegistrableDomain('x@localhost')).toBeNull()
        expect(senderRegistrableDomain('x@10.0.0.1')).toBeNull()
    })
})

describe('normalizeTrustedDomain', () => {
    it('normalizes case, whitespace and a trailing dot', () => {
        expect(normalizeTrustedDomain('  Example.COM. ')).toBe('example.com')
    })

    it('reduces a subdomain to its registrable domain', () => {
        expect(normalizeTrustedDomain('news.example.co.uk')).toBe('example.co.uk')
    })

    it('rejects IPs, empty values, public suffixes and non-hostnames', () => {
        for (const bad of ['', '   ', '1.2.3.4', '[::1]', 'com', 'co.uk', 'localhost', 'a b.com', 'a@b.com', 'https://x.com', 'x.com/path', 'x.com:80', '-x.com', 'x_y.com']) {
            expect(normalizeTrustedDomain(bad), bad).toBeNull()
        }
    })

    it('rejects names longer than 253 characters', () => {
        expect(normalizeTrustedDomain(`${'a'.repeat(250)}.com`)).toBeNull()
        expect(normalizeTrustedDomain(`${'a.'.repeat(130)}com`)).toBeNull()
    })

    it('rejects non-strings', () => {
        expect(normalizeTrustedDomain(undefined)).toBeNull()
        expect(normalizeTrustedDomain(42 as unknown as string)).toBeNull()
    })
})
