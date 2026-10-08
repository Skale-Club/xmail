/**
 * Varredura dos alertas de resposta: lê as respostas de campanha pendentes no Unified Inbox,
 * decide (plan.ts) o que enviar agora e manda pelo Telegram (telegram.ts).
 *
 * Duas portas de entrada para a mesma função:
 *   - o gancho de processReplies (hook.ts), com `conversationId`, para o aviso imediato;
 *   - o cron de 5 em 5 minutos (jobs/replyAlerts.ts), sem filtro, que cobra os lembretes, manda o
 *     resumo da manhã e também pega qualquer resposta cujo primeiro aviso não saiu (Telegram fora
 *     do ar, conversa ainda não materializada, deploy no meio do caminho).
 *
 * Nenhum estado de "lida/respondida/resolvida" é guardado aqui. Tudo é lido do Unified Inbox:
 *   - pendente   = a fila "needs reply" (NEEDS_REPLY em unified-inbox/queries.ts);
 *   - respondida = outreach_conversations.last_outbound_at passou da resposta;
 *   - resolvida  = outreach_conversations.status = 'closed' ou archived_at preenchido;
 *   - lida       = existe linha em outreach_conversation_reads com last_read_at >= last_inbound_at
 *                  (de qualquer usuário da organização).
 * A única coisa persistida é quando o último aviso saiu (inbox_reply_alerts, migration 071).
 *
 * Privacidade: o corpo da resposta e os endereços só vão para o Telegram. O log leva contagens
 * e ids de conversa, nunca texto nem e-mail.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../../db'
import { inboxReplyAlerts, type InboxReplyAlertKind } from '../../../db/schema'
import { createLogger } from '../logger'
import { isTelegramConfigured, sendTelegram, type SendResult } from '../telegram'
import { NEEDS_REPLY } from '../unified-inbox/queries'
import { formatFirstAlert, formatReminder, formatSummary, leadDisplayName, type FormattedAlert } from './format'
import {
    isConversationPending,
    MAX_PENDING_AGE_DAYS,
    planAlerts,
    type PendingReply,
} from './plan'

const log = createLogger('outreach.replyAlerts')

/** Teto de avisos imediatos por tick; o resto sai no tick seguinte (limite de taxa do Telegram). */
export const MAX_FIRST_ALERTS_PER_TICK = 10

export interface SweepFilter {
    organizationId?: string
    conversationId?: string
}

export interface SweepDeps {
    now?: () => Date
    /** Base dos links (FRONTEND_URL). */
    baseUrl?: string
    isConfigured?: () => Promise<boolean>
    loadPending?: (filter: SweepFilter, now: Date) => Promise<PendingReply[]>
    recordAlert?: (row: PendingReply, kind: InboxReplyAlertKind, at: Date) => Promise<void>
    send?: (title: string, body: string) => Promise<SendResult>
}

export interface SweepResult {
    skipped?: 'unconfigured'
    considered: number
    first: number
    reminders: number
    summaries: number
    failed: number
}

let warnedUnconfigured = false

/** Teste: o aviso de "Telegram não configurado" é emitido uma vez por processo. */
export function __resetUnconfiguredWarning(): void {
    warnedUnconfigured = false
}

// ---------------------------------------------------------------------------------------------
// Leitura das pendentes
// ---------------------------------------------------------------------------------------------

interface PendingRow {
    conversation_id: string
    organization_id: string
    status: 'open' | 'closed'
    archived_at: Date | null
    last_inbound_at: Date | null
    last_outbound_at: Date | null
    reply_message_id: string
    replied_at: Date
    from_address: string | null
    plain_body: string | null
    html_body: string | null
    inbox_address: string
    lead_email: string | null
    company_name: string | null
    custom_fields: unknown
    is_read: boolean
    alert_reply_message_id: string | null
    alert_last_alerted_at: Date | null
}

function rowsOf<T>(result: unknown): T[] {
    if (Array.isArray(result)) return result as T[]
    return (result as { rows?: T[] })?.rows ?? []
}

/**
 * As conversas de campanha que estão na fila "needs reply" do Unified Inbox, com o necessário
 * para montar a mensagem. Escopo por organização em todos os joins; o filtro opcional restringe
 * à conversa que acabou de receber a resposta.
 *
 * Os timestamps do Unified Inbox são `timestamp` sem fuso, gravados em UTC; `AT TIME ZONE 'UTC'`
 * os transforma em instantes reais antes de chegarem ao JS. Os corpos são cortados no SQL: só o
 * começo da resposta importa para o trecho, e a conversa inteira não precisa sair do banco.
 */
export async function loadPendingReplies(filter: SweepFilter, now: Date): Promise<PendingReply[]> {
    const conversationFilter = filter.conversationId
        ? sql`AND outreach_conversations.id = ${filter.conversationId}::uuid`
        : sql``
    const organizationFilter = filter.organizationId
        ? sql`AND outreach_conversations.organization_id = ${filter.organizationId}::uuid`
        : sql``
    // O horizonte de idade é calculado no JS e passado como instante: `now` vem do chamador, e o
    // teste e o cron usam o mesmo relógio.
    const horizon = new Date(now.getTime() - MAX_PENDING_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString()

    const result = await db.execute(sql`
        SELECT
            outreach_conversations.id AS conversation_id,
            outreach_conversations.organization_id AS organization_id,
            outreach_conversations.status AS status,
            (outreach_conversations.archived_at AT TIME ZONE 'UTC') AS archived_at,
            (outreach_conversations.last_inbound_at AT TIME ZONE 'UTC') AS last_inbound_at,
            (outreach_conversations.last_outbound_at AT TIME ZONE 'UTC') AS last_outbound_at,
            rm.id AS reply_message_id,
            (COALESCE(rm.received_at, rm.sent_at, rm.created_at) AT TIME ZONE 'UTC') AS replied_at,
            rm.from_address AS from_address,
            left(rm.plain_body, 8000) AS plain_body,
            CASE WHEN btrim(COALESCE(rm.plain_body, '')) = '' THEN left(rm.html_body, 40000) END AS html_body,
            ea.email AS inbox_address,
            l.email AS lead_email,
            l.company_name AS company_name,
            l.custom_fields AS custom_fields,
            EXISTS (
                SELECT 1 FROM outreach_conversation_reads r
                WHERE r.organization_id = outreach_conversations.organization_id
                  AND r.conversation_id = outreach_conversations.id
                  AND r.last_read_at >= outreach_conversations.last_inbound_at
            ) AS is_read,
            a.reply_message_id AS alert_reply_message_id,
            a.last_alerted_at AS alert_last_alerted_at
        FROM outreach_conversations
        JOIN LATERAL (
            SELECT m.id, m.received_at, m.sent_at, m.created_at, m.from_address, m.plain_body, m.html_body
            FROM outreach_conversation_messages m
            WHERE m.organization_id = outreach_conversations.organization_id
              AND m.conversation_id = outreach_conversations.id
              AND m.direction = 'inbound'
              AND m.classification = 'reply'
            ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC, m.id DESC
            LIMIT 1
        ) rm ON true
        JOIN email_accounts ea
            ON ea.id = outreach_conversations.email_account_id
           AND ea.organization_id = outreach_conversations.organization_id
        LEFT JOIN leads l
            ON l.id = outreach_conversations.lead_id
           AND l.organization_id = outreach_conversations.organization_id
        LEFT JOIN inbox_reply_alerts a
            ON a.organization_id = outreach_conversations.organization_id
           AND a.conversation_id = outreach_conversations.id
        WHERE ${NEEDS_REPLY}
          -- Só resposta de lead de campanha. Caixa de trabalho (info@) e conversa avulsa ficam de
          -- fora; tráfego de warm-up nem vira conversa (unified-inbox/warmup-traffic.ts), e a
          -- guarda de warmup_only fecha o resto.
          AND outreach_conversations.campaign_id IS NOT NULL
          AND ea.warmup_only IS NOT TRUE
          AND outreach_conversations.last_inbound_at > ${horizon}::timestamptz AT TIME ZONE 'UTC'
          ${conversationFilter}
          ${organizationFilter}
        ORDER BY outreach_conversations.last_inbound_at ASC
        LIMIT 200
    `)

    const pending: PendingReply[] = []
    for (const row of rowsOf<PendingRow>(result)) {
        const repliedAt = new Date(row.replied_at)
        const facts = {
            status: row.status,
            archivedAt: row.archived_at ? new Date(row.archived_at) : null,
            lastInboundAt: row.last_inbound_at ? new Date(row.last_inbound_at) : null,
            lastOutboundAt: row.last_outbound_at ? new Date(row.last_outbound_at) : null,
            latestReplyAt: repliedAt,
        }
        // Segunda guarda, em JS, sobre a mesma regra que o SQL acabou de aplicar.
        if (!isConversationPending(facts)) continue

        pending.push({
            organizationId: row.organization_id,
            conversationId: row.conversation_id,
            replyMessageId: row.reply_message_id,
            repliedAt,
            isRead: Boolean(row.is_read),
            alert: row.alert_reply_message_id && row.alert_last_alerted_at
                ? { replyMessageId: row.alert_reply_message_id, lastAlertedAt: new Date(row.alert_last_alerted_at) }
                : null,
            leadName: leadDisplayName({
                customFields: row.custom_fields,
                companyName: row.company_name,
                email: row.lead_email,
            }),
            fromAddress: row.from_address ?? row.lead_email ?? 'remetente desconhecido',
            inboxAddress: row.inbox_address,
            plainBody: row.plain_body,
            htmlBody: row.html_body,
        })
    }
    return pending
}

/**
 * Grava que o aviso saiu. Uma resposta nova (outro reply_message_id) reinicia a contagem; o
 * mesmo reply_message_id só avança last_alerted_at e o contador.
 */
export async function recordReplyAlert(row: PendingReply, kind: InboxReplyAlertKind, at: Date): Promise<void> {
    await db
        .insert(inboxReplyAlerts)
        .values({
            organizationId: row.organizationId,
            conversationId: row.conversationId,
            replyMessageId: row.replyMessageId,
            firstAlertedAt: at,
            lastAlertedAt: at,
            alertCount: 1,
            lastKind: kind,
        })
        .onConflictDoUpdate({
            target: [inboxReplyAlerts.organizationId, inboxReplyAlerts.conversationId],
            set: {
                firstAlertedAt: sql`CASE WHEN ${inboxReplyAlerts.replyMessageId} = excluded.reply_message_id THEN ${inboxReplyAlerts.firstAlertedAt} ELSE excluded.first_alerted_at END`,
                alertCount: sql`CASE WHEN ${inboxReplyAlerts.replyMessageId} = excluded.reply_message_id THEN ${inboxReplyAlerts.alertCount} + 1 ELSE 1 END`,
                replyMessageId: sql`excluded.reply_message_id`,
                lastAlertedAt: sql`excluded.last_alerted_at`,
                lastKind: sql`excluded.last_kind`,
                updatedAt: sql`now()`,
            },
        })
}

// ---------------------------------------------------------------------------------------------
// Varredura
// ---------------------------------------------------------------------------------------------

export async function runReplyAlertSweep(filter: SweepFilter = {}, deps: SweepDeps = {}): Promise<SweepResult> {
    const now = (deps.now ?? (() => new Date()))()
    const baseUrl = deps.baseUrl ?? process.env.FRONTEND_URL ?? 'http://localhost:9000'
    // Respostas de prospects vão para o canal de outreach (cai no chat de operação enquanto não
    // houver um chat de outreach configurado).
    const isConfigured = deps.isConfigured ?? (() => isTelegramConfigured('outreach'))
    const loadPending = deps.loadPending ?? loadPendingReplies
    const recordAlert = deps.recordAlert ?? recordReplyAlert
    const send = deps.send ?? ((title: string, body: string) => sendTelegram(title, body, 'outreach'))

    const result: SweepResult = { considered: 0, first: 0, reminders: 0, summaries: 0, failed: 0 }

    if (!(await isConfigured())) {
        if (!warnedUnconfigured) {
            warnedUnconfigured = true
            log.warn(
                { action: 'outreach.replyAlerts.unconfigured' },
                'Telegram is not configured; reply alerts are skipped until the panel has a bot token and chat id',
            )
        }
        return { ...result, skipped: 'unconfigured' }
    }
    warnedUnconfigured = false

    const rows = await loadPending(filter, now)
    result.considered = rows.length
    if (rows.length === 0) return result

    const plan = planAlerts(rows, now)

    async function deliver(
        message: FormattedAlert,
        targets: readonly PendingReply[],
        kind: InboxReplyAlertKind,
    ): Promise<boolean> {
        const sent = await send(message.title, message.body)
        if (!sent.ok) {
            result.failed++
            log.warn({
                action: 'outreach.replyAlerts.send_failed',
                kind,
                reason: sent.reason ?? 'unknown',
                conversations: targets.length,
            }, 'reply alert not delivered; it will be retried on the next tick')
            return false
        }
        for (const target of targets) {
            try {
                await recordAlert(target, kind, now)
            } catch (err) {
                // A mensagem já saiu; falhar em gravar significa um aviso repetido no próximo
                // tick, o que é preferível a perder o aviso.
                log.warn({
                    action: 'outreach.replyAlerts.record_failed',
                    conversationId: target.conversationId,
                    error: { message: err instanceof Error ? err.message : String(err) },
                }, 'reply alert sent but its state could not be saved')
            }
        }
        return true
    }

    for (const row of plan.first.slice(0, MAX_FIRST_ALERTS_PER_TICK)) {
        if (await deliver(formatFirstAlert(row, baseUrl), [row], 'first')) result.first++
    }

    if (plan.summary) {
        const { reason, rows: listed } = plan.summary
        if (await deliver(formatSummary(listed, reason, baseUrl, now), listed, 'summary')) result.summaries++
    }

    for (const row of plan.reminders) {
        if (await deliver(formatReminder(row, baseUrl, now), [row], 'reminder')) result.reminders++
    }

    if (result.first + result.reminders + result.summaries + result.failed > 0) {
        log.info({
            action: 'outreach.replyAlerts.tick',
            considered: result.considered,
            first: result.first,
            reminders: result.reminders,
            summaries: result.summaries,
            failed: result.failed,
        }, 'reply alert tick')
    }

    return result
}
