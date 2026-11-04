import { describe, expect, it } from 'vitest'
import express from 'express'
import helmet from 'helmet'
import { identityBrowserDocumentHeaders, identityBrowserSources } from './config'

const config = { NODE_ENV: 'production', XMAIL_GOOGLE_AUTH_ENABLED: 'true', XMAIL_GOOGLE_AUTH_PROJECT_ID: 'skaleclub',
    XMAIL_GOOGLE_AUTH_PROJECT_NUMBER: '937861185231', XMAIL_GOOGLE_AUTH_WEB_API_KEY: 'offline-public-config',
    XMAIL_GOOGLE_AUTH_ORIGIN: 'https://mail.skale.club' }

async function responseHeaders(path: string, enabled = true) {
    const sources = identityBrowserSources({ ...config, XMAIL_GOOGLE_AUTH_ENABLED: String(enabled) })
    const app = express()
    app.use(helmet({ contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        ...(sources ? { 'script-src': ["'self'", ...sources.script], 'frame-src': ["'self'", ...sources.frame] } : {}),
    } } }))
    app.use((req, res, next) => { res.set(identityBrowserDocumentHeaders(req.path, Boolean(sources))); next() })
    app.use((_req, res) => { res.send('identity entry') })
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test listener unavailable')
    try { return (await fetch(`http://127.0.0.1:${address.port}${path}`)).headers }
    finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

describe('Firebase browser document headers', () => {
    it('permits the Google popup loader and sends only the origin for restricted API keys', async () => {
        const headers = await responseHeaders('/auth/identity?action=link')
        expect(headers.get('referrer-policy')).toBe('origin')
        expect(headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
        const csp = headers.get('content-security-policy') ?? ''
        expect(csp.split(';').find(part => part.startsWith('script-src '))).toContain('https://apis.google.com')
        expect(csp).not.toContain('*.google.com')
        expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
        expect(csp).toContain('https://skaleclub.firebaseapp.com')
    })
    it('keeps the default private referrer and opener policies on mail pages', async () => {
        const headers = await responseHeaders('/inbox?private=message')
        expect(headers.get('referrer-policy')).toBe('no-referrer')
        expect(headers.get('cross-origin-opener-policy')).toBe('same-origin')
    })
    it('does not open provider scripts or document headers with the pilot disabled', async () => {
        const headers = await responseHeaders('/auth/identity', false)
        expect(headers.get('referrer-policy')).toBe('no-referrer')
        expect(headers.get('content-security-policy')).not.toContain('https://apis.google.com')
        expect(headers.get('cross-origin-opener-policy')).toBe('same-origin')
    })
})
