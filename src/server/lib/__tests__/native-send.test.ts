/**
 * docs/outbound-authentication-audit.md, Fase 2 + Fase 3 — the native outbound path,
 * end to end through the REAL production composer (`composeOutreachMime`) and the REAL
 * `relayMessage`. Every assertion is against the delivered bytes: a `DKIM-Signature` header
 * that actually verifies, and `List-Unsubscribe`/`List-Unsubscribe-Post` present. Nothing
 * here asserts on a log line or a boolean the code merely set.
 *
 * Only two seams are mocked: `../../db` (native-send.ts imports it at module scope; unused by
 * `relayMessage`) and `sendOutbound` (the actual network call) — everything else, including
 * DKIM signing and mailauth verification, runs for real.
 */
import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dkimVerify } from 'mailauth'
import { composeOutreachMime, readMimeHeader } from '../outreach-provider'

const DOMAIN = 'native-send-test.example'
const SELECTOR = 'sel1'
const FROM = `info@${DOMAIN}`
const TO = 'lead@prospect.example'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const dkimTxt = `v=DKIM1; k=rsa; p=${publicKey.replace(/-----[A-Z ]+-----|\s/g, '')}`
const resolver = async (name: string, rrtype: string): Promise<string[][]> => {
    if (rrtype === 'TXT' && name === `${SELECTOR}._domainkey.${DOMAIN}`) return [[dkimTxt]]
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
}

const { getDkimConfigForEmailMock, sendOutboundMock } = vi.hoisted(() => ({
    getDkimConfigForEmailMock: vi.fn(),
    sendOutboundMock: vi.fn(async () => ({ response: '250 OK', via: 'relay' })),
}))

vi.mock('../../../db', () => ({ db: {} }))

vi.mock('../dkim', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dkim')>()
    return { ...actual, getDkimConfigForEmail: getDkimConfigForEmailMock }
})

vi.mock('../outbound-transport', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../outbound-transport')>()
    return { ...actual, sendOutbound: sendOutboundMock }
})

let relayMessage: typeof import('../native-send').relayMessage

beforeEach(async () => {
    vi.clearAllMocks()
    sendOutboundMock.mockResolvedValue({ response: '250 OK', via: 'relay' })
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.NATIVE_DKIM_SIGN
    ;({ relayMessage } = await import('../native-send'))
})

/** Shape of `dkim.ts`'s `DkimConfig` — what `getDkimConfigForEmail` resolves to, already
 *  mapped from the DB row (this test mocks the function itself, not the query underneath). */
function dkimConfigRow(key: string = privateKey) {
    return { domainName: DOMAIN, keySelector: SELECTOR, privateKey: key }
}

describe('relayMessage (native-send.ts) — real composer, real signing, real verification', () => {
    it('delivers bytes whose DKIM-Signature and List-Unsubscribe headers both verify', async () => {
        getDkimConfigForEmailMock.mockResolvedValue(dkimConfigRow())

        const composed = await composeOutreachMime({
            from: { address: FROM, name: 'Info' },
            to: [TO],
            subject: 'Warm-up mesh message',
            text: 'Hello from the mesh.',
            unsubscribe: {
                url: 'https://mail.skale.club/o/u/averyveryveryverylongonclicktokenthatwouldnormallyfoldacrosslinesinnodemailerssevenetyeightcharacterlimit',
                mailto: 'unsubscribe@native-send-test.example?subject=unsubscribe',
            },
        })

        await relayMessage(FROM, [TO], composed.raw, { resolver })

        expect(sendOutboundMock).toHaveBeenCalledTimes(1)
        const [mail] = sendOutboundMock.mock.calls[0] as unknown as [{ raw: Buffer; envelope: { from: string; to: string[] } }]
        const delivered = mail.raw
        const deliveredText = delivered.toString('utf8')

        // DKIM: present, correct d=/s=, and independently verifies against the public key —
        // exactly the bytes handed to the transport, not a copy made before signing.
        expect(deliveredText).toContain('DKIM-Signature:')
        const verified = await dkimVerify(delivered, { resolver })
        const match = verified.results?.find((r) => r.signingDomain === DOMAIN)
        expect(match?.status.result).toBe('pass')
        expect(match?.selector).toBe(SELECTOR)

        // sendOutbound must NOT be handed a dkim option — the bytes are already signed, and
        // signing again would produce a second, competing signature.
        expect((sendOutboundMock.mock.calls[0] as unknown as unknown[])[2]).toBeUndefined()

        // Fase 3 — List-Unsubscribe / List-Unsubscribe-Post survive the native relay
        // unchanged (readMimeHeader unfolds RFC 5322 continuation lines to read the value;
        // see outreach-provider.ts's own doc comment on why a naive `includes()` is wrong).
        expect(readMimeHeader(delivered, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click')
        expect(readMimeHeader(delivered, 'List-Unsubscribe')).toContain('<mailto:unsubscribe@native-send-test.example?subject=unsubscribe>')

        // Envelope-from / Return-Path alignment (Fase 3): envelope MAIL FROM domain matches
        // the visible From: header domain.
        expect(mail.envelope.from).toBe(FROM)
        expect(deliveredText).toContain(`From: Info <${FROM}>`)
    })

    it('refuses to deliver and never calls sendOutbound when the signature does not verify', async () => {
        // A DIFFERENT keypair than the one `resolver` publishes for this domain/selector —
        // signing succeeds (Nodemailer doesn't know any better), but verification against the
        // real public key genuinely fails. No mock of the verification result itself.
        const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        })
        getDkimConfigForEmailMock.mockResolvedValue(dkimConfigRow(wrongPrivateKey))

        const composed = await composeOutreachMime({
            from: { address: FROM, name: 'Info' },
            to: [TO],
            subject: 'Warm-up mesh message',
            text: 'Hello from the mesh.',
        })

        await expect(relayMessage(FROM, [TO], composed.raw, { resolver })).rejects.toThrow(/DKIM self-verification failed/)
        expect(sendOutboundMock).not.toHaveBeenCalled()
    })

    it('still delivers (unsigned) when the sender domain has no DKIM key configured', async () => {
        getDkimConfigForEmailMock.mockResolvedValue(null)

        const composed = await composeOutreachMime({
            from: { address: FROM, name: 'Info' },
            to: [TO],
            subject: 'No key configured',
            text: 'Body.',
        })

        await relayMessage(FROM, [TO], composed.raw, { resolver })

        expect(sendOutboundMock).toHaveBeenCalledTimes(1)
        const [mail] = sendOutboundMock.mock.calls[0] as unknown as [{ raw: Buffer }]
        expect(mail.raw.toString('utf8')).not.toContain('DKIM-Signature:')
    })
})
