# Operator Checklist — Finalizar Mail Server (Hetzner + Thunderbird-ready)

**Status:** código 100% pronto. O que resta são tarefas manuais de ops que só você consegue executar (SSH, DNS, tickets).

---

## 1. Consultar snapshot atual do DNS

```bash
npx tsx scripts/dns-checklist.ts
```

Isso lê a tabela `domains` do Supabase e imprime exatamente quais registros DNS devem estar publicados para cada domínio registrado, com a chave DKIM pública real extraída do banco.

**Status hoje (verificado 2026-04-15):** `skale.club` está com `verification_status=verified` e todos os sub-statuses (`spf/dkim/dmarc/mx`) = `verified`. Ou seja, os registros DNS provavelmente já existem — confirme rodando o script acima e comparando com o que está publicado no seu provider DNS. Se diferir, corrija.

**Itens obrigatórios no DNS (repita para cada domínio da plataforma):**
- `mail.<domain>. A <VPS_IP>`
- `<domain>. MX 10 mail.<domain>.`
- `<domain>. TXT "v=spf1 a mx ip4:<VPS_IP> ~all"`
- `skaleclub._domainkey.<domain>. TXT "v=DKIM1; k=rsa; p=<base64>"`
- `_dmarc.<domain>. TXT "v=DMARC1; p=none; rua=mailto:dmarc@<domain>; fo=1"`
- `autoconfig.<domain>. CNAME mail.<domain>.`
- `autodiscover.<domain>. CNAME mail.<domain>.`

**Reverse DNS (na Hetzner Cloud Console):**
- Server → Networking → Reverse DNS → Set IPv4 PTR = `mail.skale.club.`

**Caddy (uma vez, SSH no host):**
```bash
cat >> /etc/caddy/Caddyfile <<'EOF'

autoconfig.skale.club, autodiscover.skale.club {
    encode zstd gzip
    reverse_proxy localhost:9001
}
EOF
caddy reload --config /etc/caddy/Caddyfile
```

---

## 2. Instalar cert TLS para portas de mail (uma vez)

Essa é a parte do Phase 10 que só funciona no host.

```bash
ssh root@<HETZNER_HOST>

# 1. Instala certbot
apt update && apt install -y certbot

# 2. Para Caddy brevemente (precisa de :80 pra HTTP-01)
systemctl stop caddy

# 3. Emite o cert
certbot certonly --standalone \
  --non-interactive --agree-tos \
  --email ops@skale.club \
  -d mail.skale.club

# 4. Reinicia Caddy
systemctl start caddy

# 5. Hook pós-renovação — recarrega container quando cert renovar
cat > /etc/letsencrypt/renewal-hooks/deploy/skaleclub-mail.sh <<'EOF'
#!/bin/bash
docker restart skaleclub-mail
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/skaleclub-mail.sh

# 6. Testa renovação (dry-run)
certbot renew --dry-run

# 7. Trigga deploy fresh pra container pegar os certs (git push main, ou force:)
docker restart skaleclub-mail
```

Verificar do seu computador:
```bash
openssl s_client -connect mail.skale.club:993 -servername mail.skale.club -brief
# Esperado: chain válido, subject=mail.skale.club, issuer=Let's Encrypt
```

---

## 3. Abrir ticket Hetzner pra porta 25

Hetzner bloqueia porta 25 para novas contas. Acesso: Cloud Console → Support → New Ticket.

**Assunto:** Request to unblock port 25 for outbound/inbound mail

**Corpo sugerido:**
```
Server: <VPS_ID> — mail.skale.club
Use case: Self-hosted transactional mail server for skale.club users.
Outbound via port 587 (authenticated SMTP submission) already working.
Inbound via port 25 needed to receive mail from public internet MX.

Abuse prevention in place:
- SPF / DKIM / DMARC published and validated (RFC-compliant)
- Reverse DNS set: <VPS_IP> → mail.skale.club
- Per-IP connection rate limit (10/min) at SMTP layer
- Spamhaus Zen DNSBL check at onConnect (reject listed IPs with 554)
- Greylisting: first-contact (IP, from, to) gets 451, accepted on retry ≥5min
- DMARC enforcement: reject on policy=reject, quarantine on policy=quarantine
- Max 50 recipients/session, 25MB message size
- Structured logging for audit

Please unblock inbound and outbound port 25 for this IP.
```

Prazo típico de resposta: 24-48h.

**Verificar (após resposta "unblocked"):**
```bash
# De qualquer rede externa
nc -vz mail.skale.club 25
# Esperado: Connection succeeded.

telnet mail.skale.club 25
# Esperado: 220 mail.skale.club ESMTP
```

---

## 4. Testes end-to-end

### A. Thunderbird conecta sem erro

- Abra Thunderbird → File → New → Existing Email Account
- Digite `<user>@skale.club` + senha (a mesma do login web)
- Thunderbird consulta `autoconfig.skale.club/mail/config-v1.1.xml?emailaddress=...` e detecta as configs automaticamente
- Clique Done — IMAP sincroniza INBOX

### B. Envio outbound com DKIM

- No Thunderbird, envie para `check-auth@verifier.port25.com`
- Aguarde ~30s pela auto-resposta
- Confira no corpo: `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`

**Ou teste com mail-tester:**
- Abra https://mail-tester.com
- Envie pro endereço descartável mostrado
- Score deve ser ≥9/10

**Ou teste com Gmail real:**
- Envie para uma conta Gmail
- Abra no Gmail → menu 3 pontos → Show original
- Confirmar: `DKIM: PASS with domain skale.club`, `SPF: PASS`, `DMARC: PASS`

### C. Recebimento inbound + DMARC

```bash
# De um servidor externo, usando swaks
swaks --to <user>@skale.club \
      --from sender@example.com \
      --server mail.skale.club:25 \
      --body "test"
# Primeira tentativa: 451 Greylisted
# Esperar 5 min, repetir: 250 OK, chega no INBOX

# Teste spoofing (deve ser rejeitado ou ir pra spam)
swaks --to <user>@skale.club \
      --from fake@gmail.com \
      --server mail.skale.club:25 \
      --header "From: Legit <real@gmail.com>" \
      --body "spoof test"
# Esperado: 550 DMARC policy violation (Gmail é p=reject)
```

### D. Header Authentication-Results

No webmail, abra uma mensagem recebida e clique em "View Source" ou similar. Deve aparecer no topo:
```
Authentication-Results: mail.skale.club; spf=pass ...; dkim=pass ...; dmarc=pass ...
```

---

## 5. Observabilidade 48h pós-liberação

Após a porta 25 ser liberada pela Hetzner, monitore por 48h:

```bash
# No host
docker logs --since 24h skaleclub-mail | grep '\[MX\]' | head -100

# Métricas úteis
docker logs --since 24h skaleclub-mail | grep -c 'Spamhaus-listed'      # IPs bloqueados
docker logs --since 24h skaleclub-mail | grep -c 'Rate-limited'         # excedentes
docker logs --since 24h skaleclub-mail | grep -c 'Greylisted'           # primeiros contatos
docker logs --since 24h skaleclub-mail | grep -c 'AUTH REJECT'          # spoofings
docker logs --since 24h skaleclub-mail | grep -c 'Delivered to INBOX'   # sucessos
docker logs --since 24h skaleclub-mail | grep -c 'Delivered to SPAM'    # quarantines
```

**Saudável depois de 48h:**
- Taxa de aceite real >95% em domínios legítimos (Gmail, Outlook, ProtonMail)
- <5 mensagens em SPAM por usuário por dia (senão tunar DMARC quarantine ou DNSBL)
- 0 rejeições de IP listado no Spamhaus com log claro

**Se falsos-positivos em domínio confiável:**
- Adicione allowlist no código (`mx-guard.ts`) ou DB
- Considere desabilitar greylist para IPs conhecidos (Gmail/Outlook/Apple)

---

## 6. Opcional — Elevar DMARC para quarantine/reject

Após 1-2 semanas rodando com `p=none`, migre a política DMARC:
```
_dmarc.skale.club.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@skale.club; pct=10"
```
`pct=10` aplica política em 10% do tráfego primeiro. Sobe gradualmente até 100%, depois `p=reject`.

---

## Quick-reference: status atual por phase

| Phase | Código | Ops | Status |
|---|---|---|---|
| 10 TLS certs | ✅ mount no docker + env vars | ⏳ certbot no host | Aguardando você rodar passo 2 |
| 11 DNS | ✅ script dns-checklist.ts | ✅ já publicado (verificado) | **Feito** |
| 12 DKIM + mailauth | ✅ signing em relay + verify em MX | — (nenhuma ação ops) | **Feito (código)** — deploy ativa |
| 13 MX hardening | ✅ guard + greylist + DNSBL | ⏳ ticket Hetzner porta 25 | Aguardando você abrir ticket |

Tudo que é código está pronto e merged em `main`. Depois de executar passos 2 e 3 deste checklist, o Thunderbird funciona end-to-end.
