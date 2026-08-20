/**
 * Detecção de SILÊNCIO — o subsistema não falhou, simplesmente não produziu nada.
 *
 * Por que existe, em uma frase: em 2026-08-15 sete defeitos foram encontrados de uma vez, e
 * **nenhum deles teria disparado qualquer alerta existente**. O `outreach-metrics.ts` alerta em
 * aprovação travada, entrega ao Xphere esgotada e run de prospecção falhado — todos da forma
 * "algo deu erro e o erro foi gravado". Os defeitos daquele dia eram de outra natureza:
 *
 *   - o mesh de warm-up morria no primeiro remetente a cada tick e parecia ocioso;
 *   - as credenciais SMTP não decifravam, e o mesh parecia "sem atividade";
 *   - 373 linhas de jsonb estavam duplo-codificadas desde março, sem erro nenhum, porque o ORM
 *     desfazia a codificação na leitura;
 *   - a atribuição de outcome nunca casava (`source_run_id` vs `xcraper_run_id`), e o resultado
 *     era `outcome_* = 0`, indistinguível de "ninguém respondeu ainda";
 *   - `enriched_count` ficava em 0 num run `enriched`, um número perfeitamente plausível.
 *
 * O denominador comum: **zero é um valor válido**, então ausência de resultado se disfarça de
 * operação normal. Um sistema que roda sozinho precisa saber gritar quando não produziu nada,
 * senão o próximo defeito silencioso espera o próximo humano curioso.
 *
 * Em 2026-08-16/17/18 a mesma família de sintoma apareceu de outra forma: três jobs (replies,
 * bounces, warm-up mesh) travaram com um socket IMAP/SMTP que nunca resolvia dentro de
 * `runWithLock` (cron-lock.ts). Como o `finally` que faz `COMMIT` nunca rodava, a lock advisory
 * ficava presa para sempre e a transação sentava `idle in transaction` por dias. O único sintoma
 * era a mesma linha "already running … skipping" que aparece em contenção normal — nada
 * distinguia "dois ticks se sobrepuseram por um segundo" de "este job está morto há 3 dias".
 * `runWithLock` agora tem um timeout que sempre libera a lock, mas esta checagem é o cinto e
 * suspensório: se uma lock advisory ainda assim ficar presa (o timeout falhar, ou algo fora de
 * `runWithLock` segurar a mesma chave via `pg_advisory_lock` sessão), isto precisa gritar.
 *
 * Cada checagem aqui responde "isto deveria ter produzido algo e não produziu", nunca
 * "isto deu erro". As duas coisas são complementares e ficam em módulos separados de propósito.
 */

import type { HealthAlert } from './outreach-metrics'

/** Abaixo de dois participantes o mesh não tem par possível, e zero envios é o correto. */
const MIN_MESH_PARTICIPANTS = 2

export interface SilenceMetrics {
    /** Caixas elegíveis ao mesh: `warmup_source='internal'` e verificadas. */
    warmupEligibleInboxes: number
    /** Mensagens do mesh que saíram de fato nas últimas 24h. */
    warmupSends24h: number
    /** Falhas do mesh atribuídas a credencial cifrada com outra chave, nas últimas 24h. */
    credentialKeyMismatches24h: number
    /** Runs `enriched` com mais de 24h que não têm NENHUM lead atribuído. */
    enrichedRunsWithoutLeads: number
    /** Runs `enriched` cujo `enriched_count` continua zero — o contador nunca é populado. */
    enrichedRunsWithoutEnrichmentCount: number
    /** Colunas jsonb que ainda guardam escalar em vez de objeto/array. */
    doubleEncodedJsonbColumns: string[]
    /**
     * Locks advisory cujo backend está `idle in transaction` há mais tempo que o limiar de
     * "preso" — ver outreach-silence-query.ts. `jobName` vem de `KNOWN_LOCK_NAMES`
     * (cron-lock.ts); uma chave que não bate com nenhum nome conhecido ainda assim aparece aqui
     * (com um `jobName` descrevendo a chave crua), porque a lock presa importa mesmo sem nome.
     */
    staleAdvisoryLocks: Array<{ jobName: string; heldForSeconds: number }>
}

/**
 * Pura, para ser testável sem banco — mesmo padrão do `buildAlerts`.
 *
 * As severidades seguem uma regra: **crítico** quando algo que deveria estar produzindo está
 * parado ou corrompendo dado silenciosamente; **aviso** quando o dado está apenas incompleto e
 * ninguém está sendo prejudicado agora.
 */
export function buildSilenceAlerts(metrics: SilenceMetrics, now: Date = new Date()): HealthAlert[] {
    const alerts: HealthAlert[] = []
    const since = now.toISOString()

    // O mesh é a única coisa que faz a rampa de warm-up andar. Parado, toda ativação de campanha
    // fica bloqueada em `sending_inbox_not_warmed` — e o sintoma visível é um job que parece ocioso.
    if (metrics.warmupEligibleInboxes >= MIN_MESH_PARTICIPANTS && metrics.warmupSends24h === 0) {
        alerts.push({
            severity: 'critical',
            kind: 'warmup_mesh_silent',
            message: `Warm-up mesh sent nothing in 24h with ${metrics.warmupEligibleInboxes} eligible inboxes. `
                + 'The ramp cannot advance while it is silent, so every campaign activation stays blocked.',
            since,
        })
    }

    if (metrics.credentialKeyMismatches24h > 0) {
        alerts.push({
            severity: 'critical',
            kind: 'credential_key_mismatch',
            message: `${metrics.credentialKeyMismatches24h} send(s) failed because a stored credential could not be decrypted `
                + 'with the current OUTLOOK_TOKEN_ENCRYPTION_KEY — it was encrypted with a different key.',
            since,
        })
    }

    if (metrics.doubleEncodedJsonbColumns.length > 0) {
        alerts.push({
            severity: 'critical',
            kind: 'double_encoded_jsonb',
            message: `jsonb stored as a JSON string in: ${metrics.doubleEncodedJsonbColumns.join(', ')}. `
                + 'The ORM hides this on read, but ->, ->>, || and jsonb_exists all see an opaque scalar. '
                + 'Write through jsonbParam (lib/jsonb.ts) and normalize the rows.',
            since,
        })
    }

    // Crítico, não aviso: uma lock presa desliga o job inteiro até alguém encerrar a sessão à
    // mão — não é um dado incompleto, é um job inteiro fora do ar disfarçado de "ocupado".
    if (metrics.staleAdvisoryLocks.length > 0) {
        const detail = metrics.staleAdvisoryLocks
            .map((lock) => `${lock.jobName} (${Math.round(lock.heldForSeconds / 60)}min)`)
            .join(', ')
        alerts.push({
            severity: 'critical',
            kind: 'stale_advisory_lock',
            message: `${metrics.staleAdvisoryLocks.length} advisory lock(s) held by a session idle in transaction `
                + `past the stale threshold: ${detail}. That job is disabled until the lock clears, and every `
                + 'later tick logs the ordinary-looking "already running … skipping" — indistinguishable from '
                + 'healthy contention from the outside. See cron-lock.ts runWithLock; terminate the holding '
                + 'backend (pg_terminate_backend) to recover immediately.',
            since,
        })
    }

    // Aviso, não crítico: nada quebrou, mas o run pagou por extração de e-mail e nenhum endereço
    // chegou à lista de envio — ou a extração não rendeu, ou ninguém importou o resultado.
    if (metrics.enrichedRunsWithoutLeads > 0) {
        alerts.push({
            severity: 'warning',
            kind: 'enriched_runs_without_leads',
            message: `${metrics.enrichedRunsWithoutLeads} enriched run(s) older than 24h have no attributable lead. `
                + 'Either the extraction yielded no address, or the addresses were never imported.',
            since,
        })
    }

    if (metrics.enrichedRunsWithoutEnrichmentCount > 0) {
        alerts.push({
            severity: 'warning',
            kind: 'enriched_count_never_populated',
            message: `${metrics.enrichedRunsWithoutEnrichmentCount} enriched run(s) still report enriched_count = 0. `
                + 'This is the counter that answers whether paying for enrichment is worth it, and nothing populates it.',
            since,
        })
    }

    return alerts
}
