import { describe, expect, it } from 'vitest'
import { isPlatformEmail, isPlatformEmailDomain, PLATFORM_EMAIL_DOMAINS } from '../platform-emails'

describe('platform-emails', () => {
    it('classifies the Booksy support address found on 2026-09-30 (11 barbershops)', () => {
        expect(isPlatformEmail('help.us@booksy.com')).toBe(true)
    })

    it('classifies the PocketSuite privacy address found on the same batch', () => {
        expect(isPlatformEmail('privacy@pocketsuite.io')).toBe(true)
    })

    it('matches every listed platform domain', () => {
        for (const domain of PLATFORM_EMAIL_DOMAINS) {
            expect(isPlatformEmailDomain(domain)).toBe(true)
            expect(isPlatformEmail(`someone@${domain}`)).toBe(true)
        }
    })

    it('matches subdomains of a listed platform domain', () => {
        expect(isPlatformEmail('noreply@mail.vagaro.com')).toBe(true)
        expect(isPlatformEmailDomain('sub.booksy.com')).toBe(true)
    })

    it('is case-insensitive', () => {
        expect(isPlatformEmail('Help.US@BOOKSY.COM')).toBe(true)
    })

    it('does not flag a legitimate business email', () => {
        expect(isPlatformEmail('owner@realbarbershop.test')).toBe(false)
    })

    it('does not flag an unrelated domain that merely contains a platform name as a substring', () => {
        expect(isPlatformEmail('owner@notboosky.com')).toBe(false)
        expect(isPlatformEmail('owner@booksy.com.evil.test')).toBe(false)
    })

    it('handles malformed input without throwing', () => {
        expect(isPlatformEmail(null)).toBe(false)
        expect(isPlatformEmail(undefined)).toBe(false)
        expect(isPlatformEmail('')).toBe(false)
        expect(isPlatformEmail('not-an-email')).toBe(false)
        expect(isPlatformEmail('trailing-at@')).toBe(false)
        expect(isPlatformEmailDomain(null)).toBe(false)
        expect(isPlatformEmailDomain('')).toBe(false)
    })
})
