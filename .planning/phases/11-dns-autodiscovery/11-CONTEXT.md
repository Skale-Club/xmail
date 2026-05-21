# Phase 11 — DNS + Autodiscovery

## Goal
All DNS records for `skale.club` published and verified, so that:
1. External mail servers find our MX
2. SPF/DKIM/DMARC policies validate outbound mail
3. Thunderbird finds autoconfig automatically from `user@skale.club`

## Current state
- Domain `skale.club` is registered and has a row in the `domains` table with `dkim_private_key`, `dkim_public_key`, `dkim_selector='skaleclub'` already generated
- `domains.ts:173 /verify` endpoint can check DNS records — works, but the records themselves need to exist at the registrar/DNS provider
- Whether the records are currently published: **UNKNOWN — must verify before any other phase proceeds**
- Autodiscovery routes are code-complete (`src/server/routes/autodiscover.ts`) but need `autoconfig.skale.club` CNAME to be reachable

## DNS provider
TBD — check where `skale.club` is managed (Cloudflare, Registro.br, Google Domains, etc.). All records below are provider-agnostic.

## Required records

```
; ------ Core web/API ------
mail.skale.club.              A      <HETZNER_VPS_IP>
skale.club.                   A      <HETZNER_VPS_IP>         ; if apex serves anything

; ------ Mail exchange ------
skale.club.                   MX  10 mail.skale.club.

; ------ SPF (authorizes Hetzner IP to send) ------
skale.club.                   TXT    "v=spf1 a mx ip4:<HETZNER_VPS_IP> ~all"

; ------ DKIM (public key from domains.dkim_public_key) ------
skaleclub._domainkey.skale.club. TXT "v=DKIM1; k=rsa; p=<base64 public key>"

; ------ DMARC (start with 'none' for observation, move to 'quarantine' in Phase 12) ------
_dmarc.skale.club.            TXT    "v=DMARC1; p=none; rua=mailto:dmarc@skale.club; ruf=mailto:dmarc@skale.club; fo=1"

; ------ Autodiscovery (Thunderbird) ------
autoconfig.skale.club.        CNAME  mail.skale.club.

; ------ Autodiscover (Outlook — classic) ------
autodiscover.skale.club.      CNAME  mail.skale.club.

; ------ MTA-STS (optional, Phase 13) ------
_mta-sts.skale.club.          TXT    "v=STSv1; id=<timestamp>"
mta-sts.skale.club.           CNAME  mail.skale.club.

; ------ TLS-RPT (optional) ------
_smtp._tls.skale.club.        TXT    "v=TLSRPTv1; rua=mailto:tls-reports@skale.club"
```

## Verification path
1. Get `dkim_public_key` from DB: `SELECT dkim_public_key FROM domains WHERE name='skale.club'`
2. Get VPS IP from Hetzner console
3. Publish records at DNS provider
4. Wait for propagation (up to 1h, usually <5min)
5. `dig +short <record>` from external network; all must resolve
6. `POST /api/domains/<id>/verify` — all statuses become `verified`

## Autodiscovery verification
After `autoconfig.skale.club` resolves to VPS:
1. Thunderbird on public network → New Account → enter `user@skale.club` + password
2. Thunderbird queries `https://autoconfig.skale.club/mail/config-v1.1.xml?emailaddress=user@skale.club` (via Caddy HTTPS or HTTP)
3. Our server responds with XML pointing to `mail.skale.club:993/SSL` + `mail.skale.club:587/STARTTLS`
4. Thunderbird presents "we found these settings" UI — user clicks Done
5. IMAP sync starts

## Out of scope for this phase
- Actually signing mail with DKIM (Phase 12)
- MTA-STS policy file (Phase 13)
- Reverse DNS (PTR) — Hetzner allows setting this in customer portal; not strictly required but helps deliverability (add as backlog sub-item)
