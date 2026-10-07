/**
 * Decisões puras dos alertas de resposta: a conversa ainda está pendente? o que enviar agora?
 *
 * Nada aqui toca banco, relógio global ou rede; `now` entra por parâmetro. O contrato com o
 * Unified Inbox é de propósito colado ao dele: "pendente" é a mesma coisa que a fila "needs
 * reply" (queries.ts, NEEDS_REPLY). Não existe um segundo modelo de estado.
 */
import { isQuietHours, isReminderDue, morningAnchor } from './schedule'

/** Mais lembretes que isso devidos no mesmo tick viram UMA mensagem de resumo. */
export const REMINDER_DIGEST_THRESHOLD = 3

/**
 * Respostas mais velhas que isso deixam de ser cobradas. Evita que um backlog antigo de
 * conversas nunca tratadas vire lembrete eterno (e que o primeiro deploy despeje o histórico).
 */
export const MAX_PENDING_AGE_DAYS = 14

export interface PendingReply {
    organizationId: string
    conversationId: string
    /** outreach_conversation_messages.id da resposta mais recente (classification 'reply'). */
    replyMessageId: string
    /** Quando essa resposta chegou. */
    repliedAt: Date
    /** Algum usuário da organização já abriu a conversa depois da resposta. */
    isRead: boolean
    /** Último aviso enviado sobre esta conversa, ou null se nunca avisou. */
    alert: { replyMessageId: string; lastAlertedAt: Date } | null
    /** Campos de exibição, já resolvidos (ver format.ts). */
    leadName: string
    fromAddress: string
    inboxAddress: string
    /** Texto bruto da resposta; o recorte de 300 caracteres é feito na formatação. */
    plainBody: string | null
    htmlBody: string | null
}

export interface ConversationFacts {
    status: 'open' | 'closed'
    archivedAt: Date | null
    lastInboundAt: Date | null
    lastOutboundAt: Date | null
    /** Chegada da resposta humana mais recente (classification 'reply'), se houver. */
    latestReplyAt: Date | null
}

/**
 * A conversa ainda espera uma resposta do Vanildo?
 *
 * Espelha NEEDS_REPLY de unified-inbox/queries.ts: aberta, não arquivada, e uma resposta
 * humana chegou DEPOIS da última saída. "Respondi" não é um campo novo: é `last_outbound_at`
 * mais novo que a resposta, e esse campo avança tanto para um envio feito pelo Unified Inbox
 * (outbound.ts) quanto para qualquer outra saída registrada na conversa. "Resolvi" é
 * `status = 'closed'`; "arquivei" é `archived_at`. Uma resposta nova do lead reabre e
 * desarquiva (ingest.ts), então a conversa volta a ser pendente sozinha.
 */
export function isConversationPending(facts: ConversationFacts): boolean {
    if (facts.status !== 'open') return false
    if (facts.archivedAt) return false
    if (!facts.lastInboundAt || !facts.latestReplyAt) return false
    const answeredAt = facts.lastOutboundAt?.getTime() ?? Number.NEGATIVE_INFINITY
    return facts.lastInboundAt.getTime() > answeredAt && facts.latestReplyAt.getTime() > answeredAt
}

export type WaitingState = 'unread' | 'read'

export function waitingState(row: Pick<PendingReply, 'isRead'>): WaitingState {
    return row.isRead ? 'read' : 'unread'
}

/** O aviso imediato desta resposta ainda não saiu (nunca avisou, ou a resposta é outra). */
export function needsFirstAlert(row: Pick<PendingReply, 'alert' | 'replyMessageId'>): boolean {
    return row.alert === null || row.alert.replyMessageId !== row.replyMessageId
}

export interface AlertPlan {
    /** Avisos imediatos, um por resposta. Saem a qualquer hora. */
    first: PendingReply[]
    /** Lembretes individuais devidos agora (só dentro da janela 08:00-20:00). */
    reminders: PendingReply[]
    /**
     * Uma única mensagem listando várias pendentes: 'morning' às 08:00 (primeiro tick da
     * janela em que alguma pendente ainda não foi avisada hoje) ou 'digest' quando há
     * lembretes demais para mandar um a um.
     */
    summary: { reason: 'morning' | 'digest'; rows: PendingReply[] } | null
}

export function planAlerts(rows: readonly PendingReply[], now: Date): AlertPlan {
    const first: PendingReply[] = []
    const alerted: PendingReply[] = []
    for (const row of rows) {
        if (needsFirstAlert(row)) first.push(row)
        else alerted.push(row)
    }

    const plan: AlertPlan = { first, reminders: [], summary: null }

    // Silêncio: só o aviso imediato passa. Lembretes e resumo esperam as 08:00.
    if (isQuietHours(now) || alerted.length === 0) return plan

    // Resumo da manhã: a primeira varredura da janela encontra pendentes cujo último aviso é
    // anterior às 08:00 de hoje (ou seja, ficaram sem lembrete durante a noite). Um aviso
    // posterior às 08:00 marca a conversa como já coberta hoje, então o resumo não repete.
    const anchor = morningAnchor(now)
    const overnight = alerted.some((row) => row.alert!.lastAlertedAt.getTime() < anchor.getTime())
    if (overnight) {
        plan.summary = { reason: 'morning', rows: alerted }
        return plan
    }

    const due = alerted.filter((row) => isReminderDue(row.alert!.lastAlertedAt, now))
    if (due.length > REMINDER_DIGEST_THRESHOLD) {
        plan.summary = { reason: 'digest', rows: due }
    } else {
        plan.reminders = due
    }
    return plan
}
