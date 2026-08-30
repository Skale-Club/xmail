# Alertas no Telegram

O Xmail reporta a um chat do Telegram aquilo que exige uma decisão humana: a
aplicação cair, o deploy falhar, a fila parar de escoar, o processo crashar, e
erros a subirem acima do normal.

Bot: **@xmailoppsbot** ("Xmail | Opps"). É um bot dedicado a este projeto — não
partilha token com nenhum outro.

---

## Antes de mais: isto não é um sistema novo

A tabela `system_integrations`, a coluna encriptada do token e o painel
`/admin/integrations` existem desde a migration `023`, de **2026-05-21**. Nunca
enviaram nada: `telegram_enabled` ficou `false` durante três meses, e o único
caminho que chegava ao Telegram era o botão "Test" do painel. O endpoint
`/monitor-config`, desenhado precisamente para alimentar um monitor externo,
respondia `503` porque `MONITOR_API_TOKEN` não estava definido em lado nenhum.

O que foi construído é o **consumidor que faltava**, não um segundo sistema. O
painel continua a ser o único sítio onde se editam as credenciais.

---

## O que te avisa o quê

| Alerta | Camada | Origem | Quando |
| --- | --- | --- | --- |
| 🚨 Xmail is DOWN / ✅ back UP | externa | GitHub Actions | `/health/ready` ou as portas 587/993 não respondem, de 15 em 15 min |
| 🚀 Deploy OK / 🚨 Deploy FAILED | externa | GitHub Actions | cada push para `main` |
| 💥 Xmail crashed | interna | `install-alerting.ts` | `uncaughtException` — o processo vai morrer |
| ⚠️ Unhandled promise rejection | interna | `install-alerting.ts` | promessa rejeitada sem `catch` — o processo **continua vivo** |
| 📮 Mail servers did NOT start | interna | `index.ts` | SMTP/IMAP/MX não conseguiram fazer bind |
| 🐌 Outbound queue is stalled | interna | `jobs/alertWatchdog.ts` | mensagens por enviar há mais de 15 min |
| 🧠 Memory is high | interna | `jobs/alertWatchdog.ts` | RSS acima de 1024 MB |
| 💾 Disk is filling up | interna | `jobs/alertWatchdog.ts` | sistema de ficheiros acima de 85% |
| 🔥 Error spike | agregada | `error-spike-alert.ts` | mais de 15 erros em 5 min |

Cada alerta de estado tem a sua mensagem de recuperação (✅). Nenhum deles
repete enquanto a condição se mantém — ver "Fadiga de alerta" abaixo.

---

## Porque é que a monitorização vive em três sítios

Esta é a parte que interessa perceber, porque é o que torna o sistema fiável em
vez de meramente tranquilizador.

**Um servidor que está em baixo não consegue avisar que está em baixo.** Tudo o
que corre dentro do processo — o detetor de picos, o watchdog, os handlers de
crash — morre exatamente no momento em que era preciso. Por isso a sonda de
uptime corre no **GitHub Actions**: fora do contentor, fora da Hetzner, fora do
caminho de rede. Se a máquina desaparecer, o GitHub continua a reparar e
continua a ter rota para o Telegram.

**Mas uma sonda HTTP vinda de fora é quase cega.** Vê "a página carrega" e fica
verde enquanto o disco enche, a memória sobe para o OOM killer ou a fila deixa
de escoar — até que, de repente, fica vermelha. A **camada interna** apanha isso
horas antes, porque vê coisas que nenhum pedido externo consegue ver.

**E há um ponto cego que só aqui existe:** isto é um *servidor de e-mail*. As
portas **25, 587 e 993 são TCP puro**, publicadas diretamente do contentor e a
contornar o Traefik. A app HTTP em `:9001` pode estar perfeitamente saudável
enquanto nada consegue enviar nem receber correio. Por isso a sonda externa
testa as portas de mail além do HTTP, e a camada interna alerta se os
servidores de mail não fizerem bind no arranque.

Três pontos de observação, três pontos cegos, sobrepostos de propósito.

### Porque é que a porta 25 não é sondada

Os runners do GitHub **bloqueiam a saída na porta 25** para impedir spam a
partir do Actions. Sondá-la de lá falharia sempre, saudável ou não, e um alarme
falso permanente é a forma mais rápida de o canal ser silenciado. As portas 587
e 993 não são bloqueadas e provam a mesma coisa: os listeners TCP do contentor
estão vivos e acessíveis da internet.

Se um dia houver um runner self-hosted que consiga sair na 25, basta
`PROBE_PORT_25=true`.

---

## Fadiga de alerta é um modo de falha

Um sistema de alertas que as pessoas silenciam é pior do que nenhum. Portanto:

- **A sonda externa alerta só em transições.** Uma mensagem quando cai, uma
  quando volta — não uma a cada 15 minutos durante horas. O estado é a *issue*
  aberta com a label `outage`: ela já é o registo por incidente, portanto ler a
  transição a partir dela evita uma segunda fonte de verdade que pudesse ser
  descartada independentemente.
- **A camada interna deduplica por condição.** A mesma condição volta a falar,
  no máximo, a cada `OPS_ALERT_REPEAT_MS` (6 h por omissão), e envia
  exatamente uma mensagem de recuperação quando passa.
- **A camada agregada alerta por TAXA, não por erro.** Um endpoint partido gera
  centenas de erros por minuto. Ver a secção seguinte.
- **Nunca há mensagem de "está tudo bem".** Uma recuperação só é anunciada se a
  falha correspondente tiver sido anunciada. Um canal que reporta "continua
  tudo bem" de 15 em 15 minutos é um canal que se deixa de ler.

---

## O limiar do pico de erros, e como foi medido

O limiar **não** é um chute. Foi medido contra produção a **2026-08-30**, sobre
as 24 horas anteriores:

| Métrica | Valor |
| --- | --- |
| Total de linhas de nível `error` em 24 h | **770** |
| Média por janela de 5 min | **2,67** |
| Janela de 5 min mais movimentada | **23** |
| Frequência desse pico | **~32×/dia**, quase exatamente de 45 em 45 min |

Comandos usados:

```bash
docker logs xmail --since 24h 2>&1 | grep -ac '"level":"error"'
```

```bash
docker logs xmail --since 24h -t 2>&1 | grep -a '"level":"error"' | awk '{print substr($1,1,13) "-" int(substr($1,15,2)/5)}' | sort | uniq -c | sort -rn | head
```

### O pico não era carga: era um defeito recorrente

Agrupando por `action`, **398 dos últimos 400 erros** eram o mesmo:

```text
outreach.inbound.account_error
TypeError: value?.toISOString is not a function
    at sqlTimestamp...   provider: "native"
```

Um erro por conta de outreach nativa, em cada passagem do processador de
entrada — e, na prática, **nenhuma resposta a entrar nas caixas nativas**. Era a
base de ruído estrutural, e a razão pela qual o valor provisório inicial de 25
estava errado: ficava 2 acima do pico recorrente e teria disparado de 45 em 45
minutos, silenciando o canal no primeiro dia.

Foi corrigido no mesmo dia (`toDate` em `outreach-inbound.ts`). A corrida
seguinte ingeriu **608 mensagens** que estavam retidas, com `errors: 0`.

### A segunda medição, depois da correção

35 minutos, abrangendo essa corrida de 608 mensagens:

| Métrica | Valor |
| --- | --- |
| Linhas de nível `error` | **0** |
| Cursores nativos com erro | **0 de 29** |

### Portanto: 15

`ERROR_SPIKE_THRESHOLD=15`. Continua bem acima de uma base silenciosa, e baixo o
suficiente para um endpoint partido — centenas de erros por minuto — disparar
dentro de uma janela. O sinal é o salto, não os erros.

> **Quando a base se move, o limiar move-se com ela.** 60 era o preço de calibrar
> contra um sistema ainda por arranjar; mantê-lo com a base a zero deixaria o
> detetor cego. E se um defeito recorrente novo levantar a base outra vez, a
> resposta é **corrigir o defeito**, não subir o limiar acima dele — isso
> silenciaria tudo o resto ao mesmo tempo.

O módulo continua a medir-se a si próprio: de hora a hora escreve uma linha com
`meanErrorsPerWindow`, `maxErrorsPerWindow` e o `configuredThreshold` em vigor.

```bash
docker logs xmail --since 24h 2>&1 | grep error_spike.baseline
```

### As duas famílias de erro

A superfície é grande: cerca de **35** chamadas a `log.error` e **246** a
`console.error`. As duas são captadas — o pino por um hook em `logger.ts`, o
resto por um tap em `console.error` instalado no arranque. Enganchar só no pino
veria ~12% dos erros.

---

## Configuração

**Estado atual (2026-08-30): tudo ligado e verificado em produção.**

| Peça | Estado |
| --- | --- |
| Linha do painel (`system_integrations`) | escrita, `telegram_enabled = true`, chat `8664810189` |
| Fonte usada pela app | **painel** — `[alerting] … credentials from the admin panel` |
| Fonte usada pela sonda externa | **painel** — `credentials resolved from: panel` |
| Cache de credenciais no Actions | populado, portanto a sonda alerta com a app em baixo |
| Secrets `MONITOR_API_TOKEN`, `TELEGRAM_*` | criados; os dois últimos são fallback |
| Workflow `Uptime` | ativo, de 15 em 15 min |

O ciclo de transição foi provado de ponta a ponta: uma falha forçada abriu a
issue `outage` e enviou 🚨; a execução seguinte fechou-a e enviou ✅.

### 1. Registar as credenciais no painel — feito

O painel tem precedência sobre o ambiente: é o único sítio onde se edita o
destino, e mudá-lo não exige deploy.

Em produção, **/admin/integrations**:

- **Bot Token:** o token do @xmailoppsbot
- **Chat ID:** `8664810189`
- **Enabled:** ligado

> **Tem de ser feito no painel de produção, não por SQL nem a partir de um
> servidor local.** O token é gravado com `encryptSecret`, que usa
> `OUTLOOK_TOKEN_ENCRYPTION_KEY`. Escrevê-lo com outra chave produz uma linha
> que parece correta e é indecifrável — foi exatamente o incidente de
> 2026-08-15. O código deteta o caso e escreve
> `[telegram] panel token could not be decrypted` no log em vez de falhar em
> silêncio.

Confirma com o botão **Test** do próprio painel.

### 2. `MONITOR_API_TOKEN` — já criado

É o segredo partilhado que deixa a sonda externa ler as credenciais de volta do
painel, através de `GET /api/admin/integrations/monitor-config`. Foi gerado com
`openssl rand -hex 32` e está como secret do repositório; os workflows de deploy
já o passam ao contentor.

Sem ele, `/monitor-config` devolve 503 e a sonda externa cai para a cópia em
cache (ou para os secrets de fallback abaixo).

Para rodar o valor:

```bash
openssl rand -hex 32 | gh secret set MONITOR_API_TOKEN
```

### 3. `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — já criados

Cobrem dois casos. Primeiro, o arranque a frio da sonda externa: a primeira
execução (ou uma depois de o cache expirar) **com a app já em baixo**, que sem
eles seria silenciosa. Segundo, a camada interna enquanto o painel não estiver
preenchido — o `telegram.ts` cai para o ambiente quando não há linha ativa.

Quando a linha do painel existir e estiver ligada, ela ganha e estes deixam de
ser lidos.

---

## O problema circular, e como está resolvido

A sonda externa existe para sobreviver à app morrer. Mas as credenciais vivem no
painel, que está *dentro* da app. Ler as credenciais da coisa que se está a
monitorizar é circular: no momento em que o alerta mais importa, a fonte das
credenciais está inacessível.

Resolução, em `scripts/resolve-alert-credentials.sh`:

1. **`/monitor-config`** — o painel ao vivo, autoritativo, lido enquanto a app
   está saudável.
2. **O cache do GitHub Actions** — a última cópia boa, que é o que realmente
   entrega o alerta durante uma falha.
3. **Secrets do repositório** — a rede de segurança do arranque a frio.

O cache só é reescrito quando o painel devolve algo diferente: as chaves de
cache são imutáveis, por isso "mudou" exprime-se como uma chave nova derivada do
hash das credenciais. O estado normal não grava nada, em vez de acumular ~96
entradas por dia.

### Se a sonda disser `resolved from: secrets` em vez de `panel`

Significa que `/monitor-config` não devolveu credenciais utilizáveis. A cadeia
degrada em silêncio de propósito — o alerta continua a ser entregue — por isso
esta linha do log é o único sinal. Três causas, por ordem de probabilidade:

1. **`MONITOR_API_TOKEN` diferente** entre o secret do repositório e o
   contentor. Sem ele no contentor o endpoint responde `503`.
2. **A rota deixou de estar na allowlist** de `src/server/lib/api-auth.ts`.
   O gate JWT global de `/api` corre antes do router, por isso responde `401`
   antes de o handler chegar a ler o seu próprio `x-monitor-token`. Foi assim
   que este endpoint ficou inalcançável desde a migration `023` (maio/2026) até
   **2026-08-30** — morto duas vezes, já que a variável também não existia.
   Pôr a rota na allowlist não a torna pública: o handler exige o token com
   comparação em tempo constante e falha fechado sem a variável.
3. **`telegram_enabled` a `false`** no painel, que o script trata como
   "não configurado" e cai para o passo seguinte.

Diagnóstico direto, de dentro do contentor:

```bash
ssh root@<host> "docker exec -e U=http://localhost:9001/api/admin/integrations/monitor-config -e H=x-monitor-token xmail node -e \"fetch(process.env.U,{headers:{[process.env.H]:process.env.MONITOR_API_TOKEN}}).then(r=>r.text().then(t=>console.log(r.status)))\""
```

`200` é o esperado; `401` é a causa 2; `503` é a causa 1.

---

## A falha nunca derruba nada

- **Sem credenciais, tudo é um no-op silencioso.** Um clone novo, o CI e
  qualquer máquina de desenvolvimento não têm linha no painel, e alertas não
  podem fazer barulho aí.
- **`sendTelegram` nunca lança e nunca rejeita.** Devolve `ok: false`. Uma
  notificação não vale falhar um envio de e-mail, um tick de cron ou um pedido.
- **`scripts/telegram-notify.sh` sai sempre com 0.** O workflow de uptime lê as
  suas próprias conclusões anteriores como histórico de falhas; um token errado
  não pode pintar uma execução de vermelho e fazer uma app saudável parecer
  instável. As falhas aparecem como anotações `::error::`, visíveis na execução
  sem lhe mudar o resultado.
- **O detetor de picos ignora os seus próprios erros** (prefixos `[telegram]`,
  `ops_alert.`, `error_spike.`), senão alimentava-se a si próprio: enviar o
  alerta falha, isso escreve um erro, que conta para o pico seguinte.

O preço disto é que um bot **mal** configurado também falha em silêncio. Por
isso todas as rejeições imprimem a explicação do próprio Telegram:

```bash
docker logs xmail 2>&1 | grep '\[telegram\]'
```

---

## A armadilha do supergrupo

Quando um grupo normal é promovido a **supergrupo** — o que o Telegram faz
sozinho assim que certas funcionalidades são ativadas — **o chat id muda**, e
todos os alertas seguintes falham. Nada parece partido; as mensagens
simplesmente param.

O código trata disto tão bem quanto é possível: extrai
`parameters.migrate_to_chat_id` da resposta e imprime o id de substituição como
valor literal para colar de volta:

```text
[telegram] rejected "Xmail is DOWN" — Bad Request: group chat was upgraded to a
supergroup chat — the group became a supergroup and its id changed. Set the chat
id to -1001234567890 in the admin panel (Integrations) to restore alerts.
```

O mesmo vale para o `403` de um bot que nunca foi contactado (um bot não pode
iniciar uma conversa) e para o `chat not found` de um id errado.

---

## Mudar o destino

Passar de conversa privada para grupo é só configuração — não há código a mudar:

1. Cria o grupo e adiciona **@xmailoppsbot**.
2. Envia **uma mensagem de texto normal** no grupo. O botão *Start* nem sempre
   gera um update na API.
3. Lê o id em `https://api.telegram.org/bot<TOKEN>/getUpdates`. **Os ids de
   grupo são negativos** (`-1001234567890` num supergrupo); mantém o sinal.
4. Substitui o Chat ID em **/admin/integrations**. É só aí — a camada interna
   relê o painel em 60 segundos, e a sonda externa apanha o valor novo na
   execução seguinte e reescreve o cache.

Se o grupo tiver **Tópicos** ativados e quiseres os alertas num tópico
específico, define também `TELEGRAM_THREAD_ID` (o número a seguir ao id do grupo
no link de uma mensagem do tópico). Sem ele, o parâmetro é omitido por completo.

---

## Testar

**A ponta externa, de ponta a ponta** — dispara o workflow com falha forçada:

```bash
gh workflow run uptime.yml -f force_failure=true
```

Deve abrir uma issue com a label `outage` e mandar 🚨. A execução seguinte, sem
o flag, fecha a issue e manda ✅.

**O canal, sem envolver a app:**

```bash
curl -s -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" -d chat_id=8664810189 -d text=teste
```

**A camada interna** — o botão *Test* em /admin/integrations.

---

## Afinação

Todos os valores são variáveis de ambiente com omissões razoáveis; ver
`.env.example`.

```text
ERROR_SPIKE_THRESHOLD=25        # erros por janela de 5 min antes de um alerta
ERROR_SPIKE_COOLDOWN_MS=1800000 # silêncio depois de um pico (30 min)
OPS_ALERT_REPEAT_MS=21600000    # quanto tempo uma condição persistente fica calada (6 h)
QUEUE_STALL_MINUTES=15          # idade de uma mensagem por enviar que conta como fila travada
RSS_WARN_MB=1024                # limiar de memória do processo
DISK_WARN_PERCENT=85            # limiar de ocupação do disco
```

---

## Ficheiros

| Ficheiro | Papel |
| --- | --- |
| `src/server/lib/telegram.ts` | o único sítio que fala com a API do Telegram; lê o painel |
| `src/server/lib/ops-alert.ts` | transições, dedup e recuperações da camada interna |
| `src/server/lib/error-spike-alert.ts` | camada agregada; mede a própria linha de base |
| `src/server/lib/error-taps.ts` | costura sem dependências entre o logger e o detetor |
| `src/server/lib/html-escape.ts` | escaping de HTML, isolado para não arrastar o `db` |
| `src/server/lib/install-alerting.ts` | tap ao `console.error` + handlers de crash |
| `src/server/jobs/alertWatchdog.ts` | fila, memória e disco, de 5 em 5 minutos |
| `scripts/telegram-notify.sh` | emissor do CI; sai sempre com 0 |
| `scripts/resolve-alert-credentials.sh` | painel → cache → secrets |
| `scripts/check-uptime.sh` | a sonda: HTTP + portas 587/993 |
| `.github/workflows/uptime.yml` | camada externa, de 15 em 15 minutos |
| `.github/workflows/build-deploy.yml` | notificação de deploy (últimos passos) |
