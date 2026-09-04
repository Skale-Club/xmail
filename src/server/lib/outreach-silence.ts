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
 * Em 2026-09-01/02 a mesma família apareceu de novo, agora depois do timeout de `runWithLock` já
 * existir: o timeout libera a lock via COMMIT (correto), mas NÃO cancela o corpo do job — a
 * promise órfã continua rodando, continua segurando uma conexão do pool, e o pool esgota devagar
 * ao longo de ~30 horas (317+307 timeouts) até um restart de container limpar tudo. Nem
 * `stale_advisory_lock` (a lock já foi liberada) nem qualquer alerta de erro viam isso — de fora,
 * cada tick individual parecia só mais um timeout isolado. A checagem `orphaned_job_bodies`
 * abaixo (kind, ver `ORPHANED_JOBS_THRESHOLD`) conta corpos órfãos vivos agora, não timeouts
 * passados, e é a que teria gritado na primeira hora do incidente, não depois de 30.
 *
 * Cada checagem aqui responde "isto deveria ter produzido algo e não produziu", nunca
 * "isto deu erro". As duas coisas são complementares e ficam em módulos separados de propósito.
 */

import type { HealthAlert } from './outreach-metrics'
import type { InFlightJobStats, JobTimeoutStats } from './cron-lock'

/** Abaixo de dois participantes o mesh não tem par possível, e zero envios é o correto. */
const MIN_MESH_PARTICIPANTS = 2

/**
 * Limiar de timeouts de job por hora (kind: job_timeout_rate).
 *
 * `runWithLock` (cron-lock.ts) já libera a lock quando `fn()` estoura o budget — por isso
 * `stale_advisory_lock` acima NÃO cobre este caso: o timeout faz COMMIT e a lock some, então de
 * fora nada parece preso. Um silêncio foi trocado por outro: o job passa a falhar
 * silenciosamente em loop (timeout, libera, tenta de novo, timeout de novo) sem que a lock presa
 * denuncie nada.
 *
 * Aritmética: a base saudável é 7-8 timeouts por DIA, concentrados em
 * outreach-replies-processor e outreach-bounces-processor (ambos falam com sockets IMAP/SMTP
 * sem timeout próprio). Mesmo no pior caso — todos os timeouts do dia caindo na mesma hora do
 * relógio — isso é no máximo 8/hora. O incidente de setembro/2026 rodou a ~13/hora sustentado
 * por 30 horas. 10/hora fica acima do pior caso da base saudável (8) com folga, e abaixo da taxa
 * do incidente (13): fica calado num agrupamento de azar de timeouts normais, mas dispara já na
 * primeira hora de um incidente real — não depois de 30 horas.
 */
const JOB_TIMEOUT_RATE_THRESHOLD_PER_HOUR = 10

/**
 * Limiar de corpos de job órfãos simultâneos (kind: orphaned_job_bodies), alimentado por
 * `getInFlightJobs()` (cron-lock.ts) exatamente como `recentJobTimeouts` acima é alimentado por
 * `getRecentJobTimeouts()` — em memória, sem SQL.
 *
 * `stale_advisory_lock` acima não cobre este caso pela mesma razão que `job_timeout_rate` não
 * cobre: o timeout de `runWithLock` libera a lock via COMMIT, então nada parece preso de fora.
 * Mas `job_timeout_rate` também não é o mesmo sinal — ele conta quantos timeouts ACONTECERAM numa
 * janela de uma hora; um job pode timear, o corpo órfão terminar sozinho segundos depois, e
 * nenhum corpo ficar de fato acumulado. Este alerta conta quantos corpos estão VIVOS agora,
 * presos, sem nunca ter assentado — é o sintoma direto da hipótese do incidente de
 * 2026-09-01/02: o timeout libera a lock mas NÃO cancela o corpo do job, então a promise órfã
 * continua rodando, continua segurando uma conexão do pool, e o pool esgota devagar.
 *
 * Aritmética: há 17 jobs registrados (jobs/index.ts). Em regime saudável, o número de corpos
 * simultaneamente em voo já é pequeno (a maioria dos jobs
 * roda em segundos), e órfãos confirmados devem ser ZERO — nenhum job deveria estourar seu
 * próprio orçamento. Os dois jobs sem timeout próprio de socket (outreach-replies-processor e
 * outreach-bounces-processor — ver comentário de JOB_TIMEOUT_RATE_THRESHOLD_PER_HOUR acima) são
 * quem realisticamente estoura esse orçamento: uma leitura IMAP lenta pode cruzar o timeout e o
 * socket ainda levar alguns segundos para desenrolar depois disso. No pior caso plausível e
 * saudável, os DOIS acontecem de estar desenrolando ao mesmo tempo no mesmo instante: 2 órfãos
 * momentâneos, não um padrão.
 *
 * Um 3º órfão simultâneo — seja um terceiro job distinto, seja o MESMO job acumulando mais de um
 * órfão sozinho (o padrão exato do incidente: timeout, libera a lock, a próxima tentativa acha a
 * lock livre e tenta de novo, tempo de novo, e o órfão anterior nunca assentou) — não tem
 * explicação de coincidência saudável. 2026-09-01/02 rodou por 30 horas acumulando órfãos sem
 * limite (317+307 timeouts); esta checagem dispara na primeira leitura acima de 2, não depois de
 * 30 horas.
 */
const ORPHANED_JOBS_THRESHOLD = 2

/** Runs mais antigos que isto sem nenhum lead atribuído entram no funil parado (kind: funnel_stalled). */
const FUNNEL_STALLED_RUN_AGE_DAYS = 7

/**
 * Limiar de share de custo sem preço (kind: unpriced_cost_share), sobre uma janela de 35 dias
 * (o suficiente para cobrir uma amortização mensal inteira).
 *
 * Aritmética: hoje 29 de 34 lançamentos de inbox_subscription (~85%) estão sem preço
 * (`mailbox_provider = 'manual'`, sem rate cadastrada) — maioria clara. Um único provedor
 * genuinamente desconhecido, cercado de outros já precificados, fica tipicamente bem abaixo de
 * metade do total. 50% (maioria) separa "um provedor sem rate" de "a maior parte do gasto real
 * está subestimado". `MIN_COST_ENTRIES_FOR_SHARE_CHECK` evita que os primeiros lançamentos após
 * o go-live (denominador minúsculo) já leiam como "maioria sem preço".
 */
const UNPRICED_COST_SHARE_THRESHOLD = 0.5
const MIN_COST_ENTRIES_FOR_SHARE_CHECK = 5

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
    /** Do cron-lock.ts `getRecentJobTimeouts` — em memória, não SQL. Ver JOB_TIMEOUT_RATE_THRESHOLD_PER_HOUR acima. */
    recentJobTimeouts: JobTimeoutStats
    /** Do cron-lock.ts `getInFlightJobs` — em memória, não SQL. Ver ORPHANED_JOBS_THRESHOLD acima. */
    inFlightJobs: InFlightJobStats
    /**
     * Prospecting runs registrados há mais de FUNNEL_STALLED_RUN_AGE_DAYS sem NENHUM lead
     * atribuído — mesmo join que `measureProspectingOutcomes` usa
     * (`leads.custom_fields->>'source_run_id' = prospecting_runs.idempotency_key`), só que numa
     * janela maior (7 dias, não 24h) porque este alerta é sobre o funil estar parado, não sobre
     * um run individual ainda não ter sido processado.
     */
    staleProspectingRunsWithoutLeads: number
    /** Idade em dias do run mais antigo entre os contados acima — para a mensagem ser acionável. */
    oldestStaleProspectingRunAgeDays: number
    /** Caixas `warmup_source='internal'` verificadas com `warmup_current_day >= warmup_days`. */
    rampedWarmupInboxes: number
    /** `outreach_emails` com `sent_at` nos últimos 7 dias, org-wide. */
    outreachSends7d: number
    /** Lançamentos de `outreach_cost_entries` nos últimos 35 dias. */
    costEntries35d: number
    /** Entre os acima, quantos têm `detail->>'rate_missing' = 'true'`. */
    unpricedCostEntries35d: number
    /** Categorias (`category`) que aparecem entre os lançamentos sem preço. */
    unpricedCostCategories: string[]
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

    // Crítico: ver o comentário de JOB_TIMEOUT_RATE_THRESHOLD_PER_HOUR acima — este é o caso que
    // stale_advisory_lock deliberadamente NÃO cobre, porque o timeout libera a lock via COMMIT.
    if (metrics.recentJobTimeouts.total > JOB_TIMEOUT_RATE_THRESHOLD_PER_HOUR) {
        const windowHours = Math.round((metrics.recentJobTimeouts.windowMs / (60 * 60 * 1000)) * 10) / 10
        const worst = Object.entries(metrics.recentJobTimeouts.byJob).sort((a, b) => b[1] - a[1])[0]
        alerts.push({
            severity: 'critical',
            kind: 'job_timeout_rate',
            message: `${metrics.recentJobTimeouts.total} job timeout(s) in the last ${windowHours}h`
                + (worst ? `, worst offender ${worst[0]} (${worst[1]})` : '') + '. '
                + 'stale_advisory_lock does not catch this: the timeout releases the lock via COMMIT, so '
                + 'nothing looks stuck — the job is failing on a loop of timeout-release-retry instead.',
            since,
        })
    }

    // Crítico: ver o comentário de ORPHANED_JOBS_THRESHOLD acima — esta é a checagem que teria
    // pego 2026-09-01/02 na primeira hora. job_timeout_rate conta quantos timeouts ACONTECERAM
    // numa janela de uma hora; este conta quantos corpos órfãos estão VIVOS agora, ainda
    // segurando uma conexão do pool, sem nunca ter assentado.
    if (metrics.inFlightJobs.orphaned > ORPHANED_JOBS_THRESHOLD) {
        const worst = Object.entries(metrics.inFlightJobs.orphansByJob).sort((a, b) => b[1] - a[1])[0]
        const oldest = metrics.inFlightJobs.oldestAgeMs
        const oldestLabel = oldest === null
            ? 'unknown'
            : (oldest >= 60 * 60 * 1000
                ? `${Math.round((oldest / (60 * 60 * 1000)) * 10) / 10}h`
                : `${Math.round(oldest / (60 * 1000))}min`)
        alerts.push({
            severity: 'critical',
            kind: 'orphaned_job_bodies',
            message: `${metrics.inFlightJobs.orphaned} orphaned job body(ies) still running past their timeout, `
                + `oldest ${oldestLabel}` + (worst ? `, worst offender ${worst[0]} (${worst[1]})` : '') + '. '
                + 'runWithLock releases the advisory lock on timeout but does NOT cancel the job body — it keeps '
                + 'running orphaned, keeps holding a pooled connection, and the pool exhausts slowly. This is the '
                + 'September 1-2 incident signature (~30h, 317+307 job timeouts, cured only by a process restart). '
                + 'stale_advisory_lock does not catch this either: the timeout already released the lock via COMMIT.',
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

    // Aviso: a máquina inteira de prospecção/outreach pode estar "saudável" (sem erro nenhum) e
    // ainda assim não produzir nada. Duas faces do mesmo sintoma, e qualquer uma sozinha já basta
    // — cada uma tem sua própria guarda contra instalação nova/vazia: um run só entra na primeira
    // contagem se existir (senão o count fica 0), e a segunda condição exige explicitamente pelo
    // menos uma caixa rampada (`rampedWarmupInboxes > 0`).
    const hasStaleRuns = metrics.staleProspectingRunsWithoutLeads > 0
    const hasIdleReadyMesh = metrics.rampedWarmupInboxes > 0 && metrics.outreachSends7d === 0
    if (hasStaleRuns || hasIdleReadyMesh) {
        const parts: string[] = []
        if (hasStaleRuns) {
            parts.push(
                `${metrics.staleProspectingRunsWithoutLeads} prospecting run(s) registered more than `
                    + `${FUNNEL_STALLED_RUN_AGE_DAYS} days ago (oldest ${metrics.oldestStaleProspectingRunAgeDays}d) `
                    + 'still have no lead attributed via source_run_id.',
            )
        }
        if (hasIdleReadyMesh) {
            parts.push(
                `${metrics.rampedWarmupInboxes} warm-up inbox(es) are fully ramped `
                    + '(warmup_current_day >= warmup_days) but outreach_emails has sent 0 message(s) in the last '
                    + '7 days — the inboxes are ready and nothing is using them.',
            )
        }
        alerts.push({
            severity: 'warning',
            kind: 'funnel_stalled',
            message: parts.join(' '),
            since,
        })
    }

    // Aviso: um lançamento de custo com detail.rate_missing=true é gasto real gravado a zero —
    // ver outreach-costs.ts. Um provedor isolado sem rate cadastrada é esperado; a maioria da
    // janela sem preço não é.
    //
    // Transiente esperado (2026-09-04, migration 063): os 29 lançamentos de inbox_subscription
    // gravados em 2026-09-01 para contas provider='native' (mailboxes self-hosted, custo marginal
    // genuinamente zero) foram escritos ANTES da rate 'native' existir no price book, então ainda
    // carregam rate_missing=true — outreach_cost_entries é append-only e congela o custo no
    // momento da escrita (ver migration 051), então essas linhas antigas ficam como estão, não são
    // reescritas. Este alerta continua disparando sobre elas até a amortização de 2026-10-01
    // gravar linhas 'native' já precificadas e as linhas antigas saírem da janela de 35 dias.
    // Isso é esperado e se autorresolve — NÃO abaixar o limiar nem excluir essas linhas para
    // silenciar o alerta enquanto isso não acontece; qualquer uma das duas cegaria o alerta
    // também para gasto genuinamente sem preço.
    if (metrics.costEntries35d >= MIN_COST_ENTRIES_FOR_SHARE_CHECK) {
        const share = metrics.unpricedCostEntries35d / metrics.costEntries35d
        if (share > UNPRICED_COST_SHARE_THRESHOLD) {
            alerts.push({
                severity: 'warning',
                kind: 'unpriced_cost_share',
                message: `${metrics.unpricedCostEntries35d} of ${metrics.costEntries35d} cost entries in the last `
                    + `35 days (${Math.round(share * 100)}%) were recorded with no rate — real spend reported at `
                    + `USD 0 for that share. Affected categories: ${metrics.unpricedCostCategories.join(', ')}.`,
                since,
            })
        }
    }

    return alerts
}
