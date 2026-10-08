import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db', () => ({ db: {} }))
vi.mock('../approval-actions', () => ({ approveOutreachAction: vi.fn(), rejectOutreachAction: vi.fn() }))
vi.mock('../outreach-approval-preview', () => ({ buildCampaignActivationPreview: vi.fn() }))
vi.mock('../telegram', () => ({ callTelegramApi: vi.fn(), getTelegramConfig: vi.fn() }))

import { handleTelegramUpdate, telegramWebhookSecret, type TelegramApprovalDeps } from '../telegram-approvals'

const TOKEN = '123456:test-token'
const OWNER = 8664810189
const APPROVAL = '188ac9e2-6f4a-4ece-9151-dfcae6115b82'
const ORG = '11111111-1111-4111-8111-111111111111'
const SECRET = telegramWebhookSecret(TOKEN)

let deps: TelegramApprovalDeps & { api: ReturnType<typeof vi.fn>; approve: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> }

function tap(data: string, fromId = OWNER, chatId = OWNER) {
    return { callback_query: { id: 'cb-1', from: { id: fromId }, data, message: { message_id: 42, chat: { id: chatId }, text: 'card' } } }
}

beforeEach(() => {
    deps = {
        config: vi.fn().mockResolvedValue({ token: TOKEN, chatId: String(OWNER), source: 'panel' }),
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
        expect(deps.approve).not.toHaveBeenCalled()
        expect(deps.api).not.toHaveBeenCalled()
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
