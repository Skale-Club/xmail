# Phase 10 — TLS Certificates for Mail Ports

## Goal
Thunderbird connects to `mail.skale.club:993` (SSL/TLS) and `:587` (STARTTLS) without certificate warnings. The Docker container must mount and read Let's Encrypt certificates.

## Current state
- Code already supports TLS via `src/server/lib/mail-tls.ts` — reads `MAIL_TLS_CERT_PATH` and `MAIL_TLS_KEY_PATH`, falls back to plaintext if unset
- Hetzner host has Caddy serving `mail.skale.club:443` (HTTP) with Let's Encrypt certs managed by Caddy — but those certs are stored in `/var/lib/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mail.skale.club/` (Caddy-specific layout, JSON metadata around them)
- Docker container does NOT currently mount any TLS volume; deploy workflow does NOT pass `MAIL_TLS_CERT_PATH`

## Why this matters
Without TLS on 993/587, Thunderbird refuses to connect in SSL/TLS mode. The autodiscovery XML we serve tells Thunderbird to use `socketType=SSL` for IMAP — mismatch = instant config failure.

## Approach options

**Option A — Dedicated certbot on host (recommended):**
- Run `certbot certonly --standalone -d mail.skale.club` once (stop Caddy briefly or use `--webroot` with Caddy)
- Cert lands in standard `/etc/letsencrypt/live/mail.skale.club/`
- Mount `/etc/letsencrypt:/etc/letsencrypt:ro` into the container
- Set env `MAIL_TLS_CERT_PATH=/etc/letsencrypt/live/mail.skale.club/fullchain.pem`
- Certbot systemd timer renews; add `--deploy-hook "docker restart skaleclub-mail"` to reload container on renewal

**Option B — Share Caddy's certs:**
- Mount `/var/lib/caddy` into container
- Parse Caddy's cert storage layout (subject to change across Caddy versions — brittle)
- No separate renewal process
- **Not recommended** due to Caddy internal layout coupling

**Option C — ACME client inside Node container:**
- Use `acme-client` npm package to issue + renew inside the app
- Container needs port 80 temporarily for HTTP-01 challenge (conflicts with Caddy)
- Or DNS-01 challenge via Cloudflare/Supabase DNS API
- More moving parts; defer unless Option A proves unmaintainable

## Decision
**Option A.** Simplest, industry-standard, decoupled from Caddy.

## Files to touch
- `.github/workflows/deploy-hetzner.yml` — add volume mount + env vars to both `docker run` blocks (primary + rollback)
- `docker-compose.yml` — add volume mount for local parity
- `CLAUDE.md` / `README.md` — document cert setup + renewal hook
- Server-side host: install certbot, run once, set up renewal hook

## Out of scope for this phase
- Automatic cert provisioning on first deploy (assumes manual first run)
- Multi-domain certs (single `mail.skale.club` only)
- HSTS / MTA-STS policy (Phase 13)
