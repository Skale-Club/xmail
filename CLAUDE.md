# CLAUDE.md — SkaleClub Mail

## Project Overview

SkaleClub Mail is a multi-tenant email server management platform inspired by Postal. It provides organization-based access control, domain verification, message tracking, email routing, webhooks, and analytics.

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

### Frontend Patterns
- All admin pages under `/admin/*` route
- React Query for server state (auto-refetch, cache invalidation)
- Forms use react-hook-form + Zod schemas
- Toast notifications for user feedback
- Dark/Light/System theme support

## Environment Variables

Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `DATABASE_URL`

Optional: `PORT` (default 9001), `NODE_ENV`, `JWT_SECRET`, `FRONTEND_URL` (default http://localhost:9000), `SMTP_HOST/PORT/USER/PASS/FROM`

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
