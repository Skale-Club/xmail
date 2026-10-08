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
    getTelegramConfig,
    isTelegramConfigured,
    sendTelegram,
    setTelegramOutreachChat,
} from '../telegram'

interface PanelRow {
    telegramBotToken: string | null
    telegramChatId: string | null
    telegramOutreachChatId?: string | null
    telegramOutreachThreadId?: string | null
    telegramEnabled: boolean
}

// Hoisted so the mock factories below can close over it: they run before the
// module graph is evaluated, when a plain module-scope `let` is still in its
// temporal dead zone.
const state = vi.hoisted(() => ({
    panelRow: null as PanelRow | null,
    panelThrows: false,
    updates: [] as Array<Record<string, unknown>>,
    outreachColumnsMissing: false,
}))

vi.mock('../../../db', () => ({
    db: {
        update: vi.fn(() => ({
            set: (values: Record<string, unknown>) => {
                state.updates.push(values)
                return { where: async () => undefined }
            },
        })),
        query: {
            systemIntegrations: {
                findFirst: vi.fn(async (args?: { columns?: Record<string, boolean> }) => {
                    if (state.panelThrows) throw new Error('database unreachable')
                    if (state.outreachColumnsMissing && args?.columns?.telegramOutreachChatId) {
                        throw new Error('column "telegram_outreach_chat_id" does not exist')
                    }
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

describe('telegram channels', () => {
    beforeEach(() => {
        __resetTelegramConfigCache()
        state.panelRow = null
        state.panelThrows = false
        state.updates = []
        state.outreachColumnsMissing = false
        delete process.env.TELEGRAM_BOT_TOKEN
        delete process.env.TELEGRAM_CHAT_ID
        delete process.env.TELEGRAM_THREAD_ID
        vi.unstubAllGlobals()
    })

    function captureSends(): Array<Record<string, unknown>> {
        const sent: Array<Record<string, unknown>> = []
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
            sent.push(JSON.parse(init.body))
            return { json: async () => ({ ok: true }) }
        }))
        return sent
    }

    it('keeps ops sends exactly as before: ops chat, no thread, same payload shape', async () => {
        state.panelRow = { telegramBotToken: 'enc:TOKEN123', telegramChatId: '8664810189', telegramOutreachChatId: '-1001', telegramEnabled: true }
        const sent = captureSends()
        await sendTelegram('Title', 'Body')
        expect(sent).toEqual([{ chat_id: '8664810189', text: 'Title\n\nBody', parse_mode: 'HTML', disable_web_page_preview: true }])
    })

    it('sends outreach to the ops chat while no outreach chat is configured', async () => {
        panelConfigured()
        const sent = captureSends()
        await sendTelegram('Title', 'Body', 'outreach')
        expect(sent[0].chat_id).toBe('8664810189')
        expect(await isTelegramConfigured('outreach')).toBe(true)
    })

    it('treats a blank outreach chat id as not configured', async () => {
        state.panelRow = { telegramBotToken: 'enc:TOKEN123', telegramChatId: '8664810189', telegramOutreachChatId: '   ', telegramEnabled: true }
        const sent = captureSends()
        await sendTelegram('Title', '', 'outreach')
        expect(sent[0].chat_id).toBe('8664810189')
    })

    it('sends outreach to its own chat and thread once configured, leaving ops on the ops chat', async () => {
        state.panelRow = {
            telegramBotToken: 'enc:TOKEN123', telegramChatId: '8664810189',
            telegramOutreachChatId: '-1001234567890', telegramOutreachThreadId: '77', telegramEnabled: true,
        }
        const sent = captureSends()
        await sendTelegram('Reply', 'Body', 'outreach')
        await sendTelegram('Deploy', 'Body')
        expect(sent[0]).toMatchObject({ chat_id: '-1001234567890', message_thread_id: '77' })
        expect(sent[1].chat_id).toBe('8664810189')
        expect(sent[1]).not.toHaveProperty('message_thread_id')
    })

    it('never applies the ops thread to the outreach chat, nor the outreach thread to ops', async () => {
        process.env.TELEGRAM_THREAD_ID = '5'
        state.panelRow = {
            telegramBotToken: 'enc:TOKEN123', telegramChatId: '8664810189', telegramOutreachChatId: '-1001', telegramEnabled: true,
        }
        const sent = captureSends()
        await sendTelegram('Reply', '', 'outreach')
        await sendTelegram('Deploy')
        expect(sent[0].chat_id).toBe('-1001')
        expect(sent[0]).not.toHaveProperty('message_thread_id')
        expect(sent[1]).toMatchObject({ chat_id: '8664810189', message_thread_id: '5' })
    })

    it('exposes the owner (ops) chat and the outreach chat on either channel config', async () => {
        state.panelRow = {
            telegramBotToken: 'enc:TOKEN123', telegramChatId: '8664810189', telegramOutreachChatId: '-1001', telegramEnabled: true,
        }
        const outreach = await getTelegramConfig('outreach')
        const ops = await getTelegramConfig('ops')
        expect(outreach).toMatchObject({ chatId: '-1001', opsChatId: '8664810189', outreachChatId: '-1001', channel: 'outreach' })
        expect(ops).toMatchObject({ chatId: '8664810189', opsChatId: '8664810189', outreachChatId: '-1001', channel: 'ops' })
    })

    it('keeps ops alerts working when migration 075 has not run yet (outreach columns missing)', async () => {
        state.outreachColumnsMissing = true
        panelConfigured()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const sent = captureSends()
        await expect(sendTelegram('Deploy')).resolves.toEqual({ ok: true })
        await expect(sendTelegram('Reply', '', 'outreach')).resolves.toEqual({ ok: true })
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('migration 075'), expect.any(String))
        warn.mockRestore()
        expect(sent.map((p) => p.chat_id)).toEqual(['8664810189', '8664810189'])
    })

    it('is unconfigured on both channels when there is no bot', async () => {
        expect(await getTelegramConfig('outreach')).toBeNull()
        expect(await isTelegramConfigured('outreach')).toBe(false)
    })

    it('saving the outreach chat resets the thread and takes effect immediately', async () => {
        panelConfigured()
        expect((await getTelegramConfig('outreach'))?.chatId).toBe('8664810189') // cached: falls back to ops

        state.panelRow = { ...state.panelRow!, telegramOutreachChatId: '-100555' }
        await setTelegramOutreachChat('-100555')

        expect(state.updates[0]).toMatchObject({ telegramOutreachChatId: '-100555', telegramOutreachThreadId: null })
        expect((await getTelegramConfig('outreach'))?.chatId).toBe('-100555')
    })

    it('clearing the outreach chat writes null', async () => {
        panelConfigured()
        await setTelegramOutreachChat(null)
        expect(state.updates[0]).toMatchObject({ telegramOutreachChatId: null, telegramOutreachThreadId: null })
    })
})
