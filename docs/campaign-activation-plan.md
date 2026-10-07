# Ligar a campanha — plano de 2026-09-30

> **Corrigido no mesmo dia.** A primeira versão deste plano assumiu que a campanha sairia das
> `info@` e montou a fase 44 inteira sobre isso. Está errado: a campanha sai **somente** das
> contas Google da Icemail (`tryskaleclub.com`), as `info@` são caixas de trabalho que não
> participam nem do warm-up nem da campanha, e o warm-up roda em caixas inúteis criadas para
> isso. As regras estão no `CLAUDE.md`, seção *Regras do processo de prospecção*. As fases 42,
> 44 e 45 abaixo já foram reescritas com a premissa certa.

> Escrito depois de o Hermes mandar uma lista de nove pendências para ativar a campanha. A
> lista está certa na forma e errada em três fatos, porque o Hermes está sem acesso ao Xphere
> desde 30/08 e respondeu de memória. Este plano parte do que foi **medido** em 30/09, não do
> que foi dito. Fases 41–46, continuando a numeração de
> [`prospecting-engine-plan.md`](prospecting-engine-plan.md) e de
> [`outbound-authentication-audit.md`](outbound-authentication-audit.md).

## O que o Hermes disse, e o que é

| Hermes disse | Medido em 30/09 |
|---|---|
| "O Xphere MCP está desconectado" | **Verdade.** Caiu em **30/08 02:50 UTC**, tentou reconectar 5 vezes em 24 segundos, desistiu e nunca mais tentou. O token que ele manda (`xph_…`) **funciona** — `initialize` responde HTTP 200 hoje. A conexão está morta por decisão do cliente, não por credencial. |
| "Temos 397 prospects" | **1044** em `prospect_rows`. 219 com e-mail, 98 verificados (69 ok, 9 catch-all, 18 inválidos, 2 desconhecidos), **121 com e-mail nunca verificados**, 5 já contatados, 1 descadastrado. |
| "O endereço postal do CAN-SPAM já foi incluído" | **Falso.** Os três passos assinam `Vanildo de Souza Jr / Skale Club LLC / skale.club` — sem endereço, exatamente como você decidiu em 12/09. `{{unsubscribeUrl}}` está nos três, que é o único portão duro de ativação. |
| "Monitor automático de créditos pausado" | **Verdade — eu errei ao contestar.** É o job `email-verification-credits` (`0a7d26ed4d30`): não tem prompt porque roda um script (`verification-credits.py`), não o agente. Rodou 16 vezes sem erro e foi pausado em 21/08 sem motivo registrado. Religado em 30/09. Saldo lido na hora: **MillionVerifier 169, NeverBounce 0** — abaixo do limiar de 500, então ele vai avisar todo dia às 9h ET até recarregar. |
| "Precisamos de uma conta verificada, validar SPF/DKIM/DMARC" | As caixas de envio são as **5 contas Google da Icemail** (`tryskaleclub.com`): verificadas, **dia 14 de 14** de warm-up, 15/dia cada, envio por `smtp.gmail.com`. `tryskaleclub.com` tem SPF do Google, DKIM `google._domainkey` e DMARC `p=quarantine`. Os relatórios DMARC da fase 1 medem as caixas **nativas** (warm-up), não estas — ver fase 42. |

O que o Hermes não sabia, porque não tinha como saber:

- O spam do warm-up para o Google está em **0,0% há doze dias** (18/09 → 30/09, 100 mensagens/dia). O incidente de 09–11/09 (19%, 29%, 24%) acabou por volta de 15/09. **A causa continua não atribuída** — o defeito da fase 42 esteve presente antes, durante e depois, então ele não explica o pico sozinho.
- O motor diário andou: 27 runs, 18 territórios feitos, 1050 negócios descobertos, 1040 importados no Xphere. **Zero verificados por ele** — a verificação continua sendo uma ferramenta que só o Hermes chama, e o Hermes está mudo desde agosto. É por isso que 121 e-mails estão parados sem verificação.
- A fila de territórios tem 12 cidades, a um por dia. **Acaba em 12 dias** (Lawrence → Pittsfield). Depois disso o motor para por falta de entrada, que é decisão de gente.
- As nove `info@` continuam no **dia 0** de warm-up, **0 mensagens em 30 dias**, teto de 50/dia. Nada mudou desde 12/09 porque a decisão da fase 4 nunca foi tomada.

---

## Fase 41 — Reconectar o Hermes e impedir que ele morra calado de novo

**Evidência.** `docker logs -t hermes`: `MCP server 'xphere' connection lost (attempt 1/5)` em
30/08 02:50:06, `failed after 5 reconnection attempts, giving up` em 02:50:30. Desde então,
todo `Tool mcp_xphere_*` devolve `MCP server 'xphere' is not connected`. O container está de
pé desde 14/08 sem reiniciar. O token em `/opt/data/config.yaml` responde 200 no
`initialize` hoje. `https://skale.club/mcp` (`skaleclub`) está no mesmo estado.

**O que fazer.**

1. `docker compose restart hermes` em `/opt/hermes`. Confirmar nos logs que os dois MCPs
   (`xphere`, `skaleclub`) conectam, e que `mcp_xphere_prospects_list` devolve dados.
2. **Reconexão que não desiste.** Cinco tentativas em 24 segundos e desistir para sempre é
   uma política de cliente que transforma um soluço de rede num mês de cegueira. Ver se o
   Hermes expõe backoff/reconexão infinita para `mcp_servers` (o `config.yaml` tem
   `timeout` e `connect_timeout`; procurar `reconnect`/`retry`). Se não expõe, um cron no
   **host** (não dentro do Hermes) que lê o log, detecta `failed after 5 reconnection
   attempts` sem um `connected` posterior, e reinicia o container. O vigia não pode morar
   dentro do vigiado.
3. **O Hermes não pode responder número quando a ferramenta falhou.** "397 prospects" e
   "endereço postal incluído" saíram de memória, com a ferramenta devolvendo erro. Uma
   regra no system prompt dele: *se a chamada de ferramenta falhou, diga que falhou e não
   estime; nunca reporte contagem, status ou conteúdo que não veio de uma ferramenta nesta
   mesma resposta.* É a mesma doença de "afirmação sem medição", agora no agente.
4. ~~Apagar o cron morto `0a7d26ed4d30`~~ — **não era morto.** É o vigia de créditos de
   verificação (script, por isso sem prompt), pausado em 21/08. Religado em 30/09. O
   `f7c84063a699` (`weekly-health-check`, Notion) está pausado desde 10/08 e não tem relação
   com a campanha; ficou como estava.

**Critério de pronto.** `mcp_xphere_prospects_list` responde via Hermes com **1044**, e um
`docker kill` simulado do Xphere seguido de volta reconecta sozinho em menos de 5 minutos.

## Fase 42 — Metade da saída autentica pela metade (SPF no IPv6)

**Evidência.** Relatórios DMARC agregados, 12/09 → 29/09, por IP de origem:

| IP de origem | Mensagens | DKIM alinhado | SPF alinhado |
|---|---|---|---|
| `49.13.197.250` (IPv4) | 867 | 867 | **866** |
| `2a01:4f8:c2c:c870::1` (IPv6) | 815 | 814 | **0** (`softfail`) |

Todos os nove domínios têm `v=spf1 mx include:spf.brevo.com ~all`. `mx.skale.club` tem só
registro A — sem AAAA — então `mx` cobre o IPv4 e nada mais. O `outbound-transport.ts:101`
abre `createTransport({ host: mxHost, port: 25 })` sem `localAddress`; o sistema operacional
escolhe IPv6 sempre que o MX de destino tem AAAA, e o Gmail tem. Resultado: **48% de tudo
que sai falha SPF**. DMARC passa porque DKIM alinha, e `p=none` não pune — mas o Gmail
avalia SPF do IP separadamente, e para IPv6 exige PTR válido. O PTR do IPv6 é
`skaleclub-mail.` — um nome sem domínio, inválido. O IPv4 tem `mx.skale.club`, correto.

Isso não é a causa do pico de 09/09: o tráfego IPv6 existe antes, durante e depois, e o
spam voltou a zero com ele presente. É um defeito **persistente do caminho nativo** — ou
seja, do warm-up das caixas `contato@`/`agenda@`. **Não afeta a campanha**, que sai pelas
contas Google da Icemail via `smtp.gmail.com` e nunca passa pelo relay do Hetzner. Continua
valendo consertar (warm-up caindo no spam das caixas Icemail é o sinal errado para o Google
sobre elas), mas não bloqueia o piloto.

**O que fazer.**

1. **Fixar a saída em IPv4** em `outbound-transport.ts`: `localAddress: '49.13.197.250'`
   (ou `family: 4` no socket) no transporte direto. Uma linha, reversível, e o efeito é
   medível: os registros IPv6 nos relatórios DMARC caem a zero em 48h.
2. **Cinto e suspensório em DNS:** acrescentar `ip6:2a01:4f8:c2c:c870::1` ao SPF dos nove
   domínios via Cloudflare, para que qualquer caminho que escape ao passo 1 ainda alinhe.
3. PTR do IPv6 → `mx.skale.club` no painel da Hetzner (não há token de API local; é um
   clique no console). Só importa se algum dia o IPv6 voltar a sair; com o passo 1 é
   higiene, não urgência.
4. **Regra de silêncio** `dmarc_spf_alignment_low`: fração de mensagens com
   `policy_spf_aligned = pass` nos últimos 7 dias abaixo de um limiar. O limiar vem da
   medição: hoje é 51%; depois do passo 1 deve ser ≥ 99%. Disparar abaixo de **95%** pega
   uma regressão de um dia inteiro sem gritar por um `temperror` isolado (houve 1 em 1697).
5. Teste sobre os **bytes**: uma conexão de saída aberta pelo transporte direto reporta
   endereço local IPv4. Não sobre a variável.

**Critério de pronto.** Zero linhas com `source_ip` IPv6 nos relatórios DMARC de 48h após o
deploy, e `policy_spf_aligned = pass` ≥ 99% dos nove domínios.

## Fase 43 — Fechar os elos que só o Hermes puxa: verificar → importar → matricular

**Evidência.** `verified_ok_count` é NULL nas 27 runs. `prospects_verify`,
`prospects_import_to_xmail` e `prospects_enroll_in_campaign` são ferramentas MCP; nenhum
cron dos três repos as chama (`grep` em `src/app/api/cron`, `lib/workflows`, `lib/jobs`:
nada). `qualification_status`: 914 de 1044 em `needs_review` — a qualificação também é do
Hermes. Com o Hermes mudo por um mês, o motor produziu 1040 prospects que ninguém
verificou, ninguém qualificou e ninguém importou. **A "esteira diária" tem três buracos com
formato de gente, em sequência.**

**O que fazer.**

1. **Verificação automática pós-import**, no Xphere, dentro do orçamento diário que já
   existe (`PROSPECTING_DAILY_BUDGET_USD=2.00`; MillionVerifier custa US$ 0,0037/crédito
   medido, então 121 e-mails são US$ 0,45). **Desligada por padrão**, atrás de uma variável
   explícita (`PROSPECTING_AUTO_VERIFY=1`). É a primeira vez que o sistema gastaria dinheiro
   sem ninguém mandar; você liga depois de olhar os primeiros dias.
2. **Import automático dos `ok`** para o pool de leads do Xmail (`leads`), sem matricular
   em campanha. Matricular continua atrás de aprovação humana em
   `outreach_action_approvals` — isso não muda.
3. **Saldo de créditos como regra de silêncio, não como cron do Hermes.** O Xphere lê o
   saldo do MillionVerifier em `prospects_verify`; expor esse número e alimentar uma regra
   `verification_credits_low` no detector do Xmail, com limiar em créditos = 3 dias do
   consumo medido. O cron morto do Hermes sai de cena.
4. **Qualificação:** decidir se `needs_review` é portão do piloto. Recomendação: **não é.**
   Para barbearia com e-mail `ok` e não contatada, o ICP está satisfeito por construção
   (o território já é "barbershops em cidade X"). A qualificação do Hermes agrega texto de
   personalização, não elegibilidade. Deixar o campo para depois do piloto.

**Critério de pronto.** Com `PROSPECTING_AUTO_VERIFY=1` num dia de teste, as 121 pendentes
ganham `email_status`, `verified_ok_count` deixa de ser NULL na run daquele dia, e a regra
`verification_missing` do watchdog **se cala sozinha**.

## Fase 44 — As caixas de envio já existem: conferir e travar a regra

**Não há decisão aqui.** A primeira versão desta fase perguntava de qual caixa sair — `info@` ou
uma semente de warm-up. As duas respostas eram erradas: nenhuma delas manda campanha. A
campanha sai das **contas Google compradas na Icemail**, que já estão cadastradas como inbox de
outreach e já estão prontas:

| Caixa | Provider | Warm-up | Limite/dia | Status |
|---|---|---|---|---|
| `v.souza@tryskaleclub.com` | smtp · smtp.gmail.com | dia 14/14 | 15 | verified |
| `vanildo.jr@tryskaleclub.com` | smtp · smtp.gmail.com | dia 14/14 | 15 | verified |
| `vanildo.skale@tryskaleclub.com` | smtp · smtp.gmail.com | dia 14/14 | 15 | verified |
| `vanildo.souza@tryskaleclub.com` | smtp · smtp.gmail.com | dia 14/14 | 15 | verified |
| `vanildo@tryskaleclub.com` | smtp · smtp.gmail.com | dia 14/14 | 15 | verified |

Capacidade: **75 envios/dia** somando as cinco. Os 2 leads que já estão na campanha piloto
estão atribuídos a `vanildo.jr@tryskaleclub.com` — correto.

**O que fazer.**

1. **Travar a regra no código.** Hoje ela vale por acidente: as `info@` têm `warmup_only=false`
   e passam no filtro de remetente; o bloqueio por domínio (`checkProtectedSendingDomains`) só
   protege `skale.club` (`MAIL_DOMAIN`). Colocar os outros oito domínios da operação em
   `OUTREACH_PROTECTED_DOMAINS` faz com que **nenhum endereço de domínio da empresa** possa ser
   matriculado ou ativado como remetente de campanha — só sobra o domínio da Icemail. Sem
   código novo: é o mecanismo P009 que já existe, e precisa entrar no `run_app_container` do
   `build-deploy.yml`, porque hoje a variável não chega ao container.
2. **DMARC do `tryskaleclub.com`** manda os relatórios (`rua`) para `vanildo.souza@tryskaleclub.com`
   — uma caixa de envio. Relatório automático caindo numa caixa de outreach polui a caixa e
   ninguém lê. Acrescentar `mailto:dmarc@skale.club` ao `rua` (com o registro de autorização
   `tryskaleclub.com._report._dmarc.skale.club`) põe o domínio que **de fato** manda a campanha
   sob o mesmo instrumento que hoje só mede o warm-up.
3. **Postmaster Tools para `tryskaleclub.com`.** É o domínio que o Gmail vai julgar na campanha
   e ele não está cadastrado. Os 12 cadastrados são todos do lado nativo.

**Critério de pronto.** Uma tentativa de matricular `info@xkedule.com` como remetente devolve
`protected_sending_domain`; relatórios DMARC de `tryskaleclub.com` aparecendo em
`dmarc_reports`; `tryskaleclub.com` verificado no Postmaster.

## Fase 45 — O piloto: 25 barbearias, um dry-run, uma aprovação

**Evidência.** Elegíveis hoje em `prospect_rows`: `email_status = 'ok'`, não contatado, não
descadastrado → **69**, todos sem risco marcado. Mais 9 `catch_all` (entregam, mas não
confirmam). Mais os que a fase 43 verificar dos 121. A campanha tem 3 passos, `max_follow_ups
= 2`, `{{websiteInsight}}` no passo 1.

**O que fazer.**

1. **Seleção:** 25 dos 69, distribuídos por cidade (`prospect_rows.city`) para não bater
   numa vizinhança só, priorizando `has_owned_website = true` — é onde `{{websiteInsight}}`
   tem conteúdo. Query, não escolha à mão.
2. **`{{websiteInsight}}` vazio deixa um parágrafo em branco.** `template-variables.ts:161`
   devolve `''` quando não há insight; o passo 1 fica com `\n\n\n\n` no meio. A maioria das
   barbearias não tem site (50–80% medido nas três runs), então a maioria dos e-mails sai
   com o buraco. Consertar: colapsar o parágrafo quando a variável resolve vazia, com teste
   sobre o corpo renderizado.
3. **`reply_to_email`**: hoje é `null`, então a resposta volta para a própria caixa Icemail que
   enviou — que é o comportamento certo, desde que a caixa unificada esteja lendo as cinco.
   Conferir antes de ativar; não trocar por `info@`.
4. **Dry-run** pelo `campaignPreview` da fase 37 (`GET /api/outreach/approvals`): quantos
   matriculados, quantos verificados, quantos bloqueados, sequência renderizada com um lead
   real, caixa e limite do dia. Nada é enviado.
5. **Aprovação** em `outreach_action_approvals` — a primeira linha da história da tabela.
6. **Ativação** e, na primeira hora, olhar `outreach_emails.sent_at` (hoje 0),
   `outreach_event_outbox` (hoje 0 — a entrega para o Xphere nunca foi exercitada; a
   regra `xphere_events_undelivered` de 12/09 pega se ela falhar) e o log
   `DKIM verified … pass` de cada envio.

**Critério de pronto.** 25 e-mails com `sent_at`, 25 linhas na outbox entregues ao Xphere,
zero `xphere_events_undelivered`, zero bounce duro no primeiro dia.

## Fase 46 — Vigiar com o que já existe

Nada novo aqui; é ligar o que foi construído para isto.

- `enforceDeliverabilityGuardrails` (10 min): `bounce_rate_limit_percent` e
  `unsubscribe_rate_limit_percent` com `*_min_sample` em `outreach_settings`. **Ler os
  valores antes de ativar** e conferir que `min_sample` não é maior que 25, senão o guarda
  nunca acorda durante o piloto.
- Detector de silêncio (5 min): já lista `funnel_stalled`, `verification_missing`; a fase
  42 e a 43 acrescentam duas regras. O `warmup_spam_rate_rising` se calou sozinho quando
  a taxa caiu — prova de que o mecanismo funciona nos dois sentidos.
- Relatórios DMARC (15 min): 48h depois do primeiro envio, comparar a taxa de SPF/DKIM
  do dia da campanha com a base do warm-up. Se DKIM cair de 100%, parar.
- Postmaster: `xkedule.com` e `skale.club` já têm volume para o Google reavaliar; os
  outros sete não. Não esperar sinal do Postmaster nos sete — o instrumento deles é o DMARC.
- **Condições de parada, escritas antes de começar:** bounce duro ≥ 2 em 25; qualquer
  reclamação de spam reportada pelo Postmaster; `dmarc_spf_alignment_low` disparando;
  resposta "not interested" ≥ 5 em 25 sem nenhuma "interested".

---

## Ordem

41 primeiro e sozinha — é um restart e destrava todo o resto. 43 e 44 em paralelo, na `dev`,
sem deploy até você mandar. 45 depende de 41 (Hermes vendo o Xphere) e de 44 (a regra das
caixas travada no código). 42 corre por fora: melhora o warm-up, não bloqueia o piloto. 46
acompanha a 45.

## O que não fazer

- Não ativar antes da 44. Enquanto a regra das caixas não estiver travada no código, uma
  matrícula errada põe uma `info@` para disparar cold e-mail.
- Nunca usar `info@` nem caixa de warm-up como remetente, nem "só para o piloto".
- Não deixar a 43 ligada por padrão. Gasta dinheiro; você liga.
- Não confiar em número que o Hermes disser até a 41 fechar. Ele respondeu "397" com a
  ferramenta devolvendo erro.
- Não subir `p=none` para `quarantine` ainda: com 50% de SPF falhando, `quarantine` é
  quarentena do próprio e-mail. Depois da 42 medida, aí sim.

## Correções que não merecem fase

- 17 arquivos `.log` soltos no worktree `main` do Xphere (`.matrix-consent-*.log` etc.):
  lixo de build, apagar.
- 9 erros/24h no Xmail, todos `outreach.inbound.account_error` com timeout de IMAP nas
  caixas do Google Workspace. Classe conhecida, não bloqueia; o processador de bounces já
  foi redimensionado para isso em 12/09.
- Fila de territórios acaba em 12 dias. Cadastrar a próxima leva (a fase 36 deixou isso
  como ação humana de propósito) antes de 12/10, ou o motor para calado — e o
  `territory_queue_empty` do watchdog vai avisar, mas só depois de parar.
- As 842 linhas de OAuth que estavam soltas no Xphere em 12/09 **foram integradas** (o
  `OAuthFailureCode` está na `main`). Pendência encerrada.

---

## Execução — 2026-09-30

O que já foi feito, com a prova de cada item. O que ficou de fora está no fim, com o motivo.

**Fase 41**
- `docker compose restart hermes` às 12:54 UTC. `hermes mcp test xphere` e `skaleclub` listam as
  ferramentas (`prospects_list`, `prospects_verify`, `prospects_enroll_in_campaign`…).
- Por que tinha morrido: `_MAX_RECONNECT_RETRIES = 5` está fixo em
  `/opt/hermes/tools/mcp_tool.py`, sem configuração. O `skaleclub` morreu do mesmo jeito em 12/09.
- Vigia no host, fora do vigiado: `hermes-mcp-watchdog.service` (systemd, mesmo formato do
  `provider-switch-notifier`), segue o `errors.log` do Hermes, reconhece as duas mensagens de
  desistência (`failed after N reconnection attempts, giving up` e `failed initial connection
  after N attempts, giving up`), reinicia o container e avisa no Telegram. Intervalo mínimo de
  30 min entre reinícios. Auto-teste do reconhecedor com as linhas reais do log: ok. Provado que
  o `docker` responde de dentro do sandbox do systemd (`ProtectSystem=strict`).
- `SOUL.md` do Hermes (estava vazio): regra "número só vem de ferramenta nesta resposta" e as
  três caixas. Backup em `SOUL.md.bak-20260930`. É relido a cada mensagem.

**Fase 42**
- `ip6:2a01:4f8:c2c:c870::1` no SPF de `skale.club` (o token de API da Cloudflare local só
  alcança essa zona). Os outros oito domínios ficam para o conserto de código (saída em IPv4),
  que resolve a causa em todos de uma vez.

**Fase 44**
- `OUTREACH_PROTECTED_DOMAINS` com os oito domínios da operação no `run_app_container`
  (`build-deploy.yml`) e no workflow legado. Só vale depois do deploy.
- `tryskaleclub.com._report._dmarc.skale.club TXT "v=DMARC1"` criado e público: o lado de quem
  recebe os relatórios está pronto. Falta o `rua` em `_dmarc.tryskaleclub.com`, que está numa
  conta Cloudflare fora do alcance do token.

**Fase 45 — o que tentar importar revelou**
- O import dos 69 `ok` do Xphere para o Xmail falhou com 500:
  `duplicate key value violates unique constraint "lead_org_email_unique"`. O
  `POST /leads/bulk-import` não deduplica dentro do próprio lote.
- E o motivo das duplicatas é pior que o 500: **`help.us@booksy.com` está gravado como e-mail
  de 11 barbearias** — é o suporte do Booksy, tirado da página da barbearia na plataforma.
  Passa na verificação porque a caixa existe. Dos 69 "ok", só 55 e-mails são distintos. Sem o
  500, o piloto teria mandado cold e-mail para o suporte do Booksy. Franquias têm o mesmo
  problema em escala menor (`contact.us@sportclips.com` é a sede da rede, não a unidade).
- Consertos em andamento: Xmail barra e-mail de plataforma na importação e na matrícula;
  Xcraper deixa de gravá-lo na origem.

**Fase 46**
- Guarda de descadastro não acordaria no piloto: exigia 50 envios em 24h. Ajustado para
  amostra 20 / limiar 10% (pausa no 3º descadastro em 25). **Valores anteriores: 2% / 50 —
  voltar a eles quando a campanha passar de ~50 envios/dia.** Bounce continua 5% / 20.
- Leitura de respostas: as 5 caixas Icemail sincronizaram IMAP há 5 min, sem erro. Os timeouts
  de ontem foram transitórios.

**Ficou de fora, e por quê**
- `rua` do `tryskaleclub.com`, Postmaster do `tryskaleclub.com`, `ip6:` no SPF dos oito
  domínios: exigem a Cloudflare da outra conta e o Postmaster, via navegador — e a extensão do
  Chrome estava desconectada.
- PTR do IPv6: só pelo console da Hetzner, sem API local. Com a saída em IPv4 é higiene.
- Verificar os 106 nunca verificados: gasta crédito, e o MillionVerifier tem 169.

### Fechamento — 2026-09-30, fim do dia

Tudo em produção nos três repos (`main` = `dev`):
- **xmail `c357356`** — regra das três caixas travada no deploy; saída nativa em IPv4 (a causa
  era o nodemailer **sortear** entre A e AAAA a cada conexão — `concat` + `Math.random`, provado
  no código instalado); regra `dmarc_spf_alignment_low` com janela de 3 dias (hoje em 51,6%: vai
  falar até ~3 dias depois do deploy e se calar — essa é a prova do conserto); parágrafo vazio do
  `{{websiteInsight}}`; import em massa sem 500 por duplicata; e-mail de plataforma recusado.
- **xcraper `e6e392f`** — e-mail de plataforma descartado na origem.
- **xphere `6acc96a2`** — verificação automática, **desligada** (`PROSPECTING_AUTO_VERIFY`); o
  agendamento fica no `skale-cron` da VPS, com o mesmo heartbeat dos outros jobs, quando ligar.
- DNS: `ip6:` no SPF dos 9 domínios nativos; `_dmarc.tryskaleclub.com` com `dmarc@skale.club`
  à frente do `rua` (destino antigo mantido); autorização
  `tryskaleclub.com._report._dmarc.skale.club` publicada.

**O piloto está montado e passaria na ativação.** `validateCampaignReadyForActivation` rodado em
produção, só leitura: nenhum problema. 25 leads, 25 verificados, 5 por caixa Icemail (0 de 15
usados hoje em cada), 3 passos (0h, +72h, +96h), `{{unsubscribeUrl}}` em todos. O "blocker" de
endereço postal que o preview mostra é informativo — decisão do Vanildo; a ativação não o exige.
Import real: 69 `ok` → 55 e-mails distintos → menos 2 de plataforma → menos 2 já existentes =
51 novos. Seleção: só barbearias (fora salões, franquia e administradora de shopping), com insight
do site, 18 fora do centro de Boston e 5 no centro.

**Postmaster do `tryskaleclub.com`: verificado** (30/09). O Vanildo cadastrou (o formulário recusa
preenchimento por automação); o TXT de verificação foi publicado ao lado do
`google-site-verification` que já existia, sem removê-lo. É o domínio que o Gmail julga na
campanha — os outros 12 cadastrados são do lado nativo.

**Falta só:** a aprovação do Vanildo para ativar.

### Pendências de código levantadas pelo plano — fechadas em 2026-09-30

Todas em produção (xmail `0415632`, xphere `3604d782`):
1. **Import automático dos verificados** — o tick de verificação importa os `ok` pelo mesmo
   caminho do `prospects_import_to_xmail`; mesmo interruptor desligado (`PROSPECTING_AUTO_VERIFY`).
2. **Caixa de envio na matrícula** — o Xmail diz em cada conta se é `campaignSenderEligible`
   (mesma função da trava); o Xphere só escolhe entre as elegíveis e falha fechado sem o campo.
   Medido em produção: as 5 elegíveis são exatamente as 5 Icemail.
3. **E-mail compartilhado e franquia** — retidos para decisão humana, sempre reportados. No
   primeiro dry-run em produção: 43 `shared_email` (incluindo **`filler@godaddy.com`**, e-mail de
   preenchimento de template do GoDaddy em várias barbearias, que o filtro de placeholder não
   conhecia) e 2 `franchise` (Sport Clips, Floyd's 99).
4. **Contabilidade do import** — só recebe `xmail_imported_at` o que o Xmail aceitou.
5. **`city`** — derivada do endereço na ingestão; backfill rodado: 1014 corrigidos, 1028 de 1044
   com cidade (16 sem endereço). O script paginava por deslocamento sobre o próprio filtro e
   teria pulado 17 linhas no modo real; trocado por paginação por id antes de rodar.

O primeiro deploy do Xphere falhou num erro de tipo que só o `next build` pega
(`const cf = customFields ?? {}`); a produção não caiu, o build parou antes. Corrigido com tipo
explícito, provado compilando o arquivo isolado em `--strict`.

### Landing e Products no ar — 2026-09-30, noite

Site (`skaleclub` `e598bc4`, Coolify): `/barbershops` reescrita e `/products`,
`/products/nfc-review-plaque`, `/products/nfc-keychains` (+ versões `/br/`) novas, tudo como
**dados** no mecanismo de landings gerenciadas, só com seções que já existiam. Extensões de
código mínimas: `tel:` no hero, `href` por card, rota `/products/:slug` no cliente E no servidor,
mapa explícito URL→slug com `Object.hasOwn` (a primeira versão aceitava `constructor`).

Revisão em duas rodadas (Opus, só leitura) reprovou a primeira entrega por quatro bloqueios
reais: `/products/*` dava 404 no servidor enquanto o sitemap anunciava as URLs;
`/products/nfc-keychains` mostrava a landing de anúncio antiga com preço; o bloco NFC não
linkava os produtos; travessão e "technology" herdados. Tudo corrigido e conferido ao vivo:
200 + canonical nas páginas novas, 404 noindex para slug inválido, 301 do slug sem prefixo,
`/nfc-keychains` antiga intocada.

Seeds aplicados em produção na ordem produtos → barbearias → traduções (dry-run antes de cada
um). O de traduções alterou UMA linha global já existente ("TikTok Ads" → "anúncios no TikTok").

**Vercel — resolvido em 2026-09-30, pelo navegador do Vanildo:** o projeto `skaleclub` (que
ainda existia, conectado ao GitHub, construindo todo push na `main` até 29/09; ninguém servido por
ele, `skale.club` → Hetzner) foi **apagado** (sem domínio próprio preso a ele). No GitHub, o app da
Vercel passou de "All repositories" para **"Only select repositories"**: xcraper, xpot, xtrenght,
xpend, xpeed, fluenverse, fluenverse2.0, paperpair — confirmado pela API
(`repository_selection=selected`). O `skaleclub` deixou de existir para a Vercel.
No código, os resquícios já tinham sido removidos no wind-down; sobrou `.gitignore` e uma
linha do `SETUP.md`, limpos em `bb1444f`.

**E-mails do piloto:** terceira versão aplicada no rascunho, aprovada pelo Vanildo para avançar
("tá melhor que antes e dá pra gente avançar"). Abertura por lead via `custom_fields.openerNote`
(plataforma de agendamento real de cada barbearia; 2 sem linha). Assinatura aponta para
`skale.club/barbershops`. A/B desligado. **Ativação ainda depende do "vai" dele.**

### Estado ao fim de 2026-09-30 (para retomar de onde parou)

**Pronto e conferido em produção:** landing `/barbershops` + seção `/products` no ar; e-mails do
piloto na v3 no rascunho (abertura por lead via `custom_fields.openerNote`, sem "tech", sem
travessão, A/B desligado), assinatura "Thanks, / Vanildo de Souza Jr / Skale Club (link para
skale.club/barbershops) / (508) 801-8190 / unsubscribe", em texto e em HTML mínimo;
`validateCampaignReadyForActivation` = OK; 25 leads, 5 por caixa Icemail; guarda de
descadastro em 10%/20 (voltar a 2%/50 depois do piloto); Postmaster do tryskaleclub.com
verificado; Hermes reconectado com vigia; verificação automática no Xphere pronta e DESLIGADA.

**Só o Vanildo pode fazer:** (1) assinar Apify Starter antes de ~07/10; (2) ~~Vercel~~ feito;
(3) demo (224) 551-6131: ele já ligou algumas vezes, ok; (4) recarregar o MillionVerifier (169
créditos); (5) escolher a frase do rodapé/hero do site (opções 1-3 dadas); (6) fotos reais da
placa NFC; (7) dizer "vai" para ativar o piloto (melhor às 9:30 ET de um dia útil).

**Depois do "vai":** ativar (`status='active'`), acompanhar a primeira hora (`outreach_emails.sent_at`,
`outreach_event_outbox` entregando ao Xphere, `DKIM verified` no relay), e as condições de parada
da fase 46. Em seguida: nova leva de territórios (fila acaba 12/10; decidir MA só ou NH/RI/CT),
ligar `PROSPECTING_AUTO_VERIFY=1` + cron no skale-cron da VPS, e a landing simples da linha NFC.


### Teste de envio e opener v4 — 2026-09-30, noite

Vanildo pediu, antes de ativar: rever os três e-mails, **rodar um teste de envio** (Apify fica no Free
até o teste passar; Starter só depois) e duas mudanças de texto:

1. **Saudação com o nome curto da loja em todo e-mail** ("Hi Boston Blendz," e não "Hi,"), como se
   estivesse falando com a barbearia. Nome curto é editorial: gravado lead a lead em
   `custom_fields.shortName` (26 leads, revisados à mão: "Danny's", "Boston Barber Co.",
   "Gentleman Barbershop", "The Barbery"…). `{{shortName}}` virou variável nativa em
   `template-variables.ts`: usa o campo gravado; sem ele, `shortenCompanyName()` tira o descritor do
   fim ("Barbershop", "Barber Studio", "& Beauty Supply"…) e, se o corte comer o nome, devolve o nome
   inteiro; sem nome nenhum, "there". Testes em `__tests__/template-variables.test.ts`.
2. **Opener do e-mail 1 (v4):** "This is Vanildo, owner of Skale Club. We're a local company here in the
   Boston area and we specialize in marketing for barbershops." e logo abaixo "Simply put, our goal is
   to help you make more money and have more free time." A frase de valor vem ANTES da observação do
   site (`{{openerNote}}`), que ficou como secundária. "Local / região de Boston" voltou a ser desejado
   (reverte a regra de 2026-09-30 de manhã); "tech" e Framingham continuam fora.

**Mecanismo do teste (criado, em rascunho, nada disparado):** campanha separada
`d537358f-79f5-40ad-9354-a5acf77ecbf0` "TESTE DE ENVIO (nao e a campanha) - Pilot 01", cópia do piloto
com janela 00:00-23:59 + fim de semana e os três delays zerados; um único lead de teste
(`skale.club@gmail.com`, "Skale Test Barbershop", Framingham, opener Squire), remetente
`vanildo.jr@tryskaleclub.com` (Icemail). Com 15 min mínimos entre envios e o processador a cada 5 min,
os três chegam em ~45 min, gastando 3 dos 15 envios diários da conta. O piloto real
(`c5573673…`) segue `draft`, 25 leads intocados; readiness das duas = OK. Backup dos corpos
anteriores em `scratchpad/pilot-steps-backup-2026-09-30-v5.json`.

**Observação para depois do teste:** os follow-ups de campanha saem SEM `In-Reply-To` (o processador
não passa threading em `dispatchOutreachMessage`), então o e-mail 2 chega como mensagem nova
"slow Tuesdays", não como "Re: booking at …". Ferramenta de cold e-mail costuma encadear. Decidir
depois de ver na caixa.

**Dispara com "vai o teste".** Depois: conferir inbox/spam no Gmail, remetente e nome exibidos,
assinatura, link de descadastro, ordem dos três; arquivar a campanha de teste; aí sim o "vai" do piloto.

### Achados do Hermes e regra de e-mail de plataforma — 2026-10-07

O Hermes listou três bloqueios antes de ativar. Conferido em produção:

1. **`help.us@booksy.com` nos prospects.** O piloto no Xmail estava limpo (0 dos 25; a org inteira
   sem nenhum lead de Booksy). O problema estava no **Xphere**: 40 de 6.388 empresas com e-mail de
   plataforma (38 Booksy, 1 Vagaro, 1 PocketSuite), 12 marcadas `ok` com crédito gasto. Regra criada
   no Xphere (`b2beb776`): nunca verifica, nunca importa, nunca matricula; limpeza aplicada nos 40
   (reversível, status anterior em `custom_fields.previous_email_status`). Listas de domínios do
   Xmail, Xphere e Xcraper alinhadas em 19 domínios.
2. **Endereço postal.** A descrição antiga da campanha (de 12/09) dizia que o endereço tinha sido
   incluído; a reescrita de 30/09 tirou o endereço do corpo e ninguém repôs. Hoje o e-mail **não tem
   endereço postal**, e o Xmail só avisa (não bloqueia). A lei americana de e-mail comercial
   (CAN-SPAM) exige um. **Decidido pelo Vanildo em 2026-10-07: o endereço pessoal dele não entra de
   forma alguma.** Saída que cumpre a lei sem expor a casa: caixa postal dos Correios (PO Box) ou caixa
   postal virtual/comercial (UPS Store, iPostal1, Anytime Mailbox), numa linha no rodapé junto do
   descadastro. Enquanto ele não contratar uma, o e-mail segue sem endereço; ativar assim é decisão e
   risco dele. Descrição da campanha reescrita para registrar a pendência.
3. **Créditos baixos.** Continua: MillionVerifier 169, NeverBounce 0. Os 25 do piloto já estão
   verificados; não bloqueia o piloto, bloqueia a próxima leva.

**Resolvido no mesmo dia:** Vanildo tem caixa virtual no Anytime Mailbox. Rodapé dos três passos do
piloto e do teste agora é "Skale Club, 74 E Glenwood Ave Unit #5650, Smyrna, DE 19977. To stop
receiving these emails: {{unsubscribeUrl}}" (texto e HTML). `assessCampaignActivationCompliance`:
endereço OK, descadastro em todos os passos, nenhum bloqueio; prontidão das duas campanhas OK. Backup
dos corpos anteriores em `scratchpad/pilot-steps-backup-2026-10-07-v6.json`.
