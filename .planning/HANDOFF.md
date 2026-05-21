---
handoff_version: 1.0
created_at: "2026-04-15T23:45:00Z"
author: Claude (session with Vanildo)
milestone: v1.2
commit: 3b2cc41
branch: main
---

# Session Handoff — v1.2 Mail Server Production

## TL;DR

Todo o código para deixar Thunderbird/Outlook/Apple Mail funcionando com `@skale.club` está pronto, mergeado em `main` (commit `3b2cc41`) e em produção no próximo deploy. **Resta apenas 3 ações manuais de ops** — tudo documentado em `.planning/OPERATOR-CHECKLIST.md`.

## O que foi feito nesta sessão

1. **v1.1 mid-cycle — Mail Server Core** (commit `8316a86`): IMAP completo (TLS/STARTTLS/IDLE/SASL/UID ops), SMTP submission, MX receiver, autodiscovery routes (Thunderbird/Outlook/Apple), UI card, migração 018.
2. **Correção de deploy target**: projeto roda em **Hetzner VPS** (não Vercel). Docs (CLAUDE.md, README.md) atualizados. Leftovers Vercel removidos (script `build:vercel`, check `process.env.VERCEL`, pasta `api/`).
3. **v1.2 code** (commit `3b2cc41`):
   - DKIM signing outbound via `src/server/lib/dkim.ts` + nodemailer `dkim` option
   - mailauth verification inbound (SPF/DKIM/DMARC/ARC) via `src/server/lib/mail-auth.ts`
   - MX hardening (rate-limit/DNSBL/greylist/header-validation) via `src/server/lib/mx-guard.ts`
   - Deploy workflow monta `/etc/letsencrypt:ro` + passa `MAIL_TLS_CERT_PATH`/`KEY_PATH`
   - Helper `scripts/dns-checklist.ts` — gera lista DNS exata lendo DB

## Descoberta importante

Rodando `npx tsx scripts/dns-checklist.ts` confirmado: **`skale.club` já tem `verification_status=verified`** com spf/dkim/dmarc/mx todos verificados. Os registros DNS já estão publicados no registrar. Phase 11 está 100% feita.

## Estado git

- Branch: `main` (mesma do origin)
- Último commit: `3b2cc41 feat(mail): v1.2 code complete — ...`
- Não há branches feature abertas
- Working tree: limpo

## Próximas ações (ordem sugerida)

### 1. TLS cert no Hetzner (Phase 10 ops — ~10 min)
```bash
ssh root@<HETZNER_HOST>
apt update && apt install -y certbot
systemctl stop caddy
certbot certonly --standalone --non-interactive --agree-tos --email ops@skale.club -d mail.skale.club
systemctl start caddy
cat > /etc/letsencrypt/renewal-hooks/deploy/skaleclub-mail.sh <<'EOF'
#!/bin/bash
docker restart skaleclub-mail
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/skaleclub-mail.sh
docker restart skaleclub-mail
```
Verificar: `openssl s_client -connect mail.skale.club:993 -servername mail.skale.club -brief`

### 2. Ticket Hetzner — porta 25 (Phase 13 ops — 24-48h)
Hetzner Cloud Console → Support → New Ticket. Texto pronto em `.planning/OPERATOR-CHECKLIST.md` §3.

### 3. Bloco Caddy para autoconfig (SSH no host — ~1 min)
```bash
cat >> /etc/caddy/Caddyfile <<'EOF'

autoconfig.skale.club, autodiscover.skale.club {
    encode zstd gzip
    reverse_proxy localhost:9001
}
EOF
caddy reload --config /etc/caddy/Caddyfile
```

### 4. Teste end-to-end Thunderbird
`.planning/OPERATOR-CHECKLIST.md` §4 tem checklist detalhado (port25.com, mail-tester, Gmail, swaks greylist test).

## Arquivos-chave para navegar

| Arquivo | Para que serve |
|---|---|
| `.planning/OPERATOR-CHECKLIST.md` | Checklist operacional completo — **ler primeiro ao retomar** |
| `.planning/STATE.md` | Snapshot de estado + métricas |
| `.planning/milestones/v1.2-ROADMAP.md` | Roadmap do milestone com dependências |
| `.planning/milestones/v1.2-REQUIREMENTS.md` | Success criteria (10 requisitos) |
| `.planning/phases/1[0-3]-*/` | CONTEXT + PLAN de cada phase |
| `.planning/BACKLOG-mail-server.md` | Itens adiados (POP3, CardDAV, pagination FETCH, etc.) |
| `scripts/dns-checklist.ts` | `npx tsx` para ver estado DNS atual |

## Decisões-chave (pra não ter que re-discutir)

- Deploy em Hetzner (não Vercel/Railway)
- certbot dedicado no host (não compartilhar certs com Caddy)
- mailauth para verificação (não implementar do zero)
- DKIM signing apenas em `relayMessage` (não em outreach-sender — usa SMTP do usuário)
- DMARC reject downgraded pra quarantine em dev
- Greylist in-memory (não Redis — single container)

## Nada mais para fazer no código

Se rodar `git log main -5`, os últimos commits são:
```
3b2cc41 feat(mail): v1.2 code complete
bb984b7 docs: document Hetzner deploy + create v1.2 milestone
919c554 docs: mark html-to-text types fix
8316a86 feat(mail): production-grade IMAP/SMTP/MX with TLS/SASL/UID/autodiscovery
9968987 fix(mail): route Add Another Account to mailbox connect flow   ← base do upstream
```

Type-check limpo, build limpo, smoke test sobe SMTP/MX/IMAP sem erro. Sem dívida técnica bloqueante no código.

## Como retomar

Amanhã, execute um destes (em ordem de preferência):

1. **`/paul:resume`** — deve carregar este arquivo + STATE.md e sugerir ação 1 acima
2. Ou abra manualmente `.planning/OPERATOR-CHECKLIST.md` e execute §2 → §3 → §4
3. Ou simplesmente: "continue com o Phase 10 ops" — o agente carrega o contexto via STATE.md + HANDOFF.md
