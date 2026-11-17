import crypto from 'crypto'
import { readFileSync } from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTelegramSharedWebhook, verifyTelegramRelay } from '../telegram-shared-webhook'

const secret = 'relay-secret-for-tests-only-0123456789'
const now = 1_800_000_000_000
const timestamp = String(now / 1000)
const raw = Buffer.from('{ "update_id": 1 }')
const sign = (body: Buffer = raw, ts = timestamp, key = secret) => 'sha256=' + crypto.createHmac('sha256', key).update(ts + '.').update(body).digest('hex')
afterEach(() => vi.unstubAllEnvs())

describe('relay signature', () => {
    it('accepts exact bytes and rejects altered JSON bytes', () => {
        expect(verifyTelegramRelay(raw, timestamp, sign(), secret, now)).toBe(true)
        expect(verifyTelegramRelay(Buffer.from('{"update_id":1}'), timestamp, sign(), secret, now)).toBe(false)
    })
    it('fails closed on absent/short keys, malformed headers and stale/future timestamps', () => {
        for (const key of [undefined, '', 'short']) expect(verifyTelegramRelay(raw, timestamp, sign(), key, now)).toBe(false)
        for (const ts of [undefined, '1e9', timestamp + '.0', String(now / 1000 - 301), String(now / 1000 + 301)]) {
            expect(verifyTelegramRelay(raw, ts, sign(raw, String(ts)), secret, now)).toBe(false)
        }
        for (const sig of [undefined, 'sha256=ff', sign().replace('sha256=', '')]) expect(verifyTelegramRelay(raw, timestamp, sig, secret, now)).toBe(false)
    })
})

describe('raw relay handler', () => {
    async function invoke(body: Buffer, signature: string | undefined, enabled = true) {
        vi.stubEnv('TELEGRAM_SHARED_WEBHOOK', String(enabled))
        vi.stubEnv('TELEGRAM_RELAY_SECRET', secret)
        const ts = String(Math.floor(Date.now() / 1000))
        const dispatch = vi.fn(async () => 200)
        const res = { sendStatus: vi.fn() }
        await createTelegramSharedWebhook(dispatch)({ body, headers: { 'x-skale-telegram-timestamp': ts, 'x-skale-telegram-signature': signature === 'valid' ? sign(body, ts) : signature } } as never, res as never, vi.fn())
        return { dispatch, status: res.sendStatus.mock.calls[0][0] }
    }
    it('rejects unsigned malformed JSON before parsing or dispatch', async () => {
        const result = await invoke(Buffer.from('{invalid'), undefined)
        expect(result.status).toBe(401)
        expect(result.dispatch).not.toHaveBeenCalled()
    })
    it('parses only authenticated object updates', async () => {
        const result = await invoke(raw, 'valid')
        expect(result.status).toBe(200)
        expect(result.dispatch).toHaveBeenCalledWith({ update_id: 1 })
        expect((await invoke(Buffer.from('{invalid'), 'valid')).status).toBe(400)
        expect((await invoke(Buffer.from('[]'), 'valid')).status).toBe(400)
        expect((await invoke(raw, 'valid', false)).status).toBe(404)
    })
    it('mounts bounded raw parsing before the global JSON parser and rejects the direct route', () => {
        const server = readFileSync('src/server/production-server.ts', 'utf8')
        expect(server.indexOf("app.post('/telegram/shared-webhook'")).toBeLessThan(server.indexOf("app.use(express.json("))
        expect(server).toContain("express.raw({ type: 'application/json', limit: '256kb' })")
        expect(server).toContain("if (process.env.TELEGRAM_SHARED_WEBHOOK === 'true') { res.sendStatus(401); return }")
    })
})
