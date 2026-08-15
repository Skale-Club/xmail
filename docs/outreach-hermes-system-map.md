# Mapa do sistema de prospecção Hermes → Xmail

> **Para que serve este doc:** reanalisar o sistema sem ter que reconstruir o entendimento do zero.
> Ele responde *onde cada decisão mora*, *quais invariantes precisam ser verdadeiras*, *como provar
> cada uma em um comando* e *o que já se sabe que está quebrado*. Os outros três docs cobrem
> ângulos diferentes: [arquitetura/contrato](outreach-hermes-architecture.md),
> [roadmap de fases](outreach-hermes-roadmap.md), [runbook operacional](outreach-hermes-runbook.md).
> O container do Hermes em si está em [`hermes/README.md`](../hermes/README.md).
>
> Última auditoria completa: **2026-08-14** (commit `9fec17f`). A seção "Achados abertos" tem data —
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

Paridade local/CI antes de qualquer push (o build **não** typecheca o client):

```bash
npm run lint && npx tsc --noEmit -p tsconfig.json && npm run build && npm test
```

## 7. Pré-requisitos de produção (checklist)

| Item | Onde | Como conferir |
|---|---|---|
| Migrations 045–049 | banco de prod | `select * from migrations` / `to_regclass('public.prospecting_runs')` |
| `APOLLO_API_KEY` | **`run_app_container()` do `.github/workflows/build-deploy.yml`** | `grep APOLLO .github/workflows/build-deploy.yml` — se não aparecer, prospecção responde 503 |
| Credencial do agente | `POST /api/outreach/agent-credentials?organizationId=…` (sessão admin) | `select id, name, scopes, revoked_at from outreach_agent_credentials` |
| `XMAIL_AGENT_KEY` no Hermes | `/opt/hermes/hermes.env` (chmod 600) | `docker exec hermes hermes mcp list` + `xmail_health` |
| Domínio de envio ≠ `MAIL_DOMAIN` | P009 | inbox de outreach precisa ser de domínio descartável; senão a ativação falha |
| `XPHERE_EVENTS_URL/API_KEY` | deploy | só afeta entrega ao Xphere, não o Hermes |

> **Armadilha nº 1 do deploy:** `deploy-hetzner.yml` é **legado** (`workflow_dispatch`). Editar
> variável de ambiente só nele não muda nada em produção. O caminho ativo é `build-deploy.yml`.

## 8. Achados abertos — auditoria de 2026-08-14

| # | Severidade | Achado | Onde |
|---|---|---|---|
| 1 | Alta | `APOLLO_API_KEY` ausente no workflow ativo → todo search responde 503 | `.github/workflows/build-deploy.yml` `run_app_container()` |
| 2 | Alta | Card do "Human gate" aprova ativação sem mostrar campanha, assunto, corpo, nº de leads ou inbox — e o approve ativa direto | `AgentOpsPage.tsx` (seção Human gate) + `outreach/approvals.ts` |
| 3 | Alta | O agente auto-certifica verificação: `customFields.email_status:'ok'` → `verified`, e o enroll só exige `verified/likely` | `email-verification-mapping.ts` + `agent-outreach.ts` `/prospects/import` |
| 4 | Média | Sem filtro para o placeholder `email_not_unlocked@…` do Apollo no import | `prospecting/apollo.ts` `normalizeEmailStatus` |
| 5 | Média | `events:read` entrega o outbox inteiro da org (inclui `email` do lead e `customFields`) ao LLM | `agent-outreach.ts` GET `/events` |
| 6 | Baixa | Nada exige `{{unsubscribeUrl}}` no corpo; só o header `List-Unsubscribe` é garantido | `outreach-sequence-state.ts` `validateSequenceForActivation` |
| 7 | Baixa | P009 só é checado na ativação, não no enroll — o agente descobre tarde | `outreach/campaigns.ts` |
| 8 | Baixa | Replay idempotente de run `failed` volta 200 com `candidates: []` (lê-se como "sem resultados") | `agent-prospecting.ts` POST `/searches` |
| 9 | Info | Rate-limit é o global de 500/15min por IP; agente sem orçamento próprio | `src/server/index.ts` |
| 10 | Info | Não há cron de outreach no lado Hermes: o loop só anda por comando no Telegram | `hermes/README.md` |
| 11 | Alta | **Não existe warm-up real** (sem pool, sem tráfego de aquecimento, sem resgate de spam) — só a rampa de teto diário. Ver §12 | `outreach-delivery-policy.ts` |

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

**Mesh interno (migration 051, 2026-08-14):** aquecimento REAL entre as caixas da plataforma.
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
`jobs/processWarmup.ts` (I/O). Operação: `scripts/warmup-mesh.ts` (`--list`, `--enable`,
`--enable-provider`, `--add-native`, `--disable`); auditoria: `scripts/warmup-audit.ts`
(estado por caixa + taxa de spam do mesh). Outlook ainda não participa (arquivar exige Graph).

**Ainda não existe:** ingestão de estado de warm-up de vendor externo (`provider_ref` segue só
comentário) e métrica de inbox placement fora do mesh. Warm-up feito por vendor é invisível ao
contador — é para isso que existem `warmup_source='vendor'` + atestação (`warmup_attested_*`).

Bloqueios independentes que impedem envio real hoje: **(1)** chave Apollo ausente em prod e
**(2)** P009 sem domínio descartável provisionado (`scripts/add-domain.ts` gera o par DKIM).

## 10. Rotina de reanálise (~15 min)

1. `git log --oneline -15 -- src/server/routes/agent-*.ts src/server/lib/prospecting hermes/` — o que mudou desde a última auditoria.
2. Rodar os 6 comandos de invariante da §6.
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
