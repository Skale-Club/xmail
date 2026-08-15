# External Integrations

**Analysis Date:** 2026-03-31

## Authentication

| Provider | SDK/Client | Config Location | Purpose |
|---------|-----------|-----------------|---------|
| Supabase Auth | `@supabase/supabase-js` 2.39.8 | `src/server/lib/supabase.ts`, `src/lib/supabase.ts` | JWT-based user authentication |
| Supabase Auth (health) | Native `fetch` | `src/server/lib/supabase.ts` (`checkSupabaseAuthHealth`) | Auth service health monitoring |
| bcrypt | `bcrypt` 6.0.0 | `src/server/lib/native-mail.ts` | SMTP/IMAP password hashing |
| JWT | `jsonwebtoken` 9.0.2 | `src/server/lib/native-mail.ts` | SMTP/IMAP session tokens |

**Auth flow:**
1. Frontend: `supabase.auth.signInWithPassword` (`src/lib/supabase.ts`)
2. JWT sent as `Authorization: Bearer <token>` on every API request
3. Server middleware validates via `supabaseAnonClient.auth.getUser(token)` in `src/server/index.ts`
4. Protected routes receive `x-user-id`, `x-user-email`, `x-user-first-name`, `x-user-last-name`, `x-user-email-verified` headers
5. Platform admin: `users.isAdmin` flag checked via `isPlatformAdmin()` in `src/server/lib/admin.ts`
6. RLS policies enforce organization-level data isolation at database layer

**Supabase clients (server):**
- `supabaseAnonClient` - validates user JWTs on API requests (`src/server/lib/supabase.ts`)
- `supabaseAdminClient` - service role for admin operations (`src/server/lib/supabase.ts`)
- `createSupabaseUserClient(accessToken)` - user-scoped client with custom auth header

## Email Services

| Service | SDK/Client | Config Location | Purpose |
|--------|-----------|-----------------|---------|
| Nodemailer | `nodemailer` 6.9.12 | `src/server/smtp-server.ts` | SMTP relay for outbound email |
| mailparser | `mailparser` 3.6.9 | `src/server/lib/mail.ts` | Parse raw MIME email messages |
| smtp-server | `smtp-server` 3.18.2 | `src/server/smtp-server.ts`, `src/server/smtp-inbound.ts` | Native SMTP server (submission + inbound) |
| IMAP (native) | Custom `net` module | `src/server/imap-server.ts` | IMAP server (RFC 3501) |
| imapflow | `imapflow` 1.2.16 | `src/server/lib/mail-sync.ts` | Sync external mailboxes (e.g., Gmail) |
| imap | `imap` 0.8.19 | — | Lower-level IMAP client (supplemental) |

**SMTP Relay configuration:**
- Config: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` env vars
- Used by: `relayMessage()` in `src/server/smtp-server.ts`
- Fallback: direct delivery (requires proper MX setup) when `SMTP_HOST` not configured

**Native SMTP Submission Server:**
- Port: `SMTP_SUBMISSION_PORT` (2587 dev, 587 prod)
- Auth: PLAIN/LOGIN against `users.passwordHash` (bcrypt)
- Implementation: `src/server/smtp-server.ts`

**Native SMTP Inbound Server:**
- Port: 25 (standard MX delivery)
- No auth required (standard inbound delivery)
- Validates recipient domain against verified domains in DB
- Implementation: `src/server/smtp-inbound.ts`

**Native IMAP Server:**
- Port: `IMAP_PORT` (2993 dev, 993 prod)
- Custom implementation using Node.js `net` module
- Supports: LOGIN, CAPABILITY, LIST, LSUB, SELECT, EXAMINE, FETCH, STORE, EXPUNGE, SEARCH, APPEND, NOOP, LOGOUT, UID
- Implementation: `src/server/imap-server.ts`

**External IMAP Sync:**
- `imapflow` + `mailparser` for connecting to external mailboxes
- Sync job runs every 15 minutes (`src/server/jobs.ts`)

## Third-Party APIs

| Service | SDK/Client | Config Location | Purpose |
|--------|-----------|-----------------|---------|
| Microsoft Graph API | Native `fetch` | `src/server/lib/outlook.ts` | Send email via Outlook OAuth |
| Azure AD OAuth 2.0 | Native `fetch` | `src/server/lib/outlook.ts` | Outlook mailbox connection |
| Supabase REST API | `@supabase/supabase-js` | `src/server/lib/supabase.ts`, `src/db/index.ts` | Database + Auth |

**Microsoft Graph / Outlook OAuth integration:**
- API base: `https://graph.microsoft.com/v1.0`
- OAuth base: `https://login.microsoftonline.com/common/oauth2/v2.0`
- Scopes: `offline_access`, `openid`, `profile`, `User.Read`, `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`
- OAuth flow: `POST /api/outlook/connect/start` → redirect → callback at `/api/outlook/connect/callback`
- Token refresh: automatic with 2-minute buffer before expiry (`REFRESH_SKEW_MS`)
- Config: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` env vars
- Token storage: encrypted with `OUTLOOK_TOKEN_ENCRYPTION_KEY` (required; no fallback)
- Implementation: `src/server/lib/outlook.ts`, `src/server/routes/outlook.ts`
- State validation: HMAC-SHA256 signed, 10-minute TTL

## Webhooks (Outbound)

| Event | Target | Format | Auth |
|-------|--------|--------|------|
| `message_sent` | User-configured URL | JSON | HMAC-SHA256 (X-Webhook-Signature header) |
| `message_delivered` | User-configured URL | JSON | HMAC-SHA256 |
| `message_bounced` | User-configured URL | JSON | HMAC-SHA256 |
| `message_held` | User-configured URL | JSON | HMAC-SHA256 |
| `message_opened` | User-configured URL | JSON | HMAC-SHA256 |
| `link_clicked` | User-configured URL | JSON | HMAC-SHA256 |
| `domain_verified` | User-configured URL | JSON | HMAC-SHA256 |
| `spam_alert` | User-configured URL | JSON | HMAC-SHA256 |
| `test` | User-configured URL | JSON | HMAC-SHA256 |

**Configuration:** Users configure webhook endpoints per organization via `/api/webhooks`
**Dispatch:** `fireWebhooks()` in `src/server/lib/tracking.ts`
**Payload:** `{ event, timestamp, organizationId, data }` with 10-second timeout
**Logging:** All attempts tracked in `webhook_requests` table
**Notifications:** Critical events (`message_bounced`, `message_held`, `spam_alert`) also create user notifications

## Webhooks (Inbound)

| Endpoint | Source | Purpose | Auth |
|---------|--------|---------|------|
| `GET /t/open/:token` | Email client pixel load | Open tracking (1×1 GIF) | Token-based |
| `GET /t/click/:token?u=<base64>` | Email client link click | Click tracking redirect | Token-based |
| `GET /api/outlook/connect/callback` | Azure AD | OAuth callback | State validation |
| `GET /health` | Monitoring | System health | None |
| `GET /health/db` | Monitoring | Database health | None |
| `GET /health/auth` | Monitoring | Auth service health | None |
| `GET /health/ready` | Monitoring | Combined readiness | None |
| `GET /app-config.js` | Browser | Runtime config | None |

**Tracking endpoints:**
- Rate limited: 100 req/min
- Respond immediately, process asynchronously
- Implementation: `src/server/routes/track.ts`
- HTML injection: tracking pixel and link rewriting in `src/server/lib/tracking.ts`

## External Dependencies Audit

| Package | Version | Purpose | Security Notes |
|--------|---------|---------|----------------|
| `express` | 5.0.0-beta.2 | HTTP framework | **Beta version** — potential stability risks |
| `@supabase/supabase-js` | 2.39.8 | Supabase client | Auth JWT validation critical path |
| `drizzle-orm` | 0.30.4 | PostgreSQL ORM | SQL injection protection via parameterized queries |
| `postgres` | 3.4.3 | PostgreSQL driver | Direct connection to Supabase pooler |
| `nodemailer` | 6.9.12 | SMTP sending | Handles credentials (`SMTP_USER`, `SMTP_PASS`) |
| `jsonwebtoken` | 9.0.2 | JWT operations | Tokens for SMTP/IMAP auth |
| `bcrypt` | 6.0.0 | Password hashing | 12 rounds (adequate) |
| `helmet` | 7.1.0 | HTTP headers | Security headers (CSP, HSTS, etc.) |
| `express-rate-limit` | 7.2.0 | Rate limiting | Auth: 5 req/15min, API: 500 req/15min |
| `uuid` | 9.0.1 | UUID generation | Crypto-random (v4) |
| `crypto` (Node.js) | Built-in | HMAC, encryption | Used for webhook signing and token encryption |
| `smtp-server` | 3.18.2 | SMTP server | Handles external email submissions |
| `imapflow` | 1.2.16 | IMAP client | External mailbox sync |
| `mailparser` | 3.6.9 | Email parser | Parses raw MIME from external sources |
| `react-quill-new` | 3.8.3 | Rich text editor | XSS risk: sanitize HTML output before sending |
| `lodash` | 4.17.21 | Utilities | Consider tree-shaking specific functions |
| `date-fns` | 3.6.0 | Date utilities | Tree-shakeable, modern |
| `node-cron` | 4.2.1 | Job scheduler | Background jobs |

**Key security considerations:**
- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — only use for admin operations
- `JWT_SECRET` and `ENCRYPTION_KEY` are critical secrets — rotate regularly
- Outlook tokens encrypted with AES before storage (`src/server/lib/crypto.ts`)
- CORS restricted to `FRONTEND_URL` origin
- CSP headers configured in `helmet` middleware

## Encryption

**Secrets at rest:**
- IMAP/SMTP passwords for external mailboxes encrypted before DB storage
- Outlook OAuth tokens encrypted before DB storage
- Keys: `ENCRYPTION_KEY` (general), `OUTLOOK_TOKEN_ENCRYPTION_KEY` (Outlook tokens)
- Implementation: `src/server/lib/crypto.ts`

**In transit:**
- Webhook payloads signed with HMAC-SHA256
- SMTP/IMAP TLS support in production (cert/key paths via `MAIL_TLS_CERT_PATH`, `MAIL_TLS_KEY_PATH`)

---

*Integration audit: 2026-03-31*
