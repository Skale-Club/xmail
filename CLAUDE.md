# CLAUDE.md — Xmail

## Project Overview

Xmail is a multi-tenant email server management platform inspired by Postal. It provides organization-based access control, domain verification, message tracking, email routing, webhooks, and analytics.

## Deployment (Hetzner + Coolify/Traefik - NOT Vercel)

**Production runs on a Hetzner VPS**, deployed via GitHub Actions on push to `main`. Coolify/Traefik is the primary HTTP routing layer when the `coolify` Docker network exists on the host.

- **Host:** Hetzner VPS (see `HETZNER_HOST` secret in GitHub Actions)
- **Process model:** single Docker container (`xmail:latest`) running Node 20-alpine
- **Container:** `Dockerfile` at repo root builds + runs `dist/server/index.js`
- **Container network:** if Docker network `coolify` exists, deploy runs the app with `--network coolify` so Traefik can reach `http://xmail:9001`
- **Published ports:**
  - `9001` - HTTP API + SPA, published for health checks and routed by Traefik as `mail.skale.club`
  - `25` - SMTP MX inbound, direct public TCP to the Node MX server
  - `587` - SMTP submission, direct public TCP to the Node SMTP server
  - `993` - IMAP, direct public TCP to the Node IMAP server
- **CI/CD (ACTIVE PATH):** `.github/workflows/build-deploy.yml` — builds the image on GitHub runners, pushes to GHCR, SSHes into the host and does a blue-green rollout (green HTTP candidate `xmail-next` → health check → promote to `xmail`, rollback to `:previous` on failure). **Runtime env vars are passed via `-e` inside its shared `run_app_container()` function — any new env var MUST be added there** (this is the block that actually creates the prod container). `.github/workflows/deploy-hetzner.yml` is the LEGACY on-host-build workflow; it duplicates the same env list and should be kept in sync, but editing only it does nothing for pushes to main.
- **HTTP reverse proxy:** Traefik via Coolify is primary. The deploy script attaches Traefik labels and, when available, writes `/data/coolify/proxy/dynamic/xmail.yaml` pointing `mail.skale.club` to `http://xmail:9001`.
- **Legacy fallback:** if the `coolify` network is absent and Caddy exists, the deploy script can still add a Caddy reverse-proxy block for `mail.skale.club -> localhost:9001`.
- **Mail ports bypass proxies:** ports `25`, `587`, and `993` are **not** behind Traefik or Caddy. They are raw TCP published from the container to the internet. TLS for mail ports is handled inside Node via `MAIL_TLS_CERT_PATH` / `MAIL_TLS_KEY_PATH`.
- **Mail identity:** production sets `MAIL_HOST=mx.skale.club`; MX DNS for `skale.club` points at `mx.skale.club`.
- **Logs:** production mail arrival logs are in Docker stdout/stderr, e.g. `docker logs xmail --since 24h 2>&1 | grep -E '\[MX\]|\[RouteMatcher\]|\[mail-auth\]'`.

**No Vercel, no serverless, no edge functions.** Traditional long-running Node process in Docker.

> **Sidecar (not part of xmail):** the same Hetzner host also runs a separate
> [Hermes Agent](https://hermes-agent.nousresearch.com/) container (`/opt/hermes`,
> isolated from the `xmail` container, capped at 1 GB RAM). It is unrelated to the
> email server but shares the box. See [`hermes/README.md`](hermes/README.md) for its
> setup, LLM config (Kimi Coding Plan + gemini fallback), Telegram channel, and gotchas
> (notably the expired ghcr.io Coolify credential that breaks Docker pulls — use
> `DOCKER_CONFIG=/tmp/emptydocker`).

### Deploy commands

```bash
# Local build parity
docker build -t xmail:local .
docker compose up

# Production deploy: automatic on git push to main
git push origin main   # triggers .github/workflows/deploy-hetzner.yml
```

### Relevant GitHub Secrets
`HETZNER_HOST`, `HETZNER_SSH_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `OUTLOOK_TOKEN_ENCRYPTION_KEY`, `MAIL_DOMAIN`, `SMTP_HOST/PORT/USER/PASS/FROM`, `FRONTEND_URL`, `APP_COMPANY_NAME`, `APP_APPLICATION_NAME`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. `MAIL_HOST` is currently set by the deploy workflow to `mx.skale.club`.

## Tech Stack

- **Frontend:** React 18, Vite, TailwindCSS, shadcn/ui (Radix UI), wouter (routing), TanStack React Query, react-hook-form + Zod
- **Backend:** Express 5 (beta), TypeScript, tsx (dev runner)
- **Database:** Supabase (PostgreSQL), Drizzle ORM, Row Level Security (RLS)
- **Auth:** Supabase Auth (JWT-based)
- **Email:** Nodemailer (SMTP sending), mailparser (parsing)

## Project Structure

```
src/
├── components/          # React components
│   ├── ui/              # shadcn/ui primitives (Button, Card, Dialog, etc.)
│   └── admin/           # Admin layout
├── db/
│   ├── index.ts         # Drizzle client init
│   └── schema.ts        # Full database schema (tables, enums, relations)
├── hooks/
│   └── useAuth.tsx      # Auth context & hook
├── lib/
│   ├── supabase.ts      # Supabase client
│   └── utils.ts         # Utility functions (cn, etc.)
├── pages/
│   ├── Login.tsx
│   ├── Dashboard.tsx
│   └── admin/           # Admin pages (Orgs, Servers, Domains, Messages, etc.)
├── server/
│   ├── index.ts         # Express entry point (middleware, auth, routing)
│   ├── lib/
│   │   └── tracking.ts  # Open/click tracking & webhook dispatch
│   └── routes/          # API route handlers
│       ├── auth.ts, users.ts, organizations.ts, servers.ts
│       ├── domains.ts, credentials.ts, routes.ts
│       ├── messages.ts, webhooks.ts, track.ts, system.ts
└── main.tsx             # React entry point with routes
supabase/migrations/     # RLS policies
scripts/                 # Migration runner scripts
```

## Commands

```bash
npm run dev              # Run client (port 9000) + server (port 9001) concurrently
npm run dev:client       # Vite dev server only
npm run dev:server       # Express server with tsx watch only
npm run build            # Build both client and server
npm start                # Run production build (node dist/server/index.js)
npm run lint             # ESLint (strict, zero warnings)
npm run db:generate      # Generate Drizzle migrations
npm run db:push          # Push schema to database
npm run db:studio        # Open Drizzle Studio
```

## Architecture Notes

### Authentication Flow
1. Frontend authenticates via Supabase Auth (`supabase.auth.signInWithPassword`)
2. JWT token sent as `Authorization: Bearer <token>` header
3. Express middleware validates token with Supabase, sets `x-user-id` header
4. **Authorization is JS-side, not DB-side.** The app's DB connection uses
   the `DATABASE_URL` Postgres role, which bypasses Row-Level Security
   (no `auth.uid()` is set per request). RLS policies in
   `supabase/migrations/` remain as defense-in-depth, but the real
   authorization check lives in `src/server/lib/access.ts`. **Every API
   route MUST call a `checkXAccess` helper before reading or writing
   tenant-scoped data — there is no DB safety net.** Background jobs
   and scripts that use the same connection also bypass RLS and must
   enforce their own scoping in code.

### Multi-Tenancy Model
- Users belong to Organizations via `organization_users` (roles: admin, member, viewer)
- Servers belong to Organizations
- All resources (domains, credentials, routes, messages, webhooks) belong to Servers
- **Authorization model:** JS-side helpers in `src/server/lib/access.ts`
  enforce org-scoped data access. RLS policies are defense-in-depth and
  do NOT alone protect tenants (the app role bypasses RLS).

### API Conventions
- All API routes under `/api/`
- Rate limited: 100 req/IP/15min
- Resources typically require a parent ID as query param (e.g., `?serverId=...`, `?organizationId=...`)
- Standard REST patterns: GET (list/detail), POST (create), PUT (update), DELETE (remove)
- Zod validation on request bodies

### Email Tracking
- Open tracking: 1x1 transparent GIF pixel injected into HTML emails (`/t/open/:token`)
- Click tracking: URL rewriting with base64url-encoded redirect (`/t/click/:token?u=...`)
- Both respond immediately, process tracking asynchronously

### Outreach Email Accounts
- `email_accounts.provider` is `'smtp'` (default, stored+encrypted SMTP/IMAP creds),
  `'outlook'` (OAuth via `src/server/routes/outlook.ts`), or `'native'`.
- `provider: 'native'` accounts send outreach campaigns through the platform's own
  user-as-mailbox model (`src/server/lib/native-send.ts`, shared with the webmail
  compose route) instead of stored credentials — **no SMTP/IMAP password is ever
  collected or persisted** for these accounts (`smtp_*`/`imap_*` columns stay NULL).
  A native account can only be created for an email that belongs to an existing
  platform user with a native mailbox who is a member of the same organization.
- Sending relays through the same DKIM-signing path as `smtp-server.ts`; replies and
  bounces are detected by reading the account owner's native INBOX folder directly
  (`mail_messages`/`mail_folders`) instead of connecting over IMAP — see
  `processReplies.ts` / `processBounces.ts` for the native-provider branches.

### Frontend Patterns
- All admin pages under `/admin/*` route
- React Query for server state (auto-refetch, cache invalidation)
- Forms use react-hook-form + Zod schemas
- Toast notifications for user feedback
- Dark/Light/System theme support

## Environment Variables

Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `DATABASE_URL`

Optional: `PORT` (default 9001), `NODE_ENV`, `JWT_SECRET`, `FRONTEND_URL` (default http://localhost:9000), `SMTP_HOST/PORT/USER/PASS/FROM`, `XMAIL_SERVICE_KEY` (machine-to-machine auth for the Xphere orchestrator on `/api/outreach/*`, fails closed if unset), `XPHERE_EVENTS_URL`/`XPHERE_EVENTS_API_KEY` (outbound outreach event notifications to Xphere; both required together)

See `.env.example` for full list.

## Database

Schema defined in `src/db/schema.ts` using Drizzle ORM. Key tables: `users`, `organizations`, `organization_users`, `servers`, `domains`, `credentials`, `routes`, `messages`, `deliveries`, `webhooks`, `webhook_requests`, `statistics`, `suppressions`, `track_domains`.

All tables have RLS enabled (policies in `supabase/migrations/001_enable_rls.sql`). RLS is **defense-in-depth only** — the app's `DATABASE_URL` Postgres role bypasses RLS, so tenant isolation is enforced in JS via `src/server/lib/access.ts`. See `### Authentication Flow` above.

### Schema & Migration Workflow

**Canonical sources:**
- **TypeScript schema:** `src/db/schema.ts` — Drizzle table definitions + types (consumed by application code).
- **SQL migrations:** `supabase/migrations/NNN_description.sql` — hand-written, hand-numbered, applied in order against the Postgres DB. THIS is the source of truth for the running database.
- **Indexes:** Defined twice intentionally — in `src/db/schema.ts` via Drizzle `index()` (for type-awareness) AND in `sql/indexes.sql` via `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (for safe production apply). Run `npm run db:indexes` to apply index changes.

**What we DO:**
- Edit `src/db/schema.ts` to update TypeScript types.
- Write a matching hand-rolled SQL migration in `supabase/migrations/NNN_<name>.sql` (take the next free integer). Migrations must be idempotent where reasonable (`IF NOT EXISTS`, `DROP POLICY IF EXISTS ... CREATE POLICY ...`).
- Apply via `psql "$DATABASE_URL" -f supabase/migrations/NNN_<name>.sql`.
- For RLS-policy changes, prefer adding to / regenerating the consolidated RLS migration (currently `020_consolidate_rls.sql` — see QUA-03).

**What we DO NOT do:**
- **Do NOT run `drizzle-kit generate` to produce migrations.** The Drizzle-generated diff would conflict with the hand-rolled SQL we've accumulated since `drizzle/0000_dear_wolverine.sql`. The `db:generate`/`db:push` scripts have been removed from `package.json` (Phase 13 QUA-02 / audit M3) to prevent accidental destruction. `db:studio` (read-only Drizzle Studio) and `db:indexes` remain available.
- **Do NOT add Drizzle relations / constraints expecting them to apply automatically.** The TS-side schema is for type information; the DB side comes from the SQL migration.

**Numbering convention:** Migrations are sequential integers (`001` through `019` as of 2026-05-16; `020_consolidate_rls.sql` is the next planned). When two phases plan migrations in parallel, the second to land takes the next number and rewrites its planning docs accordingly.

## Key Constraints

- No testing framework is currently configured
- Registration endpoint is intentionally disabled (403)
- Express 5 is beta — uses `req.query` instead of `req.params` in some places
- Vite proxies `/api` requests to the backend in dev mode
- Request body limit: 10MB
- Path alias: `@/*` maps to `./src/*`
