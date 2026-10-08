import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    approvalRow: null as null | Record<string, unknown>,
}))

vi.mock('../../../db', () => ({
    db: { query: { outreachActionApprovals: { findFirst: vi.fn(async () => state.approvalRow) } } },
}))
vi.mock('../approval-actions', () => ({ approveOutreachAction: vi.fn(), rejectOutreachAction: vi.fn() }))
vi.mock('../outreach-approval-preview', () => ({ buildCampaignActivationPreview: vi.fn() }))
vi.mock('../telegram', () => ({
    callTelegramApi: vi.fn(),
    getTelegramConfig: vi.fn(),
    setTelegramOutreachChat: vi.fn(),
}))

import { getTelegramConfig, callTelegramApi } from '../telegram'
import {
    ensureTelegramWebhook,
    handleTelegramUpdate,
    notifyApprovalRequested,
    telegramWebhookSecret,
    type TelegramApprovalDeps,
} from '../telegram-approvals'

const TOKEN = '123456:test-token'
const OWNER = 8664810189
const GROUP = -1003344556677
const OTHER_GROUP = -1009988776655
const STRANGER = 999
const APPROVAL = '188ac9e2-6f4a-4ece-9151-dfcae6115b82'
const ORG = '11111111-1111-4111-8111-111111111111'
const SECRET = telegramWebhookSecret(TOKEN)

type Cfg = { token: string; chatId: string; opsChatId: string; outreachChatId?: string; channel: 'ops'; source: 'panel'; threadId?: string }
let deps: TelegramApprovalDeps & {
    api: ReturnType<typeof vi.fn>
    approve: ReturnType<typeof vi.fn>
    reject: ReturnType<typeof vi.fn>
    saveOutreachChat: ReturnType<typeof vi.fn>
    config: ReturnType<typeof vi.fn>
}

function config(overrides: Partial<Cfg> = {}): Cfg {
    return { token: TOKEN, chatId: String(OWNER), opsChatId: String(OWNER), channel: 'ops', source: 'panel', ...overrides }
}

function tap(data: string, fromId = OWNER, chatId = OWNER) {
    return { callback_query: { id: 'cb-1', from: { id: fromId }, data, message: { message_id: 42, chat: { id: chatId }, text: 'card' } } }
}

function memberUpdate(chat: { id: number; type: string; title?: string }, oldStatus: string, newStatus: string, fromId = OWNER) {
    return {
        my_chat_member: {
            chat,
            from: { id: fromId, first_name: 'Vanildo' },
            old_chat_member: { status: oldStatus },
            new_chat_member: { status: newStatus },
        },
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    state.approvalRow = null
    deps = {
        config: vi.fn().mockResolvedValue(config()),
        saveOutreachChat: vi.fn().mockResolvedValue(undefined),
        api: vi.fn().mockResolvedValue({ ok: true, result: true }),
        approve: vi.fn().mockResolvedValue({ ok: true, status: 200, body: { idempotentReplay: false } }),
        reject: vi.fn().mockResolvedValue({ ok: true, status: 200, body: {} }),
        findApproval: vi.fn().mockResolvedValue({ id: APPROVAL, organizationId: ORG, actionKind: 'campaign_activation' }),
        reviewer: vi.fn().mockResolvedValue('reviewer-user'),
        cardText: vi.fn().mockResolvedValue('<b>card</b>'),
    } as never
})

const calls = (method: string) => deps.api.mock.calls.filter(([m]) => m === method).map(([, payload]) => payload)

describe('handleTelegramUpdate', () => {
    it('rejects a request without the webhook secret, touching nothing', async () => {
        expect(await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`), 'wrong', deps)).toBe(401)
        expect(await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`), undefined, deps)).toBe(401)
        expect(await handleTelegramUpdate(memberUpdate({ id: GROUP, type: 'supergroup' }, 'left', 'member'), 'wrong', deps)).toBe(401)
        expect(deps.approve).not.toHaveBeenCalled()
        expect(deps.api).not.toHaveBeenCalled()
        expect(deps.saveOutreachChat).not.toHaveBeenCalled()
    })

    it('ignores a tap from anyone but the configured owner chat', async () => {
        expect(await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`, 999), SECRET, deps)).toBe(200)
        expect(await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`, OWNER, -100123), SECRET, deps)).toBe(200)
        expect(deps.approve).not.toHaveBeenCalled()
        expect(calls('answerCallbackQuery')[0]).toMatchObject({ text: 'Sem permissão.' })
    })

    it('first Aprovar tap only asks for confirmation; it does not approve', async () => {
        await handleTelegramUpdate(tap(`apv:a:${APPROVAL}`), SECRET, deps)
        expect(deps.approve).not.toHaveBeenCalled()
        const markup = calls('editMessageReplyMarkup')[0] as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
        expect(markup.reply_markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual([`apv:c:${APPROVAL}`, `apv:x:${APPROVAL}`])
    })

    it('Voltar restores the first buttons without acting', async () => {
        await handleTelegramUpdate(tap(`apv:x:${APPROVAL}`), SECRET, deps)
        expect(deps.approve).not.toHaveBeenCalled()
        expect(deps.reject).not.toHaveBeenCalled()
        const markup = calls('editMessageReplyMarkup')[0] as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
        expect(markup.reply_markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual([`apv:a:${APPROVAL}`, `apv:r:${APPROVAL}`])
    })

    it('the confirm tap runs the panel approval with the resolved admin and says the campaign is live', async () => {
        await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`), SECRET, deps)
        expect(deps.approve).toHaveBeenCalledWith({ approvalId: APPROVAL, organizationId: ORG, actorUserId: 'reviewer-user', note: 'Aprovado pelo Telegram' })
        expect((calls('editMessageText')[0] as { text: string }).text).toContain('A campanha está ativa')
    })

    it('Recusar rejects through the shared function', async () => {
        await handleTelegramUpdate(tap(`apv:r:${APPROVAL}`), SECRET, deps)
        expect(deps.reject).toHaveBeenCalledWith(expect.objectContaining({ approvalId: APPROVAL, actorUserId: 'reviewer-user' }))
        expect((calls('editMessageText')[0] as { text: string }).text).toContain('Recusado')
    })

    it('shows the readiness issues when the campaign cannot be activated', async () => {
        deps.approve.mockResolvedValue({ ok: false, status: 422, body: { error: 'Campaign is not ready to activate', issues: [{ code: 'x', message: 'Lead has no inbox' }] } })
        await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`), SECRET, deps)
        const text = (calls('editMessageText')[0] as { text: string }).text
        expect(text).toContain('Não aprovado')
        expect(text).toContain('Lead has no inbox')
    })

    it('refuses when no Xmail admin can be recorded as reviewer', async () => {
        deps.reviewer = vi.fn().mockResolvedValue(null)
        await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`), SECRET, deps)
        expect(deps.approve).not.toHaveBeenCalled()
    })

    it('ignores malformed callback data', async () => {
        await handleTelegramUpdate(tap('apv:c:not-a-uuid'), SECRET, deps)
        await handleTelegramUpdate(tap(`other:${APPROVAL}`), SECRET, deps)
        expect(deps.approve).not.toHaveBeenCalled()
    })
})

describe('approvals tapped in the outreach GROUP', () => {
    beforeEach(() => {
        deps.config.mockResolvedValue(config({ outreachChatId: String(GROUP) }))
    })

    it('the owner can approve from the outreach group', async () => {
        expect(await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`, OWNER, GROUP), SECRET, deps)).toBe(200)
        expect(deps.approve).toHaveBeenCalledTimes(1)
        // The card is edited where it was tapped: the group.
        expect(calls('editMessageText')[0]).toMatchObject({ chat_id: GROUP, message_id: 42 })
    })

    it('another member of the group cannot approve or reject', async () => {
        await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`, STRANGER, GROUP), SECRET, deps)
        await handleTelegramUpdate(tap(`apv:r:${APPROVAL}`, STRANGER, GROUP), SECRET, deps)
        await handleTelegramUpdate(tap(`apv:a:${APPROVAL}`, STRANGER, GROUP), SECRET, deps)
        expect(deps.approve).not.toHaveBeenCalled()
        expect(deps.reject).not.toHaveBeenCalled()
        expect(calls('editMessageReplyMarkup')).toHaveLength(0)
        expect(calls('answerCallbackQuery').every((p) => (p as { text: string }).text === 'Sem permissão.')).toBe(true)
    })

    it('even the owner is refused from a chat that is neither the outreach group nor the ops chat', async () => {
        await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`, OWNER, OTHER_GROUP), SECRET, deps)
        expect(deps.approve).not.toHaveBeenCalled()
        expect(calls('answerCallbackQuery')[0]).toMatchObject({ text: 'Sem permissão.' })
    })

    it('cards sent to the ops chat before the group existed still work for the owner there', async () => {
        await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`, OWNER, OWNER), SECRET, deps)
        expect(deps.approve).toHaveBeenCalledTimes(1)
    })

    it('refuses everything when the ops chat is not private, saying why', async () => {
        deps.config.mockResolvedValue(config({ chatId: String(GROUP), opsChatId: String(GROUP), outreachChatId: undefined }))
        // A group chat id can never equal a user id, but be explicit: not even a "matching" tap passes.
        await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`, GROUP, GROUP), SECRET, deps)
        await handleTelegramUpdate(tap(`apv:c:${APPROVAL}`, OWNER, GROUP), SECRET, deps)
        expect(deps.approve).not.toHaveBeenCalled()
        const answers = calls('answerCallbackQuery') as Array<{ text: string }>
        expect(answers).toHaveLength(2)
        expect(answers[0].text).toContain('não é privado')
        expect(answers[0].text.length).toBeLessThanOrEqual(200)
    })
})

describe('my_chat_member: bot added to / removed from a group', () => {
    it('posts a card with a one-tap button to the OPS chat when the bot joins a supergroup', async () => {
        await handleTelegramUpdate(memberUpdate({ id: GROUP, type: 'supergroup', title: 'Xmail <Outreach>' }, 'left', 'member'), SECRET, deps)

        expect(calls('sendMessage')).toHaveLength(1)
        const card = calls('sendMessage')[0] as { chat_id: string; text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }
        expect(card.chat_id).toBe(String(OWNER))
        expect(card.text).toContain('Fui adicionado ao grupo <b>Xmail &lt;Outreach&gt;</b>')
        expect(card.text).toContain(`id ${GROUP}`)
        expect(card.text).toContain('Usar este grupo para os avisos de outreach?')
        expect(card.text).not.toContain('não é você')
        const button = card.reply_markup.inline_keyboard[0][0]
        expect(button.text).toBe('Usar para outreach')
        expect(button.callback_data).toBe(`chan:o:${GROUP}`)
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64)
        expect(deps.saveOutreachChat).not.toHaveBeenCalled() // nothing changes until the owner taps
    })

    it('flags a card when somebody else added the bot', async () => {
        await handleTelegramUpdate(memberUpdate({ id: GROUP, type: 'group', title: 'Unknown' }, 'left', 'member', STRANGER), SECRET, deps)
        expect((calls('sendMessage')[0] as { text: string }).text).toContain('não é você')
    })

    it('ignores private chats, channels, promotions inside the group and the group already in use', async () => {
        await handleTelegramUpdate(memberUpdate({ id: STRANGER, type: 'private' }, 'left', 'member'), SECRET, deps)
        await handleTelegramUpdate(memberUpdate({ id: GROUP, type: 'channel', title: 'c' }, 'left', 'administrator'), SECRET, deps)
        await handleTelegramUpdate(memberUpdate({ id: GROUP, type: 'supergroup', title: 'g' }, 'member', 'administrator'), SECRET, deps)
        deps.config.mockResolvedValue(config({ outreachChatId: String(GROUP) }))
        await handleTelegramUpdate(memberUpdate({ id: GROUP, type: 'supergroup', title: 'g' }, 'left', 'member'), SECRET, deps)
        expect(deps.api).not.toHaveBeenCalled()
        expect(deps.saveOutreachChat).not.toHaveBeenCalled()
    })

    it('does not post a card nobody could tap when the ops chat is not private', async () => {
        deps.config.mockResolvedValue(config({ chatId: String(OTHER_GROUP), opsChatId: String(OTHER_GROUP) }))
        await handleTelegramUpdate(memberUpdate({ id: GROUP, type: 'supergroup', title: 'g' }, 'left', 'member'), SECRET, deps)
        expect(deps.api).not.toHaveBeenCalled()
    })

    it('removal from the current outreach group clears it and tells the owner', async () => {
        deps.config.mockResolvedValue(config({ outreachChatId: String(GROUP) }))
        await handleTelegramUpdate(memberUpdate({ id: GROUP, type: 'supergroup', title: 'Xmail Outreach' }, 'member', 'kicked'), SECRET, deps)

        expect(deps.saveOutreachChat).toHaveBeenCalledWith(null)
        const note = calls('sendMessage')[0] as { chat_id: string; text: string }
        expect(note.chat_id).toBe(String(OWNER))
        expect(note.text).toContain('Fui removido do grupo <b>Xmail Outreach</b>')
        expect(note.text).toContain('voltaram para este chat')
    })

    it('removal from some other group changes nothing', async () => {
        deps.config.mockResolvedValue(config({ outreachChatId: String(GROUP) }))
        await handleTelegramUpdate(memberUpdate({ id: OTHER_GROUP, type: 'supergroup', title: 'x' }, 'member', 'left'), SECRET, deps)
        expect(deps.saveOutreachChat).not.toHaveBeenCalled()
        expect(deps.api).not.toHaveBeenCalled()
    })
})

describe('chan:o tap (use this group for outreach)', () => {
    const data = `chan:o:${GROUP}`

    beforeEach(() => {
        deps.api.mockImplementation(async (method: string) =>
            method === 'getChat' ? { ok: true, result: { id: GROUP, type: 'supergroup', title: 'Xmail Outreach' } } : { ok: true, result: true })
    })

    it('saves the group, confirms in the ops chat and says hello in the group', async () => {
        expect(await handleTelegramUpdate(tap(data), SECRET, deps)).toBe(200)

        expect(deps.saveOutreachChat).toHaveBeenCalledWith(String(GROUP))
        const hello = calls('sendMessage')[0] as { chat_id: string; text: string }
        expect(hello).toMatchObject({ chat_id: String(GROUP), text: 'A partir de agora os avisos de outreach do Xmail chegam aqui.' })
        const edit = calls('editMessageText')[0] as { chat_id: number; message_id: number; text: string; reply_markup?: unknown }
        expect(edit).toMatchObject({ chat_id: OWNER, message_id: 42 })
        expect(edit.text).toContain('Xmail Outreach')
        expect(edit.reply_markup).toBeUndefined() // the button is gone
        expect(calls('answerCallbackQuery')[0]).toMatchObject({ text: 'Feito.' })
    })

    it('refuses a tap from anyone but the owner', async () => {
        await handleTelegramUpdate(tap(data, STRANGER, OWNER), SECRET, deps)
        expect(deps.saveOutreachChat).not.toHaveBeenCalled()
        expect(calls('sendMessage')).toHaveLength(0)
        expect(calls('answerCallbackQuery')[0]).toMatchObject({ text: 'Sem permissão.' })
    })

    it('only accepts the tap in the ops chat, never from inside a group (even the owner)', async () => {
        deps.config.mockResolvedValue(config({ outreachChatId: String(OTHER_GROUP) }))
        await handleTelegramUpdate(tap(data, OWNER, OTHER_GROUP), SECRET, deps)
        await handleTelegramUpdate(tap(data, OWNER, GROUP), SECRET, deps)
        expect(deps.saveOutreachChat).not.toHaveBeenCalled()
    })

    it('does not save a group the bot can no longer reach', async () => {
        deps.api.mockImplementation(async (method: string) =>
            method === 'getChat' ? { ok: false, detail: 'chat not found' } : { ok: true, result: true })
        await handleTelegramUpdate(tap(data), SECRET, deps)
        expect(deps.saveOutreachChat).not.toHaveBeenCalled()
        expect(calls('sendMessage')).toHaveLength(0)
        expect((calls('answerCallbackQuery')[0] as { text: string }).text).toContain('Não consegui acessar')
    })

    it('never saves a positive id (a person, not a group), even from a forged button', async () => {
        await handleTelegramUpdate(tap('chan:o:8664810189'), SECRET, deps)
        await handleTelegramUpdate(tap('chan:o:abc'), SECRET, deps)
        expect(deps.saveOutreachChat).not.toHaveBeenCalled()
    })

    it('says so and sends nothing when the save fails', async () => {
        deps.saveOutreachChat.mockRejectedValue(new Error('db down'))
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await handleTelegramUpdate(tap(data), SECRET, deps)
        spy.mockRestore()
        expect(calls('sendMessage')).toHaveLength(0)
        expect((calls('answerCallbackQuery')[0] as { text: string }).text).toContain('Não consegui salvar')
    })

    it('is a no-op when that group already receives outreach alerts', async () => {
        deps.config.mockResolvedValue(config({ outreachChatId: String(GROUP) }))
        await handleTelegramUpdate(tap(data), SECRET, deps)
        expect(deps.saveOutreachChat).not.toHaveBeenCalled()
        expect(calls('answerCallbackQuery')[0]).toMatchObject({ text: 'Esse grupo já recebe os avisos de outreach.' })
    })

    it('still saves when the hello cannot be written, and warns the owner', async () => {
        deps.api.mockImplementation(async (method: string) => {
            if (method === 'getChat') return { ok: true, result: { type: 'group', title: 'G' } }
            if (method === 'sendMessage') return { ok: false, detail: 'forbidden' }
            return { ok: true, result: true }
        })
        await handleTelegramUpdate(tap(data), SECRET, deps)
        expect(deps.saveOutreachChat).toHaveBeenCalledWith(String(GROUP))
        expect((calls('editMessageText')[0] as { text: string }).text).toContain('Não consegui escrever no grupo')
    })
})

describe('notifyApprovalRequested', () => {
    beforeEach(() => {
        state.approvalRow = {
            id: APPROVAL,
            organizationId: ORG,
            actionKind: 'paid_enrichment',
            resourceId: 'run-1',
            maximumCreditCost: 12,
            expiresAt: new Date('2026-10-09T12:00:00Z'),
        }
        vi.mocked(callTelegramApi).mockResolvedValue({ ok: true, result: true })
    })

    it('asks for the OUTREACH channel config and posts the card to that chat and thread', async () => {
        vi.mocked(getTelegramConfig).mockResolvedValue({
            token: TOKEN, chatId: String(GROUP), threadId: '77', source: 'panel', channel: 'outreach', opsChatId: String(OWNER), outreachChatId: String(GROUP),
        })
        expect(await notifyApprovalRequested(APPROVAL)).toBe(true)

        expect(getTelegramConfig).toHaveBeenCalledWith('outreach')
        const [method, payload] = vi.mocked(callTelegramApi).mock.calls[0]
        expect(method).toBe('sendMessage')
        expect(payload).toMatchObject({ chat_id: String(GROUP), message_thread_id: '77', parse_mode: 'HTML' })
        expect((payload as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup.inline_keyboard[0]).toHaveLength(2)
    })

    it('falls back to the ops chat while no outreach chat is set (the config already resolves it)', async () => {
        vi.mocked(getTelegramConfig).mockResolvedValue({
            token: TOKEN, chatId: String(OWNER), source: 'panel', channel: 'outreach', opsChatId: String(OWNER),
        })
        await notifyApprovalRequested(APPROVAL)
        expect(vi.mocked(callTelegramApi).mock.calls[0][1]).toMatchObject({ chat_id: String(OWNER) })
    })

    it('does nothing when Telegram is not configured', async () => {
        vi.mocked(getTelegramConfig).mockResolvedValue(null)
        expect(await notifyApprovalRequested(APPROVAL)).toBe(false)
        expect(callTelegramApi).not.toHaveBeenCalled()
    })
})

describe('ensureTelegramWebhook', () => {
    it('subscribes to callback_query and my_chat_member in production', async () => {
        const env = { ...process.env }
        process.env.NODE_ENV = 'production'
        process.env.BASE_URL = 'https://mail.example.com'
        vi.mocked(getTelegramConfig).mockResolvedValue({
            token: TOKEN, chatId: String(OWNER), source: 'panel', channel: 'ops', opsChatId: String(OWNER),
        })
        vi.mocked(callTelegramApi).mockResolvedValue({ ok: true, result: true })
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            await ensureTelegramWebhook()
        } finally {
            log.mockRestore()
            process.env.NODE_ENV = env.NODE_ENV
            if (env.BASE_URL === undefined) delete process.env.BASE_URL
            else process.env.BASE_URL = env.BASE_URL
        }
        const [method, payload] = vi.mocked(callTelegramApi).mock.calls[0]
        expect(method).toBe('setWebhook')
        expect(payload).toMatchObject({
            url: 'https://mail.example.com/telegram/webhook',
            secret_token: SECRET,
            allowed_updates: ['callback_query', 'my_chat_member'],
        })
    })
})
