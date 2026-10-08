import crypto from 'crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { campaigns, organizationUsers, outreachActionApprovals, users } from '../../db/schema'
import { approveOutreachAction, rejectOutreachAction, type ApprovalOutcome } from './approval-actions'
import { buildCampaignActivationPreview } from './outreach-approval-preview'
import { callTelegramApi, getTelegramConfig, type TelegramConfig } from './telegram'
import { escapeHtml } from './html-escape'

/**
 * Approve / reject agent requests from Telegram (2026-10-07: Vanildo will not open the panel to
 * approve each campaign). The Xmail ops bot (not Hermes's bot) posts a card with buttons to the
 * configured private chat; Telegram calls POST /telegram/webhook when a button is tapped.
 *
 * Trust anchor: only a callback whose sender AND chat are the configured chat id is honoured, and
 * the webhook carries a secret derived from the bot token, so neither Hermes (a different bot) nor
 * anyone who finds the URL can approve. The action itself is approveOutreachAction /
 * rejectOutreachAction, the same code the panel buttons run, with the same readiness checks.
 *
 * Approve is two taps: "Aprovar" swaps the buttons for "Sim, começar" / "Voltar", because one
 * mistaken tap would otherwise start cold email.
 */

type Action = 'a' | 'c' | 'r' | 'x'
const CALLBACK_RE = /^apv:([acrx]):([0-9a-f-]{36})$/

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
        const config = await getTelegramConfig()
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

export interface TelegramApprovalDeps {
    config: () => Promise<TelegramConfig | null>
    api: typeof callTelegramApi
    approve: (input: Parameters<typeof approveOutreachAction>[0]) => Promise<ApprovalOutcome>
    reject: (input: Parameters<typeof rejectOutreachAction>[0]) => Promise<ApprovalOutcome>
    findApproval: (id: string) => Promise<{ id: string; organizationId: string; actionKind: string } | null>
    reviewer: (organizationId: string) => Promise<string | null>
    cardText: (id: string) => Promise<string | null>
}

const defaultDeps: TelegramApprovalDeps = {
    config: getTelegramConfig,
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

/**
 * Handle one Telegram update. `secretHeader` is X-Telegram-Bot-Api-Secret-Token. Returns the HTTP
 * status for the webhook response (Telegram retries on non-2xx, so anything we decline is 200).
 */
export async function handleTelegramUpdate(
    update: { callback_query?: CallbackQuery },
    secretHeader: string | undefined,
    deps: TelegramApprovalDeps = defaultDeps,
): Promise<number> {
    const config = await deps.config()
    if (!config) return 404
    const expected = telegramWebhookSecret(config.token)
    const provided = secretHeader ?? ''
    if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
        return 401
    }

    const query = update.callback_query
    if (!query) return 200
    const answer = (text: string) => deps.api('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: false })

    const ownerId = String(config.chatId)
    if (String(query.from?.id ?? '') !== ownerId || String(query.message?.chat?.id ?? '') !== ownerId) {
        await answer('Sem permissão.')
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
        allowed_updates: ['callback_query'],
        drop_pending_updates: false,
    })
    if (result.ok) console.log(`[telegram-approvals] webhook set to ${base}${telegramWebhookPath()}`)
}
