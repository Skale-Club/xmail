# Caça aos erros antes de acelerar a campanha

Lista viva. Regra combinada com o Vanildo em 2026-10-07: rodar devagar, com poucas barbearias, e corrigir cada
problema que aparecer antes de aumentar o volume. Cada linha diz o que aconteceu, o efeito, e o estado.

## Corrigidos

| # | Achado | Efeito se não tivesse sido pego | Correção |
|---|---|---|---|
| 1 | Reserva da conta quebrava com `timestamp <= interval` | **Nenhuma** campanha enviava | `b83f901`, cast `::timestamp` + teste |
| 2 | Registro do envio quebrava (`queryClient.json` com `prepare: false`) | E-mail saía, mas o lead nunca ia para o passo 2; evento não chegava ao Xphere; lembretes da caixa unificada também quebrados | `c5279b0`, `JSON.stringify(...)::jsonb` |
| 3 | Aviso imediato de resposta travava esperando a própria transação | Telegram só avisava na varredura de 5 min | `6544e9d`, aviso depois da transação + teste |
| 4 | `{{city}}` virava "United States" nos endereços novos do Xphere | Frase da visita: "around the corner from United States" | `59bfc62` |
| 5 | Gancho "sem agendamento online" falso para N. Fadez e Neighborhood Barbers (o analisador não viu Squire/Booksy) | Dizer ao dono que o site dele não tem agendamento, quando tem | Dados corrigidos nos 2 leads; **ver aberto #A** |
| 6 | Hermes montou campanha nova com texto próprio ("Hi there", sem link, sem descadastro) | Texto não aprovado; travaria na ativação por falta de descadastro | Live Pilot 02 recebeu a sequência aprovada; ver corrigido #9 |
| 7 | Hermes chamava o Xcraper sem `scrapeType` → Apify sem crédito | Raspagem falhava | Regras do homelab no manual dele (`hermes/xcraper-homelab.md`); ver corrigido #10 |
| 8 | Endereço postal nos e-mails | Decisão do Vanildo: não quer endereço físico | Removido de todas as campanhas (ciente do CAN-SPAM); a falta dele virou aviso, não bloqueio (`25eabe6`) |
| 9 | Hermes não lia nem editava texto de campanha existente (era o aberto B) | Campanhas duplicadas com texto improvisado | `85d2921`: escopo `campaigns:copy` (Hermes e Kai, migração 072), ler/editar/reverter passo, auditoria, aviso de travessão/"Hi there"/endereço |
| 10 | Xcraper caía no Apify quando o `scrapeType` não vinha (era o aberto C) | Raspagem falhava sem crédito | Xcraper `a175626`: sem `scrapeType`, super admin vai para o homelab |
| 11 | A edição do Hermes aceitava tirar o `{{unsubscribeUrl}}` do texto puro quando o HTML ainda tinha | E-mail sem descadastro para quem lê em texto puro | Achado no teste real das ferramentas; agora cada corpo preenchido tem que ter o link, senão 422 e nada é salvo |
| 12 | Salvar a sequência pela tela zerava a espera variável (3 a 5 dias) (era o aberto F) | Follow-ups com espera fixa | `85ee773`: as telas carregam, mostram ("Up to") e enviam `delayHoursMax` |
| 13 | Hermes sem acesso para operar o dia a dia (campanha, leads, caixas, caixa de entrada, métricas, supressões) | Tudo passava pelo Claude ou pela tela | `c29d910`..`1b7b648`: escopo `outreach:manage` (só Hermes, migration 073 aplicada), 20 ferramentas, 43 no total. Ativação e resposta a prospect seguem na aprovação; limite diário pelo agente no máximo 30 por caixa. Provado em produção: só as 5 contas Icemail aparecem como remetente, nenhum segredo sai |
| 14 | Leitura das caixas ficava 30 min de castigo depois de qualquer erro de IMAP (era o aberto D) | Um deploy reinicia o container, o tick morre no meio da conexão e toda resposta fica invisível por até ~45 min | `b634a58`: erro transitório (timeout, reset, conexão fechada) castiga 5 min e sobe 15 e 30 nas falhas seguidas; credencial, caixa inexistente, chave errada e erro desconhecido seguem em 30. Durante o shutdown nenhum castigo é gravado. A contagem vai no prefixo de `last_error`, sem migration |
| 15 | Follow-ups saíam sem `In-Reply-To`/`References` (era o aberto E) | E-mail 2 chegava como conversa nova, não como continuação | `7c297f6`: passo 2+ leva o Message-ID do último e-mail enviado ao lead na campanha e a cadeia (últimos 10). Assunto em branco depois do primeiro passo vira `Re: <assunto anterior>`; assunto escrito fica como está (texto aprovado intacto). Migration 074 (**escrita, não aplicada**) deixa o banco aceitar assunto vazio em `step_order > 1` |
| 16 | Limite diário fixo em 15 por caixa Icemail (era o aberto I) | Teto de volume sem critério para subir | `6ee5dd7`: `rampRecommendation` em `GET /email-accounts` (e na tool `outreach_email_accounts_list`): 20+ envios em 7 dias, bounce < 2%, descadastro < 3% e zero reclamação sugerem + 3 (teto 30); bounce ≥ 5% ou reclamação sugerem − 3 (piso 5). Só recomenda, nunca aplica |
| 17 | Link de descadastro nunca tinha sido clicado num teste real (era o aberto G) | Descadastro quebrado = problema legal e de reputação | Provado em produção em 2026-10-07 com lead descartável: página abre, POST one-click (como o Gmail) descadastra, lead e campanha marcados, supressão `unsubscribe` gravada, POST repetido ok, token adulterado 400. Teste apagado depois |
| 18 | Fila do homelab só andava quando alguém consultava (era o aberto H) | Busca parada se ninguém acompanhar | Xcraper `c3ff00c`: `POST /api/service/homelab/tick`; cron de 2 em 2 min no Hetzner (`/etc/cron.d/xcraper-tick`, script `/opt/hermes/xcraper-tick.sh`, chave lida do container do Hermes) |
| 19 | Gancho "sem agendamento" saía sem ninguém conferir (parte do aberto A) | Afirmação falsa ao dono | `51bc24d`: só aparece com `booking_verified_none: true`, que o Hermes marca depois de abrir o site |
| 20 | Aprovação só pelo painel do Xmail | Vanildo tinha que entrar no Xmail para cada campanha | `0ab60fd`/`dbfb05c`: cartão com Aprovar/Recusar no Telegram (bot xmailoppsbot), com confirmação em dois toques; mesma lógica do painel |
| 21 | Analisador do Xphere não via Squire/Booksy em sites Squarespace/Wix (resto do aberto A) | `booking_platform` errado no lead | Xphere `b10b020a`: lista única de provedores, lê scripts, iframes, `data-*`, JSON inline, segue uma subpágina `/book`; CTA externo desconhecido conta como agendamento (`unknown`). Na dúvida, "tem agendamento" |

## Abertos

Achado novo entra aqui antes de subir o volume.

| # | Achado | Risco | Próximo passo |
|---|---|---|---|
| J | Hermes não voltou a janela da Pilot 02 depois do primeiro envio (passo 4 da mensagem 5) | Follow-up no sábado às 23h | Corrigido à mão em 08/10; lembrar o Hermes que é dele |
| K | IMAP do Gmail estoura o prazo total de vez em quando (7 vezes em 12h, 4 caixas) | Resposta vista até ~20 min depois | Castigo de 5 min já segura; olhar o prazo se aumentar |
| L | Relatório da rodada noturna do Hermes diz 37 créditos gastos, mas o MillionVerifier caiu de 163 para 84 (79) | Conta de crédito errada | Pedir ao Hermes que reconcilie |

## Testes de envio reais

| Data | Campanha | Destino | Resultado |
|---|---|---|---|
| 2026-10-07 | Teste (1 lead) | skale.club@gmail.com | Caixa de entrada; resposta detectada; passo 2 cancelado; Telegram avisou (pela varredura) |
| 2026-10-07 | Live Pilot 02 (3 leads, Newton) | 3 barbearias reais | Aprovada pelo Telegram às 22:26 ET; e-mail 1 saiu às 22:30, 22:50 e 23:10 ET (espaço de 15 a 30 min da caixa), sem erro. Janela voltou para 09:30-16:30 dias úteis em 08/10 de manhã (o Hermes não tinha ajustado). Follow-ups a partir de segunda 13/10 |
