import { Router, Request, Response } from 'express'
import { db } from '../../db'
import { systemIntegrations } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { encryptSecret, decryptSecret } from '../lib/crypto'
import { isPlatformAdmin } from '../lib/admin'
import crypto from 'crypto'

const router = Router()
const INTEGRATIONS_ID = 'default'

// ─── helpers ──────────────────────────────────────────────────────────────────

function maskToken(token: string | null | undefined): string | null {
    if (!token) return null
    try {
        // Decrypt to get actual value length, mask keeping last 4 chars of the real token
        const real = decryptSecret(token)
        if (real.length <= 4) return '****'
        return `****${real.slice(-4)}`
    } catch {
        // If decryption fails (e.g. legacy plaintext stored), still mask safely
        return '****'
    }
}

async function readIntegrations() {
    const row = await db.query.systemIntegrations.findFirst({
        where: eq(systemIntegrations.id, INTEGRATIONS_ID),
    })
    return row ?? null
}

function getMonitorToken(): string | null {
    return process.env.MONITOR_API_TOKEN ?? null
}

function timingSafeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    if (bufA.length !== bufB.length) {
        // Still run comparison to avoid timing leak on length
        crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length))
        return false
    }
    return crypto.timingSafeEqual(bufA, bufB)
}

// ─── GET / — admin only ────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) return res.status(401).json({ error: 'Unauthorized' })
        if (!await isPlatformAdmin(userId)) return res.status(403).json({ error: 'Forbidden' })

        const row = await readIntegrations()

        res.json({
            telegramBotToken: maskToken(row?.telegramBotToken),
            telegramChatId: row?.telegramChatId ?? null,
            telegramEnabled: row?.telegramEnabled ?? false,
            updatedAt: row?.updatedAt ?? null,
        })
    } catch (error) {
        console.error('Error fetching integrations:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ─── PATCH / — admin only ─────────────────────────────────────────────────────

const patchSchema = z.object({
    telegramBotToken: z.string().optional(),
    telegramChatId: z.string().optional(),
    telegramEnabled: z.boolean().optional(),
})

router.patch('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) return res.status(401).json({ error: 'Unauthorized' })
        if (!await isPlatformAdmin(userId)) return res.status(403).json({ error: 'Forbidden' })

        const parseResult = patchSchema.safeParse(req.body)
        if (!parseResult.success) {
            return res.status(400).json({ error: parseResult.error.errors })
        }

        const { telegramBotToken, telegramChatId, telegramEnabled } = parseResult.data
        const current = await readIntegrations()

        // Build update payload — only overwrite fields that were explicitly sent
        const payload: Partial<typeof systemIntegrations.$inferInsert> = {
            updatedAt: new Date(),
        }

        if (telegramBotToken !== undefined && telegramBotToken.trim() !== '') {
            payload.telegramBotToken = encryptSecret(telegramBotToken.trim())
        } else if (current?.telegramBotToken) {
            payload.telegramBotToken = current.telegramBotToken
        }

        if (telegramChatId !== undefined) {
            payload.telegramChatId = telegramChatId
        }

        if (telegramEnabled !== undefined) {
            payload.telegramEnabled = telegramEnabled
        }

        // Upsert
        await db.insert(systemIntegrations)
            .values({ id: INTEGRATIONS_ID, ...payload })
            .onConflictDoUpdate({
                target: systemIntegrations.id,
                set: payload,
            })

        const updated = await readIntegrations()

        res.json({
            telegramBotToken: maskToken(updated?.telegramBotToken),
            telegramChatId: updated?.telegramChatId ?? null,
            telegramEnabled: updated?.telegramEnabled ?? false,
            updatedAt: updated?.updatedAt ?? null,
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating integrations:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ─── POST /test — admin only ───────────────────────────────────────────────────

router.post('/test', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) return res.status(401).json({ error: 'Unauthorized' })
        if (!await isPlatformAdmin(userId)) return res.status(403).json({ error: 'Forbidden' })

        const row = await readIntegrations()

        if (!row?.telegramBotToken) {
            return res.status(400).json({ success: false, error: 'Telegram Bot Token not configured' })
        }
        if (!row.telegramChatId) {
            return res.status(400).json({ success: false, error: 'Telegram Chat ID not configured' })
        }

        let token: string
        try {
            token = decryptSecret(row.telegramBotToken)
        } catch {
            return res.status(500).json({ success: false, error: 'Failed to decrypt Bot Token' })
        }

        const chatId = row.telegramChatId
        const text = `[Xmail] Test message from admin panel — integrations are working correctly.`

        const telegramUrl = `https://api.telegram.org/bot${token}/sendMessage`
        const response = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
        })

        const body = await response.json() as { ok: boolean; description?: string }

        if (!response.ok || !body.ok) {
            return res.json({ success: false, error: body.description ?? `Telegram API returned ${response.status}` })
        }

        res.json({ success: true })
    } catch (error) {
        console.error('Error testing Telegram integration:', error)
        res.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
    }
})

// ─── GET /monitor-config — authenticated by x-monitor-token header ─────────────

router.get('/monitor-config', async (req: Request, res: Response) => {
    const monitorApiToken = getMonitorToken()

    if (!monitorApiToken) {
        return res.status(503).json({ error: 'Monitor API token not configured on server' })
    }

    const providedToken = req.headers['x-monitor-token'] as string | undefined

    if (!providedToken || !timingSafeEqual(providedToken, monitorApiToken)) {
        return res.status(401).json({ error: 'Unauthorized' })
    }

    try {
        const row = await readIntegrations()

        if (!row) {
            return res.json({ telegramBotToken: null, telegramChatId: null, telegramEnabled: false })
        }

        let telegramBotToken: string | null = null
        if (row.telegramBotToken) {
            try {
                telegramBotToken = decryptSecret(row.telegramBotToken)
            } catch {
                telegramBotToken = null
            }
        }

        res.json({
            telegramBotToken,
            telegramChatId: row.telegramChatId ?? null,
            telegramEnabled: row.telegramEnabled,
        })
    } catch (error) {
        console.error('Error fetching monitor config:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
