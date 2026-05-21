# SkaleClub Mail

A complete email system built with modern web technologies, inspired by Postal. This application provides a full-featured email management platform with organization-based access control.

## Tech Stack

- **Frontend**: React 18, Vite, TailwindCSS, shadcn/ui, wouter
- **Backend**: Express 5, tsx
- **Database**: Supabase (PostgreSQL, Auth, Storage)
- **Validation**: Zod with drizzle-zod
- **ORM**: Drizzle ORM

## Features

- 🏢 **Organization Management** - Multi-tenant architecture with role-based access
- 📧 **Email Server Management** - Create and manage mail servers
- 🌐 **Domain Verification** - DNS verification for sending domains
- 🔑 **Credential Management** - SMTP and API credentials
- 📨 **Message Tracking** - Send and track email messages
- 🔗 **Webhook Support** - Event notifications via webhooks
- 📊 **Statistics** - Email delivery analytics
- 🔒 **Row Level Security** - Supabase RLS for data isolation

## Outlook Outreach Integration

The backend now includes a Microsoft Outlook / Microsoft 365 outreach integration:

- OAuth 2.0 mailbox connection through Microsoft Graph
- Encrypted access and refresh token storage
- Outlook mailbox management per mail server
- Message delivery through Graph when `sendMode` is `outlook`
- Test send endpoint at `/api/outlook/mailboxes/:id/send-test`

### Outlook environment variables

Add these variables to your `.env` file:

```env
MICROSOFT_CLIENT_ID=your_microsoft_app_client_id
MICROSOFT_CLIENT_SECRET=your_microsoft_app_client_secret
MICROSOFT_REDIRECT_URI=http://localhost:9001/api/outlook/callback
OUTLOOK_TOKEN_ENCRYPTION_KEY=use_a_long_random_secret_here
```

### Outlook database migration

Apply the migration before using the integration:

```text
supabase/migrations/002_outlook_integration.sql
```

## Getting Started

### Prerequisites

- Node.js 18+
- Supabase account

### Installation

1. Clone the repository:
```bash
git clone https://github.com/Skale-Club/skaleclub-mail.git
cd skaleclub-mail
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

4. Add your Supabase credentials to `.env`:
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres:password@db.your-project.supabase.co:5432/postgres
```

5. Apply the SQL migrations (in filename order) against your Postgres DB. The
   recommended path is `psql`:
```bash
for f in supabase/migrations/[0-9]*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Or paste each file into the Supabase SQL Editor in filename order. See
[Schema & Migration Workflow](#schema--migration-workflow) below — `npm run
db:push` / `drizzle-kit generate` are intentionally NOT used.

6. Apply RLS policies (idempotent re-run of the consolidated migration):
```bash
npm run db:rls
```

### Development

Start the development server:
```bash
npm run dev
```

- Frontend: http://localhost:9000
- Backend API: http://localhost:9001

### Production Build

```bash
npm run build
npm start
```

## Deployment — Hetzner VPS

**Production hosts on Hetzner** (not Vercel, not Railway). Deployment is fully automated via GitHub Actions on push to `main`.

### Architecture

```
GitHub Actions (on push to main)
      ↓ SSH
Hetzner VPS (Ubuntu)
      ↓
Docker (skaleclub-mail:latest)
      ├─ :9001  (HTTP API + SPA)  ──► Caddy reverse-proxy (mail.skale.club)
      ├─ :25    (SMTP MX inbound)  ──► direct TCP, raw (Let's Encrypt TLS inside Node)
      ├─ :587   (SMTP submission)  ──► direct TCP, raw (Thunderbird etc.)
      └─ :993   (IMAP)             ──► direct TCP, raw (Thunderbird etc.)
```

### Workflow

1. `git push origin main` → GitHub Actions triggers `.github/workflows/deploy-hetzner.yml`
2. Action SSHes into `HETZNER_HOST`, pulls latest, builds fresh Docker image with `--no-cache`
3. Tags current `:latest` as `:previous` for rollback
4. Stops old container, waits for clean shutdown (up to 30s), starts new container
5. Caddyfile check: adds `mail.skale.club { reverse_proxy localhost:9001 }` block if missing
6. Health-checks `http://localhost:9001/health` up to 12× with 5s interval
7. On failure: automatic rollback to `:previous` image; previous image reused with same env vars
8. On success: prunes old images, emits deploy summary

### Required GitHub Secrets

| Secret | Purpose |
|---|---|
| `HETZNER_HOST` | Server IP/hostname for SSH |
| `HETZNER_SSH_KEY` | Private SSH key for root access |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase backend |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Client-side Supabase |
| `DATABASE_URL` | Postgres pooler connection |
| `JWT_SECRET`, `ENCRYPTION_KEY`, `OUTLOOK_TOKEN_ENCRYPTION_KEY` | Signing/crypto |
| `MAIL_HOST`, `MAIL_DOMAIN` | Public mail hostnames |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Outbound relay (fallback) |
| `FRONTEND_URL` | Frontend URL for CORS |
| `APP_COMPANY_NAME`, `APP_APPLICATION_NAME` | Branding |

### Local parity

```bash
docker build -t skaleclub-mail:local .
docker compose up      # uses docker-compose.yml, ports 9001/25/587/993
```

### Files related to deploy

| File | Purpose |
|---|---|
| `Dockerfile` | Node 20 Alpine, builds client + server, runs `dist/server/index.js` |
| `docker-compose.yml` | Local parity; same port mapping as production |
| `.github/workflows/deploy-hetzner.yml` | CI/CD pipeline with rollback |

## Project Structure

```
skaleclub-mail/
├── src/
│   ├── components/         # React components
│   │   └── ui/            # shadcn/ui components
│   ├── db/                # Database schema and connection
│   │   ├── index.ts       # Drizzle client
│   │   └── schema.ts      # Database schema
│   ├── hooks/             # React hooks
│   │   └── useAuth.tsx    # Authentication hook
│   ├── lib/               # Utility libraries
│   │   ├── supabase.ts    # Supabase client
│   │   └── utils.ts       # Utility functions
│   ├── pages/             # Page components
│   │   ├── Dashboard.tsx  # Main dashboard
│   │   └── Login.tsx      # Login page
│   └── server/            # Express backend
│       ├── index.ts       # Server entry point
│       └── routes/        # API routes
│           ├── auth.ts
│           ├── credentials.ts
│           ├── domains.ts
│           ├── messages.ts
│           ├── organizations.ts
│           ├── routes.ts
│           ├── servers.ts
│           ├── users.ts
│           └── webhooks.ts
├── supabase/
│   └── migrations/        # SQL migrations
│       └── 001_enable_rls.sql
├── drizzle.config.ts      # Drizzle ORM config
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```

## API Endpoints

### Authentication
- `POST /api/auth/signup` - Create new account
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/user` - Get current user

### Organizations
- `GET /api/organizations` - List organizations
- `POST /api/organizations` - Create organization
- `GET /api/organizations/:id` - Get organization
- `PUT /api/organizations/:id` - Update organization
- `DELETE /api/organizations/:id` - Delete organization

### Servers
- `GET /api/servers` - List servers
- `POST /api/servers` - Create server
- `GET /api/servers/:id` - Get server
- `PUT /api/servers/:id` - Update server
- `DELETE /api/servers/:id` - Delete server

### Domains
- `GET /api/domains` - List domains
- `POST /api/domains` - Create domain
- `GET /api/domains/:id` - Get domain
- `PUT /api/domains/:id` - Update domain
- `DELETE /api/domains/:id` - Delete domain

### Messages
- `GET /api/messages` - List messages
- `POST /api/messages` - Send message
- `GET /api/messages/:id` - Get message
- `DELETE /api/messages/:id` - Delete message

### Webhooks
- `GET /api/webhooks` - List webhooks
- `POST /api/webhooks` - Create webhook
- `GET /api/webhooks/:id` - Get webhook
- `PUT /api/webhooks/:id` - Update webhook
- `DELETE /api/webhooks/:id` - Delete webhook

### Credentials
- `GET /api/credentials` - List credentials
- `POST /api/credentials` - Create credential
- `GET /api/credentials/:id` - Get credential
- `DELETE /api/credentials/:id` - Delete credential

### Routes
- `GET /api/routes` - List routes
- `POST /api/routes` - Create route
- `GET /api/routes/:id` - Get route
- `PUT /api/routes/:id` - Update route
- `DELETE /api/routes/:id` - Delete route

## Database Schema

### Core Tables

| Table | Description |
|-------|-------------|
| `users` | User profiles (linked to Supabase Auth) |
| `organizations` | Email organizations |
| `organization_users` | Organization membership |
| `servers` | Mail servers |
| `domains` | Sending domains |
| `credentials` | SMTP/API credentials |
| `routes` | Email routing rules |
| `messages` | Email messages |
| `deliveries` | Message delivery tracking |
| `webhooks` | Webhook configurations |
| `webhook_requests` | Webhook request logs |
| `track_domains` | Tracking domains |
| `suppressions` | Email suppressions |
| `statistics` | Email statistics |

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

## Security

- Row Level Security (RLS) enabled on all tables
- Organization-based data isolation
- Role-based access control (owner, admin, member)
- Supabase Auth for authentication
- Service role for system operations

## License

MIT
