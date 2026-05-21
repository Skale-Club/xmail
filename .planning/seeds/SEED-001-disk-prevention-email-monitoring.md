---
id: SEED-001
status: dormant
planted: 2026-05-21
planted_during: v1.3 (Outreach Hardening) — Phase 17 complete
trigger_when: próximo milestone (v1.5) — ou qualquer milestone com foco em estabilidade/observabilidade
scope: Medium
---

# SEED-001: Prevenção de disco cheio + Monitoramento de email com Telegram e Netdata

## Why This Matters

O servidor Hetzner chegou a **100% de disco** por acúmulo de 36 imagens Docker (~35 GB)
sem limpeza automática, logs sem limite e build cache sem teto. Uma limpeza emergencial
foi feita, mas sem as proteções abaixo o problema volta em semanas.

Além do disco, não há visibilidade quando emails param de funcionar: falhas de entrega
SMTP são silenciosas, a fila pode travar sem alertar ninguém, e o outreach processor
pode parar sem que o operador saiba. O objetivo é blindar a infra e ter alertas Telegram
em tempo real para qualquer falha que impeça emails de serem enviados.

## When to Surface

**Trigger:** Próximo milestone (v1.5) — ou quando qualquer milestone tiver foco em
estabilidade, DevOps, ou observabilidade.

Este seed deve ser apresentado durante `/gsd:new-milestone` quando:
- O milestone menciona "estabilidade", "produção", "observabilidade" ou "ops"
- Há previsão de aumento de volume de emails (outreach scaling, novos clientes)
- Qualquer trabalho de infra/deploy estiver no escopo

## Scope Estimate

**Medium** — 2 fases independentes:
- **Fase A (servidor):** hardening + Netdata + crons de limpeza — sem mudança no app
- **Fase B (app):** endpoint `/api/health/email` + métricas expostas para o monitor

## Breadcrumbs

Arquivos relevantes no codebase:

- `src/server/routes/system.ts` — rota de sistema existente, montar `/api/health/email` aqui
- `src/server/routes/admin/outreach-health.ts` — health de outreach já existente, reutilizar padrão
- `src/server/lib/outreach-metrics.ts` — métricas de outreach, consumir no endpoint
- `src/server/jobs/index.ts` — jobs registrados (outreach processor, daily digest)
- `src/server/jobs/cleanupMessages.ts` — padrão de cleanup job existente
- `src/db/schema.ts` — tabelas `deliveries` e `outreach_emails` para queries do health check
- `.github/workflows/deploy-hetzner.yml` — adicionar disk check pré-build

## Notes

**O que já foi feito (2026-05-21):**
- Deploy script corrigido para remover imagens antigas após cada push
  (mantém apenas `latest` e `previous`)
- Limpeza emergencial: 36 imagens → 2, disco 100% → 20% (liberado ~29 GB)
- Build cache limitado a 500MB no deploy

**O que falta (este seed):**
- Docker daemon log rotation (`/etc/docker/daemon.json`)
- journald limite permanente (`/etc/systemd/journald.conf`)
- Remoção de snaps de desktop desnecessários (`cups`, `gnome-46-2404`, etc.)
- Limpeza semanal via cron (`docker system prune + journalctl --vacuum`)
- Netdata no host com alertas de disco, container, portas 25/587/993
- Endpoint `/api/health/email` com: fila stuck, outreach status, delivery failure rate, porta TCP
- Script monitor a cada 5min que chama o endpoint e envia alertas Telegram
- Verificação de espaço livre no deploy antes do build (falha se < 4 GB)
- Painel de integrações no app para configurar Telegram Bot Token + Chat ID (fase futura separada)

**Plano detalhado disponível em:**
`C:\Users\Vanildo\.claude\plans\generic-herding-feather.md`

**Credenciais necessárias quando executar:**
- `TELEGRAM_BOT_TOKEN` — criar via @BotFather
- `TELEGRAM_CHAT_ID` — ID do grupo/canal de alertas
- Senha para basicauth do Netdata dashboard (`monitor.skale.club`)
