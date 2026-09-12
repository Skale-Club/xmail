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

/**
 * Idade mínima (kind: verification_missing) para um run `enriched` já importado e sem
 * verificação registrada virar alerta.
 *
 * Evidência (Fase 34, medida em 2026-09-08): a categoria `email_verification` do ledger tem
 * tarifa seeded desde as migrações 055/056 e, até esta fase, ZERO lançamentos — o saldo do
 * MillionVerifier caiu de 253 para 215 créditos ao longo de 98 verificações e nada registrou
 * isso; a Journey só soube dos números verificados por nota humana do Hermes. 6 horas dá tempo
 * de sobra para o Xphere terminar um lote de verificação (98 endereços não leva minutos, não
 * horas) sem já confundir "ainda não chamou o endpoint" com "está atrasado".
 */
export const VERIFICATION_MISSING_RUN_AGE_HOURS = 6

/**
 * Fase 40 (docs/prospecting-engine-plan.md "Fase 40 -- Silêncio do motor e resumo diário").
 * Evidence: the daily territory-queue engine (Fase 36) can be perfectly "healthy" -- no error
 * anywhere -- and still spend its whole day doing nothing: money available, work queued, zero
 * cost entries. Nothing before this fase looked.
 *
 * `runDailyProspecting` is scheduled at 10:00 UTC (jobs/index.ts) and its own job-timeout
 * budget is 200s (cron-lock.ts JOB_TIMEOUT_BUDGETS_MS.runDailyProspecting — raised 2026-09-12
 * to also bound the territory-reconciliation poll), so by roughly 10:04 UTC the tick has either
 * fired or failed closed. This gate exists so the check itself is never the
 * false alarm: evaluated at 09:00 UTC (the daily digest's own schedule) the engine has not had
 * its turn yet today, and "no lead_source entry today" would be true of every single day at
 * that hour. 12:00 UTC gives a two-hour buffer past the scheduled run before "idle" is treated
 * as a real finding rather than "hasn't run yet".
 */
export const ENGINE_IDLE_CHECK_AFTER_UTC_HOUR = 12

/**
 * Lookback window (kind: enriched_zero_emails) for a completed, template=`enriched` run whose
 * `enriched_count` is 0.
 *
 * Unlike `verification_missing`, this needs no minimum AGE past completion: `enriched_count` is
 * written once, at import time, by the same call that sets `status = 'imported'` (see
 * measureProspectingOutcomes.ts's doc comment -- it is never recomputed later, so there is
 * nothing to wait for). What this constant bounds instead is how far back the check looks --
 * the prospecting pipeline (migration 051) and the `enriched` template are both new as of
 * Fase 31-33, so 14 days comfortably covers "since this became possible" today without the
 * count growing unbounded as history accumulates and diluting a fresh, real regression among
 * old rows a since-fixed defect already produced.
 */
export const ENRICHED_ZERO_EMAILS_LOOKBACK_DAYS = 14

/**
 * Guards `territory_queue_empty` against a fresh install (kind: territory_queue_empty) that has
 * never had `scripts/seed-prospecting-territories.mjs` run at all -- zero territory rows is a
 * DIFFERENT condition from "every territory drained to done/paused", and the two need different
 * human action (seed territories for the first time vs. add more). Same shape as
 * `MIN_MESH_PARTICIPANTS`/`MIN_COST_ENTRIES_FOR_SHARE_CHECK` above.
 */
export const MIN_TERRITORIES_FOR_QUEUE_CHECK = 1

/**
 * Window (kind: analyzer_stalled) over which a Journey event named `analyze.stalled` would be
 * counted, matching the file's usual 24h "recent" cadence. DORMANT: see the doc comment on
 * `analyzerStalledEvents24h` below and the alert block itself -- Xphere does not emit this event
 * yet, so this metric reads 0 forever until it does, and this check can never fire today.
 */
export const ANALYZER_STALLED_EVENT_WINDOW_HOURS = 24

// ------------------------------------------------------------------
// Fase 5 (docs/outbound-authentication-audit.md "Fase 5 — Detectar esta classe de falha
// sozinho"). Three new rules, same file, same pattern: "isto deveria ter produzido algo e não
// produziu" (dmarc_report_gap) or "uma taxa cruzou um limiar medido" (warmup_spam_rate_rising),
// plus one DORMANT rule following the analyzer_stalled precedent immediately above.
// ------------------------------------------------------------------

/**
 * Threshold for kind: warmup_spam_rate_rising, MEASURED against the audit doc's own 14-day
 * baseline — never guessed. The baseline: ten days at 0.0% (29/08-08/09) with one isolated
 * 1.0% spike on 06/09, then a sustained jump to 9.5% (09/09), 14.5% (10/09), 12.0% (11/09),
 * 8.3% (12/09). Nobody noticed for three days because nothing compared the rate to anything.
 *
 * 3% sits strictly between the isolated healthy spike (1.0%) and the incident's onset rate
 * (9.5%): high enough that one lucky/unlucky day of ordinary noise never trips it, low enough
 * that the actual incident would have crossed it on 09/09 — the SAME day the first sustained
 * spam started at 18:00, instead of the three days it actually took a human to notice. This is
 * literally the audit doc's own proposed number ("Um limiar de 3% teria disparado em 09/09, no
 * mesmo dia") — restated here as the enforced constant, not re-derived independently.
 *
 * Scoped to EXTERNAL destinations only (email_accounts.provider != 'native' — a real mailbox
 * we monitor via IMAP folder placement) on purpose: mail landing on our OWN mx-server proves
 * nothing, because our own server is the judge of its own inbound mail (see the audit doc's
 * "Ausência de um juiz" section) — a native-to-native or Gmail-to-native send always reads
 * 0% and always will, regardless of what a real recipient's spam filter thinks.
 */
export const WARMUP_SPAM_RATE_THRESHOLD = 0.03

/** Below this many folder-classified external sends in the window, a rate is noise, not signal
 *  — same shape as MIN_MESH_PARTICIPANTS/MIN_COST_ENTRIES_FOR_SHARE_CHECK above. The audit's
 *  own 7-day sample was ~100/day for the native-to-Gmail direction; 20 in 24h is comfortably
 *  below a healthy day's real volume while still being enough messages that one or two
 *  spam-folder landings do not read as a "rate". */
export const MIN_EXTERNAL_WARMUP_SAMPLE_FOR_SPAM_CHECK = 20

/**
 * Threshold for kind: dmarc_report_gap (hours since the last DMARC aggregate report was
 * ingested). This is literally the audit doc's own figure ("nenhum relatório agregado
 * processado em 48h"), restated as the enforced constant for the same reason
 * WARMUP_SPAM_RATE_THRESHOLD is: reporters (Google et al.) send once roughly every 24h per
 * domain, so 48h is one full missed cycle of margin — a single reporter's report arriving a
 * few hours late never fires this, but the instrument actually going silent (the mailbox
 * filling up, the ingest job breaking, the mailbox itself disappearing) is caught within one
 * extra day, not discovered by a human noticing spam three days late again.
 */
export const DMARC_REPORT_GAP_HOURS = 48

/**
 * The exact substring this check expects Fase 2's self-verification step (native-send.ts,
 * per the audit doc: "verificar a própria mensagem com dkimVerify... antes de entregar.
 * Falhou a autoverificação: não entrega, registra erro, alerta") to write into an error field
 * when it refuses to deliver a message. DORMANT today: nothing in this tree writes this
 * marker yet (Fase 2 belongs to the other half of this audit's work, on a different outbound
 * path this module does not own) — see `outboundDkimUnverified24h`'s own doc comment and the
 * alert block below, same shape as `analyzerStalledEvents24h`/`analyzer_stalled` above. This
 * constant is the CONTRACT: whichever outbound path implements the self-verify-before-deliver
 * step should log an error containing this exact substring so this check starts firing the
 * day that work lands, without either side having to coordinate further.
 */
export const OUTBOUND_DKIM_UNVERIFIED_ERROR_MARKER = 'own DKIM verification failed'

/**
 * Age threshold (kind: xphere_events_undelivered) for a row still sitting in
 * `outreach_event_outbox` with no `xphere_delivered_at`, in minutes.
 *
 * Derived from this same job's own retry schedule (deliverOutreachEvents.ts `retryAt`:
 * `delayMinutes = min(360, 2^(attempt-1))`, `MAX_ATTEMPTS = 10`). Assuming every attempt fails,
 * the delays after attempts 1..N sum to `2^N - 1` minutes, so attempt N+1 fires at that mark:
 * attempt 8 at +127min (~2.1h), attempt 9 at +255min (~4.25h), attempt 10 at +511min (~8.5h) —
 * and once that tenth attempt fails the row is abandoned for good, because `xphereAttempts`
 * reaches `MAX_ATTEMPTS` and `buildDeliverableOutreachEventsQuery` stops selecting it.
 *
 * 180 minutes (3h) sits between the 8th attempt (+2.1h) and the 9th (+4.25h), comfortably before
 * the ~8.5h a genuinely flaky-but-working endpoint would take to exhaust every retry: by 3h a row
 * still being retried on schedule has already had 8 real attempts, so ordinary transient failures
 * have had every reasonable chance to clear. This also covers the scenario this rule exists for —
 * `XPHERE_EVENTS_URL`/`XPHERE_EVENTS_API_KEY` missing entirely, where `deliverOutreachEventsToXphere`
 * returns before ever touching a row, so `xphereAttempts` stays 0 and age is purely wall-clock
 * time since insertion — that case is already well past this threshold within the first hour of
 * the misconfiguration, not just by the three-hour mark.
 */
export const XPHERE_EVENT_STUCK_AGE_MINUTES = 180

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
    /**
     * Runs `imported`, template `enriched`, `enriched_count > 0` e `verified_at IS NULL`,
     * registrados há mais de VERIFICATION_MISSING_RUN_AGE_HOURS — ver o comentário do limiar
     * acima. Fase 34: o mesmo padrão de `enrichedRunsWithoutEnrichmentCount`, um passo adiante
     * no funil (aqui o enriquecimento aconteceu; a verificação é que nunca chegou).
     */
    verificationMissingRuns: number

    // ------------------------------------------------------------------
    // Fase 40 -- the engine's own silences (docs/prospecting-engine-plan.md "Fase 40").
    // ------------------------------------------------------------------

    /** `outreach_cost_entries` rows with `category = 'lead_source'` and `occurred_at` since
     *  UTC midnight today. See `fetchSpentTodayUsd` in runDailyProspecting.ts -- same boundary. */
    leadSourceCostEntriesToday: number
    /** Sum of the same rows, in USD. Kept separate from the count above: the rule reads as
     *  "no entry AND spend under budget" so a zero-amount entry (a genuinely free run) does
     *  not read the same as no entry at all. */
    spentTodayUsd: number
    /** `resolveDailyBudgetUsd()` (daily-territory-budget.ts) -- env-resolved, not queried. */
    dailyBudgetUsd: number
    /** `prospecting_territories` rows with `status = 'queued'`, org-wide. */
    queuedTerritories: number
    /** Completed (`status = 'imported'`), template `enriched` runs within
     *  `ENRICHED_ZERO_EMAILS_LOOKBACK_DAYS` whose `enriched_count` is 0 -- the actor was asked
     *  to extract emails and came back with a real answer of zero. */
    enrichedZeroEmailRuns: number
    /** Total `prospecting_territories` rows, org-wide -- see `MIN_TERRITORIES_FOR_QUEUE_CHECK`. */
    totalTerritories: number
    /** Of those, how many are still actionable (`status` IN ('queued', 'running')). Zero of
     *  these with `totalTerritories > 0` means the queue is drained: every territory reached
     *  `done` or `paused`. */
    activeTerritories: number
    /**
     * DORMANT (kind: analyzer_stalled). Xphere's Website Analyzer is a service Xmail has no
     * visibility into except through a Journey event Xphere would send -- there is no such
     * event today, so this is always 0 and the check below can never fire. Wired against
     * `prospecting_run_events` code `analyze.stalled` (a code that does not exist in
     * RUN_EVENT_CODES and that nothing in Xmail ever writes) so the query is already correct
     * the day Xphere/Xmail add an endpoint for it -- see the alert's own comment for the name.
     */
    analyzerStalledEvents24h: number

    // ------------------------------------------------------------------
    // Fase 5 (docs/outbound-authentication-audit.md "Fase 5").
    // ------------------------------------------------------------------

    /** `warmup_messages` sent in the last 24h to an EXTERNAL destination (email_accounts.provider
     *  != 'native') with `detected_folder` populated (inbox or spam — a verdict was actually
     *  observed). See WARMUP_SPAM_RATE_THRESHOLD: only this direction has a real judge. */
    externalWarmupMessagesWithFolder24h: number
    /** Of those, how many landed in `detected_folder = 'spam'`. */
    externalWarmupSpamMessages24h: number
    /** `max(created_at)` over `dmarc_reports` — null if none has ever been ingested. See
     *  DMARC_REPORT_GAP_HOURS. */
    lastDmarcReportProcessedAt: Date | null
    /** `count(*)` over `dmarc_reports`, all time — guards dmarc_report_gap against firing during
     *  the initial DNS-propagation window before the first report has ever arrived, same shape
     *  as MIN_TERRITORIES_FOR_QUEUE_CHECK's fresh-install guard above. */
    totalDmarcReportsEver: number
    /** DORMANT (kind: outbound_dkim_unverified) — count of `warmup_messages.last_error` /
     *  `outreach_emails.last_error_code` containing OUTBOUND_DKIM_UNVERIFIED_ERROR_MARKER in the
     *  last 24h. Always 0 until Fase 2's self-verify-before-deliver step exists and writes that
     *  marker — see the constant's own doc comment. */
    outboundDkimUnverified24h: number

    /**
     * `outreach_event_outbox` rows with `xphere_delivery_enabled = true` and
     * `xphere_delivered_at IS NULL`, org-wide. See XPHERE_EVENT_STUCK_AGE_MINUTES above.
     */
    pendingXphereEvents: number
    /** Oldest `occurred_at` age (in minutes) among the rows counted above — null when
     *  `pendingXphereEvents` is 0, so an empty (healthy, draining) outbox never evaluates the
     *  threshold at all, the same shape as `lastDmarcReportProcessedAt` guarded by
     *  `totalDmarcReportsEver` above. */
    oldestPendingXphereEventAgeMinutes: number | null
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

    // Aviso: um passo adiante no mesmo funil que enriched_count_never_populated cobre — aqui o
    // enriquecimento aconteceu (enriched_count > 0), mas a verificação de e-mail nunca chegou.
    // O defeito real (Fase 34): a categoria email_verification do ledger tinha tarifa seeded
    // desde 055/056 e ZERO lançamentos; o saldo do MillionVerifier caiu 253 -> 215 créditos em
    // 98 verificações sem que nada gravasse isso.
    if (metrics.verificationMissingRuns > 0) {
        alerts.push({
            severity: 'warning',
            kind: 'verification_missing',
            message: `${metrics.verificationMissingRuns} enriched run(s) imported more than `
                + `${VERIFICATION_MISSING_RUN_AGE_HOURS}h ago still have no verification recorded `
                + '(verified_at IS NULL). Either POST /external-runs/:externalRunId/verification was '
                + 'never called, or the verification batch itself never ran.',
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

    // ------------------------------------------------------------------
    // Fase 40 -- the engine's own silences.
    // ------------------------------------------------------------------

    // Aviso: dinheiro disponível, trabalho na fila, e o motor não fez nada. Ver
    // ENGINE_IDLE_CHECK_AFTER_UTC_HOUR acima para por que isto só é avaliado depois das 12:00
    // UTC -- antes disso, "nenhum lançamento hoje" é simplesmente "o tick das 10:00 UTC ainda
    // não aconteceu", não um defeito.
    if (
        now.getUTCHours() >= ENGINE_IDLE_CHECK_AFTER_UTC_HOUR
        && metrics.leadSourceCostEntriesToday === 0
        && metrics.spentTodayUsd < metrics.dailyBudgetUsd
        && metrics.queuedTerritories > 0
    ) {
        alerts.push({
            severity: 'warning',
            kind: 'engine_idle_with_budget',
            message: `No lead_source cost entry today, USD ${metrics.spentTodayUsd.toFixed(2)} spent of a `
                + `USD ${metrics.dailyBudgetUsd.toFixed(2)} daily budget, and ${metrics.queuedTerritories} `
                + 'territory(ies) queued. The engine had both money and work available and did nothing -- '
                + 'check runDailyProspecting (jobs/index.ts, 10:00 UTC) and XCRAPER_SERVICE_URL/KEY.',
            since,
        })
    }

    // Aviso: o ator (Apify template `enriched`) foi pago para extrair e-mail e voltou com zero.
    // Zero é uma resposta real, mas suspeita -- e antes desta fase nada olhava para
    // `enriched_count` de um run já completo, só para o agregado sem status/idade (ver
    // enriched_count_never_populated acima, que também conta runs ainda em andamento).
    if (metrics.enrichedZeroEmailRuns > 0) {
        alerts.push({
            severity: 'warning',
            kind: 'enriched_zero_emails',
            message: `${metrics.enrichedZeroEmailRuns} completed enriched-template run(s) in the last `
                + `${ENRICHED_ZERO_EMAILS_LOOKBACK_DAYS} days imported with enriched_count = 0. The actor is `
                + 'supposed to extract emails for this template -- zero is a real answer, but a suspicious one.',
            since,
        })
    }

    // Aviso: distinto de engine_idle_with_budget -- ali sobra orçamento e falta execução; aqui
    // falta MATÉRIA-PRIMA. Confundir os dois manda um humano ao lugar errado (recarregar
    // orçamento não ajuda uma fila vazia).
    if (metrics.totalTerritories >= MIN_TERRITORIES_FOR_QUEUE_CHECK && metrics.activeTerritories === 0) {
        alerts.push({
            severity: 'warning',
            kind: 'territory_queue_empty',
            message: `All ${metrics.totalTerritories} territory(ies) are 'done' or 'paused' -- none `
                + '\'queued\' or \'running\'. A human needs to add territories; topping up the budget will '
                + 'not help an empty queue.',
            since,
        })
    }

    // ------------------------------------------------------------------
    // Fase 5 (docs/outbound-authentication-audit.md "Fase 5 — Detectar esta classe de falha
    // sozinho").
    // ------------------------------------------------------------------

    // Crítico: ver WARMUP_SPAM_RATE_THRESHOLD acima — o limiar que teria disparado no MESMO dia
    // do incidente de 09/09, em vez dos três dias que um humano levou para notar. Só a direção
    // para caixas EXTERNAS conta: nosso próprio mx-server aceitando quase tudo não é notícia.
    if (metrics.externalWarmupMessagesWithFolder24h >= MIN_EXTERNAL_WARMUP_SAMPLE_FOR_SPAM_CHECK) {
        const share = metrics.externalWarmupSpamMessages24h / metrics.externalWarmupMessagesWithFolder24h
        if (share > WARMUP_SPAM_RATE_THRESHOLD) {
            alerts.push({
                severity: 'critical',
                kind: 'warmup_spam_rate_rising',
                message: `${metrics.externalWarmupSpamMessages24h} of ${metrics.externalWarmupMessagesWithFolder24h} `
                    + `warm-up mesh send(s) to EXTERNAL mailboxes in the last 24h landed in spam `
                    + `(${Math.round(share * 100)}%, threshold ${Math.round(WARMUP_SPAM_RATE_THRESHOLD * 100)}%). `
                    + 'Mail landing on our own mx-server proves nothing — this counts only sends a real '
                    + 'external provider judged. See docs/outbound-authentication-audit.md.',
                since,
            })
        }
    }

    // Crítico: o instrumento da Fase 1 parou, e voltamos a voar cego exatamente como antes dele
    // existir. Guardado contra a instalação nova (nenhum relatório ainda chegou -- ver
    // MIN_TERRITORIES_FOR_QUEUE_CHECK acima para a mesma forma de guarda) -- sem isso, os
    // primeiros DMARC_REPORT_GAP_HOURS após dmarc@skale.club existir e antes do primeiro
    // relatório do Gmail chegar (propagação de DNS) disparariam um alarme falso todo dia um.
    if (metrics.totalDmarcReportsEver > 0) {
        const lastAt = metrics.lastDmarcReportProcessedAt
        const gapHours = lastAt ? (now.getTime() - lastAt.getTime()) / (60 * 60 * 1000) : Infinity
        if (gapHours > DMARC_REPORT_GAP_HOURS) {
            const lastLabel = lastAt ? lastAt.toISOString() : 'never'
            alerts.push({
                severity: 'critical',
                kind: 'dmarc_report_gap',
                message: `No DMARC aggregate report has been ingested in the last ${DMARC_REPORT_GAP_HOURS}h `
                    + `(last one: ${lastLabel}). Reporters send roughly daily -- this means the Fase 1 `
                    + 'instrument itself has stopped (mailbox full, ingest job broken, DNS rua changed back) '
                    + 'and we are flying blind on outbound authentication again.',
                since,
            })
        }
    }

    // Aviso: DORMANTE (kind: outbound_dkim_unverified) -- ver OUTBOUND_DKIM_UNVERIFIED_ERROR_MARKER
    // acima. Este alerta nunca dispara hoje porque nada nesta árvore ainda escreve esse marcador
    // -- não é um sinal fingido, é a leitura correta de um dado que ainda não existe, no mesmo
    // molde de analyzer_stalled logo abaixo.
    if (metrics.outboundDkimUnverified24h > 0) {
        alerts.push({
            severity: 'critical',
            kind: 'outbound_dkim_unverified',
            message: `${metrics.outboundDkimUnverified24h} outbound message(s) in the last 24h failed their own `
                + 'pre-delivery DKIM self-verification and were refused delivery. If our own verification of our '
                + 'own signature fails, the recipient\'s will too -- see Fase 2 of docs/outbound-authentication-audit.md.',
            since,
        })
    }

    // DORMANTE (kind: analyzer_stalled) -- ver o comentário de analyzerStalledEvents24h acima.
    // O Website Analyzer vive no Xphere; Xmail só o enxerga através de um evento de Journey que
    // o Xphere ainda não emite. Nomeando o evento para quando ele existir: `analyze.stalled`.
    // Esta checagem nunca dispara hoje -- não é um sinal fingido, é a leitura correta de um
    // dado que ainda não chega.
    if (metrics.analyzerStalledEvents24h > 0) {
        alerts.push({
            severity: 'warning',
            kind: 'analyzer_stalled',
            message: `Xphere reported ${metrics.analyzerStalledEvents24h} stalled Website Analyzer run(s) `
                + `in the last ${ANALYZER_STALLED_EVENT_WINDOW_HOURS}h via the analyze.stalled Journey event.`,
            since,
        })
    }

    // Crítico: ver XPHERE_EVENT_STUCK_AGE_MINUTES acima. Cobre as duas causas com a mesma leitura
    // — "config ausente" (zero tentativas feitas, idade = tempo desde a criação) e "endpoint do
    // Xphere fora do ar" (tentativas de fato aconteceram e continuam falhando) — porque das duas
    // perspectivas de fora o outbox é a mesma coisa: linhas paradas sem entrega há tempo demais.
    // Guardado contra a fila vazia (o caso saudável e comum) pelo mesmo formato de
    // oldestPendingXphereEventAgeMinutes ser null quando não há nenhuma linha pendente.
    if (
        metrics.oldestPendingXphereEventAgeMinutes !== null
        && metrics.oldestPendingXphereEventAgeMinutes > XPHERE_EVENT_STUCK_AGE_MINUTES
    ) {
        const ageMinutes = metrics.oldestPendingXphereEventAgeMinutes
        const ageLabel = ageMinutes >= 60
            ? `${Math.round((ageMinutes / 60) * 10) / 10}h`
            : `${ageMinutes}min`
        alerts.push({
            severity: 'critical',
            kind: 'xphere_events_undelivered',
            message: `${metrics.pendingXphereEvents} outreach_event_outbox row(s) are undelivered to `
                + `Xphere, oldest ${ageLabel} old (threshold ${XPHERE_EVENT_STUCK_AGE_MINUTES}min). `
                + 'Either XPHERE_EVENTS_URL/XPHERE_EVENTS_API_KEY is missing or misconfigured '
                + '(deliverOutreachEventsToXphere returns before making any attempt), or the Xphere '
                + 'endpoint itself has been failing this whole time.',
            since,
        })
    }

    return alerts
}
