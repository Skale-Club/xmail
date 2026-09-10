import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Two distinct, valid self-signed cert/key pairs (CN=test.local / CN=test2.local, 10y
// validity) generated once with `openssl req -x509 -newkey rsa:2048 -nodes`. Static so the
// test suite never shells out to openssl or depends on it being installed.
const CERT_1 = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUJPEQ8NogE5IPdd/Tvzs+fduSD7EwDQYJKoZIhvcNAQEL
BQAwFTETMBEGA1UEAwwKdGVzdC5sb2NhbDAeFw0yNjA5MTAyMjMwMTlaFw0zNjA5
MDcyMjMwMTlaMBUxEzARBgNVBAMMCnRlc3QubG9jYWwwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCsOY2UrLkPJg9llniIvpPs3jBo6zkkTT8+YGaINwMD
4UmOiOKQwA7QK8x6MpdvVEipu25ckZm6mfsHVHNKkVRZ/bQEy9/kHEyctVBKkywd
efgECSbDvLsg92zGGR6rmhjEXbxu7OE8xWaR4t7PzNqJ+LJCGsJW3pHr2hrjJLH6
aZ8MaCDvlCdbh3YKC5x3HesV/lcKaY4eHCxfPathkWBl8WtNF7229ATBsStoZAgw
qQ7X2LF7kzCvJB9X5wc1zHdU1QIBq653daUmwLMMTb00kE6mUcf97rafP44cvfTd
ILfCQ6EzR9jt/ocHSMSe4tag/gjGl9M+RMVzsRMRyK6jAgMBAAGjUzBRMB0GA1Ud
DgQWBBTQXYIZ+dJYE0YMAWjMKveFmgAHLzAfBgNVHSMEGDAWgBTQXYIZ+dJYE0YM
AWjMKveFmgAHLzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCQ
pK7DIwcWGcCjbO/YtOIxiWrDkm+QHfMWb6FWFr1qsDlS5JQfYeRvl9hU8+efZav7
Y9f/Uh5dnibK0HFI3TJS9sBB1YvdWGpUoinl6SZeTDGjLNf716HGE6BdyPNis0qT
g+AtMa27QISu0J9MeTK5iERlgdDqB4Pm56FobdOnLkw8RRh6R6J7TKco/Bh9KqEC
YmETlB2ktopAkP2c+GDC8FcOozsvlg8eBJGIo/9q67N7xPWFhmObqY5Ucy9M8h4w
f1WQuz/bfmk2rBk4fNkWDRdFFxlW8MblRIYUH4bkk2M7KN90i+9ubWUmotGejLSh
yCZY/b5+xcIv6eZL7u7J
-----END CERTIFICATE-----
`

const KEY_1 = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCsOY2UrLkPJg9l
lniIvpPs3jBo6zkkTT8+YGaINwMD4UmOiOKQwA7QK8x6MpdvVEipu25ckZm6mfsH
VHNKkVRZ/bQEy9/kHEyctVBKkywdefgECSbDvLsg92zGGR6rmhjEXbxu7OE8xWaR
4t7PzNqJ+LJCGsJW3pHr2hrjJLH6aZ8MaCDvlCdbh3YKC5x3HesV/lcKaY4eHCxf
PathkWBl8WtNF7229ATBsStoZAgwqQ7X2LF7kzCvJB9X5wc1zHdU1QIBq653daUm
wLMMTb00kE6mUcf97rafP44cvfTdILfCQ6EzR9jt/ocHSMSe4tag/gjGl9M+RMVz
sRMRyK6jAgMBAAECggEAUQNRohoNgx64J2U8lbZwBwANbY0YeAcONN1L3c9iz7Rt
0Wp6iPSPA0VXDjQ2H9xZwd208D5dPfWoq64B/ZWXRC2fPJJaYwcc0qpHdoz8N3Fk
RSG45mIk9EDvHdA7KSV3eQdO2C79VITW1tENVlpagoRF9ep4eDyCD5utAiQExHGd
C9Za2Vkm+MMJqd6+BrDpZkT0tCZAFaGWDNm4OY77i7bO+8Ww+u8yVTGLXBsppU8L
1QITU1fa1YcyOjnOAV40BFQPcqQ5PnyC1yfUap+mK9rWeBBCRX+JWddd9XXwpIfs
lfjneub4ZOUlKUjTGx+8EKwCkF392vlHpz+0yGuWAQKBgQDYASe9zQRI15eBENb7
mgCS3MI0UbYtoZjFbBtESoJ28dutlQxzMzfSrQXEvlfntI8sOkkB5i9QYS8ydU0f
S44sEiCQRPP5GFlwoEgbyZmzUOYLA2nWBDgWu6nsXZzWcFPg8YZa56Mbn5bPA5lv
kUDbWXd7GCWoDhYbGo3WcSU94wKBgQDMHTGEYyKNBO8KOXnrQcUFY2Z+yeHgzYw9
iquUAT3WduOHSez1RpT9VGFB0Dm3+0gUeRtb1TS5S/roBhOCgwEp/WGaozXEKeH3
LVQwZtej4qkEEakdAm8vcIQx3coB8Bm55rdiGW7VuLfz8znokYMYzjfWKCWWCbEE
wl99zB2oQQKBgFVmh4bkItiF3JGbzdOl/KoT+/hhggyiglsztcgXSWOrlfYYItb9
Hgn+fHRf6TNj0ONkm+7TSkuWUOm7NOW1op1MAXHowSjv9pSv2jKaT1l1F66tB9Ak
1OQwCCu6i0LBIHikJUGVqYhHXYG1Y5mXrTPMOJADaQf7ocPPiNqK23WPAoGAJA88
QkEpR3SJrmq9CTzTS8JlxxxvVUG69txat4kInazfQXVj8WkIxUB09iWNLN2tvEAw
/yZJbDrqFreMFtCCEiL7bVBMHV2w1/QgHXTtv7w5U8iy8bcOYXklQZIHMBR01wzV
dPU9SXCavvRHVLjwSh+Uabcp/Lm1ljuolxbKXoECgYEAplYf3I/NBQNB/Dy9jvzf
pBlCgV7ptmiFfyf4Tdtq5+jvBR+lAN/fjw9WR5kxMBLLTPDNvbdGj1QfdX3gL2w8
JQxmtwkT2z+eVLXi/u+MmdKUvSEmbHqjno/Qx/acwxERVLOi9uezVPq4M0zT3CUW
FUV7G3q8IipTus+KvKHLs30=
-----END PRIVATE KEY-----
`

const CERT_2 = `-----BEGIN CERTIFICATE-----
MIIDDTCCAfWgAwIBAgIUFdn6zxT543dTWGXOSBKSxfl1nVwwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLdGVzdDIubG9jYWwwHhcNMjYwOTEwMjIzMDE5WhcNMzYw
OTA3MjIzMDE5WjAWMRQwEgYDVQQDDAt0ZXN0Mi5sb2NhbDCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAL+YZFlK7DT3ARns3Chp0Zqxks3BgXyrUWXKfI0E
sJnzKOXzWmIA6tyEsVKtbWaBz+ttrXvPlkk3T4KcxU/ME24o7xPOhx8yCPNIWTNH
XvUYuD++1warbRq8F96bTsv0gzZnR66CdVKhdzgQHZ1LMWZRpY2jA6g/gFqJUtVL
wZCRkSKWN6llkif6Jy3E5EirUzdrYE4xMpcJT4R4yqToN9SM7xJgx7e/e12tbbkV
lQA4iVEHF+OJSnULDr/rLrK492NmAvsjqbFIQ10Jm4/ImqOqsTWD6TzdSSmnSqjA
hXLO4lUxR1BWtbVF/hNGiqsv2tQ0Uccslj/umgq1TcnxR3cCAwEAAaNTMFEwHQYD
VR0OBBYEFKiQpcWMeieZ3mEjunvjHaIF+xvqMB8GA1UdIwQYMBaAFKiQpcWMeieZ
3mEjunvjHaIF+xvqMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEB
AI0FIEJ6ohoINnz891XXdoA2LF2JYs/+WOG+AqXeFM6YNFyUxiCyW7OU+qmHZDXP
P2uUFS5cp2vwTLKDXos7Iwu1muJjreYfBFJ9rWXuevdmGCFE2m0hhs44qe0OOW/K
02+Q4FFP/YZtLLpkUVUBy2h1re7Vau7IBpvwaSl6LJ72b4vtJKXdn7z9J+JrSxyw
xvyYQwhfTZV9TDjIVmcObGrWLRiWLfWvdrsT9qf95SOuzyRLUp+jz8j9uQp2w/Mt
cQzhwgiV2XjfIWZl+OJDv4N4YRQt7j1EbwnyuhxAn/gRw802Yn4z88dzsGWVE+DI
llpmn4nPdLQEjGjwp/qCoJg=
-----END CERTIFICATE-----
`

const KEY_2 = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC/mGRZSuw09wEZ
7NwoadGasZLNwYF8q1FlynyNBLCZ8yjl81piAOrchLFSrW1mgc/rba17z5ZJN0+C
nMVPzBNuKO8TzocfMgjzSFkzR171GLg/vtcGq20avBfem07L9IM2Z0eugnVSoXc4
EB2dSzFmUaWNowOoP4BaiVLVS8GQkZEiljepZZIn+ictxORIq1M3a2BOMTKXCU+E
eMqk6DfUjO8SYMe3v3tdrW25FZUAOIlRBxfjiUp1Cw6/6y6yuPdjZgL7I6mxSENd
CZuPyJqjqrE1g+k83Ukpp0qowIVyzuJVMUdQVrW1Rf4TRoqrL9rUNFHHLJY/7poK
tU3J8Ud3AgMBAAECggEADmyksWxImDw4YwFIGerNkv3ndYIqA37KZAV4lw1RVmXO
IHHPzi0PgYaj6vuPjvYa9ziMpROd1ulJHSY8XKOamuKODUmxNpIHxnkd7hRje8Re
qr3tZl0lm6upiGLc7dH8xu3DocnEl3H8jcX41MzCbVecRSuOrO4K9cX87H4FlqKd
lIf6REiLC9FyQCndBMhSUYe07QmA3GxXmIqX4Z6jjPQbcFqLhkDuuULkxpEfvk8H
LqUMlp9mgCF/z46qxWPUYC5REGnNkXVruNQWk7UT3f875TgCltl9OcEo3Qg4n2z6
rfxZvynTPYUmG3WhzuU2yuDx8loH9TPLZkO2HflTgQKBgQDjmHFm3cfRQoaYxKZC
60Dx1kkip+Z06RIfJ5HzSMjUsUVdOCkPQb/e9Y8CYJvSzDqRJ7Wqc1jJGW0xGAX6
2UmsukYi8qfOB9CTKSzhsZU67VymPgN6IqblmTr6DtPzknDFMWmMDexDKQZaMein
L27sbgdSN2pjGSZu6yADXfFrVwKBgQDXgcLrWM4KjdgbCfT1EtbdzpwK+KmyD6d+
JPXDHRt8r7Kjx9nrRETg4nu017Pag8BAtqP22K+rM4/BlUu1xCF5+qbQoyjX3F3+
825YiuQ4OU8WC/MBehd2LZ1DGetyPrcJ/v4EVqxR/4RAVWUWMw/P/WHGNp8cDPTC
GvWsSweQ4QKBgFTmJc9IheRCm7DbEmY+GZDc7ZU26pnL442pliEZkoj8w7I9Y9uk
HC3QjhNF9HqS4noJRRQbSRBjIr9AheKIMZp0NfuNZxlNAvoSTwK12sQLjRcaZPOn
f3iAS2bCJ0Bh7R0yDHxJKUv4Pr1ghrfu0sLxXFvH/jCPTi3sGZoH7imrAoGBAJ0f
aKP6fU7ImDUuj0BXWf0h9DczkVXXgADCpcR55l6EIzSyMzoK7kUgG52AXwsEYBlO
kEEbPwkNcNRtK2P8+YNbsmAPdWncq1OE3IEF0tsDPZwPXj9Hau+o1i3kKfuDqiRJ
m55CKyUlrKDTIf6LgA3e6XiAvoTPFWyoB1J06bFBAoGBAI2q8xDZSXwmxVp2qZVh
NfxHvxs9IdL8erNrnbnAUJEiXkqobQ7fQY8nuHck/VMC1rrGEg/n3rl2at0z99or
N41G9TsKMg/k7IaaRSvpF8iS73g2eKuHHAD67tfPBCsEExNbiy4VLrW1T0v+fx6c
3YUHaUPxQrUgX1rpfD0Fh4G2
-----END PRIVATE KEY-----
`

// The module keeps its cache in module-level variables, so each test needs a fresh import
// (vi.resetModules() + dynamic import) alongside its own temp cert directory.
describe('mail-tls certificate reload', () => {
    let dir: string
    let certPath: string
    let keyPath: string
    const originalCertEnv = process.env.MAIL_TLS_CERT_PATH
    const originalKeyEnv = process.env.MAIL_TLS_KEY_PATH

    beforeEach(() => {
        vi.resetModules()
        dir = mkdtempSync(join(tmpdir(), 'mail-tls-test-'))
        certPath = join(dir, 'cert.pem')
        keyPath = join(dir, 'key.pem')
        writeFileSync(certPath, CERT_1)
        writeFileSync(keyPath, KEY_1)
        process.env.MAIL_TLS_CERT_PATH = certPath
        process.env.MAIL_TLS_KEY_PATH = keyPath
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    afterEach(() => {
        vi.useRealTimers()
        rmSync(dir, { recursive: true, force: true })
        if (originalCertEnv === undefined) delete process.env.MAIL_TLS_CERT_PATH
        else process.env.MAIL_TLS_CERT_PATH = originalCertEnv
        if (originalKeyEnv === undefined) delete process.env.MAIL_TLS_KEY_PATH
        else process.env.MAIL_TLS_KEY_PATH = originalKeyEnv
    })

    it('loads the configured cert and keeps serving it unchanged inside the 60s recheck window', async () => {
        const { getMailTLSOptions, resetMailTLSCache } = await import('../mail-tls')
        resetMailTLSCache()

        const first = getMailTLSOptions()
        expect(first?.cert.toString()).toBe(CERT_1)

        // Swap the files on disk (with a distinct, later mtime) but stay under 60s of fake
        // time. A correct implementation must not even look — it should keep serving the
        // originally cached bytes without re-stating the files.
        writeFileSync(certPath, CERT_2)
        writeFileSync(keyPath, KEY_2)
        const bumped = new Date(Date.now() + 5_000)
        utimesSync(certPath, bumped, bumped)
        utimesSync(keyPath, bumped, bumped)

        vi.setSystemTime(new Date('2026-01-01T00:00:30Z')) // +30s — inside the window
        const stillCached = getMailTLSOptions()
        expect(stillCached?.cert.toString()).toBe(CERT_1)
    })

    it('reloads once the recheck window elapses and the file mtime changed', async () => {
        const { getMailTLSOptions, resetMailTLSCache } = await import('../mail-tls')
        resetMailTLSCache()

        expect(getMailTLSOptions()?.cert.toString()).toBe(CERT_1)

        writeFileSync(certPath, CERT_2)
        writeFileSync(keyPath, KEY_2)
        const bumped = new Date(Date.now() + 5_000)
        utimesSync(certPath, bumped, bumped)
        utimesSync(keyPath, bumped, bumped)

        vi.setSystemTime(new Date('2026-01-01T00:01:01Z')) // +61s — past the window
        const reloaded = getMailTLSOptions()
        expect(reloaded?.cert.toString()).toBe(CERT_2)
        expect(reloaded?.key.toString()).toBe(KEY_2)
    })

    it('does not reload when the recheck window elapses but the file is unchanged', async () => {
        const { getMailTLSOptions, resetMailTLSCache } = await import('../mail-tls')
        resetMailTLSCache()

        const first = getMailTLSOptions()
        vi.setSystemTime(new Date('2026-01-01T00:01:01Z')) // past the window, file untouched
        const second = getMailTLSOptions()
        expect(second?.cert.toString()).toBe(first?.cert.toString())
        expect(second?.cert.toString()).toBe(CERT_1)
    })

    it('builds a real tls.SecureContext and only rebuilds it when the cert changes', async () => {
        const { getMailTLSSecureContext, resetMailTLSCache } = await import('../mail-tls')
        resetMailTLSCache()

        const ctx1 = getMailTLSSecureContext()
        // @types/node doesn't expose SecureContext as a constructible value (only as an
        // interface), so check the runtime constructor name rather than instanceof.
        expect(ctx1?.constructor.name).toBe('SecureContext')
        // Cached: same underlying content, no rebuild.
        expect(getMailTLSSecureContext()).toBe(ctx1)

        writeFileSync(certPath, CERT_2)
        writeFileSync(keyPath, KEY_2)
        const bumped = new Date(Date.now() + 5_000)
        utimesSync(certPath, bumped, bumped)
        utimesSync(keyPath, bumped, bumped)
        vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))

        const ctx2 = getMailTLSSecureContext()
        expect(ctx2?.constructor.name).toBe('SecureContext')
        expect(ctx2).not.toBe(ctx1)
    })

    it('returns null (and never throws) when no certificate is configured', async () => {
        delete process.env.MAIL_TLS_CERT_PATH
        delete process.env.MAIL_TLS_KEY_PATH
        const { getMailTLSOptions, getMailTLSSecureContext, hasMailTLS, resetMailTLSCache } = await import('../mail-tls')
        resetMailTLSCache()

        expect(getMailTLSOptions()).toBeNull()
        expect(getMailTLSSecureContext()).toBeNull()
        expect(hasMailTLS()).toBe(false)
    })
})
