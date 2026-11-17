import crypto from 'crypto'
import type { RequestHandler } from 'express'

/** Authenticate exact relay bytes before JSON parsing, config lookup or business work. */
export function verifyTelegramRelay(raw: Buffer, timestamp: unknown, signature: unknown, secret: string | undefined, now = Date.now()): boolean {
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || !Buffer.isBuffer(raw)) return false
    if (typeof timestamp !== 'string' || !/^[0-9]{1,12}$/.test(timestamp)) return false
    if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false
    if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false
    const expected = crypto.createHmac('sha256', secret).update(timestamp + '.').update(raw).digest()
    const actual = Buffer.from(signature.slice(7), 'hex')
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

export function createTelegramSharedWebhook(dispatch: (update: Record<string, unknown>) => Promise<number>): RequestHandler {
    return async (req, res) => {
        if (process.env.TELEGRAM_SHARED_WEBHOOK !== 'true') { res.sendStatus(404); return }
        if (!verifyTelegramRelay(req.body, req.headers['x-skale-telegram-timestamp'], req.headers['x-skale-telegram-signature'], process.env.TELEGRAM_RELAY_SECRET)) {
            res.sendStatus(401); return
        }
        let update: unknown
        try { update = JSON.parse(req.body.toString('utf8')) } catch { res.sendStatus(400); return }
        if (!update || typeof update !== 'object' || Array.isArray(update)) { res.sendStatus(400); return }
        try { res.sendStatus(await dispatch(update as Record<string, unknown>)) }
        catch { console.error('[telegram-approvals] shared relay dispatch failed'); res.sendStatus(500) }
    }
}
