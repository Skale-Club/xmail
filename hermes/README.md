# Hermes Agent no host do xmail

[Hermes Agent](https://hermes-agent.nousresearch.com/) (Nous Research) rodando **no
mesmo Hetzner do xmail**, em container próprio, isolado do servidor de email, com
LLM **externo** (sem GPU local) e teto de RAM pra nunca ameaçar o email.

> **Status: IMPLANTADO em 2026-06-08.** Este doc descreve a instalação real em produção.

## Onde está

- **Host:** `49.13.197.250` (mesmo do xmail — `mail.skale.club`/`mx.skale.club`), Ubuntu 24.04, root via SSH.
- **Diretório no host:** `/opt/hermes/` → `docker-compose.yml` + `hermes.env` (secrets, `chmod 600`) + `vendor/hermes-agent` (upstream clonado, contexto de build).
- **Container:** `hermes` (imagem `hermes-agent:local`, v0.16.0), `restart: unless-stopped`.
- **Volume:** `hermes-data` → home do agente `/opt/data` (memória, `config.yaml`, `auth.json`, `SOUL.md`). Sobrevive a recriação/deploy.
- **Versionado neste repo:** `hermes/docker-compose.yml`, `hermes/hermes.env.example`, este README.

## Specs da máquina (verificadas 2026-06-08)

| Recurso | Valor |
|---|---|
| CPU / RAM | 2 vCPU / 3.7 GB + **2 GB swap** (criado pra isso, `vm.swappiness=10`) |
| Disco | 38 GB, ~26 GB livres |
| GPU | nenhuma → **LLM só via API externa** |
| Coabita com | `xmail` + stack Coolify (traefik, postgres, redis…) |
| RAM do Hermes em idle | **~113 MiB** de 1 GiB (teto `mem_limit`) |

## Config atual (LLM)

- **Principal (desde 2026-08-14):** OpenAI Codex via OAuth — `provider: openai-codex`,
  `model: gpt-5.6-sol` (explicitamente Sol, não Terra/Luna). A credencial renovável
  vive em `/opt/data/auth.json`; não usa `OPENAI_API_KEY`.
- **Único fallback:** `opencode-go` / `kimi-k3`.
- A cadeia em `config.yaml` dispara em rate-limit, 5xx ou erro de conexão sem perder a conversa.
- **Modelo vive no `config.yaml`** (no volume), NÃO em env var — ver "Gotchas" abaixo.

## Canais

- **Telegram:** bot `@skaleclubhermesbot`, allowlist travada no user id `5209892068` (@vdesjr),
  que também é o `TELEGRAM_HOME_CHANNEL` (notificações/cron caem aí). Polling de saída, sem porta aberta.
- **CLI:** `docker exec -it hermes hermes chat` (interativo) ou `hermes -z "prompt"` (one-shot).

## Papel: orquestrador do Active Prospect System (verificado 2026-08-13)

O Hermes não é só um assistente de chat — ele **orquestra o pipeline de prospecção**
inteiro (a memória do agente registra: "EU disparo as ações, não peço pro Vanildo
fazer no navegador"):

1. Vanildo pede no Telegram ("vamos prospectar X em Y").
2. Hermes chama `POST $XCRAPER_SERVICE_URL/scrape` (xcraper em
   `https://xcraper.skale.club/api/service`, autenticado por `XCRAPER_SERVICE_KEY`
   no `hermes.env`) e faz poll de `/scrape/<id>` a cada ~20s até `completed`.
3. O xcraper (Apify/Google Maps) faz **auto-push pro Xphere** como prospects
   (`source=xcraper`, `lifecycle_stage=prospect`); o **Website Analyzer do Xphere**
   roda sozinho em quem tem domínio (audit + screenshots + lead_score +
   websiteInsights multilíngue).
4. Hermes tria os resultados e recomenda; **Vanildo aprova só o sensível**
   (prospect→lead, disparo de outreach; preview de website é manual only).
5. Outreach: via MCP do **Xphere** — `xmail_outreach_status` (lista campanhas/inboxes)
   e `prospects_enroll_in_campaign` (enrola E ativa; dry-run por padrão, só executa
   com `confirmed:true` após aprovação explícita no Telegram).
6. Meta/Facebook Audiences: `meta_audiences_status` mostra a configuração e
   `meta_audience_sync` faz preview agregado. Um sync real de ADD/REMOVE exige
   `confirmed:true`, termos aceitos e a audiência habilitada no Xphere.

### Journey e skill operacional

- A skill ativa é `/opt/data/skills/skale-club/active-prospect-system/SKILL.md`;
  a cópia versionada para deploy fica em `hermes/active-prospect-system/SKILL.md`.
- Todo scrape iniciado pelo Hermes inclui uma hipótese declarada antes do run.
- O Xcraper envia `external_run_id`, custo real e contagens ao Xphere; o Xphere
  registra o run no Xmail e propaga `source_run_id` aos leads.
- O Xmail mede outcomes a cada seis horas. Fatos, custos e outcomes permanecem
  separados; o Hermes consulta o estado atual em vez de confiar em números
  gravados na skill.

### MCPs conectados (4)

| Nome | Transporte | Papel |
|---|---|---|
| `xphere` | `https://xphere.app/api/mcp` | prospects, Website Analyzer, enrollment/ativação de campanha |
| `skaleclub` | `https://skale.club/mcp` | site/serviços Skale Club |
| `notion` | stdio `npx @notionhq/notion-mcp-server` | workspace Skale Club |
| `xmail` | stdio `node /opt/xmail-mcp/server.mjs` | gateway escopado `/api/agent/outreach/*` |

> A fronteira de segurança descrita em `docs/outreach-hermes-architecture.md`
> (sem ativação, sem envio) vale **apenas para o gateway do xmail**. Pelo MCP do
> Xphere o Hermes consegue enrolar e ativar campanhas — o gate ali é o
> `confirmed:true` + aprovação humana no chat, não uma restrição de capability.

### Crons ativos (2026-08)

- `hermes-memories-backup` — 02:00 ET diário, `scripts/hermes-backup.sh`, modo no-agent.
- `email-verification-credits` — 09:00 ET diário, `verification-credits.py`, modo no-agent.
- `weekly-health-check` — **pausado** desde 2026-08-10 (custo recorrente).

## Notion + Health Check semanal (adicionado 2026-07-08)

- **MCP do Notion conectado** ao Hermes via servidor stdio oficial
  (`npx @notionhq/notion-mcp-server`, Node 22 já presente no container),
  autenticado por um **integration token** do workspace Skale Club. O token vive
  no `config.yaml` do volume (NÃO neste repo). 24 tools (`API-*`) habilitadas.
  Adicionado com:
  ```bash
  docker exec -e HERMES_ACCEPT_HOOKS=1 -i hermes hermes mcp add notion \
    --command npx --args @notionhq/notion-mcp-server \
    --env npm_config_yes=true NOTION_TOKEN=<token>
  # responda "Y" no prompt "Enable all 24 tools?" (por isso o -i + pipe de Y)
  ```
  > `npm_config_yes=true` substitui o `-y` do npx: o argparse do Hermes trata
  > `-y` como flag dele e quebra (`unrecognized arguments`).
- **Cron `weekly-health-check`** — `0 8 * * 1` (**segunda 08:00 ET**), entrega no
  Telegram. Executa o "🩺 Weekly Health Check Protocol" (página do Notion
  `398b7a68612181d1acd7f23d5b93b9a6`): varre os Active Projects em modo read-only,
  cria um report em "Project Health Reports" (Backlog & Ideas) e resume no
  Telegram. Editar: `hermes cron edit f7c84063a699 ...`; testar: `hermes cron run <id>`.
- **Timezone:** o container roda `TZ=America/New_York` (operador em Boston). O
  scheduler usa server-local time, então **todos os cron schedules são em ET e
  DST-safe**. Setado no `docker-compose.yml` (requer `docker compose up -d` pra
  aplicar; o offset em jobs já existentes só recalcula ao editar o schedule).
- **Budget:** `agent.max_turns` subido de 60 → 120
  (`hermes config set agent.max_turns 120`) — a travessia do protocolo é profunda.

> **Atualização 2026-08-10:** o `weekly-health-check` foi pausado para eliminar seu
> consumo recorrente. O backup diário `hermes-memories-backup` roda
> `scripts/hermes-backup.sh` em modo `no-agent`. O serviço systemd
> `hermes-provider-switch-notifier` observa ativações de fallback no log do Hermes e
> avisa o canal pessoal do Telegram quando o `kimi-k3` entra em uso.

> **Atualização 2026-08-13 — escopo do backup.** O `hermes-backup.sh` usava
> `git add -A` dentro de `/opt/data`, então publicava **534 arquivos** no repo com
> remote no GitHub (`config.yaml`, `config/auth.json`, `.env`, e 500+ logs de cron),
> e não apenas os arquivos de memória que ele copia. Agora o script adiciona
> pathspec explícito e instala `scripts/backup-repo.gitignore` (deny-by-default,
> reabrindo só `MEMORY.md`/`USER.md`) dentro do repo de backup. Os 532 arquivos
> saíram do índice — **continuam no disco e no volume `hermes-data`**, que é a via
> real de recuperação. O histórico anterior não foi reescrito: o repo é privado e a
> reescrita/rotação foi avaliada como custo maior que o risco.
>
> O cron roda com `HOME=/opt/data/home` (é de lá que vem a identidade git). Para
> executar o script na mão, replique isso:
> `docker exec -u hermes -e HOME=/opt/data/home hermes /opt/data/scripts/hermes-backup.sh`

## Decisões de design (pra caber na máquina pequena)

- **Container separado** do xmail (que é rebuildado `--no-cache` a cada deploy) — não dentro dele.
- `TERMINAL_ENV=local` — Hermes **não** sobe containers Docker extras (protege RAM).
- **Só o gateway** (a imagem s6 ainda supervisiona um dashboard interno em 127.0.0.1, não publicado).
- Browser automation **off** (sem keys de browser → nenhum Chromium sobe sozinho).
- `mem_limit: 1g` + `memswap_limit: 2g` + `cpus: 1.0` — guard-rail: o Hermes nunca derruba o email por OOM.
- Rede default bridge, **sem portas publicadas** → isolado do xmail.

## Xmail outreach MCP

O Hermes usa o gateway versionado em `xmail-mcp/server.mjs`, montado como
`/opt/xmail-mcp/server.mjs`. Ele autentica com uma credencial exclusiva e escopada; nunca coloque
`XMAIL_SERVICE_KEY` no Hermes.

Depois de aplicar a migration 045 e criar a credencial pela API administrativa do Xmail, adicione
`XMAIL_AGENT_API_URL` e `XMAIL_AGENT_KEY` ao `hermes.env`, recrie o container e registre o MCP:

```bash
docker compose up -d --force-recreate
docker exec -it hermes hermes mcp add xmail \
  --command node \
  --env 'XMAIL_AGENT_API_URL=${XMAIL_AGENT_API_URL}' \
        'XMAIL_AGENT_KEY=${XMAIL_AGENT_KEY}' \
  --args /opt/xmail-mcp/server.mjs
```

O `env` do MCP e obrigatorio mesmo quando as variaveis ja existem no container. O Hermes filtra o
ambiente de subprocessos stdio e so encaminha secrets declarados explicitamente; os placeholders
sao resolvidos em memoria a partir do ambiente do container, sem duplicar os valores no
`config.yaml`.

As tools permitem leitura, busca Apollo sem consumo de créditos, scoring/listagem de candidatos,
importação limitada, criação de rascunho, pausa e consumo de eventos. Enriquecimento pago fica fora
do MCP até passar por aprovação durável no Xmail.
Não existe tool de ativação nem envio direto. O contrato completo e o rollout estão em
`docs/outreach-hermes-architecture.md`.

## Operação

```bash
ssh root@49.13.197.250
cd /opt/hermes

docker compose ps                     # estado
docker stats hermes --no-stream       # RAM/CPU
docker logs hermes --tail 50          # logs do container (stdout s6)
docker exec hermes hermes logs        # logs detalhados do gateway
docker exec hermes hermes status      # provider/modelo/keys
docker exec -it hermes hermes chat    # conversar via CLI
```

### Trocar modelo / provider

```bash
docker exec hermes hermes config set model.provider <provider>
docker exec hermes hermes config set model.default  <modelo>
docker compose restart hermes         # gateway recarrega o config
```

### Fallback

```bash
docker exec hermes hermes fallback list          # ver a cadeia
# `hermes fallback add` é INTERATIVO (não dá pra script).
# Pra setar sem interação, edite `fallback_providers:` em /opt/data/config.yaml
# (ele nasce como `fallback_providers: []`) e dê restart.
```

### Adicionar um canal (ex.: novo allowlist / token)

Edite `/opt/hermes/hermes.env` e `docker compose up -d --force-recreate`.

## ⚠️ Gotchas (aprendidos no deploy)

1. **Build puxando do ghcr.io falha com `denied`.** O host tem uma credencial ghcr
   **expirada** do Coolify em `/root/.docker/config.json` que quebra TODO pull do ghcr
   (até imagem pública). Workaround: buildar/pullar com `DOCKER_CONFIG=/tmp/emptydocker`
   (pull anônimo). Ex.: `DOCKER_CONFIG=/tmp/emptydocker docker compose build`.
2. **Modelo do gateway vem do `config.yaml`, não de env var.** `HERMES_INFERENCE_MODEL`
   só afeta CLI direto, não o gateway/Telegram. O `config.yaml` nasce default em
   `anthropic/claude-opus-4.6` (caro!) — sempre fixe o modelo no `config.yaml`.
3. **`hermes config set` aceita chaves aninhadas** (`model.provider`, `model.default`)
   e gera o bloco YAML certo.
4. **Após mudar modelo/fallback, reinicie o container** pra o gateway recarregar.
5. **Append em arquivo sem newline final gruda linhas.** Ao editar `hermes.env` por
   `>>`, garanta `\n` final (o exemplo já termina com newline).
6. **Notion: use as tools do Notion, NÃO o browser.** Um prompt dizendo "fetch the
   page at https://notion.so/…" faz o agente tentar `browser_navigate` (Chrome não
   instalado — browser automation está off) e falhar com "task is blocked". O prompt
   do cron referencia a página pelo **ID** e manda usar só as tools `API-*` do Notion.
7. **O CLI (`hermes -z`) NÃO usa a cadeia de fallback; o gateway usa.** Descoberto em
   2026-08-15, com o Codex em `usage_limit_reached (429)` por 5 dias. A cadeia em
   `config.yaml` dispara em *rate-limit, 5xx ou erro de conexão* — mas o CLI filtra a
   credencial indisponível e reporta **`No Codex credentials stored`**, que não é
   nenhum dos três, então o fallback nunca casa. A mensagem é enganosa: a credencial
   existe, está é em cooldown. Confira com `docker exec -u hermes hermes hermes auth`,
   que mostra o estado real e quanto falta.
   **Workaround (testado):** force o provider na chamada.
   ```bash
   docker exec -u hermes hermes hermes -z "prompt" --provider opencode-go -m kimi-k3
   ```
   Sem isso é fácil concluir que o Hermes está fora do ar quando ele só precisa de um
   flag. Pior: um `hermes -z` que morre por credencial pode ter **executado ações
   antes de falhar** — foi o que aconteceu naquele dia, e um scrape pago acabou
   rodando duas vezes porque o `ps aux` no container não mostrou o processo e eu
   concluí que ele nunca tinha começado. **Verifique o efeito no banco, não o
   processo.**

8. **O protocolo é pesado pro modelo de fallback.** A varredura completa pode consumir
   muitos turns (buscas do Notion voltam com 100k+ chars e incham o contexto), inclusive
   quando `kimi-k3` assume após uma falha do Codex. Mitigações: prompt enxuto (usar
   `last_edited_time`/metadata e `API-query-data-source` em vez de `get_block_children`
   de páginas grandes) + `agent.max_turns` folgado.

## Build do zero (referência)

```bash
ssh root@49.13.197.250
mkdir -p /opt/hermes && cd /opt/hermes
# copie docker-compose.yml e hermes.env (a partir de hermes.env.example) pra cá
git clone --depth 1 https://github.com/NousResearch/hermes-agent.git vendor/hermes-agent
DOCKER_CONFIG=/tmp/emptydocker docker compose build      # ~minutos no 2-vCPU
DOCKER_CONFIG=/tmp/emptydocker docker compose up -d
# Device-code OAuth: abra a URL mostrada e autorize com a conta do Codex.
docker exec -it hermes hermes auth add openai-codex --type oauth
docker exec hermes hermes config set model.provider openai-codex
docker exec hermes hermes config set model.default gpt-5.6-sol
# No picker, selecione OpenCode Go → kimi-k3 como único fallback.
docker exec -it hermes hermes fallback add
docker compose restart hermes
```

## Reverter / parar

```bash
docker compose down                       # para (volume hermes-data preserva memória)
docker volume rm hermes_hermes-data       # apaga a memória do agente (irreversível)
# backup anterior à troca para GPT-5.6 Sol: /opt/data/config.yaml.bak-pre-gpt56-20260814
```
