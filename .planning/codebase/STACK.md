# Technology Stack

**Analysis Date:** 2026-03-31

## Languages

**Primary:**
- TypeScript 5.4.2 - All source code (client and server)

**Secondary:**
- SQL - Drizzle migrations and raw Supabase RLS policies in `supabase/migrations/`
- HTML/CSS - Email templates and frontend markup

## Runtime

**Environment:**
- Node.js 20 (Alpine, per `Dockerfile`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core (Frontend):**
- React 18.2 - UI rendering (`src/main.tsx`)
- Vite 5.1.6 - Dev server (port 9000) and production build (`vite.config.ts`)
- wouter 3.0 - Client-side routing (lightweight alternative to react-router)
- TailwindCSS 3.4.1 - Utility-first CSS (`tailwind.config.ts`)
- shadcn/ui (Radix UI) - Component primitives under `src/components/ui/`

**Core (Backend):**
- Express 5.0.0-beta.2 - HTTP server (`src/server/index.ts`)
- tsx 4.7.1 - TypeScript execution for dev server (`npm run dev:server`)

**Forms & Validation:**
- react-hook-form 7.51.0 - Form state management
- Zod 3.22.4 - Schema validation (shared client + server)
- @hookform/resolvers 3.3.4 - Connects Zod schemas to react-hook-form

**Data Fetching:**
- @tanstack/react-query 5.28.0 - Server state management with caching and auto-refetch
- @tanstack/react-table 8.13.2 - Data table rendering

**UI Components:**
- Full @radix-ui/* suite (accordion, alert-dialog, avatar, checkbox, dialog, dropdown-menu, icons, label, popover, progress, scroll-area, select, separator, slot, switch, tabs, toast, tooltip)
- lucide-react 0.358.0 - Icon set
- recharts 2.12.3 - Analytics charts
- react-quill-new 3.8.3 - Rich text editor for email composition
- react-markdown 9.0.1 - Markdown rendering
- cmdk 1.0.0 - Command palette component

**Testing:**
- Vitest 3.2.4 with Node, jsdom, and PostgreSQL projects (`vitest.config.ts`)
- Testing Library + jest-dom for React component behavior
- Testcontainers PostgreSQL for guarded disposable-database integration tests
- Commands: `npm run test`, `npm run test -- <file>`, and `npm run test:watch`

**Build/Dev:**
- esbuild - Used via `build:api` script for Vercel serverless bundle
- concurrently 8.2.2 - Runs client and server in parallel (`npm run dev`)
- drizzle-kit 0.20.17 - Schema generation and migration tooling

## Key Dependencies

**Critical:**
- `@supabase/supabase-js` 2.39.8 - Auth client (frontend + backend token validation)
- `drizzle-orm` 0.30.4 + `postgres` 3.4.3 - Database ORM + raw PostgreSQL driver (Supavisor pooler on port 6543)
- `nodemailer` 6.9.12 - SMTP email sending for outbound messages
- `smtp-server` 3.18.2 - Native SMTP server (submission port 587, inbound port 25)
- `imapflow` 1.2.16 - IMAP client for syncing external mailboxes
- `imap` 0.8.19 - Lower-level IMAP client used alongside imapflow
- `mailparser` 3.6.9 - Parsing raw MIME email messages
- `node-cron` 4.2.1 - Background job scheduler

**Infrastructure:**
- `helmet` 7.1.0 - HTTP security headers on Express
- `express-rate-limit` 7.2.0 - Rate limiting (global 500 req/15min prod, auth 5 req/15min, tracking 100 req/min)
- `cors` 2.8.5 - CORS middleware scoped to `FRONTEND_URL`
- `jsonwebtoken` 9.0.2 - JWT signing for SMTP/IMAP authentication
- `bcrypt` 6.0.0 - Password hashing for native mail auth (12 rounds)
- `uuid` 9.0.1 - UUID generation throughout
- `date-fns` 3.6.0 + `date-fns-tz` 3.1.3 - Date formatting and timezone handling
- `lodash` 4.17.21 - Utility functions
- `html-to-text` 9.0.5 - Email HTML to plain text conversion
- `drizzle-zod` 0.5.1 - Auto-generates Zod schemas from Drizzle table definitions

## Database & Storage

**Database:**
- PostgreSQL via Supabase (cloud-hosted)
  - Connection: `DATABASE_URL` env var (Supavisor pooler, port 6543, transaction mode)
  - Direct URL: `DIRECT_URL` env var (used by drizzle-kit for migrations; configured in `drizzle.config.ts`)
  - Client: `drizzle-orm` + `postgres` driver (`src/db/index.ts`)
  - Pool: max 20 connections (configurable via `DB_POOL_MAX`), 10s idle timeout, 30s connect timeout, 30min max lifetime
  - Retry logic: exponential backoff up to 3 attempts for connection errors (`withRetry` in `src/db/index.ts`)
  - Schema: `src/db/schema.ts`
  - RLS policies: `supabase/migrations/001_enable_rls.sql` through `015_schema_reconciliation.sql`
  - Debug logging in development via Drizzle's `logger` option

**File Storage:**
- Supabase Storage (avatars referenced by `avatarUrl` on `users` table; CSP `img-src` allows the Supabase origin)
- Local filesystem: not used for persistent storage

**Caching:**
- Server-side in-memory cache for system branding (`src/server/lib/serverBranding.ts`, `getCachedBranding`)
- No Redis or external cache layer

## Dev Tooling

**Linting:**
- ESLint 8.57.0 - strict mode, zero warnings enforced
- @typescript-eslint/eslint-plugin 7.2.0 - TypeScript-specific rules
- @typescript-eslint/parser 7.2.0
- eslint-plugin-react-hooks 4.6.0 - React hooks rules
- eslint-plugin-react-refresh 0.4.5 - React Refresh rules

**Formatting:**
- No Prettier or formatter configured (ESLint handles style)

**CSS:**
- PostCSS (`postcss.config.js`) with TailwindCSS + Autoprefixer 10.4.18

**TypeScript Config:**
- `tsconfig.json` - Client TypeScript (target ES2020, lib ES2020/DOM/DOM.Iterable, bundler resolution, jsx react-jsx, strict, noUnusedLocals, noUnusedParameters)
- `tsconfig.node.json` - Vite config compilation only
- `tsconfig.server.json` - Server TypeScript (emits to `dist/`)

## Build & Deploy

**Development:**
```bash
npm run dev              # Run client (port 9000) + server (port 9001) concurrently
npm run dev:client       # Vite dev server only
npm run dev:server       # Express server with tsx watch only
```

**Production Build:**
```bash
npm run build            # Full build (client + server)
npm run build:client     # Vite build → dist/client/
npm run build:server     # tsc → dist/ (with package.json type: commonjs)
npm run build:api        # esbuild for Vercel → api/index.js
npm run build:vercel     # Client + API build for Vercel
npm start                # Run production build (node dist/server/index.js)
```

**Database:**
```bash
npm run db:generate      # Generate Drizzle migrations
npm run db:push          # Push schema to database
npm run db:studio        # Open Drizzle Studio
npm run db:rls           # Run RLS migration script
npm run db:audit         # Audit schema drift
```

**Vite config highlights:**
- Client dev port: 9000
- Server dev port: 9001
- `/api` proxied to backend
- Manual chunk splitting: vendor-react, vendor-router, vendor-query, vendor-ui, vendor-quill, vendor-date
- `appConfigPlugin`: serves `/app-config.js` with Supabase config in dev mode

**Deployment targets:**
- Docker: `Dockerfile` (node:20-alpine), `docker-compose.yml`
- Railway: detected via `RAILWAY_ENVIRONMENT`; SMTP/IMAP disabled by default
- Vercel: `build:vercel` script creates `api/index.js` serverless bundle

## Environment Variables

| Variable | Required | Purpose | Default |
|---------|----------|---------|---------|
| `SUPABASE_URL` | Yes | Supabase project URL (server) | — |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon key (server) | — |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server) | — |
| `VITE_SUPABASE_URL` | Yes | Supabase project URL (client) | Falls back to `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase anon key (client) | Falls back to `SUPABASE_ANON_KEY` |
| `DATABASE_URL` | Yes | PostgreSQL connection string (Supabase pooler) | — |
| `JWT_SECRET` | No | JWT signing secret for SMTP/IMAP auth | — |
| `ENCRYPTION_KEY` | No | Data encryption key (hex, 32 bytes) | — |
| `OUTLOOK_TOKEN_ENCRYPTION_KEY` | No | Outlook token encryption key | Falls back to `JWT_SECRET` |
| `PORT` | No | Server port | `9001` |
| `NODE_ENV` | No | Environment mode | `development` |
| `FRONTEND_URL` | No | Frontend URL for CORS | `http://localhost:9000` |
| `VITE_APP_NAME` | No | App display name | `Skale Club Mail` |
| `APP_COMPANY_NAME` | No | Company branding | `Skale Club` |
| `APP_APPLICATION_NAME` | No | Application branding | `Skale Club Mail` |
| `SMTP_HOST` | No | SMTP relay host | — |
| `SMTP_PORT` | No | SMTP relay port | `587` |
| `SMTP_USER` | No | SMTP relay username | — |
| `SMTP_PASS` | No | SMTP relay password | — |
| `SMTP_FROM` | No | Default sender address | — |
| `MAIL_HOST` | No | Native mail server hostname | `localhost` |
| `MAIL_DOMAIN` | No | Mail domain for SMTP/IMAP | `mail.yourdomain.com` |
| `SMTP_SUBMISSION_PORT` | No | SMTP submission port | `2587` (dev), `587` (prod) |
| `IMAP_PORT` | No | IMAP server port | `2993` (dev), `993` (prod) |
| `MAIL_TLS_CERT_PATH` | No | TLS certificate path (prod) | — |
| `MAIL_TLS_KEY_PATH` | No | TLS private key path (prod) | — |
| `DB_POOL_MAX` | No | Database connection pool size | `20` |
| `DB_IDLE_TIMEOUT_SECONDS` | No | DB idle timeout | `10` |
| `DB_CONNECT_TIMEOUT_SECONDS` | No | DB connection timeout | `30` |
| `DB_MAX_LIFETIME_SECONDS` | No | DB connection max lifetime | `1800` |
| `MICROSOFT_CLIENT_ID` | No | Microsoft OAuth client ID (Outlook) | — |
| `MICROSOFT_CLIENT_SECRET` | No | Microsoft OAuth client secret (Outlook) | — |
| `ENABLE_MAIL_SERVER` | No | Enable SMTP/IMAP servers | — |
| `VERCEL` | No | Vercel deployment flag | — |
| `RAILWAY_ENVIRONMENT` | No | Railway deployment flag | — |
| `DEPLOY_VERSION` | No | Deployed version string | `unknown` |
| `DEPLOYED_AT` | No | Deploy timestamp | — |
| `BASE_URL` | No | Base URL for tracking links | `http://localhost:{PORT}` |

## Path Aliases

| Alias | Resolves To | Config |
|-------|------------|--------|
| `@/*` | `./src/*` | `tsconfig.json` → `paths` |

**Security note:** `.env.example` file present. Never commit `.env` or secrets to git.

---

*Stack analysis: 2026-03-31*
