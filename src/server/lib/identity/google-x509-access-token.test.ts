import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { getGoogleX509AccessToken, type GoogleX509Credential } from './google-x509-access-token'

const transport = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: transport.request }))
const credential: GoogleX509Credential = {
    audience: '//iam.googleapis.com/projects/937861185231/locations/global/workloadIdentityPools/hetzner-xmail/providers/x509',
    serviceAccountEmail: 'xmail-firebase-auth-reader@skaleclub.iam.gserviceaccount.com',
    certificate: Buffer.from('offline-public-cert'), privateKey: Buffer.from('offline-placeholder-not-a-key'), subjectToken: '["b2ZmbGluZQ=="]',
}
const sts = { access_token: 'offline-sts', token_type: 'Bearer', expires_in: 600 }
const iam = () => ({ accessToken: 'offline-impersonated', expireTime: new Date(Date.now() + 600_000).toISOString() })

function reply(body: unknown, status = 200, stalled = false) {
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn(), end: vi.fn() })
    const res = Object.assign(new EventEmitter(), { statusCode: status, destroy: vi.fn() })
    transport.request.mockImplementationOnce((_url, _options, callback) => {
        req.end.mockImplementation(() => queueMicrotask(() => {
            callback(res)
            if (!stalled) {
                res.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
                res.emit('end')
            }
        }))
        return req
    })
    return { req, res }
}

afterEach(() => { transport.request.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('bounded portable X509 token exchange', () => {
    it('uses only fixed Google endpoints, verified mTLS, scoped600s impersonation and one deadline', async () => {
        vi.stubGlobal('fetch', vi.fn(() => { throw Error('Unexpected HTTP') }))
        const first = reply(sts), second = reply(iam())
        await expect(getGoogleX509AccessToken(credential, new AbortController().signal)).resolves.toBe('offline-impersonated')
        const [exchange, impersonation] = transport.request.mock.calls
        expect(exchange[0]).toBe('https://sts.mtls.googleapis.com/v1/token')
        expect(impersonation[0]).toBe('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/xmail-firebase-auth-reader@skaleclub.iam.gserviceaccount.com:generateAccessToken')
        expect(exchange[1]).toMatchObject({ rejectUnauthorized: true, agent: false, minVersion: 'TLSv1.2', cert: credential.certificate, key: credential.privateKey })
        expect(exchange[1].headers.Authorization).toBeUndefined()
        expect(impersonation[1].headers.Authorization).toBe('Bearer offline-sts')
        expect(impersonation[1].cert).toBeUndefined()
        expect(exchange[1].signal).toBe(impersonation[1].signal)
        expect(JSON.parse(first.req.end.mock.calls[0][0])).toMatchObject({ audience: credential.audience, subject_token: credential.subjectToken, subject_token_type: 'urn:ietf:params:oauth:token-type:mtls' })
        expect(JSON.parse(second.req.end.mock.calls[0][0])).toEqual({ scope: ['https://www.googleapis.com/auth/identitytoolkit'], lifetime: '600s' })
        expect(fetch).not.toHaveBeenCalled()
    })
    it.each([301, 302, 307, 400, 401, 500])('refuses status%s without following a redirect or leaking diagnostics', async status => {
        const io = reply({ secret: 'private-provider-diagnostics' }, status)
        await expect(getGoogleX509AccessToken(credential, new AbortController().signal)).rejects.toThrow(/^Keyless Google credentials are unavailable\.$/)
        expect(transport.request).toHaveBeenCalledTimes(1)
        expect(io.req.destroy).toHaveBeenCalled()
        expect(io.res.destroy).toHaveBeenCalled()
    })
    it.each(['not-json', 'x'.repeat(65_537), '[]', '{}', JSON.stringify({ ...sts, access_token: 'bad\r\ntoken' }), JSON.stringify({ ...sts, expires_in: 0 })])('rejects malformed/oversized/error bodies %#', async body => {
        const io = reply(body)
        await expect(getGoogleX509AccessToken(credential, new AbortController().signal)).rejects.toThrow('Keyless Google credentials are unavailable.')
        expect(transport.request).toHaveBeenCalledTimes(1)
        expect(io.req.setTimeout).toHaveBeenCalledWith(8_000, expect.any(Function))
    })
    it.each(['sts', 'iam'])('destroys both socket and partial response on the shared deadline during%s', async stage => {
        const timer = new AbortController()
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal)
        if (stage === 'iam') reply(sts)
        const io = reply({}, 200, true)
        const pending = getGoogleX509AccessToken(credential, new AbortController().signal)
        const assertion = expect(pending).rejects.toThrow('Keyless Google credentials are unavailable.')
        await vi.waitFor(() => expect(io.req.end).toHaveBeenCalled())
        timer.abort()
        await assertion
        expect(timeout).toHaveBeenCalledWith(8_000)
        expect(io.req.destroy).toHaveBeenCalled()
        expect(io.res.destroy).toHaveBeenCalled()
        expect(transport.request).toHaveBeenCalledTimes(stage === 'iam' ? 2 : 1)
    })
    it('honors caller cancellation before opening a connection and rejects noncanonical destinations', async () => {
        const caller = new AbortController(); caller.abort()
        await expect(getGoogleX509AccessToken(credential, caller.signal)).rejects.toThrow('Keyless Google credentials are unavailable.')
        await expect(getGoogleX509AccessToken({ ...credential, serviceAccountEmail: 'reader@attacker.invalid/redirect' }, new AbortController().signal)).rejects.toThrow()
        expect(transport.request).not.toHaveBeenCalled()
    })
    it.each([{ accessToken: 'bad\ntoken' }, { ...iam(), expireTime: 'invalid' }, { ...iam(), expireTime: new Date(0).toISOString() }])('refuses invalid final IAM credentials %#', async body => {
        reply(sts); reply(body)
        await expect(getGoogleX509AccessToken(credential, new AbortController().signal)).rejects.toThrow('Keyless Google credentials are unavailable.')
    })
})
