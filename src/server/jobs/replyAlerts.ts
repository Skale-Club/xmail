/**
 * Cron de alertas de resposta: lembretes de 2 em 2 horas (08:00-20:00 America/New_York), resumo
 * das 08:00 e rede de segurança para o aviso imediato. Ver lib/reply-alerts/sweep.ts.
 *
 * A trava avançada fica em lib/reply-alerts/hook.ts, compartilhada com o gancho de
 * processReplies. Falhas são tratadas no ponto de chamada em jobs/index.ts.
 */
import { runReplyAlertSweepWithLock } from '../lib/reply-alerts/hook'

export async function runReplyAlertsWithLock(): Promise<void> {
    await runReplyAlertSweepWithLock()
}
