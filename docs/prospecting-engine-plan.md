# Motor diário de prospecção — plano de fases

> Continuação do [`outreach-hermes-roadmap.md`](outreach-hermes-roadmap.md) (fases 24–32).
> Escrito em 2026-09-08 a partir de três runs reais feitos no mesmo dia, à mão, com o
> ciclo inteiro operado por uma pessoa. Cada fase abaixo nasce de algo que quebrou, custou
> crédito à toa ou exigiu intervenção humana nesses runs. Os números citados são medidos,
> não estimados; a fonte de cada um está na Journey da run correspondente.

## As três runs que geraram este plano

| Run | Cidade | Resultados | Sem site próprio | Com e-mail | Verificados ok | Custo Apify |
|---|---|---|---|---|---|---|
| `ff0ddd60` | Framingham, MA | 25 | 13 (52%) | 7 (28%) | 3 (12%) | US$ 0,1651 |
| `c9c35798` | Worcester, MA | 100 | 79 (79%) | 11 (11%) | 7 (7%) | US$ 0,6076 |
| `37766ea5` | Boston, MA | 330 | 231 (70%) | 60 (18%) | 45 (13,6%) | US$ 2,0601 |

Total do dia: 455 negócios, US$ 2,83 de Apify, 98 verificações (69 ok, 9 catch-all, 2
desconhecidos, 18 inválidos), 80 endereços enviáveis, **zero importados, zero enviados**.
O padrão que se repetiu nas três cidades: 50 a 80% sem site próprio, Booksy dominante entre
quem usa plataforma (38 de 52 em Boston), e-mail bruto entre 10 e 20%.

O ciclo manual teve onze passos. Os que precisaram de mim são o plano.

## Visão das fases

| Fase | Resultado | Repos | Depende de |
|---|---|---|---|
| 33 | Filtros determinísticos antes de gastar crédito ou análise | Xcraper, Xphere | — |
| 34 | Verificação como passo de run, com custo no ledger | Xphere, Xmail | — |
| 35 | Scorer completo e hipótese calibrada pela mediana | Xmail | 34 |
| 36 | Fila de territórios com orçamento diário | Xmail | 34, 35 |
| 37 | Import automático de verificados e aprovação de um toque | Xmail, Xphere | 34, achado 2 |
| 38 | Destino diário para quem não tem e-mail (Meta Audiences) | Xphere | reconexão OAuth (humano) |
| 39 | Hermes fora do caminho crítico | Xmail, Hermes | 35 |
| 40 | Silêncio do motor e resumo diário | Xmail | 36 |

Ordem de execução: 33 e 34 em paralelo, depois 35, depois 36 e 37, depois 39 e 40. A 38
só depende de você reconectar o Meta e pode entrar a qualquer momento.

Convenções que valem para todas: migração nova do Xmail começa em `064` (ledger em
produção está em `063`; reconferir em `supabase_migrations.schema_migrations` antes),
do Xphere em `1298`. Nenhuma fase envia e-mail. Ativar campanha continua atrás de
aprovação humana em `outreach_action_approvals`.

---

## Fase 33 — Filtros determinísticos

**Evidência.** 4 dos 98 e-mails verificados eram placeholder de template
(`filler@godaddy.com` três vezes, `contact@seusite.com.br` uma), todos inválidos, todos
cobrados. 6 dos 99 "sites próprios" de Boston eram domínio `.top` parado (`zincx.top` em
três barbearias distintas, `unkusa.top`, `moneyus.top`) ou subdomínio de plataforma
(`chichi-barbershop.booksy.net`); `barbershops.net`, um diretório, passou como site próprio
em Worcester e Boston. O Analyzer tentou `gubarbershop.com`, que não resolve DNS, **432
vezes em três dias**, a cada 10 minutos, ocupando uma das cerca de dez vagas por rodada.

**Xcraper**
- `backend/src/services/scrapers/helpers.ts` (linha ~104, onde `email` sai de
  `item.email || item.emails`): passar por uma denylist antes de gravar. Lista inicial:
  `filler@godaddy.com`, `*@seusite.com.br`, `*@example.com`, `*@yourdomain.*`,
  `*@domain.com`, `*@email.com`, `*@sentry.io`, `*@wixpress.com`, `test@*`,
  `noreply@*`/`no-reply@*`. Placeholder descartado **não vira e-mail nulo silencioso**:
  gravar `email_rejected_reason` no resultado, para a cobertura de e-mail continuar
  honesta (o motivo importa mais que o número).
- `backend/src/services/webPresence.ts`: (a) TLDs de baixa reputação (`.top`, `.xyz`,
  `.icu`, `.click`, `.online` sem sinal de negócio) classificam como `none`, não como
  `owned_website`; (b) `booksy.net` entra ao lado de `booksy.com`; (c) diretórios
  conhecidos (`barbershops.net`, `locmaps.com`, `yelp.com`, `yellowpages.com`) viram
  `directory_listing`. Teste com os seis domínios reais de Boston como fixture.
- Métrica nova no `buildSourceMetadata`: `emails_rejected_as_placeholder`, enviada ao
  Xphere junto de `enriched_count`. Zero é resposta válida aqui também.

**Xphere**
- `src/app/api/cron/website-analyzer/route.ts`: falha permanente (`ERR_NAME_NOT_RESOLVED`,
  `ERR_CERT_*`, 4xx estável) marca a análise como `dead` na primeira ocorrência; falha
  transitória (`ECONNRESET`, timeout) tenta no máximo três vezes com backoff de 10, 60 e
  360 minutos. Hoje não há distinção nem limite. Coluna `attempts` e `next_attempt_at` em
  `website_analyses` (migração `1298`).
- Domínios já marcados `.top`/diretório pela fase Xcraper nem entram na fila.

**Pronto quando** um re-push de Boston não gera nenhuma análise para os seis domínios
suspeitos e o `gubarbershop.com` tem exatamente uma linha `dead`.

---

## Fase 34 — Verificação como passo de run

**Evidência.** Verificar os 98 exigiu chamar `prospects_enroll_in_campaign` **sem**
`confirmed`, porque é a única ferramenta que verifica. Não filtra por run, o nome mente
sobre o que faz, e a saída teve que ser cruzada no banco por janela de `created_at`. A
categoria `email_verification` do ledger tem tarifa seeded desde a migração `055`/`056` e
**zero lançamentos**. O saldo caiu de 253 para 215 créditos e nada registrou isso. O script
de saldo do Hermes só alerta; ninguém recarrega.

**Xphere**
- Nova tool MCP e endpoint `prospects_verify` em `src/lib/mcp/tools/prospects.ts`,
  filtrando por `external_run_id` (via `prospect_sources`) ou `source_type`, com `max` e
  sem qualquer relação com campanha. Reusa `verifyProspectsBatch` de
  `src/lib/email-verification/verify.ts`. Retorna a quebra por status e a lista de
  `prospect_id → status`.
- Ao terminar, o Xphere chama o Xmail: `POST /api/outreach/prospecting/external-runs/:externalRunId/verification`
  com `{ checked, ok, catchAll, unknown, invalid, provider, creditsUsed, placeholdersRejected }`.
  Mesma credencial de serviço do `POST /external-runs` (`src/lib/xmail/client.ts`).
- `src/lib/email-verification/credits.ts`: registrar `creditsUsed` como diferença de saldo
  antes/depois do lote, não como contagem de chamadas. A proporção observada hoje (24
  verificações persistidas, 6 créditos debitados) não está explicada; medir em vez de supor.

**Xmail**
- Rota nova em `src/server/routes/outreach/prospecting.ts`: valida, grava evento
  `verify.completed` na Journey (`prospecting_run_events`) com o payload inteiro, lança
  `outreach_cost_entries` em `email_verification` usando `resolveRate` para
  `millionverifier`/`credit` (a tarifa `056` já existe), e atualiza um contador novo
  `verified_ok_count` em `prospecting_runs` (migração `064`).
- `outreach-silence.ts`: regra nova, `verification_missing`: run `imported` com
  `enriched_count > 0` e sem `verify.completed` em 6 horas.

**Pronto quando** a Journey de uma run mostra `verify.completed` com custo lançado e o
ledger fecha com a diferença de saldo do MillionVerifier.

---

## Fase 35 — Scorer completo, hipótese pela mediana

**Evidência.** Escrevi as hipóteses à mão e errei a taxa verificada em duas de três
runs, ancorando no run anterior. O scorer (`src/server/lib/prospecting/hypothesis-scoring.ts`)
só mede `discovered`, `reply_rate` e `verified_email_rate`, e essa última só depois de
importar leads. `no_owned_website_rate`, `email_rate` e `cost_usd` vieram como `unknown`
nas três Journeys, apesar de os dados estarem no evento `import.external_run_registered`
(cobertura) e no ledger (custo). A verdade ficou nas notas humanas do Hermes.

**Xmail**
- `SUPPORTED_METRICS` ganha `no_owned_website_rate` (cobertura do evento de import:
  `1 − owned_website / total`), `email_rate` (`enriched_count / discovered_count` no
  template `enriched`; `unknown` no `standard`), `cost_usd` (soma de `lead_source` da run
  no ledger), `booking_platform_share` (cobertura). `verified_email_rate` passa a ler
  `verified_ok_count / discovered_count` da fase 34, sem depender de import.
- Gerador de hipótese `buildBaselineHypothesis(provider, template)` em
  `src/server/lib/prospecting/`: mediana das últimas 5 runs concluídas do mesmo template
  para cada métrica, com margem de −20% relativa, e `basis` listando as runs usadas. Sem
  histórico, não inventa: escreve `expected` vazio e `basis: "first run"`. A hipótese
  escrita por humano continua vencendo se enviada.
- `measureProspectingOutcomes.ts` já emite evento quando o veredito muda; passa a rodar
  também logo após `verify.completed`, não só a cada 6 horas.

**Pronto quando** uma run nova recebe hipótese automática e o veredito da Journey sai
sem nenhum `unknown` além de `reply_rate` antes do primeiro envio.

---

## Fase 36 — Fila de territórios com orçamento diário

**Evidência.** Escolhi as três cidades de cabeça e calibrei `maxResults` a partir do custo
unitário do run anterior (US$ 0,0061 a 0,0066 por resultado). O teto de "uns dois dólares"
veio de você em linguagem natural. Nada impede raspar Boston de novo amanhã.

**Xmail**
- Tabela `prospecting_territories` (migração `064`, junto da fase 34): `query`, `location`,
  `template`, `priority`, `status` (`queued`, `running`, `done`, `paused`), `last_run_id`,
  `max_results`, `notes`. Único por `(organization_id, query, location)`.
- Job `runDailyProspecting` em `src/server/jobs/`, agendado uma vez por dia no horário que
  você definir, dentro de `runWithLock` como os demais. Lógica: lê o gasto real de
  `lead_source` do dia no ledger; se sobra orçamento, pega o território `queued` de maior
  prioridade, calcula `maxResults = min(território, orçamento restante / custo unitário
  mediano das últimas 5 runs)`, gera a hipótese da fase 35, chama
  `POST $XCRAPER_SERVICE_URL/scrape`, grava `external_run_id` no território. Não faz
  polling: o Xphere registra a run quando o push chega, como hoje.
- Configuração: `PROSPECTING_DAILY_BUDGET_USD` (padrão `2.00`), `XCRAPER_SERVICE_URL`,
  `XCRAPER_SERVICE_KEY`. **As três entram em `run_app_container()` do
  `.github/workflows/build-deploy.yml` e como secrets**; a chave hoje só existe em
  `/opt/hermes/hermes.env`. Teste de contrato garantindo que o job nunca dispara com
  orçamento zero ou chave ausente, e que orçamento é lido do ledger, não estimado.
- Seed inicial dos territórios: as cidades de Massachusetts ao redor de Hudson, em
  ordem de população, excluindo as três já raspadas.

**Pronto quando** dois dias seguidos produzem duas runs distintas sem intervenção e o
terceiro dia com orçamento esgotado não dispara nada, com o silêncio explicando por quê.

---

## Fase 37 — Import automático de verificados, aprovação de um toque

**Evidência.** 80 endereços enviáveis esperam no Xphere. Importar para o Xmail é
reversível e não envia nada, mas hoje só acontece dentro de `prospects_enroll_in_campaign`
com `confirmed:true`, que **também enrola e pode ativar**. O gate humano existe
(`outreach_action_approvals`, `AgentOpsPage.tsx`) e tem zero linhas na história. O achado
2 do mapa continua aberto: o card aprova sem mostrar campanha, assunto, corpo ou leads.

**Xphere**
- Separar import de enrolamento: `prospects_import_to_xmail` importa por
  `external_run_id` só quem tem `email_status = 'ok'` (catch-all e unknown ficam para
  decisão humana, com contagem visível), carregando `source_run_id`, presença web e
  booking em `customFields`. Não enrola. `prospects_enroll_in_campaign` passa a exigir
  leads já importados.
- Chamado pelo Xphere automaticamente após `prospects_verify` da fase 34, se o
  território tiver `auto_import = true`.

**Xmail**
- Achado 2: o card de aprovação em `AgentOpsPage.tsx` mostra campanha, assunto do passo 1,
  corpo renderizado com um lead real, nº de leads, caixa de envio e limite diário. Sem
  isso a fase não fecha.
- `deliverDailyDigest` (já existe às 09:00 UTC) ganha a seção "aguardando aprovação" com
  link direto para o card. Aprovar continua sendo ação humana na UI; o Telegram só avisa.
- Pré-requisitos humanos que este plano **não** resolve e que bloqueiam a primeira
  ativação: endereço postal na sequência do piloto (a própria descrição da campanha o
  chama de "COMPLIANCE BLOCKER"), e limite diário das caixas `info@` (hoje 50 num endereço
  que nunca enviou; 10 a 15 no início).

**Pronto quando** uma run verificada aparece como leads no Xmail sem ninguém tocar, e o
card de aprovação mostra o e-mail exatamente como sairia.

---

## Fase 38 — Destino diário para quem não tem e-mail

**Evidência.** 70% dos negócios de Boston não têm site próprio e 82% não têm e-mail. É o
cliente ideal descrito por você, e hoje ele fica no Xphere sem canal. As duas conexões
Meta estão em `error` com token vencido em 02/08; as seis do Google Ads desde 15/06; não
existe `meta_audience_config`.

**Humano, antes de qualquer código:** reconectar o Meta no painel do Xphere e criar uma
audiência com escopo e base de consentimento definidos.

**Xphere**
- Job diário que sincroniza para a audiência configurada todo prospect `xcraper` com
  telefone, sem e-mail verificável, marcado `dirty` (o mecanismo `audience-dirty.ts` já
  existe). Registrar por run quantos foram enviados, para a Journey (`audience.synced`
  como evento no Xmail, mesma rota da fase 34).
- Alerta quando `token_expires_at < now() + 7 dias`, antes de vencer, não depois.

**Pronto quando** a Journey de uma run mostra quantos negócios sem e-mail chegaram à
audiência no mesmo dia.

---

## Fase 39 — Hermes fora do caminho crítico

**Evidência.** Em seis sessões `hermes -z` hoje, duas perderam as tools MCP: uma o
Xphere, uma o Xmail. `hermes mcp test xphere` conecta, `hermes tools list` mostra tudo
habilitado, o token responde 200. O modo one-shot é não determinístico para MCP remoto;
o gateway (Telegram, sessão longa) não mostrou isso em 14/08. Numa das falhas o Hermes
improvisou scripts com a chave errada e recebeu 401; recusou escrever a nota, o que foi
correto, mas o motor não pode depender disso.

**Xmail**
- Nota "observado vs esperado" passa a ser escrita pelo próprio scorer, determinística,
  como evento `assess.verdict` com a tabela métrica por métrica, no momento em que o
  veredito muda. Hoje isso é texto ditado por humano ao Hermes.

**Hermes**
- Substituir `hermes -z` por `hermes cron` no gateway para a lição qualitativa e o resumo
  diário, com a skill orientando a ler `assess.verdict` em vez de recalcular.
- `hermes/README.md` e `docs/outreach-hermes-system-map.md`: registrar a limitação do
  one-shot como achado, com os seis casos de hoje.

**Pronto quando** uma run passa do início ao veredito sem nenhuma chamada ao Hermes, e o
Hermes só acrescenta a lição.

---

## Fase 40 — Silêncio do motor e resumo diário

**Evidência.** O detector de silêncio já parte do princípio de que zero é valor. As
ausências novas que o motor cria: nenhum run hoje com orçamento disponível, run registrada
sem verificação, template `enriched` com zero e-mails, análise de site parada, audiência
sem sync. Nenhuma delas alerta hoje. O acumulado do dia (custos, saldo de créditos,
vereditos, anomalias de qualidade) foi montado à mão em consultas SQL.

**Xmail**
- `outreach-silence.ts`: `engine_idle_with_budget`, `verification_missing` (fase 34),
  `enriched_zero_emails`, `analyzer_stalled` (lido do Xphere via evento), `audience_stale`.
- Resumo diário no Telegram, dentro do `dailyDigest` existente: runs do dia com veredito,
  funil (raspados, verificados, enviáveis, importados, enrolados, enviados), custo do dia
  contra o orçamento, saldo MillionVerifier e NeverBounce, anomalias (placeholders
  rejeitados, domínios lixo, territórios pausados).

**Pronto quando** um dia sem run gera exatamente um alerta com a causa, e o resumo diário
reproduz sem SQL tudo que esta página cita.

---

## Correções menores que não merecem fase

- `requested_limit` chega como 25 no Xmail para qualquer run externa: o Xphere não
  repassa `maxResults` em `src/lib/xmail/external-run-mapping.ts`. Corrigir junto da
  fase 34.
- `outreach_event_outbox` tem zero linhas na história; a entrega Xmail→Xphere nunca foi
  exercitada. A primeira campanha ativa prova; olhar `xphere_delivered_at` na primeira hora.
- Franquias (`Supercuts` seis vezes em Boston) colidem por nome com runs anteriores. São
  legítimas; marcar `franchise` no classificador evita que virem alvo do Xkedule.

## Custos que o motor vai gerar

| Item | Base medida | Por dia a US$ 2 de orçamento |
|---|---|---|
| Apify, template `enriched` | US$ 0,0061–0,0066 por resultado | ~300 negócios |
| MillionVerifier | tarifa seeded US$ 0,0037/crédito; ~15% dos resultados têm e-mail | ~45 créditos, ~US$ 0,17 |
| Caixas nativas | zero marginal (migração `063`) | — |
| Hermes | assinatura Codex, não medida no ledger | — |

O ledger cobre Apify e passará a cobrir verificação na fase 34. Domínios e infra continuam
fora até você fornecer os números reais.
