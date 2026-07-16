# Architecture

**Analysis Date:** 2026-03-31

## Pattern Overview

**Overall:** Monorepo full-stack SPA with co-located frontend and backend, three distinct product domains, and background job processing.

**Key Characteristics:**
- Single Express server serves both the REST API and the built React SPA (production) or proxies in dev
- Frontend is split into three role-gated zones: `/admin/*` (platform admin), `/outreach/*` (admin-only outreach), `/mail/*` (end-user webmail)
- Database access is exclusively through Drizzle ORM with Supabase (PostgreSQL) as the persistence layer; RLS enforces org-level isolation at the DB layer
- Native SMTP/IMAP servers run in-process alongside the HTTP server, sharing the same DB connection pool
- Background cron jobs run in-process via `node-cron`, started after server boot

## System Architecture Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│                        React SPA Frontend                           │
│  src/main.tsx (route tree) + src/pages/ + src/components/           │
│  Context Providers: Auth, MultiSession, Mailbox, Compose, Org       │
│  HTTP Transport: src/lib/api-client.ts (token refresh + retry)      │
│  Server State: TanStack React Query (30s staleTime, no refetch)     │
├─────────────────────────────────────────────────────────────────────┤
│                        Express API Backend                          │
│  src/server/index.ts (middleware stack, auth, route mounting)        │
│  src/server/routes/ (one file per resource domain)                   │
│  src/server/routes/mail/ (webmail endpoints)                         │
│  src/server/routes/outreach/ (campaign/lead endpoints)               │
│  src/server/lib/ (shared business logic)                             │
├─────────────────────────────────────────────────────────────────────┤
│                     Native Mail Protocol Servers                     │
│  src/server/smtp-server.ts   — Outbound submission (port 2587)      │
│  src/server/smtp-inbound.ts  — Inbound MX delivery (port 25)        │
│  src/server/imap-server.ts   — IMAP access (port 2993)               │
│  Shared auth: src/server/lib/native-mail.ts (bcrypt passwordHash)    │
├─────────────────────────────────────────────────────────────────────┤
│                  Background Jobs (node-cron, in-process)             │
│  src/server/jobs/index.ts → 7 cron schedules                         │
│  processQueue (1min), processHeld (5min), processOutreach (5min),    │
│  processReplies (15min), processBounces (30min), cleanup (daily),    │
│  resetDailyLimits (midnight)                                         │
├─────────────────────────────────────────────────────────────────────┤
│                   Drizzle ORM + PostgreSQL (Supabase)                │
│  src/db/schema.ts — single file, all 30+ tables, relations, Zod     │
│  src/db/index.ts  — postgres.js pool (max 20), health checks, retry │
│  Supabase RLS policies — org-scoped data isolation                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Request Flow

### API Request (Authenticated)

```
Client (React SPA)
  │  Authorization: Bearer <supabase-jwt>
  ▼
Vite Dev Proxy (port 9000 → 9001, dev only)
  │
  ▼
Express Server (src/server/index.ts, port 9001)
  ├── helmet() security headers + CSP
  ├── cors() origin check (FRONTEND_URL or localhost:9000)
  ├── rateLimit(/api/) — 500 req/IP/15min (prod), 2000 (dev)
  ├── rateLimit(/api/auth/login) — 5 req/IP/15min
  ├── express.json({ limit: '10mb' })
  ├── Cache-Control: no-store (on /api/*)
  ├── Auth Middleware (lines 158-184):
  │   ├── Skip if path in PUBLIC_PATHS array
  │   ├── Validate JWT via supabase.auth.getUser(token)
  │   ├── Set x-user-id, x-user-email, x-user-first-name, x-user-last-name, x-user-email-verified
  │   └── next()
  ├── Route Handler (e.g., src/server/routes/organizations.ts)
  │   ├── Zod validation on req.body
  │   ├── isPlatformAdmin() check (if admin-only endpoint)
  │   ├── Membership check via organizationUsers table
  │   ├── Drizzle ORM queries (RLS enforced at DB layer)
  │   └── res.json({ data })
  └── Global Error Handler → 500 { error, message? }
```

### Tracking Request (Public, No Auth)

```
Email Client
  │  GET /t/open/:token  (1x1 transparent GIF)
  │  GET /t/click/:token?u=<base64url>  (302 redirect)
  ▼
Express Server
  ├── rateLimit(/t/) — 100 req/min
  ├── trackRoutes (src/server/routes/track.ts)
  │   ├── Lookup token in messages table
  │   ├── Update message status (openedAt, etc.)
  │   ├── incrementStat() for org analytics (upsert per org+date)
  │   ├── fireWebhooks() → HMAC-SHA256 signed POST to subscriber URLs
  │   └── Respond immediately (GIF or 302)
```

### SMTP Inbound Flow

```
External Mail Server (Gmail, Outlook, etc.)
  │  Port 25 (MX delivery, no auth)
  ▼
src/server/smtp-inbound.ts
  ├── Parse raw email via mailparser
  ├── findOrganizationForDomain(domain) — check verified domains
  ├── findLocalUser(email) — check native mailboxes
  ├── If local user → store in recipient's inbox (mailMessages table)
  ├── If not local → processInboundEmail(recipient)
  │   ├── findMatchingRoutes(orgId, recipient) — wildcard pattern matching
  │   ├── Route modes: endpoint (smtp/http/address), hold, reject
  │   └── deliverViaRoutes() — nodemailer relay, HTTP POST, or address forward
  ├── Store sender copy in Sent folder
  ├── incrementStat() + fireWebhooks()
  └── Accept or reject at SMTP level
```

### SMTP Outbound Flow (Native Mail Server)

```
Email Client (Thunderbird, etc.)
  │  Port 2587 (STARTTLS, PLAIN/LOGIN auth)
  ▼
src/server/smtp-server.ts
  ├── onAuth → authenticateNativeUser(email, password) — bcrypt against passwordHash
  ├── onData → parseRawEmail(raw)
  ├── Store copy in sender's Sent folder (mailMessages)
  ├── Separate local vs external recipients
  ├── Local → store directly in recipient's inbox
  ├── External → relay via nodemailer (SMTP_HOST or direct delivery)
  │   └── Also check route-based delivery via processInboundEmail()
  └── Accept callback
```

### Background Job Flow

```
src/server/jobs/index.ts (cron scheduler)
  ├── processQueue (every 1 min)
  │   ├── Find pending deliveries (limit 50)
  │   ├── Filter out deliveries in retry delay
  │   ├── For each: load message, get org SMTP config, send via nodemailer
  │   ├── Retry with exponential backoff (1min, 5min, 15min) up to 3 attempts
  │   ├── Update delivery status, incrementStat, fireWebhooks
  │   └── Mutex via `running` flag (prevents overlap)
  ├── processHeldMessages (every 5 min) — release expired held messages
  ├── cleanupOldMessages (daily 3am) — purge old data
  ├── processOutreachSequences (every 5 min)
  │   ├── Load active campaigns with pending leads
  │   ├── For each lead in sequence: send next step email
  │   ├── Respect daily limits, warm-up, randomized delays
  │   └── Mutex via isSequenceProcessing flag
  ├── resetDailyLimits (daily midnight) — reset emailAccount.currentDailySent
  ├── processReplies (every 15 min) — detect replies to outreach campaigns
  └── processBounces (every 30 min) — process bounced emails, update suppressions
```

## Authentication & Authorization

**Auth Provider:** Supabase Auth (JWT-based)

**Flow:**
1. Frontend calls `supabase.auth.signInWithPassword()` → receives JWT access token + refresh token
2. Refresh token stored in httpOnly cookie (`sb_refresh_token`, 7-day expiry, path `/api/auth`)
3. Access token sent as `Authorization: Bearer <token>` on every API request
4. Express middleware validates JWT with `supabase.auth.getUser(token)` (stateless verification against Supabase)
5. User metadata extracted into `x-user-id`, `x-user-email`, `x-user-first-name`, `x-user-last-name` headers for downstream handlers
6. RLS policies in PostgreSQL enforce org-scoped data isolation at the database layer

**Public endpoints** (no auth required): `/api/auth/login`, `/api/auth/register` (returns 403), `/api/auth/reset-password`, `/api/auth/refresh`, `/api/system/branding`, `/api/system/mail-server-info`

**Authorization levels:**
- **Platform Admin** (`users.is_admin = true`) — full access to all organizations and system management
- **Organization Admin** — manage org members, servers, domains, credentials
- **Organization Member** — standard access within org
- **Organization Viewer** — read-only access

**Frontend route guards:**
- `AdminCheck` (`src/main.tsx` line 80) — redirects non-admins to `/mail/inbox`
- `MailCheck` (`src/main.tsx` line 101) — redirects admins to `/admin`
- `RootRedirect` (`src/main.tsx` line 122) — sends to `/admin` or `/mail/inbox` based on role

**Native SMTP/IMAP auth:** Separate bcrypt password stored in `users.password_hash`, synced on password update via `/api/auth/update-password`. Auth function: `src/server/lib/native-mail.ts` → `authenticateNativeUser()`

## Data Flow

### Multi-Tenancy Model

```
Users
  └── organization_users (role: admin|member|viewer)
       └── Organizations (owner_id → users.id)
            ├── Domains (DKIM, SPF, DMARC, MX, return_path verification)
            ├── Credentials (SMTP/API keys, bcrypt-hashed secrets)
            ├── Routes → SMTP Endpoints / HTTP Endpoints / Address Endpoints
            ├── Messages → Deliveries (per-recipient status tracking)
            ├── Webhooks → Webhook Requests (delivery log with HMAC signatures)
            ├── Statistics (daily aggregated counters per org)
            ├── Suppressions (bounce/complaint opt-out list)
            ├── Templates (email templates with variable interpolation)
            ├── Outlook Mailboxes (Microsoft OAuth tokens, encrypted)
            ├── Email Accounts (outreach sending inboxes)
            │   ├── Campaigns → Sequences → Sequence Steps (A/B variants)
            │   ├── Lead Lists → Leads → Campaign Leads → Outreach Emails
            │   └── Outreach Analytics (daily stats per campaign/account)
            └── Track Domains (custom tracking domains)
```

### Webmail Data Model (User-scoped, NOT org-scoped)

```
Users
  └── Mailboxes (userId-scoped, SMTP/IMAP config, isNative flag)
       ├── Mail Folders (inbox, sent, drafts, trash, spam, custom)
       ├── Mail Messages (synced from IMAP or stored directly)
       ├── Mail Filters (JSON conditions + actions rules engine)
       └── Signatures (HTML email signatures)
  └── Contacts (address book with emailedCount tracking)
  └── user_notifications (event-driven alerts)
```

## Key Design Decisions

| Decision | Rationale | Trade-offs |
|----------|-----------|------------|
| Monolithic single-process deployment | Simpler ops, single deploy, shared DB connection pool | Harder to scale individual subsystems independently |
| Drizzle ORM with raw SQL for analytics | Type-safe schema, but raw SQL needed for upserts/increments (`tracking.ts`) | Split pattern — some queries use ORM, some use `db.execute()` |
| Database polling for jobs (no message queue) | Simpler infrastructure, no Redis/SQS dependency | Higher latency for job processing (1-5 min poll intervals) |
| Durable outreach dispatcher with origin adapters | Campaign, manual, and agentic sends share policy, leases, idempotency, and retry state | Provider-specific MIME parity remains an adapter concern |
| Supabase for auth + Postgres | Managed auth service, RLS for multi-tenancy, single vendor | Vendor lock-in, RLS policies in raw SQL migrations |
| Express 5 (beta) | Needed for modern middleware patterns | `req.params` vs `req.query` inconsistency noted in CLAUDE.md |
| Single schema.ts file (1250+ lines) | Simple discovery, all types in one place, shared across modules | Very large file, harder to navigate as domain grows |
| Native SMTP/IMAP servers (not Postfix/Dovecot) | Full control, runs in same Node process, no external deps | Less battle-tested than production MTA software |
| Zod for validation (client + server) | Shared validation logic, type inference | Some duplication between drizzle-zod and route-level schemas |
| In-memory mutex for jobs | Simple concurrency control in single-process architecture | No distributed locking — breaks if scaled horizontally |
| No testing framework | (As noted in CLAUDE.md) | No automated quality gates |

## Separation of Concerns

| Layer | Responsibility | Key Files |
|-------|---------------|-----------|
| **Route Handlers** | HTTP request handling, validation, response formatting | `src/server/routes/*.ts`, `src/server/routes/mail/*.ts`, `src/server/routes/outreach/*.ts` |
| **Business Logic** | Email routing, tracking, outreach sending, health checks, native mail auth | `src/server/lib/*.ts` (17 files) |
| **Background Jobs** | Async processing: queue delivery, bounce handling, outreach sequences, cleanup | `src/server/jobs/*.ts` (7 jobs) |
| **Native Mail Servers** | SMTP submission, SMTP inbound, IMAP protocol handling | `src/server/smtp-server.ts`, `smtp-inbound.ts`, `imap-server.ts` |
| **Data Access** | ORM queries, connection pooling, health monitoring, retry logic | `src/db/schema.ts`, `src/db/index.ts` |
| **Frontend Pages** | Route-specific UI components (admin, mail, outreach) | `src/pages/**/*.tsx` |
| **Frontend Components** | Reusable UI primitives (shadcn/ui), layouts, domain-specific widgets | `src/components/**/*.tsx` |
| **Frontend Hooks** | Context providers, API integration, client state management | `src/hooks/*.tsx` (11 files) |
| **Frontend Lib** | API client, Supabase client, utilities, constants, branding | `src/lib/*.ts` (12 files) |

## Error Handling Strategy

**API Layer (Express):**
- Zod validation errors → `400` with `{ error: errors }` array
- Auth failures → `401` with `{ error: 'Unauthorized' }` or `{ error: 'Invalid or expired token' }`
- Permission denied → `403` with `{ error: 'Forbidden' }`
- Not found → `404` with `{ error: 'Not found' }` (or generic for security)
- Unexpected errors → `500` with `{ error: 'Internal server error' }` (+ message in dev mode)
- Global error handler at `src/server/index.ts` lines 211-219

**Background Jobs:**
- Each job wrapped in `.catch()` with `console.error` logging
- Jobs use `running` / `isSequenceProcessing` flags to prevent overlapping execution
- Individual delivery failures don't stop the batch
- Process queue: 50 deliveries per tick, max 3 retries with exponential backoff (1min → 5min → 15min)

**Webhook Dispatch (`src/server/lib/tracking.ts`):**
- `Promise.allSettled()` — one webhook failure doesn't block others
- 10-second timeout per webhook call via `AbortSignal.timeout(10_000)`
- All attempts logged to `webhook_requests` table (success or failure)
- Errors swallowed — tracking never blocks the HTTP response

**Database (`src/db/index.ts`):**
- `withRetry()` utility — exponential backoff for connection errors (ECONNRESET, ETIMEDOUT)
- `onConflictDoNothing()` used for idempotent inserts (messages, stats)
- Health check endpoints: `/health`, `/health/db`, `/health/auth`, `/health/ready`
- Connection pool stats via `getPoolStats()` for monitoring

**Frontend (`src/lib/api-client.ts`):**
- `ApiClientError` class carries `status`, `path`, `code`, `details`
- Auto-refresh on 401: clears token cache, retries once
- `src/hooks/useApiError.ts` maps error codes to user-facing messages
- React Query: retries skip 401 and rate-limit errors

## Concurrency Patterns

**Job Concurrency:**
- In-memory mutex flags (`running` in `processQueue`, `isSequenceProcessing` in `jobs/index.ts`)
- No distributed locking — single-process assumption
- Rate-limited via batch size (50 deliveries per tick)

**Connection Pooling (`src/db/index.ts`):**
- `postgres` library with configurable pool (default max 20 connections, env: `DB_POOL_MAX`)
- Idle timeout: 10s (env: `DB_IDLE_TIMEOUT_SECONDS`)
- Connection timeout: 30s (env: `DB_CONNECT_TIMEOUT_SECONDS`)
- Max lifetime: 30min (env: `DB_MAX_LIFETIME_SECONDS`)
- Supabase transaction mode (port 6543) with Supavisor

**Rate Limiting (`src/server/index.ts`):**
- General API: 500 req/IP/15min (prod), 2000 (dev)
- Auth endpoints: 5 req/IP/15min (`/api/auth/login`, `/api/auth/reset-password`)
- Tracking endpoints: 100 req/IP/min (`/t/`)

**Outreach Throttling (`src/server/lib/outreach-sender.ts`):**
- Per-account `dailySendLimit` (default 50/day)
- `minMinutesBetweenEmails` / `maxMinutesBetweenEmails` (randomized delay)
- Warm-up ramp-up over `warmupDays` (default 14 days)
- Daily counter reset via `resetDailyLimits` job at midnight

---

*Architecture analysis: 2026-03-31*
