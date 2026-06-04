# Native SMTP, IMAP, and MX Servers

Xmail runs embedded mail servers inside the same long-running Node process as the Express API. This makes the app a small email provider: users can read mail over IMAP, send mail over SMTP submission, and receive public internet mail through the MX listener.

## Runtime Components

| File | Purpose |
|------|---------|
| `src/server/smtp-server.ts` | Authenticated SMTP submission server, usually port `587` in production and `2587` in development |
| `src/server/imap-server.ts` | IMAP4rev1 server, usually port `993` in production and `2993` in development |
| `src/server/mx-server.ts` | Public MX receiver for unauthenticated inbound mail, usually port `25` in production and `2525` in development |
| `src/server/lib/native-mail.ts` | Native mailbox creation, deletion, password auth, and local user lookup |
| `src/server/routes/mail/*` | Webmail APIs for mailboxes, messages, sending, folders, filters, and signatures |
| `src/server/routes/autodiscover.ts` | Thunderbird, Outlook, and Apple mail client autodiscovery |

## Traffic Model

```text
HTTP UI/API:
  browser -> Traefik/Coolify -> xmail:9001

Mail clients:
  Thunderbird/Outlook -> SMTP 587 -> Node SMTP server -> DB + relay/routing
  Thunderbird/Outlook -> IMAP 993 -> Node IMAP server -> DB

Inbound internet mail:
  remote MTA -> MX DNS mx.skale.club -> TCP 25 -> Node MX server -> DB or route
```

Only HTTP goes through Traefik/Coolify. Ports `25`, `587`, and `993` are published directly from Docker and bypass reverse proxies.

## Production Deployment

Production on Hetzner is deployed by `.github/workflows/deploy-hetzner.yml`:

- Runs one Docker container named `xmail`.
- Joins Docker network `coolify` when present so Traefik can route HTTP.
- Publishes `9001`, `25`, `587`, and `993` from the container.
- Mounts `/etc/letsencrypt` read-only for mail TLS certificates.
- Sets `MAIL_HOST=mx.skale.club`, `SMTP_SUBMISSION_PORT=587`, `MX_PORT=25`, `IMAP_PORT=993`, and `ENABLE_MAIL_SERVER=true`.

The MX DNS for `skale.club` points to `mx.skale.club`. The certificate paths in production point at `/etc/letsencrypt/live/mx.skale.club/...`.

## Environment

```env
MAIL_HOST=mx.yourdomain.com
MAIL_DOMAIN=yourdomain.com
SMTP_SUBMISSION_PORT=587
MX_PORT=25
IMAP_PORT=993
ENABLE_MAIL_SERVER=true
MAIL_TLS_CERT_PATH=/etc/letsencrypt/live/mx.yourdomain.com/fullchain.pem
MAIL_TLS_KEY_PATH=/etc/letsencrypt/live/mx.yourdomain.com/privkey.pem
```

In development, leave TLS unset and use high ports:

```env
MAIL_HOST=localhost
MAIL_DOMAIN=yourdomain.com
SMTP_SUBMISSION_PORT=2587
MX_PORT=2525
IMAP_PORT=2993
```

## Mail Arrival Logs

Mail server logs go to Docker stdout/stderr. There are no local `.log` files for inbound delivery.

```bash
# MX arrival, route matching, and mail authentication
docker logs xmail --since 24h 2>&1 | grep -E '\[MX\]|\[RouteMatcher\]|\[mail-auth\]'

# SMTP submission and IMAP logins
docker logs xmail --since 24h 2>&1 | grep -E '\[SMTP\]|\[IMAP\]'
```

Useful success lines:

```text
[MX] Delivered to INBOX: user@example.com (...)
[MX] Delivered to SPAM: user@example.com (...)
[MX] Routed: route@example.com
[SMTP] Auth ok: user@example.com (...)
[IMAP] Login ok: user@example.com (...)
```

Useful rejection/error lines:

```text
[MX] Greylisted: ...
[MX] AUTH REJECT ...
[MX] Spamhaus-listed IP rejected: ...
[MX] Processing error: ...
[RouteMatcher] ... NO MATCHING ROUTES
[RouteMatcher] ... domain "..." has NO ORG
```

## Diagnostics

```bash
# Public app health
curl -sS https://mail.skale.club/health
curl -sS https://mail.skale.club/health/mail

# Host-local health during deploy/SSH
curl -sf http://localhost:9001/health
curl -sS http://localhost:9001/health/mail

# Admin-only deep mail diagnostic, requires auth token
curl -sS "https://mail.skale.club/api/system/mail-diag?testEmail=user@skale.club" \
  -H "Authorization: Bearer <jwt>"
```

`/health/mail` reports whether mail TLS loaded and which ports the process expects. `mail-diag` checks verified domains, users, native mailboxes, and whether a test address would deliver locally.

## Mail Client Settings

| Setting | Production value |
|---------|------------------|
| IMAP host | `mx.skale.club` |
| IMAP port | `993` |
| IMAP security | SSL/TLS |
| SMTP host | `mx.skale.club` |
| SMTP port | `587` |
| SMTP security | STARTTLS |
| Username | full email address |
| Password | user's Xmail password |

Autodiscovery endpoints expose these settings publicly without leaking user data.
