# Ligar a campanha — plano de 2026-09-30

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
| "Monitor automático de créditos pausado" | É um cron do Hermes (`0 9 * * *`) **desabilitado e com prompt vazio**. Não é monitor; é uma linha morta. |
| "Precisamos de uma conta verificada, validar SPF/DKIM/DMARC" | Já medido pelo instrumento da fase 1: 142 relatórios DMARC do Google, 1697 mensagens. **DKIM alinhado: 100%.** **SPF alinhado: 50%** — ver fase 42, é o achado deste plano. |

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
4. Apagar o cron morto `0a7d26ed4d30` (prompt vazio) e o `f7c84063a699` desabilitado, ou
   documentar o que eram. Uma linha desabilitada com prompt vazio não é monitor pausado, é
   lixo que vira frase enganosa.

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
spam voltou a zero com ele presente. É um defeito **persistente** que reduz a margem, e a
campanha vai testar essa margem com desconhecidos.

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

## Fase 44 — A caixa que vai enviar

**Evidência.** `info@` (9 caixas): dia 0 de 14 em sete, dia 2 em duas; 0 mensagens em 30
dias; teto de 50/dia; as únicas 8 mensagens que já mandaram (antes de setembro) tiveram 4
em spam. Sementes `contato@`/`agenda@` (20 caixas): dia 14 de 14, ~5/dia cada, 2,9% de spam
em 30 dias e **0,0% para o Google nos últimos 12 dias**. A campanha tem `from_name =
"Vanildo | Skale Club"`, `reply_to_email = null`, janela 09:30–16:30 ET, sem fim de
semana, sem rastreio de abertura/clique.

**A decisão é sua, e são duas opções, não três:**

- **(A) Enviar de uma semente aquecida** (`contato@skale.club` ou `contato@xkedule.com` —
  `xkedule.com` é o domínio com mais volume medido nos relatórios, 302 mensagens, 100% DKIM,
  e "No issues" no Postmaster). Piloto sai **esta semana**. `info@` fica para resposta
  humana. Custo: a assinatura diz `skale.club` e o remetente é `contato@`, coerente.
- **(B) Aquecer `info@` antes.** Reduzir `daily_send_limit` de 50 para **15**, ligar no
  mesh, 14 dias subindo. Piloto sai em **duas semanas**, de uma caixa cujo primeiro
  histórico será bom em vez de 4-em-8.

Recomendação: **(A)** para o piloto, **(B)** em paralelo para a campanha de verdade. O
piloto de 25 não precisa da `info@`; a `info@` precisa de 14 dias que o piloto não tem por
que esperar. E independente da escolha: **baixar o teto das `info@` para 15 hoje.** 50/dia
num endereço de dia zero é o número que a fase 4 já chamou de errado.

**Critério de pronto.** Caixa escolhida, `reply_to_email` preenchido com uma caixa que
alguém lê, e teto das `info@` em 15.

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
3. **`reply_to_email`** para a caixa da fase 44. Hoje é `null`.
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

41 primeiro e sozinha — é um restart e destrava todo o resto. 42 e 43 em paralelo, na
`dev`, sem deploy até você mandar. 44 é a sua decisão, e pode ser tomada hoje. 45 depende
de 41 (Hermes vendo o Xphere), 42 (metade da saída autenticando inteira) e 44. 46 acompanha
a 45.

## O que não fazer

- Não ativar antes da 42. Mandar cold e-mail para desconhecidos com metade do tráfego
  falhando SPF é gastar a lista para testar uma hipótese que os relatórios já respondem.
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
