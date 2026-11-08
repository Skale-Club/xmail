# CLAUDE.md — Xmail

<!-- journal-protocol:v1 -->
## Journal (mandatory)

This app's history (what it does, how each part was built, decisions and releases) lives in its Notion Journal. It replaces the old GSD/PAUL planning flow; `.planning/` and `.paul/`, if present, are a read-only legacy archive.

- Journal hub: https://app.notion.com/p/411b7a686121814abf98e7c623e2539a
- Journal Entries data source: collection://1ed041df-1ece-4cf7-9b7e-facc2ecbe5f7
- Latest view: view://411b7a68-6121-813c-a6bc-000c0703ae26
- Entry prefix: XML
- Rules (they win on any conflict): https://app.notion.com/p/411b7a68612181b3ac36f4ce2b2c3850 (skill: `app-journal`)

**Start of session:** fetch the hub and read Identity and Current State; list the latest 20 entries with Notion query-data-sources in `view` mode on the Latest view above (`page_size` 20; view mode has no plan quota) and read only titles and summaries; use `rows` mode with a filter only to narrow down (it has a plan quota); if a read fails, say so and continue from the code, never guess journal content; open only the entries you need; never read the whole database. Cross-check with the code: the code is the fact.

**End of every task that changed code, behavior, infrastructure or a decision:**
1. Create ONE entry in the data source above (one per logical unit of work, not per commit): `Title` = `YYYY-MM-DD — <imperative summary>`, `date:Date:start` (YYYY-MM-DD, with `date:Date:is_datetime` = 0), `Type`, `Area` (JSON array of existing options), `Status`, `Summary` (max 280 characters), `Agent`, `Model`, `Repo / Branch`, `Commits / PR`, `Tests` (what ran, or "Not run"), and `Decision ID` / `Decision Status` when a choice was made.
2. Body headings: Context · What changed · How it was built · Decisions and why · Tests and evidence · Not done / risks · Next.
3. If the app changed, rewrite the affected part of the hub's Current State. Read back what you wrote; never report a write you did not see.
4. Notion unavailable: append the full entry to `docs/journal/PENDING-NOTION.md` and tell the owner.

Journal records are in English. No secrets.
<!-- /journal-protocol -->

<!-- model-routing:v1 -->
## Model routing (token economy) — mandatory, every task

The model the owner chose for this session is the **orchestrator**. It plans the work, splits it into pieces, picks the right model for each piece, and **audits and validates** every result. It does not have to execute everything itself: execution goes to faster, cheaper models whenever they can do the piece well. Without routing, tokens drain fast.

**Delegation ladder** (delegate one or two tiers down, never up):

| Session model (orchestrator) | Delegates execution to |
|---|---|
| Claude Fable | Opus (hard sub-problems), Sonnet (standard implementation, analysis, writing) |
| Claude Opus | Sonnet (implementation, analysis, writing), Haiku (bulk reads, search, mechanical edits, data entry) |
| Claude Sonnet | Haiku (bulk reads, search, mechanical edits), when it pays off |
| Claude Haiku | does the work itself |
| Codex / ChatGPT top model | the same idea with the smaller models available there (a mini model for bulk and mechanical work) |

**Rules**
1. **Routing plan first.** Before a multi-step task, list the pieces and give each one a tier. A trivial task (a handful of tool calls, or a lookup whose target is known) is done directly: an extra agent would cost more than it saves.
2. **Delegate:** bulk file reading and search, codebase mapping, mechanical multi-file edits, data entry (Notion rows, seed data), log and test-output triage, first drafts.
3. **Keep on the orchestrator:** decisions and trade-offs, architecture, anything touching production, credentials, money or customer data, security review, and the **final verification** of every delegated result.
4. **Self-contained briefs:** goal, files, constraints, what done looks like, output format. Ask for a concise report, never raw dumps.
5. **Audit before accepting:** read the diff, re-run the tests, spot-check the data. A subagent's report is a claim, not proof.
6. **Parallel when independent:** independent pieces run at the same time; dependent pieces run in order.
7. **Record it:** the journal entry says which models did what (Agent / Model fields).

How (Claude Code): the Agent tool with `model: "opus" | "sonnet" | "haiku"`; read-only searches can use the Explore agent type. Skill: `model-routing`. Notion: Projects → Templates → AI Model Routing Protocol.
<!-- /model-routing -->

<!-- machine-awareness:v1 -->
## Machine awareness — check the computer before heavy work

The owner works on two very different computers, often on several projects at once:
- **Surface Pro 7+** (`VANILDO-TABLET`): 8 GB RAM, i5 4 cores. Usually has about 1 GB free. **Always light mode.**
- **Home desktop** (high-end): normal mode.

**At the start of a session, and before any heavy step**, run:
`powershell -NoProfile -File "$HOME\.claude\bin\machine-check.ps1"` (Codex: `$HOME\.codex\bin\machine-check.ps1`).
It prints `MACHINE=… MODE=light|normal|critical` with free RAM.

**Light mode** (Surface, any computer with 16 GB or less, or under 2 GB free):
1. No parallel fan-out: at most **one** subagent at a time; do small things directly.
2. No dev servers, full builds, full test suites, Docker, Playwright/Chrome automation or `npm install` unless the owner asks. Run only the targeted test for what changed. Never two heavy Node processes at once; stop any server you started.
3. No extra git worktrees with `node_modules`; reuse the checkout or a junction, and remove temporary worktrees right after.
4. Keep tool output small (`head`, `--stat`, filters); never dump big files or logs.
5. Heavy jobs (full test runs, builds, large data loads) go to the server or wait for the desktop: say so and record a task instead of running them here.

**Critical** (under 1 GB free): stop before the heavy step and tell the owner what is using memory; continue only with light commands.

**Normal mode** (desktop): routing rules still apply; parallel agents and full test runs are fine.
<!-- /machine-awareness -->

<!-- delivery-time:v1 -->
## Delivery estimate and no silent stalls (owner rule 2026-11-07, from Brasil Showdown)

1. **Estimate every task.** For any task longer than a quick answer, say in the first message the expected delivery as a **clock time plus duration** (owner's local time, e.g. "pronto por volta das 19:40, ~25 min"). Long commands (build, release, full tests, migration, seed, deploy, bulk Notion work) get their own clock time when they start. Estimates may miss; giving one is mandatory 100% of the time.
2. **Update when it slips.** If a step runs past its estimate, say so right away with the new time and the reason. Never let an estimate silently expire.
3. **Time-box every step; never sit idle.** If a step takes **2× its estimate**, or a command or subagent shows **no progress for 10 minutes**, stop waiting and re-check: is the process alive, what do the logs say, is it waiting for input, is the machine out of memory (`machine-check.ps1`)? Then retry, change approach, or tell the owner. Do not poll in a tight loop either: wait with a timeout, then check.
4. **Budget subagents.** Every delegated brief carries a time budget; a subagent past its budget is checked, not waited on.
5. **Close the loop.** At the end, one line: estimated vs actual. Record measured durations of recurring steps in the repository's docs (e.g. "lab rebuild about 2-3 min") so the next estimate is better.
<!-- /delivery-time -->

## Project Overview

Xmail is a multi-tenant email server management platform inspired by Postal. It provides organization-based access control, domain verification, message tracking, email routing, webhooks, and analytics.

## Deployment (Hetzner + Coolify/Traefik - NOT Vercel)

**Production runs on a Hetzner VPS**, deployed via GitHub Actions on push to `main`. Coolify/Traefik is the primary HTTP routing layer when the `coolify` Docker network exists on the host.

- **Host:** Hetzner VPS (see `HETZNER_HOST` secret in GitHub Actions)
- **Process model:** single Docker container (`xmail:latest`) running Node 20-alpine
- **Container:** `Dockerfile` at repo root builds + runs `dist/server/index.js`
- **Container network:** if Docker network `coolify` exists, deploy runs the app with `--network coolify` so Traefik can reach `http://xmail:9001`
- **Published ports:**
  - `9001` - HTTP API + SPA, bound to `127.0.0.1:9001` only (not public). Traefik reaches it over the `coolify` Docker network at `http://xmail:9001`; `wait_for_container_health()` probes it via `docker exec` from inside the container. Publishing it on `0.0.0.0` would let a client hit Express directly and forge `X-Forwarded-For` (the app trusts it via `trust proxy`) to dodge the per-IP rate limiter (500 req/15min in production) — loopback-only closes that off since 25/587/993 have no such proxy-trust surface to spoof.
  - `25` - SMTP MX inbound, direct public TCP to the Node MX server
  - `587` - SMTP submission, direct public TCP to the Node SMTP server
  - `993` - IMAP, direct public TCP to the Node IMAP server
- **CI/CD (ACTIVE PATH):** `.github/workflows/build-deploy.yml` — builds the image on GitHub runners, pushes to GHCR, SSHes into the host and does a blue-green rollout (green HTTP candidate `xmail-next` → health check → promote to `xmail`, rollback to `:previous` on failure). **Runtime env vars are passed via `-e` inside its shared `run_app_container()` function — any new env var MUST be added there** (this is the block that actually creates the prod container). `.github/workflows/deploy-hetzner.yml` is the LEGACY on-host-build workflow; it duplicates the same env list and should be kept in sync, but editing only it does nothing for pushes to main.
- **HTTP reverse proxy:** Traefik via Coolify is primary. The deploy script attaches Traefik labels and, when available, writes `/data/coolify/proxy/dynamic/xmail.yaml` pointing `mail.skale.club` to `http://xmail:9001`.
- **Legacy fallback:** if the `coolify` network is absent and Caddy exists, the deploy script can still add a Caddy reverse-proxy block for `mail.skale.club -> localhost:9001`.
- **Mail ports bypass proxies:** ports `25`, `587`, and `993` are **not** behind Traefik or Caddy. They are raw TCP published from the container to the internet. TLS for mail ports is handled inside Node via `MAIL_TLS_CERT_PATH` / `MAIL_TLS_KEY_PATH`.
- **Mail identity:** production sets `MAIL_HOST=mx.skale.club`; MX DNS for `skale.club` points at `mx.skale.club`.
- **Public origin for tracking links:** `BASE_URL` (optional) is the origin `/api/messages` uses to build open/click tracking links (`/t/*`); when unset it falls back to `FRONTEND_URL`, since the same origin serves both the SPA and `/t/*` in production.
- **Logs:** production mail arrival logs are in Docker stdout/stderr, e.g. `docker logs xmail --since 24h 2>&1 | grep -E '\[MX\]|\[RouteMatcher\]|\[mail-auth\]'`.

**No Vercel, no serverless, no edge functions.** Traditional long-running Node process in Docker.

> **Sidecar (not part of xmail):** the same Hetzner host also runs a separate
> [Hermes Agent](https://hermes-agent.nousresearch.com/) container (`/opt/hermes`,
> isolated from the `xmail` container, capped at 1 GB RAM). It is unrelated to the
> email server but shares the box. See [`hermes/README.md`](hermes/README.md) for its
> setup, LLM config (Codex OAuth with `gpt-5.6-sol` primary and `kimi-k3` fallback), Telegram channel, and gotchas
> (notably the expired ghcr.io Coolify credential that breaks Docker pulls — use
> `DOCKER_CONFIG=/tmp/emptydocker`).

### Deploy commands

```bash
# Local build parity
docker build -t xmail:local .
docker compose up

# Production deploy: automatic on git push to main
git push origin main   # triggers .github/workflows/build-deploy.yml (deploy-hetzner.yml is LEGACY)
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
│   ├── admin/           # Admin layout + per-tab org admin components (org-tabs/)
│   └── mail/            # Webmail UI (ComposeDialog, EmailThread, MailLayout, etc.)
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
│   ├── admin/           # Admin pages (Organizations, Users, Branding, Integrations, and
│   │                    #   the tabbed OrganizationDetailPage — no per-resource pages)
│   ├── mail/             # Webmail (Inbox, Sent, Drafts, Trash, Compose, Search, etc.)
│   └── outreach/         # Outreach/prospecting UI (campaigns, leads, unified inbox)
├── server/
│   ├── index.ts         # Express entry point (middleware, auth, routing)
│   ├── lib/              # ~100 files: access.ts (authorization), tracking.ts (open/click
│   │                    #   + webhook dispatch), mail-tls.ts, health.ts, and the outreach/
│   │                    #   prospecting/inbox support libs
│   └── routes/           # API route handlers — auth.ts, users.ts, organizations.ts,
│       │                #   domains.ts, credentials.ts, routes.ts, messages.ts,
│       │                #   webhooks.ts, track.ts, system.ts, outlook.ts, templates.ts,
│       │                #   integrations.ts, notifications.ts, autodiscover.ts,
│       │                #   agent-outreach.ts / agent-approvals.ts / agent-assessments.ts /
│       │                #   agent-prospecting.ts (the Hermes gateway, see below)
│       ├── admin/         # Admin-only routes (outreach-health.ts)
│       ├── mail/           # Native webmail routes (mailboxes, messages, send, sync, ...)
│       └── outreach/       # Campaigns, leads, email-accounts, unified-inbox, etc.
│                          #   (there is no routes/servers.ts — see Multi-Tenancy Model)
└── main.tsx             # React entry point with routes
supabase/migrations/     # Hand-rolled SQL migrations — source of truth for the running DB
drizzle/archive/         # Historical genesis DDL, never applied (see its README)
scripts/                 # Migration runner + audit scripts
```

## Commands

```bash
npm run dev              # Run client (port 9000) + server (port 9001) concurrently
npm run dev:client       # Vite dev server only
npm run dev:server       # Express server with tsx watch only
npm run build            # Build both client and server
npm start                # Run production build (node dist/server/index.js)
npm run lint             # ESLint (strict, zero warnings)
npm test                 # Vitest (single run); npm run test:watch for watch mode
npm run db:studio        # Open Drizzle Studio (read-only)
npm run db:indexes       # Apply sql/indexes.sql (CREATE INDEX CONCURRENTLY)
npm run db:rls           # Run the RLS migration script
npm run db:audit         # Audit schema drift between schema.ts and the DB
```

**Real data in development:** `npm run db:pull` copies a read-only production snapshot into the
development Supabase project (secrets and native mailbox passwords are never copied); in development the
process cannot send or receive real mail (mail servers off, fail-closed network guard, read-only
attachment storage). See [`docs/dev-database-pull.md`](docs/dev-database-pull.md).

**Development database selection (migration in progress):** `dev:server` forces
`NODE_ENV=development`. Both Drizzle pools require `XMAIL_DEV_SUPABASE_PROJECT_REF`
and `XMAIL_DEV_DATABASE_URL`; optional `XMAIL_DEV_DIRECT_URL` must target that same
approved Supabase development project. They never inherit `DATABASE_URL` or
`DIRECT_URL` in development, including with `XMAIL_ALLOW_REMOTE_DB=true`.
Both URLs require an explicit password, database `postgres`, and direct/session
port 5432 (an omitted port is pinned). Direct connections require user `postgres`;
pooler users must be `postgres.<approved-ref>`. The selector adds `sslmode=require`
when absent and accepts only required TLS modes (`require`, `verify-ca`,
`verify-full`); other/duplicate query options and URL fragments fail before pool
construction. The development migration wrapper uses the same normalized target.
Operational scripts still using raw URLs are not covered. Do not start development
until Auth settings and external side effects are isolated too. See
[`docs/xmail-supabase-exit.md`](docs/xmail-supabase-exit.md) for evidence and remaining work.

> **Typechecking needs BOTH configs.** `tsconfig.json` **excludes `src/server/**` and
> `src/db/**`**, so `npx tsc --noEmit -p tsconfig.json` type-checks only the client and
> reports "clean" while real errors sit in server code. Server and DB code are covered by
> `tsconfig.server.json` (what `npm run build:server` uses). CI runs both; anyone checking
> types by hand must too. This was discovered on 2026-09-08 after a whole session of
> server-side work was "validated" with the client-only command — two genuine type errors
> were sitting in `measureProspectingOutcomes.ts` and `advisory.ts` the whole time.

## Architecture Notes

`src/server/index.ts` selects a runtime before importing application modules. Its
default path loads the unchanged production server from `production-server.ts`.
Explicit `XMAIL_STAGING_HTTP_ONLY=true` loads only the restricted private-candidate
reader/aggregate HTTP probe; see `docs/xmail-http-staging.md`. Do not use development
mode or ENABLE_MAIL_SERVER alone to isolate a copied database from startup jobs.

### Authentication Flow

**Owned identity pilot (not activated):** `src/server/lib/identity/` provides
Firebase Google/verified-phone token verification, a live account-status adapter,
hashed opaque session policy and a postgres.js store. Migrations `079`/`080` are
additive and applied on the private candidate; they preserve application UUIDs,
organization roles, `isAdmin` and SMTP/IMAP `password_hash`. The reviewed controls
import reconciled 39 users (1 disabled), with matching readback and native-hash
digests; independent audit confirmed 39 controls/38 memberships, RLS on all four
tables and zero bindings, sessions or challenges. Candidate runtime roles remain
NOLOGIN, `XMAIL_GOOGLE_AUTH_ENABLED=false`, and the production container and
application source are unchanged. `XMAIL_GOOGLE_AUTH_ENABLED` defaults off.
The isolated `/auth/identity` pilot uses host-only HttpOnly cookies, single-use
CSRF challenges, fresh local controls/provider status and in-memory Firebase
persistence. Current `/login` remains the default. DEV needs distinct explicit
SQL/Auth/Google projects; API-key provenance is checked before exposing browser
config. Read `docs/xmail-identity-pilot.md` and `docs/xmail-supabase-exit.md` before activation.

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
- The `servers` table was dropped in migration `008_remove_server_legacy.sql` — there is no
  intermediate server layer any more. All resources (domains, credentials, routes,
  messages, webhooks, mailboxes, outreach data, etc.) belong directly to Organizations via
  `organization_id`.
- **Authorization model:** JS-side helpers in `src/server/lib/access.ts`
  enforce org-scoped data access. RLS policies are defense-in-depth and
  do NOT alone protect tenants (the app role bypasses RLS).

### API Conventions
- All API routes under `/api/`
- Rate limited per IP on `/api/`: 500 req/15min in production, 2000 otherwise (`src/server/index.ts`); long-lived SSE reconnects count against it
- Resources typically require a parent ID as query param, almost always `?organizationId=...` (no `?serverId=` — that layer no longer exists)
- Standard REST patterns: GET (list/detail), POST (create), PUT (update), DELETE (remove)
- Zod validation on request bodies

### Email Tracking
- Open tracking: 1x1 transparent GIF pixel injected into HTML emails (`/t/open/:token`)
- Click tracking: URL rewriting with base64url-encoded redirect (`/t/click/:token?u=...`)
- Both respond immediately, process tracking asynchronously

### Mail Message UIDs (native mailboxes)

`mail_messages.remote_uid` is the IMAP UID our own IMAP server serves to clients
(Thunderbird et al). It is **folder-scoped**: unique inside the folder, ascending, and
always strictly below that folder's `uid_next` (the UIDNEXT we advertise). The unique
index `mail_message_folder_uid_unique` enforces the uniqueness half.

- **Never change `folder_id` on its own.** Every folder change goes through
  `moveMessagesToFolder()` in `src/server/lib/move-messages.ts`, which allocates a fresh
  UID from the destination inside a transaction. Setting `folder_id` alone imports the
  source folder's UID and leaves the destination advertising a UIDNEXT below UIDs it
  already holds; it also collides with the unique index, and the MX insert path uses
  `ON CONFLICT DO NOTHING`, so inbound mail is dropped silently.
- **Never insert with a null `remote_uid`.** A UID-less row cannot be addressed by
  `UID EXPUNGE`, so once it reaches Trash it is undeletable over IMAP — this was the
  2026-08-16 bug where Thunderbird could not delete from Lixeira/Spam. Use
  `allocateUidForNewMessage()` (or `allocateNextUid()` on the MX/SMTP paths).
- **Mirrored mailboxes are the exception.** When `mailboxes.is_native = false`,
  `remote_uid` belongs to the *remote* server and is the dedup key `mail-sync.ts` matches
  on. Both helpers detect this and leave the UID alone.
- **`is_deleted` means only the IMAP `\Deleted` flag** — a client asked for this message
  to be expunged. Do not reuse it as an app-level soft delete: `EXPUNGE`/`CLOSE` hard-delete
  every flagged row, so anything the backend flags gets destroyed on the client's next
  folder switch. `cleanupMessages.ts` used to do exactly that to aged-out spam.

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
- `POST /api/outreach/send-message` (`x-service-key` auth, `?organizationId=` required) sends a
  one-to-one transactional email from a verified native outreach inbox — not campaign traffic, no
  warmup/sending-limit bookkeeping and no open/click tracking injection.

### Regras do processo de prospecção — as três caixas (NÃO NEGOCIÁVEL)

Definidas pelo Vanildo e registradas em 2026-09-30, depois de um plano de ativação ter sido
escrito em cima da premissa errada (que a campanha sairia das `info@`). **Se qualquer análise,
plano ou código contradisser isto, quem está errado é a análise.** Toda a estrutura de
prospecção depende destas três regras:

| Papel | Quais caixas | Warm-up | Campanha fria |
|---|---|---|---|
| **Caixa útil da empresa** | `info@` de cada domínio da operação | **NUNCA** | **NUNCA** |
| **Caixa de warm-up** | endereços criados só para isso, sem uso real (hoje `contato@`, `agenda@`, e `parcerias@`/`suporte@` em skale.club/xkedule) | sim — é a única função delas | **NUNCA** |
| **Caixa de envio (outreach)** | as contas **Google compradas na Icemail**, cadastradas como inbox de outreach (hoje as 5 de `tryskaleclub.com`, `provider='smtp'`, `smtp.gmail.com`) | sim, com as caixas de warm-up | **SIM — só elas** |

1. **`info@` é caixa de trabalho: gente lê.** Não entra no mesh de warm-up (tráfego sintético numa
   caixa de trabalho é lixo para quem lê) e não dispara campanha. No banco: `warmup_source='none'`.
2. **Warm-up acontece entre caixas inúteis, criadas para isso.** Caixa nova de warm-up se cria com
   `scripts/warmup-seed-native.ts` (sem `--no-mesh`), que grava `warmup_source='internal'` +
   `warmup_only=true`. `warmup_only=true` é o que impede a caixa de ser matriculada como remetente.
3. **Cold e-mail para prospect sai somente pelas contas Google da Icemail.** O tráfego de campanha,
   portanto, sai pela infraestrutura do Google (`smtp.gmail.com`), autentica pelo SPF/DKIM/DMARC de
   `tryskaleclub.com` e **não** passa pelo relay direto do Hetzner. Problemas de entrega do caminho
   nativo (ex.: o SPF falhando no IPv6, fase 42 de `docs/campaign-activation-plan.md`) afetam o
   warm-up das caixas nativas, **não** a campanha.

**O que garante isto no código, e o que não garante (medido em 2026-09-30):**
- Regra 2/3 para as caixas de warm-up: garantida — `warmup_only=true` é filtrado em
  `agent-outreach.ts` (matrícula pelo agente) e em `campaigns.ts` (ativação).
- Regra 1/3 para as `info@`: **garantida desde 2026-09-30** (`63982a9`). `OUTREACH_PROTECTED_DOMAINS`
  leva os domínios da operação (nove desde 2026-10-23, com `brasilshowdown.com`) no `run_app_container` do `build-deploy.yml`; somado ao
  `MAIL_DOMAIN` (`skale.club`), nenhum endereço de domínio da empresa pode ser matriculado nem
  ativado como remetente (`checkProtectedSendingDomains`, em `campaigns.ts` e `agent-outreach.ts`).
  Provado dentro do container de produção: `info@xkedule.com`, `contato@xphere.app` e
  `info@skale.club` → bloqueado; `vanildo.jr@tryskaleclub.com` → permitido. **Domínio novo da
  operação tem que entrar nessa lista**, senão a `info@` dele vira remetente possível.
- E-mail de plataforma de agendamento (Booksy, Vagaro, PocketSuite…) nunca é da empresa: o Xmail
  recusa na importação e na matrícula (`src/server/lib/platform-emails.ts`), o Xcraper não grava
  na origem e, desde 2026-10-07, o Xphere nunca verifica (sem gastar crédito), nunca importa e
  nunca matricula (`src/lib/prospects/platform-emails.ts`, gravado como `invalid`/`platform_rule`).
  Caso real que motivou: `help.us@booksy.com` em 38 barbearias no Xphere, 12 delas marcadas como
  verificadas, e o Hermes lendo isso como problema do piloto. **As três listas de domínios têm que
  ser iguais (19 domínios em 2026-10-07): plataforma nova entra nas três.**

### Prospecting system documentation (read first, keep current)
The whole prospecting pipeline (homelab scraper, Xcraper, Xphere, Xmail, Hermes, the rules and
limits) is described in ONE place: [`docs/prospecting/README.md`](docs/prospecting/README.md),
in English. **Any change to prospecting behavior updates that file in the same commit** (a rule, a
limit, a tool, a step, a host). Notion holds a read-only mirror; refresh it after updating.

### Hermes Prospecting Gateway
The LLM agent (Hermes) drives prospecting through `/api/agent/outreach/*` only — a
capability-scoped, org-bound credential with no send and no activation capability.
**Before analyzing, debugging or changing anything in that pipeline, read
[`docs/outreach-hermes-system-map.md`](docs/outreach-hermes-system-map.md)** — it maps the
files, the ten authority gates, the invariants (each with a one-command proof), the
production prerequisites and the currently-open findings, so the analysis does not have to
be rebuilt from scratch. Keep its "achados abertos" table and audit date current.

### Frontend Patterns
- All admin pages under `/admin/*` route
- React Query for server state (auto-refetch, cache invalidation)
- Forms today are plain `useState` + manual validation, not react-hook-form. `react-hook-form`, `@hookform/resolvers`, and `zod` are dependencies and are the intended target for a form-adoption pass in progress — don't assume existing forms use them until that lands.
- Toast notifications for user feedback
- Dark/Light/System theme support

## Environment Variables

Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `DATABASE_URL`, `OUTLOOK_TOKEN_ENCRYPTION_KEY`

Development Auth additionally requires `XMAIL_DEV_SUPABASE_ANON_KEY` and
`XMAIL_DEV_SUPABASE_SERVICE_ROLE_KEY` for the explicitly selected
`XMAIL_DEV_SUPABASE_PROJECT_REF`. Vite development and server Auth never inherit
production `SUPABASE_*` / `VITE_SUPABASE_*` aliases. Credential encryption in
development uses only `XMAIL_DEV_OUTLOOK_TOKEN_ENCRYPTION_KEY`. Production keys and
native mailbox password hashes remain unchanged. Development does not start cron
jobs, native mail listeners, startup ops alerts or the DB liveness watchdog.
This is **not** complete external-effect isolation: manual send/sync, route-driven
webhooks, OAuth, R2 and stored integration credentials still need sanitization or
dedicated sandbox targets. Do not start development against a production copy.

> **`OUTLOOK_TOKEN_ENCRYPTION_KEY` has no fallback, on purpose.** It is the single key behind
> `encryptSecret`/`decryptSecret` (stored SMTP/IMAP passwords, Outlook tokens). It used to fall back
> to `JWT_SECRET`, which meant two servers pointed at the same database could encrypt with two
> different keys and neither would complain — the rows only turned out unreadable much later, at the
> point of use. That is exactly what happened on 2026-08-15: a dev server on a local `.env` wrote the
> five outreach mailbox credentials, and production could not decrypt any of them. **Never point a
> local server at the production `DATABASE_URL` to write credentials.** A wrong-key payload now
> raises `CredentialKeyMismatchError`, which names the affected record instead of surfacing Node's
> bare `Unsupported state or unable to authenticate data`.

Optional: `PORT` (default 9001), `NODE_ENV`, `JWT_SECRET`, `FRONTEND_URL` (default http://localhost:9000), `SMTP_HOST/PORT/USER/PASS/FROM`, `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` (Cloudflare R2 object storage for inbox attachments + branding assets via `src/server/lib/object-storage.ts`; falls back to Supabase Storage when unset) plus `R2_PUBLIC_BASE_URL` (public domain of the branding-assets bucket) and optional `R2_ENDPOINT` override, `XMAIL_SERVICE_KEY` (machine-to-machine auth for the Xphere orchestrator on `/api/outreach/*`, fails closed if unset), `XMAIL_SERVICE_USER_ID`/`XMAIL_SERVICE_ORGANIZATION_ID` (bind the service key to a server-configured principal + organization; the client cannot choose its own identity or tenant, and all three must be set together or machine auth stays disabled), `XPHERE_EVENTS_URL`/`XPHERE_EVENTS_API_KEY` (outbound outreach event notifications to Xphere; both required together), `MONITOR_API_TOKEN` (shared secret letting the external uptime probe read the Telegram alert credentials back out of the admin panel via `GET /api/admin/integrations/monitor-config`; without it that endpoint returns 503 — see below), `ERROR_SPIKE_THRESHOLD`/`ERROR_SPIKE_COOLDOWN_MS`/`OPS_ALERT_REPEAT_MS`/`QUEUE_STALL_MINUTES`/`RSS_WARN_MB`/`DISK_WARN_PERCENT` (alert tuning), `OUTREACH_HOME_BASE_ZIP`/`OUTREACH_HOME_RADIUS_MILES` (home ZIP, default `01702`, and radius in miles, default `30`, behind the `nearby` template flag in `src/server/lib/zip-distance.ts`; moving cities is these two vars only)

### Telegram Ops Alerting

Three layers with deliberately overlapping blind spots — external (GitHub Actions, the only
one that survives the app dying), internal (crashes, stalled queue, memory, disk, mail servers
failing to bind), and aggregated (one alert per error *rate*, never per error). **The bot token
and chat id live in the admin panel (`system_integrations`, `/admin/integrations`), never in
env** — the token is encrypted with `OUTLOOK_TOKEN_ENCRYPTION_KEY`, so writing it from a local
server pointed at the production database produces an undecryptable row. Ports 25/587/993 are
raw TCP outside Traefik, so the external probe checks 587/993 directly; port 25 is not probed
because GitHub-hosted runners block outbound 25. The error-spike threshold (15 per 5 min) is
**measured, never guessed**: production showed 770 errors/24h with a recurring peak of 23 until
the `outreach.inbound.account_error` defect behind it was fixed, after which the floor fell to
zero and the threshold came down from 60 to 15 with it. **Recalibrate the same way whenever the
floor moves** — read a day of `error_spike.baseline` log lines, and fix a new recurring defect
rather than raising the threshold past it, which would mute everything else too. Full rationale,
setup and troubleshooting in [`docs/TELEGRAM-ALERTS.md`](docs/TELEGRAM-ALERTS.md).

**Two Telegram channels, one bot.** `sendTelegram(title, body, channel)` defaults to `'ops'`
(server, deploy, errors, watchdog, uptime: the private owner chat). Prospect reply alerts and
approval cards pass `'outreach'`, which goes to `system_integrations.telegram_outreach_chat_id`
(migration 075) and falls back to the ops chat while that is unset. Any new outreach-domain
Telegram message must pass `'outreach'`; anything about the server stays on the default. The
owner for approval taps is the ops chat id, valid only while that chat is private; a tap must come
from the owner AND from the outreach or ops chat (`authorizeTap` in `lib/telegram-approvals.ts`).
Adding the bot to a group makes it offer that group as the outreach chat via a button in the ops chat.

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
- **Do NOT run `drizzle-kit generate` to produce migrations.** The Drizzle-generated diff would conflict with the hand-rolled SQL we've accumulated since `drizzle/archive/0000_dear_wolverine.sql` (the original genesis DDL — moved into `drizzle/archive/` because it targets the pre-`organization_id`, server-scoped schema and must never be applied against the current database; see `drizzle/archive/README.md`). The `db:generate`/`db:push` scripts have been removed from `package.json` (Phase 13 QUA-02 / audit M3) to prevent accidental destruction. `db:studio` (read-only Drizzle Studio) and `db:indexes` remain available.
- **Do NOT add Drizzle relations / constraints expecting them to apply automatically.** The TS-side schema is for type information; the DB side comes from the SQL migration.

**Numbering convention:** Migrations are sequential integers. This branch reserves `079_owned_identity_foundation.sql` and `080_identity_browser_challenges.sql` (unapplied outside disposable CI); the next free number is `081`. Migrations `070` through `078` are applied in production with their ledger rows (`077` and `078` verified on 2026-10-28; `078` widens the `outreach_action_approvals.action_kind` check for `campaign_enrollment`). Re-verify what is actually applied against `supabase_migrations.schema_migrations` before assuming. When two phases plan migrations in parallel, the second to land takes the next number and rewrites its planning docs accordingly.

> **Resolved collision (2026-08-15):** `051_warmup_engine.sql` shared its prefix with the
> already-applied `051_prospecting_journey_and_costs.sql`. Because the ledger keys on the numeric
> prefix, `051` read as applied and the warm-up file would never have run — silently. It was
> renumbered to `058_warmup_engine.sql` and applied. Treat this as the worked example of why a
> duplicate prefix must never be reintroduced.

**Two numbers must never collide.** `scripts/apply-pending-migrations.mjs` keys the ledger on the numeric prefix alone, so two files sharing a prefix register as one version and the second is silently skipped forever. A `032_reconcile_unique_indexes.sql` once collided with `032_add_native_email_provider.sql`; it was deleted on 2026-08-13 because `035` already creates the same index idempotently and transaction-safely. Do not reintroduce a duplicate prefix.

**Applying:** `DATABASE_URL=... node scripts/apply-pending-migrations.mjs` applies everything pending and records it in `supabase_migrations.schema_migrations`. Two caveats:
- The runner wraps each file in a transaction, so **a migration must not contain `CREATE INDEX CONCURRENTLY`** — that fails inside a transaction block. Put concurrent index builds in `sql/indexes.sql` and apply with `npm run db:indexes`.
- A file carrying its own `BEGIN;`/`COMMIT;` commits the runner's outer transaction early, so the ledger insert lands outside it. Harmless for idempotent migrations, but it means a file is not atomic with its own ledger row.

## Key Constraints

- Tests run on Vitest (`npm test`); ~69 `*.test.ts` files live alongside the code they cover, plus `*.db.test.ts` integration tests that need a reachable `DATABASE_URL`
- Registration endpoint is intentionally disabled (403)
- Express 5 is beta — uses `req.query` instead of `req.params` in some places
- Vite proxies `/api` requests to the backend in dev mode
- Request body limit: 10MB
- Path alias: `@/*` maps to `./src/*`
