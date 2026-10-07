/**
 * Gancho de processReplies: avisa no Telegram assim que uma resposta humana é gravada.
 *
 * Chamado logo depois de markAsReplied (o ponto em que a resposta já está durável: lead em
 * 'replied', contadores atualizados). Nunca lança: uma falha aqui, no Telegram ou no banco, não
 * pode quebrar o processamento da resposta. O que o gancho perder o cron de varredura recupera
 * em até 5 minutos, porque a decisão de avisar vem do estado do Unified Inbox e não do gancho.
 */
import { materializeProviderEvent } from '../unified-inbox/ingest'
import { publishInboxEvent } from '../inbox-events'
import { runWithLock } from '../cron-lock'
import { createLogger } from '../logger'
import { runReplyAlertSweep, type SweepFilter, type SweepResult } from './sweep'

const log = createLogger('outreach.replyAlerts')

/**
 * Orçamento da varredura. Fica aqui e não em JOB_TIMEOUT_BUDGETS_MS (cron-lock.ts) porque é um job
 * novo sem latência medida em produção. Dimensionado pelo corpo: um SELECT e, no máximo, 10 avisos
 * imediatos + 1 resumo + 3 lembretes por tick, cada envio já limitado a 20 s pelo sendTelegram.
 * Com o Telegram saudável termina em segundos; os 120 s só entram em cena se ele travar.
 */
export const REPLY_ALERT_SWEEP_TIMEOUT_MS = 120_000

/** Nome estável da trava: renomear deixaria instâncias velha e nova se sobreporem num deploy. */
export const REPLY_ALERT_LOCK_NAME = 'reply-alert-sweep'

/**
 * A varredura sempre roda dentro desta trava, venha do cron ou do gancho. Sem ela, o gancho e o
 * cron podiam avisar a mesma resposta duas vezes. Em contenção o runWithLock simplesmente pula:
 * quem segura a trava já está cuidando, e o próximo tick cobre o que ficou de fora.
 */
export async function runReplyAlertSweepWithLock(
    filter: SweepFilter = {},
    sweep: (filter: SweepFilter) => Promise<SweepResult> = (f) => runReplyAlertSweep(f),
): Promise<void> {
    await runWithLock(REPLY_ALERT_LOCK_NAME, async () => {
        await sweep(filter)
    }, { timeoutMs: REPLY_ALERT_SWEEP_TIMEOUT_MS })
}

export interface ReplyHookEvent {
    id: string
    organizationId: string
}

export interface ReplyHookDeps {
    /** Cria (ou localiza) a conversa do Unified Inbox para o evento. Idempotente. */
    materialize?: (eventId: string) => Promise<{ inserted: boolean; conversationId: string | null }>
    runSweep?: (filter: SweepFilter) => Promise<void>
}

/**
 * O aviso depende da conversa, e o materializador do Unified Inbox só corre em ciclo próprio. Em
 * vez de esperar o próximo ciclo (até 5 minutos), o gancho materializa este evento agora.
 * materializeProviderEvent é idempotente e serializa por FOR UPDATE com o materializador do cron.
 */
async function materializeNow(eventId: string): Promise<{ inserted: boolean; conversationId: string | null; organizationId: string | null }> {
    const outcome = await materializeProviderEvent(eventId)
    return {
        inserted: outcome.inserted,
        conversationId: outcome.conversationId,
        organizationId: outcome.organizationId,
    }
}

export async function notifyReplyReceived(event: ReplyHookEvent, deps: ReplyHookDeps = {}): Promise<void> {
    try {
        const materialize = deps.materialize ?? materializeNow
        const runSweep = deps.runSweep ?? ((filter: SweepFilter) => runReplyAlertSweepWithLock(filter))

        const outcome = await materialize(event.id)
        if (outcome.inserted && outcome.conversationId) {
            try {
                // Mesmo sinal que o materializador publica: a tela aberta recarrega a lista.
                publishInboxEvent({
                    organizationId: event.organizationId,
                    kind: 'conversation.updated',
                    conversationId: outcome.conversationId,
                    version: Date.now(),
                    at: new Date().toISOString(),
                })
            } catch { /* canal opcional; o polling cobre */ }
        }
        // Sem conversa (evento de warm-up fechado como skipped, ou materialização que falhou):
        // nada a avisar agora; a varredura decide se há algo pendente.
        if (!outcome.conversationId) return

        await runSweep({ organizationId: event.organizationId, conversationId: outcome.conversationId })
    } catch (err) {
        log.warn({
            action: 'outreach.replyAlerts.hook_failed',
            eventId: event.id,
            error: { message: err instanceof Error ? err.message : String(err) },
        }, 'immediate reply alert failed; the sweep job will pick the reply up')
    }
}
