# Mapa do sistema de prospecção Hermes → Xmail

> **Para que serve este doc:** reanalisar o sistema sem ter que reconstruir o entendimento do zero.
> Ele responde *onde cada decisão mora*, *quais invariantes precisam ser verdadeiras*, *como provar
> cada uma em um comando* e *o que já se sabe que está quebrado*. Os outros três docs cobrem
> ângulos diferentes: [arquitetura/contrato](outreach-hermes-architecture.md),
> [roadmap de fases](outreach-hermes-roadmap.md), [runbook operacional](outreach-hermes-runbook.md).
> O container do Hermes em si está em [`hermes/README.md`](../hermes/README.md).
>
> Última auditoria completa: **2026-08-15** (commit `159450d`). A seção "Achados abertos" tem data —
> se estiver velha, refaça a rotina de reanálise no fim do doc antes de confiar nela.

## 1. O que é, em uma frase

O Hermes (agente LLM em container próprio no mesmo Hetzner) fala com o Xmail por um MCP stdio
local, usando uma credencial escopada que só existe sob `/api/agent/outreach/*`. Ele **descobre,
pontua, avalia, importa e rascunha** — nunca ativa campanha e nunca envia e-mail. Todo gasto de
crédito pago e toda ativação passam por aprovação humana durável.

## 2. Modelo de autoridade

> ⚠️ **A tabela abaixo vale para o gateway do Xmail, não para o Hermes como um todo.** O Hermes
> tem 4 MCPs conectados; pelo MCP do **Xphere** (`prospects_enroll_in_campaign`) ele consegue
> **enrolar e ativar campanha**. Lá o gate é `confirmed: true` + aprovação no chat — comportamento,
> não capability. Ou seja: "o agente não ativa campanha" é verdade sobre esta API e falso sobre o
> sistema. Ver `hermes/README.md` § "Papel: orquestrador do Active Prospect System".
> O que continua valendo para os dois caminhos é o gate de ativação do §4 (G9), porque a rota
> `PUT /api/outreach/campaigns/:id` roda `validateCampaignReadyForActivation` para qualquer
> chamador — humano, service key do Xphere ou aprovação de agente.

| O Hermes PODE (via gateway do Xmail) | O Hermes NÃO PODE (via gateway do Xmail) |
|---|---|
| Ler campanhas, runs, candidatos, aprovações próprias | Ativar campanha (só pedir aprovação) |
| Buscar no Apollo (sem revelar contato, sem crédito) | Enviar e-mail por qualquer caminho |
| Pontuar/ler score ICP determinístico | Aprovar as próprias solicitações |
| Registrar parecer com evidência (advisory) | Gastar crédito Apollo sem aprovação humana casada |
| Pedir aprovação de enriquecimento (≤10 candidatos) | Ver `APOLLO_API_KEY`, `DATABASE_URL`, SMTP, service-role |
| Importar candidatos qualificados / prospects em lote (≤100) | Escapar da org à qual a credencial está presa |
| Criar rascunho de campanha + steps, matricular ≤100 leads | Entrar em `/api/outreach/*` (rota humana/Xphere) |
| Pausar campanha (direção segura) | Escolher a própria identidade/tenant |
| Ler e reconhecer eventos do outbox | — |

Escopos (`OUTREACH_AGENT_SCOPES` em `src/db/schema.ts`): `outreach:read`, `prospects:search`,
`prospects:enrich`, `prospects:assess`, `prospects:write`, `campaigns:draft`,
`campaigns:request_activation`, `campaigns:pause`, `approvals:read`, `events:read`.

## 3. Mapa de arquivos — onde cada coisa mora

| Camada | Arquivo | O que verificar aqui |
|---|---|---|
| Tools expostas ao LLM | `hermes/xmail-mcp/server.mjs` | Nenhuma tool de envio/ativação; todo input com `additionalProperties: false` e teto numérico |
| Autenticação do agente | `src/server/lib/agent-auth.ts` | Hash SHA-256, prefixo, revogação, expiração, **e o principal ainda pertencer à org** |
| Roteamento da auth | `src/server/lib/api-auth.ts` | `stripAgentHeaders` antes de tudo; agente só entra em `/api/agent/outreach` |
| Gateway do agente | `src/server/routes/agent-outreach.ts` | health, campanhas, import livre, draft, enroll-draft, pause, events/ack |
| Prospecção | `src/server/routes/agent-prospecting.ts` | search → candidatos → enrich aprovado → import |
| Aprovações (lado agente) | `src/server/routes/agent-approvals.ts` | Pede; nunca decide |
| Aprovações (lado humano) | `src/server/routes/outreach/approvals.ts` | `requireInteractiveAdmin` bloqueia service-principal; approve de `campaign_activation` **ativa na hora** |
| Provider Apollo | `src/server/lib/prospecting/apollo.ts` | `reveal_personal_emails=false`, `reveal_phone_number=false`, teto de 9 créditos/pessoa |
| Score ICP | `src/server/lib/prospecting/scoring.ts` | Determinístico, pesos só contam quando o critério existe |
| Parecer do LLM | `src/server/lib/prospecting/assessment.ts` | `qualified` exige confiança ≥60 + evidência + zero risk-flag bloqueante |
| Auditoria | `src/server/lib/agent-audit.ts` → `outreach_agent_audit_log` | Toda ação e todo `scope.denied` |
| Eventos | `src/server/lib/xphere-events.ts` → `outreach_event_outbox` | Dedup por org+chave; Hermes e Xphere têm cursores independentes |
| Gate de envio | `src/server/lib/outreach-delivery-policy.ts` | Org habilitada, campanha ativa, inbox verificada, unsub, supressão, janela, limite diário, warmup, espaçamento |
| Gate de ativação | `src/server/routes/outreach/campaigns.ts` → `validateCampaignReadyForActivation` | Sequência válida, leads com inbox, **P009 domínio protegido** |
| Workers | `src/server/jobs/index.ts` | Cadências e locks (ver §5) |
| UI do operador | `src/pages/outreach/AgentOpsPage.tsx` | Fila de aprovação, runs, evidência dos candidatos |
| Métricas | `src/server/routes/admin/*` → `GET /api/admin/outreach/health`, campo `agentOps` | `stuckExecutingApprovals`, `failedXphereDeliveries`, `failedProspectingRuns24h` |

Migrations relevantes: `045_outreach_agent_gateway`, `046_prospecting_pipeline`,
`047_outreach_action_approvals`, `048_deliverability_guardrails`, `049_prospect_ai_assessments`.

## 4. Fluxo end-to-end e os gates

```
xmail_search_prospects ──G1─→ prospecting_runs + prospect_candidates (score ICP, SEM e-mail)
        │
        ├─ xmail_assess_prospect_candidate ──G2─→ prospect_ai_assessments (advisory)
        │
        └─ xmail_request_enrichment_approval ──G3─→ outreach_action_approvals (status=requested)
                    │
              [HUMANO aprova na UI] ──G4─→ status=approved (TTL 24h)
                    │
        xmail_execute_approved_enrichment ──G5─→ Apollo bulk_match (claim transacional, 1x só)
                    │
        xmail_import_prospect_candidates ──G6─→ leads
                    │
        xmail_create_campaign_draft + xmail_enroll_campaign_draft ──G7─→ campaign(draft) + campaign_leads
                    │
        xmail_request_campaign_activation ──G8─→ approval(campaign_activation)
                    │
              [HUMANO aprova] ──G9─→ campanha ATIVA → cron dispara → G10 delivery policy → envio
```

| Gate | Onde | O que garante |
|---|---|---|
| G1 | `agent-prospecting.ts` POST `/searches` | Idempotente por (org, provider, key); search não consome crédito nem revela contato |
| G2 | `assessment.ts` | Parecer não pode alegar `qualified` sem evidência/confiança/sem risk-flag |
| G3 | `agent-approvals.ts` | Máx. 10 candidatos; teto = candidatos × 9 créditos; conjunto **imutável** |
| G4 | `outreach/approvals.ts` `requireInteractiveAdmin` | Sessão humana interativa + role admin; agente e service-key barrados |
| G5 | `agent-prospecting.ts` `/enrich` | Claim transacional approved→executing + run→enriching; falha = run e approval terminais (nunca retry cego) |
| G6 | `/searches/:id/import` | Só candidato com e-mail, status aceito e score ≥ threshold |
| G7 | `/campaigns/:id/enroll-draft` | Só draft, inbox verificada da org, leads verified/likely e não descadastrados, ≤100 |
| G8 | `agent-approvals.ts` | Só de `draft`/`paused`; idempotente |
| G9 | `outreach/approvals.ts` + `PUT /campaigns/:id` | `validateCampaignReadyForActivation` (sequência, leads com inbox, **P009**, **warm-up completo**) + ativação atômica. Único gate comum aos caminhos humano, Xphere e agente |
| G10 | `outreach-delivery-policy.ts` | Última rede antes do envio, por destinatário |

## 5. Workers (todos in-process, `src/server/jobs/index.ts`)

| Cadência | Job | Lock |
|---|---|---|
| 1 min | `processQueue`, `processInboxCommands`, `deliverOutreachEvents` | advisory por job |
| 5 min | `processOutreachSequences`, `materializeUnifiedInbox`, `expireOutreachApprovals`, `reconcileOutreachEvents` | 4014 (outreach) etc. |
| 10 min | `processFollowUps`, `enforceDeliverabilityGuardrails` | advisory |
| 15/30 min | `processReplies` (4016) / `processBounces` (4015) | advisory |
| diário | `resetDailyLimits` 00:00 UTC, `dailyOutreachDigest` 09:00 UTC, limpezas 03:00/03:30 | — |

O reconciliador do outbox cobre a janela de crash (lookback padrão 6h,
`OUTREACH_EVENT_RECONCILE_LOOKBACK_HOURS`).

## 6. Invariantes — e como provar cada uma

Rode do root do repo. Qualquer resultado diferente do esperado é regressão de segurança.

```bash
# 1. Nenhuma tool de envio/ativação chega ao LLM (esperado: só request_activation e pause)
grep -n "name: 'xmail_" hermes/xmail-mcp/server.mjs
```

```bash
# 2. Toda rota do agente exige escopo (esperado: nº de requireScope >= nº de router.get/post)
grep -c "requireScope" src/server/routes/agent-*.ts
```

```bash
# 3. Aprovação humana não aceita principal de máquina (esperado: bloqueio por SERVICE_PRINCIPAL_HEADER + role admin)
grep -n -A 12 "requireInteractiveAdmin" src/server/routes/outreach/approvals.ts
```

```bash
# 4. Apollo nunca revela e-mail pessoal/telefone (esperado: ambos 'false')
grep -n "reveal_" src/server/lib/prospecting/apollo.ts
```

```bash
# 5. P009 continua barrando o domínio transacional na ativação
grep -n "protected_sending_domain" src/server/routes/outreach/campaigns.ts
```

```bash
# 6. Contrato do MCP e gateway sob teste (esperado: verde)
npx vitest run src/server/lib/__tests__/hermes-mcp-contract.test.ts src/server/lib/__tests__/outreach-agent-gateway.db.test.ts
```

```bash
# 7. Nenhuma escrita de jsonb sem o cast via text (esperado: nenhuma saída). Ver §13.
grep -rnE "(toAddresses|ccAddresses|bccAddresses|headers|attachments|customFields):\s*[a-zA-Z]" \
  src/server --include="*.ts" | grep -v jsonbParam | grep -viE "test|interface|type |\?\?"
```

Paridade local/CI antes de qualquer push (o build **não** typecheca o client):

```bash
npm run lint && npx tsc --noEmit -p tsconfig.json && npm run build && npm test
```

## 7. Pré-requisitos de produção (checklist)

| Item | Onde | Como conferir |
|---|---|---|
| Migrations 045–058 | banco de prod | `select * from supabase_migrations.schema_migrations` / `to_regclass('public.warmup_messages')` |
| `APOLLO_API_KEY` | **`run_app_container()` do `.github/workflows/build-deploy.yml`** *e* o secret existir | `gh secret list \| grep APOLLO` — **o grep no workflow NÃO basta**: ele confirma a fiação, e um `${{ secrets.X }}` inexistente resolve para string vazia sem erro. Foi assim que este item passou por resolvido em 2026-08-15 estando quebrado |
| Credencial do agente | `POST /api/outreach/agent-credentials?organizationId=…` (sessão admin) | `select id, name, scopes, revoked_at from outreach_agent_credentials` |
| `XMAIL_AGENT_KEY` no Hermes | `/opt/hermes/hermes.env` (chmod 600) | `docker exec hermes hermes mcp list` + `xmail_health` |
| Domínio de envio ≠ `MAIL_DOMAIN` | P009 | inbox de outreach precisa ser de domínio descartável; senão a ativação falha |
| `XPHERE_EVENTS_URL/API_KEY` | deploy | só afeta entrega ao Xphere, não o Hermes |

> **Armadilha nº 1 do deploy:** `deploy-hetzner.yml` é **legado** (`workflow_dispatch`). Editar
> variável de ambiente só nele não muda nada em produção. O caminho ativo é `build-deploy.yml`.

## 8. Achados abertos — auditoria de 2026-08-15

| # | Severidade | Achado | Onde |
|---|---|---|---|
| 1 | Alta | `APOLLO_API_KEY` **não existe nos secrets do repo**. O workflow referencia `${{ secrets.APOLLO_API_KEY }}`, que resolve para string vazia, e `apollo.ts` lança `APOLLO_API_KEY is required` → search responde 503. Só afeta o caminho Apollo; o xcraper não usa | GitHub Secrets |
| 1b | Alta | `XPHERE_EVENTS_API_KEY` também ausente (só `XPHERE_EVENTS_URL` existe). Como os dois são obrigatórios em par, a entrega de eventos ao Xphere está desligada | GitHub Secrets |
| 2 | Alta | Card do "Human gate" aprova ativação sem mostrar campanha, assunto, corpo, nº de leads ou inbox — e o approve ativa direto | `AgentOpsPage.tsx` (seção Human gate) + `outreach/approvals.ts` |
| 3 | Alta | O agente auto-certifica verificação: `customFields.email_status:'ok'` → `verified`, e o enroll só exige `verified/likely` | `email-verification-mapping.ts` + `agent-outreach.ts` `/prospects/import` |
| 4 | Média | Sem filtro para o placeholder `email_not_unlocked@…` do Apollo no import | `prospecting/apollo.ts` `normalizeEmailStatus` |
| 5 | Média | `events:read` entrega o outbox inteiro da org (inclui `email` do lead e `customFields`) ao LLM | `agent-outreach.ts` GET `/events` |
| 6 | Baixa | Nada exige `{{unsubscribeUrl}}` no corpo; só o header `List-Unsubscribe` é garantido | `outreach-sequence-state.ts` `validateSequenceForActivation` |
| 7 | Baixa | P009 só é checado na ativação, não no enroll — o agente descobre tarde | `outreach/campaigns.ts` |
| 8 | Baixa | Replay idempotente de run `failed` volta 200 com `candidates: []` (lê-se como "sem resultados") | `agent-prospecting.ts` POST `/searches` |
| 9 | Info | Rate-limit é o global de 500/15min por IP; agente sem orçamento próprio | `src/server/index.ts` |
| 10 | Info | Não há cron de outreach no lado Hermes: o loop só anda por comando no Telegram | `hermes/README.md` |
| 11 | ~~Alta~~ | ~~Não existe warm-up real~~ — **resolvido** pela migration `058_warmup_engine` + `jobs/processWarmup.ts`. Ver §9 | — |
| 12 | ~~Média~~ | ~~jsonb duplo-codificado em produção~~ — **resolvido** pela migration `059`. Verificado: 0 linhas escalares no banco inteiro | — |
| 13 | Média | O corpo do step 1 da campanha piloto tem `{{websiteInsight}}` num parágrafo próprio, e o Xphere **não envia `websiteInsights`** no push — o e-mail sai com um buraco onde estaria a personalização | lado Xphere |
| 14 | Média | `prospects_list` do MCP do Xphere **não devolve** `web_presence_type`, `booking_platform`, `location` nem `phone`. A segmentação comercial que decide entre cold email e proposta de Website/Xkedule não pode ser produzida pelo agente | lado Xphere — ver [contrato](xphere-xmail-contract.md) |
| 15 | Média | O Xphere não envia `enrichedCount` nem `coverage` em `/external-runs`. O Xmail já aceita ambos; enquanto não chegarem, `enriched_count` fica 0 e o alerta `enriched_count_never_populated` permanece firing | lado Xphere |
| 16 | Info | `hermes -z` (CLI) **não usa a cadeia de fallback** que o gateway usa: filtra a credencial em cooldown e reporta `No Codex credentials stored`, que não é o rate-limit em que a cadeia dispara. Workaround testado: `--provider opencode-go -m kimi-k3` | `hermes/README.md` gotcha 7 |
| 17 | Info | Rampa de warm-up em 0/14 nas 7 caixas em 2026-08-15 (1/14 em 2026-08-16 — avançou). O mesh envia; o contador avança na virada UTC. Ativação de campanha destravada em ~14 dias, ou com `OUTREACH_ALLOW_UNWARMED_ACTIVATION=true` | tempo, não bug |
| 18 | ~~Alta~~ | ~~Groom cego na direção native→Gmail~~ — **resolvido em 2026-08-16**. O relay Brevo das caixas nativas reescreve o `Message-ID` (`<uuid@smtp-relay.sendinblue.com>`) e o groom só procurava pelo nosso `w.…@dominio`: 7/7 mensagens native→Gmail presas em `sent`, as de `info@xkedule.com` 100% na pasta Spam sem resgate, e o audit dizendo "spam 0%". Agora `lib/warmup/detect.ts` casa também por envelope (remetente + assunto exato + janela); `groomed` no log conta só o que foi localizado e há `undetected`; o audit mostra "aguardando detecção". Ver §9 | `jobs/processWarmup.ts`, `lib/warmup/detect.ts` |
| 19 | ~~Média~~ | ~~`runWithLock` com lock de sessão através do pooler transaction-mode~~ — **resolvido em 2026-08-16**: `pg_try_advisory_xact_lock` dentro de `BEGIN…COMMIT` na conexão reservada (o pooler pina o backend durante a transação). Antes, ~50% dos ticks de **todos** os jobs logavam `already running … skipping` (851 em 6h) sem nada rodando. Validado contra o pooler de prod com chave descartável: lock visto ocupado durante o corpo, 20/20 livre após o COMMIT | `src/server/lib/cron-lock.ts` |

### Correções aplicadas em 2026-08-15

O mesh de warm-up nunca havia enviado uma única mensagem desde que subiu. Três bugs **em série**, cada
um escondido atrás do anterior — vale ler como exemplo de por que "job silencioso" não é "job ocioso":

1. **Corte de data em template `sql` cru** (`processWarmup.ts`). Um fragmento `sql` não aplica o
   `mapToDriverValue` da coluna, então o `Date` chegava puro ao postgres-js e estourava
   `ERR_INVALID_ARG_TYPE` no Bind — no PRIMEIRO remetente, matando a fase SEND inteira. Corrigido com
   o operador tipado `gte()`, que a fase GROOM já usava logo abaixo.
2. **O mesmo `sql` cru na volta.** `sql<Date | null>` sobre `max(sent_at)` é uma anotação que o runtime
   não cumpre: vem string, e `dueForNextSend` chamava `.getTime()`. Ficou escondido porque com a tabela
   vazia `max()` dá NULL e o caminho quente nunca era exercido — quebrou no primeiro tick com linhas.
3. **Credenciais SMTP cifradas com outra chave.** As 5 caixas de `tryskaleclub.com` foram gravadas por
   um servidor de desenvolvimento local apontado para o `DATABASE_URL` de produção, com a chave do
   `.env` local. Produção não decifrava. Re-cifradas para a chave de produção; `getEncryptionKey()`
   perdeu o fallback silencioso para `JWT_SECRET` (era ele que permitia dois servidores cifrarem
   diferente sem reclamar) e um payload de chave errada agora levanta `CredentialKeyMismatchError`.

Também nesta data:

- **`jsonbParam` em todos os writes de jsonb** dos caminhos de lead e de mail (ver §13), e migration
  `059` normalizando o que já estava gravado. Verificado: 0 linhas escalares restantes.
- **Atribuição de outcome consertada.** O Xmail procurava `source_run_id`, o Xphere carimba
  `xcraper_run_id` — chaves diferentes, então TODO run de xcraper ficava com `outcome_*` zerado
  para sempre. `lib/prospecting/source-run-id.ts` passou a tolerar os apelidos e a extrair o id do
  próprio `source`; migration `060` carimbou o que existia. O join agora casa.
- **Detector de silêncio** (`lib/outreach-silence.ts`, exposto no health endpoint). Nasceu da
  constatação de que **nenhum** dos sete defeitos deste dia teria disparado um alerta existente:
  todos os alertas eram da forma "algo deu erro", e estes eram "não produziu nada", com zero se
  passando por valor legítimo.
- **Guarda dev→prod** (`lib/remote-db-guard.ts`): o servidor recusa subir fora de produção contra
  banco remoto, porque foi assim que as credenciais entraram cifradas com a chave errada.
- **Contrato Xphere↔Xmail** versionado em [`xphere-xmail-contract.md`](xphere-xmail-contract.md),
  com as quatro divergências encontradas — todas por acidente, todas silenciosas.
- **`{{city}}`** criada; sua ausência era o motivo de a campanha piloto ter "Hudson" fixo no corpo.

### Correções aplicadas em 2026-08-14

- `resetDailyLimits` passou a avançar `warmup_current_day` **só em dia com envio real** (era
  calendário: a caixa graduava sozinha sem ter aquecido nada).
- `getEffectiveDailySendLimit` virou wrapper de `effectiveDailyLimit` — acabou a fórmula duplicada
  que fazia a UI e o dispatcher poderem discordar. Coberto por `__tests__/warmup-ramp.test.ts`.
- Novo issue de ativação `sending_inbox_not_warmed`: campanha não ativa com caixa de warm-up
  incompleto. Escape hatch de ops: `OUTREACH_ALLOW_UNWARMED_ACTIVATION=true`.

> **Consequência imediata:** com o contador agora baseado em envio, toda caixa que nunca enviou
> está no dia 0 → ativação bloqueada até existir warm-up de verdade (ou até o override). Isso é
> intencional: torna visível o estado que antes passava silencioso.

## 9. Warm-up: o que existe e o que falta

**Existe:** rampa de teto diário. `effectiveDailyLimit()` sai de `min(5, dailySendLimit)` e sobe
linearmente até o limite cheio ao longo de `warmup_days` (default 14 na criação de inbox, 21 nas
settings da org). É avaliada por destinatário em toda origem — `campaign`, `manual`, `agentic`,
`unified_inbox` — e devolve `warmup_limit_exhausted`, que faz o processador **adiar**, não falhar.

**Mesh interno (migration 058, 2026-08-14):** aquecimento REAL entre as caixas da plataforma.
*(Nasceu como `051` e foi renumerado por colisão de prefixo — ver o aviso no `CLAUDE.md`. Este doc
carregou o número velho por um dia; se você leu `051` aqui em algum fork, é o mesmo arquivo.)*
Participação é campo do cadastro normal de inbox (`warmup_source = 'internal'`; `warmup_only`
proíbe a caixa de campanha). O job `processWarmup.ts` (cron 10min, advisory lock) roda duas fases:
**SEND** — volume pequeno e crescente (2→20/dia na rampa, 8/dia de manutenção depois), pares
priorizando outro domínio e outro provedor, conteúdo combinatório determinístico sem custo de LLM,
sem links, sem header identificável (o Message-ID é a chave de correlação); **GROOM** — do lado
do destinatário: caiu em Spam → resgata para a Inbox; na Inbox → marca lida, responde ~35% em
thread e **arquiva** (IMAP move para Archive/All Mail; nativa move de pasta no banco) — o inbox
dos participantes não acumula ruído. Envios do mesh usam `warmup_sent_today` (não consomem cota
de campanha) e contam como dia de envio real na rampa via `resetDailyLimits`.

Módulos: `lib/warmup/plan.ts` (alvos/pares/jitter, puro), `lib/warmup/content.ts` (texto, puro),
`lib/warmup/detect.ts` (localizar a cópia entregue, puro), `jobs/processWarmup.ts` (I/O).

**Detecção tem duas chaves, e a segunda não é opcional.** As caixas nativas enviam pelo relay
Brevo, que **reescreve o `Message-ID`** (`<uuid@smtp-relay.sendinblue.com>`); a busca por header só
funciona quando o caminho preserva o id (Gmail→nativa preserva). Sem a chave de envelope
(remetente + assunto exato + janela −30min/+24h em torno do `sent_at`), toda a direção
native→Gmail fica invisível — e invisível é pior que ausente, porque o que cai em Spam não é
resgatado e o audit reporta "spam 0%". Foi o estado real em 2026-08-16 (achado #18). A chave de
envelope é segura porque o SEND nunca repete um par no mesmo dia e "Re: agenda" não é igual a
"agenda". `In-Reply-To` da resposta aponta para o NOSSO id (é o que a pasta Enviados do remetente
conhece); `References` lista o nosso e o entregue.

Leia o log `outreach.warmup.tick` assim: `groomed` = mensagens LOCALIZADAS e tratadas no tick;
`undetected` = examinadas e não achadas em nenhuma pasta (viram `failed/missing` após 3 dias).

Operação: `scripts/warmup-mesh.ts` (`--list`, `--enable`, `--enable-provider`, `--add-native`,
`--disable`); auditoria: `scripts/warmup-audit.ts` (estado por caixa, taxa de spam do mesh e
"aguardando detecção"). Outlook ainda não participa (arquivar exige Graph).

**Ainda não existe:** ingestão de estado de warm-up de vendor externo (`provider_ref` segue só
comentário) e métrica de inbox placement fora do mesh. Warm-up feito por vendor é invisível ao
contador — é para isso que existem `warmup_source='vendor'` + atestação (`warmup_attested_*`).

**Estado verificado em 2026-08-15:** o mesh envia. As 7 caixas (`info@skale.club`,
`info@xkedule.com` e as 5 de `tryskaleclub.com`) registraram envio real no mesmo tick.
**2026-08-16:** 24 envios/24h, rampa 1/14 em todas; Gmail→nativa 15/15 arquivadas (4 respondidas);
native→Gmail 0/7 detectadas até a correção do achado #18 (a de `info@xkedule.com` estava caindo
em Spam no Gmail — a partir do deploy o groom passa a resgatar).

**Mesh ampliado em 2026-08-16 — 19 caixas em 7 domínios.** Antes eram 7 caixas em 2 domínios de
fato distintos, e o pareador (que prioriza outro domínio *e* outro provedor) só conseguia formar
pares Gmail↔nativa: as 5 do `tryskaleclub.com` nunca se aqueciam entre si. Foram provisionados
`fluenverse.com`, `xareable.com`, `xphere.app` e `xtimator.com` (org + DKIM + DNS completo) com
duas seeds `warmup_only` cada (`contato@`, `agenda@`), mais quatro em `skale.club`/`xkedule.com`.
As caixas `info@` de cada domínio são o **inbox principal da empresa** e ficam FORA do mesh
(`warmup_source='none'`) — gente lê essas caixas, e tráfego sintético de aquecimento ali é ruído;
`info@skale.club` e `info@xkedule.com` foram retiradas do mesh nessa mesma data. Provisionamento:
`scripts/add-domain.ts` (org+DKIM+checklist DNS) e `scripts/warmup-seed-native.ts`
(`--no-mesh` para a caixa principal, sem flag para seed).

O super admin não precisa de vínculo por org para ler essas caixas: `checkUserMailboxAccess`
(`routes/mail/mailboxes.ts`) dá a `users.is_admin` acesso a qualquer mailbox, e a listagem devolve
todas. `skale.club@gmail.com` é admin e dono de todas as orgs.

**Oito domínios na plataforma desde 2026-08-16**, todos verificados nos seis checks (verificação,
SPF, DKIM, DMARC, MX, return-path): `skale.club`, `xkedule.com`, `endenemy.com`, `fluenverse.com`,
`skleanings.com`, `stuscle.com`, `xareable.com`, `xphere.app`, `xtimator.com`. Os três primeiros da
lista de migração (`endenemy`, `skleanings`, `stuscle`) tinham e-mail na Hostinger e foram cortados
para cá — MX, SPF e DKIM da Hostinger removidos. Inbound conferido por handshake SMTP: o MX aceita
`info@` de cada domínio e devolve `550 User unknown` para endereço inexistente.

### Saída de e-mail: por que ainda passa por relay

`native-send.ts`/`smtp-server.ts` usam relay quando `SMTP_HOST`+`SMTP_USER` existem, e tentam
ENTREGA DIRETA quando não existem. Direta é melhor (assina com a chave DKIM do próprio domínio →
DMARC alinha sem terceiro), mas em 2026-08-16 ela é impossível neste host: **a porta 25 de saída
da Hetzner está bloqueada** — `gmail-smtp-in.l.google.com:25` e `mx1.hostinger.com:25` dão timeout
de dentro do container, enquanto `smtp-relay.brevo.com:587` responde `220`. Além disso o PTR do IP
é o genérico `static.250.197.13.49.clients.your-server.de`, e não `mx.skale.club`.

Portanto **esvaziar `SMTP_HOST`/`SMTP_USER` hoje derruba todo o envio, em silêncio**. Para migrar:
(1) pedir à Hetzner a liberação da porta 25 de saída; (2) apontar o rDNS do IP para `mx.skale.club`;
(3) confirmar os dois com os testes do `.env.example`; só então limpar as variáveis. O alerta de
silêncio (`lib/outreach-silence.ts`) é a rede que pega uma queda total de envio.

Os dois passos exigem o console da Hetzner, que roda o anti-bot **Heray** — ele trava em
"Verifying…" num navegador automatizado, e contornar detecção de bot está fora de questão. Ou o
operador faz à mão, ou cria um API token do Hetzner Cloud e o rDNS vira uma chamada de API
(`POST /v1/servers/{id}/actions/change_dns_ptr`); a liberação da porta 25 é ticket de suporte e não
tem API.

### SPF: o include de terceiro foi removido em 2026-08-16

`skale.club` e `xkedule.com` publicavam `include:spf.skaleclub.com`. Esse host é **CNAME para
`easthamptonhigh.org`**, domínio de terceiro cujo SPF autoriza `api.lizardlink.com`,
`api.superherosunman.com` e outros — ou seja, esses domínios delegavam autorização de envio a
desconhecidos. Agora publicam `v=spf1 mx include:spf.brevo.com …` (o `include:mailgun.org` do
`skale.club` foi mantido: os subdomínios `mail.`/`m.`/`send.` ainda usam Mailgun). O
`_dmarc.xkedule.com` estava em `p=quarantine` sem DKIM alinhado — tudo que saía do domínio ia para
Spam por política, não por reputação; baixado para `p=none` até a saída direta alinhar o DKIM.
Só então subir de volta para `quarantine` e depois `reject`.

Cuidado ao ler a zona do `skale.club`: existem 4 TXT de SPF e 3 de DMARC, mas em SUBDOMÍNIOS
(`mail.`, `m.`, `send.`) — não são duplicatas no apex e não causam `permerror`.

O que bloqueia **campanha** hoje é só a rampa: `warmup_current_day` avança um dia por dia COM envio
real, então uma caixa nova leva `warmup_days` dias até a ativação passar — override de ops em
`OUTREACH_ALLOW_UNWARMED_ACTIVATION=true`. Note a distinção que confunde: a rampa bloqueia o **G9**
(ativação) mas no **G10** só limita volume — `effectiveDailyLimit` parte de `min(5, limite)` e nunca
devolve zero, então envio individual/transacional funciona desde o dia 0.

P009 **não** é bloqueio aqui: o domínio protegido é o `MAIL_DOMAIN` (`skale.club`), e as caixas de
outreach vivem em `tryskaleclub.com` e `xkedule.com`. Só `info@skale.club` seria barrada em campanha.

## 13. A armadilha do jsonb — leia antes de escrever em qualquer coluna jsonb

**Toda escrita em coluna `jsonb` tem que passar por `jsonbParam()` (`lib/jsonb.ts`), ou por
`::text::jsonb` quando for SQL cru.** Nunca `::jsonb` direto sobre um valor já serializado, nunca o
binding padrão do Drizzle.

Motivo: o Supavisor infere o parâmetro como jsonb antes de o postgres-js enviá-lo. O valor já foi
passado por `JSON.stringify` (pelo Drizzle ou à mão), então ele é codificado uma **segunda** vez e a
coluna guarda uma STRING JSON. O cast intermediário via `text` mantém o parâmetro escalar e deixa o
PostgreSQL fazer o único parse.

O que torna isso traiçoeiro é a simetria: **o ORM desfaz na leitura**, então a aplicação funciona e
nada parece quebrado. Quem enxerga a diferença é o SQL do servidor. Numa linha duplo-codificada:

| Operação | Resultado |
|---|---|
| `jsonb_exists(col, 'qualquer_chave')` | sempre `false` |
| `col->>'chave'` | sempre `null` |
| `col \|\| '{}'::jsonb` | devolve **array**, não objeto |
| `jsonb_object_keys(col)` | erro: *cannot call on a scalar* |

Consequência concreta encontrada em 2026-08-15: o merge de re-import em
`routes/outreach/leads.ts` usa `||` e protege a atribuição de primeiro toque com
`jsonb_exists(custom_fields, 'source_run_id')` — essa guarda **nunca teria disparado**, deixando um
run posterior roubar silenciosamente a atribuição (e os `outcome_*`) do run que achou o lead.

Diagnóstico de uma linha, que vale rodar depois de qualquer feature nova que escreva jsonb:

```sql
SELECT jsonb_typeof(custom_fields), count(*) FROM leads GROUP BY 1;
-- 'string' em qualquer coluna jsonb = duplo-codificado. Esperado: object/array.
```

Normalização (idempotente, e segura porque o ORM lê as duas formas):

```sql
UPDATE <tabela> SET <coluna> = (<coluna> #>> '{}')::jsonb
WHERE jsonb_typeof(<coluna>) = 'string';
```

## 10. Rotina de reanálise (~15 min)

1. `git log --oneline -15 -- src/server/routes/agent-*.ts src/server/lib/prospecting hermes/` — o que mudou desde a última auditoria.
2. Rodar os 7 comandos de invariante da §6.
3. `npx vitest run src/server/lib/__tests__/hermes-mcp-contract.test.ts` — o contrato de capacidade.
4. Conferir a §7 (pré-requisitos) contra o estado real de prod.
5. `GET /api/admin/outreach/health` → campo `agentOps`; alertar se `stuckExecutingApprovals > 0`.
6. Em prod: `docker logs xmail --since 24h 2>&1 | grep -E 'agent-auth|prospecting|outreach\.(approvals|events)'`.
7. Atualizar a tabela §8 (achado resolvido sai; achado novo entra com data).

## 11. Decisões de design que parecem bug e não são

- **Não existe tool de ativação nem de envio.** É deliberado, e há teste de contrato garantindo.
- **Aprovação de enriquecimento falha "para o lado terminal":** provider ambíguo → run e approval
  viram `failed` e ninguém retenta. Reprocessar exige run + aprovação novos. Nunca resetar um
  approval `executing` para `approved`.
- **RLS não protege nada aqui.** A role do `DATABASE_URL` fura RLS; o isolamento é o
  `principal.organizationId` em cada `where`. Toda query nova em rota de agente precisa dele.
- **Eventos do agente não vão ao Xphere:** `publishOutreachEvent` usa `deliverToXphere: false` por
  padrão; só `sendXphereOutreachEvent` marca `true`.
- **O score ICP sem critério devolve 50/`tier c`** — é baseline neutro, não bug.

## 12. Manutenção deste doc

Atualize quando mudar: as tools do MCP, a lista de escopos, os gates G1–G10, as cadências de job,
ou quando um achado da §8 for resolvido. Se você acabou de reauditar, troque a data no topo — é
ela que diz ao próximo leitor se pode confiar na §8 sem refazer o trabalho.

**Um achado só sai da §8 com prova que fecha a pergunta inteira.** Em 2026-08-15 o achado nº 1 foi
dado por resolvido porque `grep APOLLO .github/workflows/build-deploy.yml` casava — mas o secret não
existia, e `${{ secrets.X }}` inexistente vira string vazia sem erro nenhum. O comando provava a
fiação e foi lido como prova da configuração. Quando escrever um comando de prova aqui, pergunte o
que ele NÃO cobre.
