import crypto from 'crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { campaigns, organizationUsers, outreachActionApprovals, users } from '../../db/schema'
import { approveOutreachAction, rejectOutreachAction, type ApprovalOutcome } from './approval-actions'
import { buildCampaignActivationPreview } from './outreach-approval-preview'
import { callTelegramApi, getTelegramConfig, setTelegramOutreachChat, type TelegramChannel, type TelegramConfig } from './telegram'
import { escapeHtml } from './html-escape'

/**
 * Approve / reject agent requests from Telegram (2026-10-07: Vanildo will not open the panel to
 * approve each campaign). The Xmail ops bot (not Hermes's bot) posts a card with buttons to the
 * configured private chat; Telegram calls POST /telegram/webhook when a button is tapped.
 *
 * Cards go to the OUTREACH channel (a dedicated chat, possibly a group; the ops chat until one is
 * set). Trust anchor: the webhook carries a secret derived from the bot token, and a callback is
 * honoured only when (1) the tapping user is the owner and (2) the chat it was tapped in is the
 * outreach chat or the ops chat (cards sent before the outreach chat existed live there). The owner
 * is the ops chat id, which is only a user id while the ops chat is private (positive id); if the
 * ops chat is a group there is no way to tell who the owner is, so every tap is refused. Neither
 * Hermes (a different bot) nor anyone else in the group, nor anyone who finds the URL, can approve.
 * The action itself is approveOutreachAction / rejectOutreachAction, the same code the panel
 * buttons run, with the same readiness checks.
 *
 * Setup of the outreach group is one tap: when the bot is added to a group (my_chat_member), the
 * owner gets a card in the ops chat with "Usar para outreach" (callback chan:o:<chatId>).
 *
 * Approve is two taps: "Aprovar" swaps the buttons for "Sim, começar" / "Voltar", because one
 * mistaken tap would otherwise start cold email.
 */

type Action = 'a' | 'c' | 'r' | 'x'
const CALLBACK_RE = /^apv:([acrx]):([0-9a-f-]{36})$/
/** `chan:o:<chatId>` is at most 6 + 21 bytes; Telegram allows 64. Group ids are negative. */
const CHANNEL_CALLBACK_RE = /^chan:o:(-\d{1,20})$/
/** A private chat id is the user's id: positive. Groups, supergroups and channels are negative. */
const PRIVATE_CHAT_RE = /^\d+$/

export function telegramWebhookSecret(botToken: string): string {
    return crypto.createHmac('sha256', botToken).update('xmail-telegram-approvals-v1').digest('hex')
}

export function telegramWebhookPath(): string {
    return '/telegram/webhook'
}

function keyboard(approvalId: string, stage: 'initial' | 'confirm') {
    return stage === 'initial'
        ? { inline_keyboard: [[
            { text: '✅ Aprovar', callback_data: `apv:a:${approvalId}` },
            { text: '❌ Recusar', callback_data: `apv:r:${approvalId}` },
        ]] }
        : { inline_keyboard: [[
            { text: '🚀 Sim, começar', callback_data: `apv:c:${approvalId}` },
            { text: '↩️ Voltar', callback_data: `apv:x:${approvalId}` },
        ]] }
}

function hours(h: number): string {
    if (h === 0) return 'na hora'
    return h % 24 === 0 ? `${h / 24} dia(s) depois` : `${h}h depois`
}

/** HTML body of the approval card. Exported for tests. */
export async function buildApprovalCardText(approvalId: string): Promise<string | null> {
    const approval = await db.query.outreachActionApprovals.findFirst({
        where: eq(outreachActionApprovals.id, approvalId),
    })
    if (!approval) return null

    if (approval.actionKind === 'campaign_activation') {
        const preview = await buildCampaignActivationPreview(approval.resourceId, approval.organizationId).catch(() => null)
        const campaign = preview?.campaign ?? await db.query.campaigns.findFirst({
            where: and(eq(campaigns.id, approval.resourceId), eq(campaigns.organizationId, approval.organizationId)),
            columns: { id: true, name: true, status: true },
        })
        const lines = [
            '<b>🟢 Pedido de ativação de campanha</b>',
            '',
            `<b>${escapeHtml(campaign?.name ?? approval.resourceId)}</b>`,
        ]
        if (preview) {
            const c = preview.leadCounts
            lines.push(`Leads: <b>${c.total}</b> (verificados ${c.verified}, catch-all ${c.catchAll}, sem verificação ${c.unknown})`)
            lines.push(`Remetente: ${preview.sendingInboxes.map((i) => escapeHtml(`${i.email} (${i.currentDailySent}/${i.dailySendLimit} hoje)`)).join(', ') || '<i>nenhum</i>'}`)
            lines.push('', '<b>Sequência</b>')
            for (const step of preview.sequence) {
                lines.push(`${step.stepOrder}. ${escapeHtml(step.variantA.subject || '(responde no mesmo assunto)')} · ${hours(step.delayHours)}`)
            }
            if (preview.sampleLead) lines.push('', `Exemplo renderizado para ${escapeHtml(preview.sampleLead.email)} no painel.`)
            const blockers = preview.compliance.blockers
            if (blockers.length > 0) {
                lines.push('', '<b>⚠️ Bloqueios</b>', ...blockers.map((b) => `• ${escapeHtml(b.message)}`))
            }
        }
        lines.push('', `Pedido ${approval.id.slice(0, 8)} · vence ${approval.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`)
        lines.push('Aprovar começa os envios na hora.')
        return lines.join('\n')
    }

    return [
        '<b>🟡 Pedido de enriquecimento pago</b>',
        '',
        `Execução ${escapeHtml(approval.resourceId)}`,
        `Custo máximo: <b>${approval.maximumCreditCost}</b> crédito(s)`,
        '',
        `Pedido ${approval.id.slice(0, 8)} · vence ${approval.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    ].join('\n')
}

/**
 * Post the approval card. Best effort: a Telegram failure never fails the agent's request; the
 * panel still lists the approval. Returns whether the card was sent.
 */
export async function notifyApprovalRequested(approvalId: string): Promise<boolean> {
    try {
        const config = await getTelegramConfig('outreach')
        if (!config) return false
        const text = await buildApprovalCardText(approvalId)
        if (!text) return false
        const payload: Record<string, unknown> = {
            chat_id: config.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: keyboard(approvalId, 'initial'),
        }
        if (config.threadId) payload.message_thread_id = config.threadId
        const sent = await callTelegramApi('sendMessage', payload)
        return sent.ok
    } catch (error) {
        console.error('[telegram-approvals] could not post approval card:', error instanceof Error ? error.message : error)
        return false
    }
}

/**
 * The Xmail user recorded as reviewer, picked by the same rule the panel applies
 * (checkOutreachAccess): a platform admin, or an admin of the approval's organization.
 * TELEGRAM_APPROVER_EMAIL picks one when there are several; with exactly one candidate it is
 * used. In production (2026-10-07) that is the single platform admin, who is not an org member.
 */
export async function resolveTelegramReviewer(organizationId: string): Promise<string | null> {
    const platformAdmins = await db.select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.isAdmin, true))
    const orgAdmins = await db.select({ id: users.id, email: users.email })
        .from(organizationUsers)
        .innerJoin(users, eq(users.id, organizationUsers.userId))
        .where(and(eq(organizationUsers.organizationId, organizationId), eq(organizationUsers.role, 'admin')))
    const candidates = [...new Map([...platformAdmins, ...orgAdmins].map((row) => [row.id, row])).values()]
    const wanted = process.env.TELEGRAM_APPROVER_EMAIL?.trim().toLowerCase()
    if (wanted) return candidates.find((row) => row.email.toLowerCase() === wanted)?.id ?? null
    return candidates.length === 1 ? candidates[0].id : null
}

interface CallbackQuery {
    id: string
    from?: { id?: number }
    data?: string
    message?: { message_id?: number; chat?: { id?: number }; text?: string }
}

/** Bot membership change in a chat (Bot API ChatMemberUpdated), the part we read. */
interface ChatMemberUpdate {
    chat?: { id?: number; type?: string; title?: string }
    from?: { id?: number; first_name?: string; username?: string }
    old_chat_member?: { status?: string }
    new_chat_member?: { status?: string }
}

export interface TelegramUpdate {
    callback_query?: CallbackQuery
    my_chat_member?: ChatMemberUpdate
}

export interface TelegramApprovalDeps {
    config: (channel?: TelegramChannel) => Promise<TelegramConfig | null>
    /** Persist (or clear, with null) the outreach chat id and refresh the config cache. */
    saveOutreachChat: (chatId: string | null) => Promise<void>
    api: typeof callTelegramApi
    approve: (input: Parameters<typeof approveOutreachAction>[0]) => Promise<ApprovalOutcome>
    reject: (input: Parameters<typeof rejectOutreachAction>[0]) => Promise<ApprovalOutcome>
    findApproval: (id: string) => Promise<{ id: string; organizationId: string; actionKind: string } | null>
    reviewer: (organizationId: string) => Promise<string | null>
    cardText: (id: string) => Promise<string | null>
}

const defaultDeps: TelegramApprovalDeps = {
    config: getTelegramConfig,
    saveOutreachChat: setTelegramOutreachChat,
    api: callTelegramApi,
    approve: approveOutreachAction,
    reject: rejectOutreachAction,
    findApproval: async (id) => (await db.query.outreachActionApprovals.findFirst({
        where: eq(outreachActionApprovals.id, id),
        columns: { id: true, organizationId: true, actionKind: true },
    })) ?? null,
    reviewer: resolveTelegramReviewer,
    cardText: buildApprovalCardText,
}

function describeOutcome(outcome: ApprovalOutcome, kind: string): string {
    if (outcome.ok) {
        if (outcome.body.idempotentReplay) return '✅ Já estava aprovado.'
        return kind === 'campaign_activation' ? '✅ Aprovado. A campanha está ativa e começa a enviar.' : '✅ Aprovado.'
    }
    const issues = Array.isArray(outcome.body.issues)
        ? (outcome.body.issues as Array<{ message?: string; code?: string }>).map((i) => `• ${escapeHtml(i.message ?? i.code ?? '')}`).join('\n')
        : ''
    return `⛔ Não aprovado: ${escapeHtml(outcome.body.error)}${issues ? `\n${issues}` : ''}`
}

/** Telegram caps answerCallbackQuery text at 200 characters. */
const NOT_PRIVATE_TEXT = 'Recusado: o chat de ops não é privado, então não sei quem é o dono. Use um chat privado como chat de ops.'

type TapGate = { ok: true } | { ok: false; text: string }

/**
 * Who may tap. The owner is the ops chat id, valid only while the ops chat is private (its id is
 * then the user's id). `opsOnly` is for taps that change configuration: those must come from the
 * ops chat itself, never from the outreach group.
 */
function authorizeTap(query: CallbackQuery, config: TelegramConfig, opsOnly: boolean): TapGate {
    const opsChatId = String(config.opsChatId)
    if (!PRIVATE_CHAT_RE.test(opsChatId)) return { ok: false, text: NOT_PRIVATE_TEXT }
    if (String(query.from?.id ?? '') !== opsChatId) return { ok: false, text: 'Sem permissão.' }
    const allowedChats = opsOnly ? [opsChatId] : [opsChatId, config.outreachChatId].filter((id): id is string => Boolean(id))
    if (!allowedChats.includes(String(query.message?.chat?.id ?? ''))) return { ok: false, text: 'Sem permissão.' }
    return { ok: true }
}

function isMember(status: string | undefined): boolean {
    return status === 'member' || status === 'administrator' || status === 'creator'
}

/** Sends to the ops chat (private, the owner), keeping the ops thread when there is one. */
function sendToOps(deps: TelegramApprovalDeps, config: TelegramConfig, payload: Record<string, unknown>) {
    const body: Record<string, unknown> = {
        chat_id: config.opsChatId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...payload,
    }
    // The config handed to the webhook is the ops one, so its thread is the ops thread.
    if (config.channel === 'ops' && config.threadId) body.message_thread_id = config.threadId
    return deps.api('sendMessage', body)
}

/**
 * The bot's own membership changed. Added to a group: ask the owner, in the ops chat, whether it
 * should receive the outreach alerts (nothing changes until the owner taps). Removed from the
 * current outreach group: fall back to the ops chat on our own, because messages to a group the
 * bot left would just fail.
 */
async function handleMyChatMember(update: ChatMemberUpdate, config: TelegramConfig, deps: TelegramApprovalDeps): Promise<void> {
    const chat = update.chat
    if (typeof chat?.id !== 'number' || (chat.type !== 'group' && chat.type !== 'supergroup')) return
    const chatId = String(chat.id)
    const opsChatId = String(config.opsChatId)
    if (chatId === opsChatId) return

    const newStatus = update.new_chat_member?.status
    const wasIn = isMember(update.old_chat_member?.status)
    const isIn = isMember(newStatus)
    const title = chat.title?.trim() || chatId

    if (newStatus === 'left' || newStatus === 'kicked') {
        if (chatId !== config.outreachChatId) return
        await deps.saveOutreachChat(null)
        await sendToOps(deps, config, {
            text: `Fui removido do grupo <b>${escapeHtml(title)}</b>. Os avisos de outreach voltaram para este chat.`,
        })
        return
    }

    if (!isIn || wasIn) return // promoted/demoted inside the group, not a new join
    if (chatId === config.outreachChatId) return
    // A card nobody can tap (ops chat is a group) would only be noise.
    if (!PRIVATE_CHAT_RE.test(opsChatId)) return

    const adder = update.from
    const adderName = adder?.first_name?.trim() || adder?.username?.trim() || (adder?.id ? `id ${adder.id}` : 'alguém')
    const byOwner = String(adder?.id ?? '') === opsChatId
    const lines = [
        `Fui adicionado ao grupo <b>${escapeHtml(title)}</b> (id ${escapeHtml(chatId)}). Usar este grupo para os avisos de outreach?`,
        '',
        `Adicionado por: ${escapeHtml(adderName)}${byOwner ? '' : ' ⚠️ (não é você)'}`,
        'As respostas de prospects e os pedidos de aprovação passam a chegar lá. Os avisos de operação continuam neste chat.',
    ]
    await sendToOps(deps, config, {
        text: lines.join('\n'),
        reply_markup: { inline_keyboard: [[{ text: 'Usar para outreach', callback_data: `chan:o:${chatId}` }]] },
    })
}

/** The owner tapped "Usar para outreach" on the card in the ops chat. */
async function handleChannelTap(
    chatId: string,
    query: CallbackQuery,
    config: TelegramConfig,
    deps: TelegramApprovalDeps,
    answer: (text: string) => Promise<unknown>,
): Promise<void> {
    if (config.outreachChatId === chatId) {
        await answer('Esse grupo já recebe os avisos de outreach.')
        return
    }
    // Confirms the bot is still in the group and gives its current title.
    const info = await deps.api<{ title?: string; type?: string }>('getChat', { chat_id: chatId })
    const type = info.ok ? info.result?.type : undefined
    if (!info.ok || (type !== undefined && type !== 'group' && type !== 'supergroup')) {
        await answer('Não consegui acessar esse grupo. O bot ainda está nele?')
        return
    }
    const title = info.result?.title?.trim() || chatId

    try {
        await deps.saveOutreachChat(chatId)
    } catch (error) {
        console.error('[telegram-approvals] could not save the outreach chat:', error instanceof Error ? error.message : error)
        await answer('Não consegui salvar. Tente de novo ou use o painel (Integrations).')
        return
    }

    const hello = await deps.api('sendMessage', {
        chat_id: chatId,
        text: 'A partir de agora os avisos de outreach do Xmail chegam aqui.',
    })
    await deps.api('editMessageText', {
        chat_id: query.message?.chat?.id,
        message_id: query.message?.message_id,
        text: `<b>✅ Avisos de outreach agora vão para o grupo ${escapeHtml(title)}</b>${hello.ok ? '' : '\n⚠️ Não consegui escrever no grupo; confira se o bot pode enviar mensagens lá.'}`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
    })
    await answer('Feito.')
}

/**
 * Handle one Telegram update. `secretHeader` is X-Telegram-Bot-Api-Secret-Token. Returns the HTTP
 * status for the webhook response (Telegram retries on non-2xx, so anything we decline is 200).
 */
export async function handleTelegramUpdate(
    update: TelegramUpdate,
    secretHeader: string | undefined,
    deps: TelegramApprovalDeps = defaultDeps,
): Promise<number> {
    const config = await deps.config('ops')
    if (!config) return 404
    const expected = telegramWebhookSecret(config.token)
    const provided = secretHeader ?? ''
    if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
        return 401
    }

    if (update.my_chat_member) {
        await handleMyChatMember(update.my_chat_member, config, deps)
        return 200
    }

    const query = update.callback_query
    if (!query) return 200
    const answer = (text: string) => deps.api('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: false })

    const channelMatch = CHANNEL_CALLBACK_RE.exec(query.data ?? '')
    const gate = authorizeTap(query, config, channelMatch !== null)
    if (!gate.ok) {
        await answer(gate.text)
        return 200
    }
    if (channelMatch) {
        await handleChannelTap(channelMatch[1], query, config, deps, answer)
        return 200
    }

    const match = CALLBACK_RE.exec(query.data ?? '')
    if (!match) {
        await answer('Botão desconhecido.')
        return 200
    }
    const action = match[1] as Action
    const approvalId = match[2]
    const messageId = query.message?.message_id
    const chatId = query.message?.chat?.id

    if (action === 'a' || action === 'x') {
        await deps.api('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: keyboard(approvalId, action === 'a' ? 'confirm' : 'initial'),
        })
        await answer(action === 'a' ? 'Confirme para começar.' : 'Ok.')
        return 200
    }

    const approval = await deps.findApproval(approvalId)
    if (!approval) {
        await answer('Pedido não encontrado.')
        return 200
    }
    const reviewerUserId = await deps.reviewer(approval.organizationId)
    if (!reviewerUserId) {
        await answer('Nenhum admin do Xmail definido como aprovador (TELEGRAM_APPROVER_EMAIL).')
        return 200
    }

    const outcome = action === 'c'
        ? await deps.approve({ approvalId, organizationId: approval.organizationId, actorUserId: reviewerUserId, note: 'Aprovado pelo Telegram' })
        : await deps.reject({ approvalId, organizationId: approval.organizationId, actorUserId: reviewerUserId, reason: 'Recusado pelo Telegram' })

    const result = action === 'c'
        ? describeOutcome(outcome, approval.actionKind)
        : outcome.ok ? '❌ Recusado.' : `⛔ ${escapeHtml(outcome.body.error)}`
    const card = (await deps.cardText(approvalId).catch(() => null)) ?? escapeHtml(query.message?.text ?? '')
    await deps.api('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `${card}\n\n<b>${result}</b>`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
    })
    await answer(outcome.ok ? 'Feito.' : 'Não deu, veja a mensagem.')
    return 200
}

/**
 * Point the ops bot's webhook at this server. Production only: a dev server would otherwise steal
 * the webhook from production. Idempotent (setWebhook replaces the previous URL).
 *
 * `my_chat_member` is how the bot learns it was added to (or removed from) a group, which drives
 * the one-tap setup of the outreach chat.
 */
export async function ensureTelegramWebhook(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') return
    const base = (process.env.BASE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '')
    if (!base.startsWith('https://')) return
    const config = await getTelegramConfig()
    if (!config) return
    const result = await callTelegramApi('setWebhook', {
        url: `${base}${telegramWebhookPath()}`,
        secret_token: telegramWebhookSecret(config.token),
        allowed_updates: ['callback_query', 'my_chat_member'],
        drop_pending_updates: false,
    })
    if (result.ok) console.log(`[telegram-approvals] webhook set to ${base}${telegramWebhookPath()}`)
}
