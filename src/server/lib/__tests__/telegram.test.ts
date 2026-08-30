/**
 * Covers the two things that decide whether this alerting is trustworthy:
 *
 *  1. It NEVER throws and NEVER blocks, whatever Telegram or the database do.
 *     A notification is not worth failing a mail delivery over.
 *  2. When a send is refused it prints Telegram's own explanation. The
 *     supergroup migration is the failure mode that matters: the chat id
 *     changes, every later alert fails, and nothing looks broken — the messages
 *     simply stop. The replacement id must reach the operator.
 *
 * The database and crypto layers are mocked so the panel row can be varied
 * without a live Postgres.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    __resetTelegramConfigCache,
    escapeHtml,
    isTelegramConfigured,
    sendTelegram,
} from '../telegram'

interface PanelRow {
    telegramBotToken: string | null
    telegramChatId: string | null
    telegramEnabled: boolean
}

// Hoisted so the mock factories below can close over it: they run before the
// module graph is evaluated, when a plain module-scope `let` is still in its
// temporal dead zone.
const state = vi.hoisted(() => ({
    panelRow: null as PanelRow | null,
    panelThrows: false,
}))

vi.mock('../../../db', () => ({
    db: {
        query: {
            systemIntegrations: {
                findFirst: vi.fn(async () => {
                    if (state.panelThrows) throw new Error('database unreachable')
                    return state.panelRow
                }),
            },
        },
    },
}))

vi.mock('../crypto', () => ({
    decryptSecret: vi.fn((payload: string) => {
        if (payload === 'UNDECRYPTABLE') throw new Error('wrong key')
        return payload.replace(/^enc:/, '')
    }),
}))

function panelConfigured(): void {
    state.panelRow = { telegramBotToken: 'enc:TOKEN123', telegramChatId: '8664810189', telegramEnabled: true }
}

function mockFetchOnce(body: unknown): void {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        json: async () => body,
    })))
}

describe('escapeHtml', () => {
    it('neutralises the characters that would break HTML parse mode', () => {
        expect(escapeHtml('<script> & "x"')).toBe('&lt;script&gt; &amp; &quot;x&quot;')
    })

    it('is applied to error text, which is where stray brackets come from', () => {
        expect(escapeHtml(new Error('unexpected <token>').message)).toBe('unexpected &lt;token&gt;')
    })
})

describe('sendTelegram', () => {
    beforeEach(() => {
        __resetTelegramConfigCache()
        state.panelRow = null
        state.panelThrows = false
        delete process.env.TELEGRAM_BOT_TOKEN
        delete process.env.TELEGRAM_CHAT_ID
        vi.unstubAllGlobals()
    })

    it('is a silent no-op when nothing is configured', async () => {
        const fetchSpy = vi.fn()
        vi.stubGlobal('fetch', fetchSpy)
        const result = await sendTelegram('Title')
        expect(result).toEqual({ ok: false, reason: 'unconfigured' })
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('stays a no-op while the panel row exists but the toggle is off', async () => {
        state.panelRow = { telegramBotToken: 'enc:TOKEN123', telegramChatId: '123', telegramEnabled: false }
        expect(await isTelegramConfigured()).toBe(false)
    })

    it('sends when the panel is configured and enabled', async () => {
        panelConfigured()
        mockFetchOnce({ ok: true })
        await expect(sendTelegram('Title', 'Body')).resolves.toEqual({ ok: true })
    })

    it('names the replacement chat id when a group becomes a supergroup', async () => {
        panelConfigured()
        mockFetchOnce({
            ok: false,
            error_code: 400,
            description: 'Bad Request: group chat was upgraded to a supergroup chat',
            parameters: { migrate_to_chat_id: -1001234567890 },
        })

        const result = await sendTelegram('Title')
        expect(result.ok).toBe(false)
        expect(result.reason).toBe('rejected')
        // The literal value the operator has to paste back.
        expect(result.detail).toContain('-1001234567890')
        expect(result.detail).toContain('admin panel')
    })

    it('explains the unmessaged-bot 403, the most common setup mistake', async () => {
        panelConfigured()
        mockFetchOnce({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' })
        const result = await sendTelegram('Title')
        expect(result.detail).toContain('cannot start a conversation')
    })

    it('falls back to the environment when the database is unreachable', async () => {
        state.panelThrows = true
        process.env.TELEGRAM_BOT_TOKEN = 'ENVTOKEN'
        process.env.TELEGRAM_CHAT_ID = '999'
        mockFetchOnce({ ok: true })
        await expect(sendTelegram('Title')).resolves.toEqual({ ok: true })
    })

    it('treats an undecryptable panel token as unconfigured rather than crashing', async () => {
        state.panelRow = { telegramBotToken: 'UNDECRYPTABLE', telegramChatId: '123', telegramEnabled: true }
        const result = await sendTelegram('Title')
        expect(result).toEqual({ ok: false, reason: 'unconfigured' })
    })

    it('resolves instead of rejecting when the network fails', async () => {
        panelConfigured()
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('ECONNREFUSED')
        }))
        const result = await sendTelegram('Title')
        expect(result.ok).toBe(false)
        expect(result.reason).toBe('network')
    })

    it('truncates a body past Telegram 4096-character hard limit', async () => {
        panelConfigured()
        let captured = ''
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
            captured = JSON.parse(init.body).text
            return { json: async () => ({ ok: true }) }
        }))

        await sendTelegram('Title', 'x'.repeat(9000))
        expect(captured.length).toBeLessThanOrEqual(4096)
        expect(captured).toContain('[truncated]')
    })
})
