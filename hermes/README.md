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

- **Principal:** Kimi Coding Plan — `provider: kimi-coding`, `model: kimi-for-coding`
  (key `KIMI_API_KEY`, prefixo `sk-kimi-` → auto-roteia pra `api.kimi.com/coding/v1`).
- **Fallback:** `openrouter` / `google/gemini-2.5-flash` (em `config.yaml` `fallback_providers:`,
  dispara em rate-limit / 5xx / erro de conexão, sem perder a conversa).
- **Modelo vive no `config.yaml`** (no volume), NÃO em env var — ver "Gotchas" abaixo.

## Canais

- **Telegram:** bot `@skaleclubhermesbot`, allowlist travada no user id `5209892068` (@vdesjr),
  que também é o `TELEGRAM_HOME_CHANNEL` (notificações/cron caem aí). Polling de saída, sem porta aberta.
- **CLI:** `docker exec -it hermes hermes chat` (interativo) ou `hermes -z "prompt"` (one-shot).

## Decisões de design (pra caber na máquina pequena)

- **Container separado** do xmail (que é rebuildado `--no-cache` a cada deploy) — não dentro dele.
- `TERMINAL_ENV=local` — Hermes **não** sobe containers Docker extras (protege RAM).
- **Só o gateway** (a imagem s6 ainda supervisiona um dashboard interno em 127.0.0.1, não publicado).
- Browser automation **off** (sem keys de browser → nenhum Chromium sobe sozinho).
- `mem_limit: 1g` + `memswap_limit: 2g` + `cpus: 1.0` — guard-rail: o Hermes nunca derruba o email por OOM.
- Rede default bridge, **sem portas publicadas** → isolado do xmail.

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

## Build do zero (referência)

```bash
ssh root@49.13.197.250
mkdir -p /opt/hermes && cd /opt/hermes
# copie docker-compose.yml e hermes.env (a partir de hermes.env.example) pra cá
git clone --depth 1 https://github.com/NousResearch/hermes-agent.git vendor/hermes-agent
DOCKER_CONFIG=/tmp/emptydocker docker compose build      # ~minutos no 2-vCPU
DOCKER_CONFIG=/tmp/emptydocker docker compose up -d
docker exec hermes hermes config set model.provider kimi-coding
docker exec hermes hermes config set model.default  kimi-for-coding
docker compose restart hermes
```

## Reverter / parar

```bash
docker compose down                       # para (volume hermes-data preserva memória)
docker volume rm hermes_hermes-data       # apaga a memória do agente (irreversível)
# backup do config antes do Kimi: /opt/data/config.yaml.bak-pre-kimi
```
