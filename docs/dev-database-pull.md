# Real data in development: `npm run db:pull`

Production Xmail runs on the PostgreSQL container `e12scyfsrp822dag7m9wwd4x` on the
Coolify host (private Docker network only; the same cluster also holds the `xmartmenu`
database). Locally, `npm run dev` uses a Supabase **development** project
(`XMAIL_DEV_DATABASE_URL`). `npm run db:pull` copies a snapshot of production into that
project on demand. Production never depends on Supabase for application data.

`npm run dev` **never** copies anything by itself. Only the explicit `db:pull` does.

## How `npm run dev` picks its database today

`scripts/dev-server.mjs` forces `NODE_ENV=development`; `src/db/database-target.ts` then
accepts **only** `XMAIL_DEV_DATABASE_URL` (+ optional `XMAIL_DEV_DIRECT_URL` for the job
pool), validated against `XMAIL_DEV_SUPABASE_PROJECT_REF`: Supabase direct or session
pooler, port 5432, database `postgres`, TLS required. `DATABASE_URL` / `DIRECT_URL` are
ignored in development. The projects in `src/db/production-project-refs.ts` are refused
outright, both by `npm run dev` and by `db:pull`.

## Setup (no value is a secret except the dev database URL)

```
XMAIL_DEV_SUPABASE_PROJECT_REF=<20-character ref of the dev project>
XMAIL_DEV_DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-...pooler.supabase.com:5432/postgres
XMAIL_PROD_SSH=root@<Coolify host>
# optional: XMAIL_PROD_DB_CONTAINER (default e12scyfsrp822dag7m9wwd4x)
# optional: XMAIL_PROD_DB_NAME (default: the container's own POSTGRES_DB)
```

SSH must work without a password (`BatchMode=yes`): an already authorized key.

## What the command does, in order

1. Validates the destination (see above). Refuses `NODE_ENV=production` and any known
   production project.
2. Backs up the destination to `../xmail-db-backups/dev-<timestamp>.json` (outside the
   repo, mode 0600).
3. Brings the destination schema to the repo's state with `scripts/dev-migrations.ts
   --apply` (SQL migrations in `supabase/migrations/`). **Never `db:push`.**
4. Over SSH reads the container address and credentials (kept in memory), opens a tunnel
   bound to `127.0.0.1` only, and reads production in one `REPEATABLE READ READ ONLY`
   transaction.
5. Compares the schemas. Any production table or column missing in the destination, a
   different type, or a destination-only NOT NULL column without default **aborts before
   any data moves**.
6. Replaces the destination data in a **single transaction** (any error is a ROLLBACK).
   User triggers are disabled inside it (`session_replication_role = replica`); if the
   role cannot, the command stops (use `--allow-triggers` only when the destination has
   none).
7. Resets the sequences and closes the tunnel.

Nothing is downloaded to the PC besides the destination's own backup, and nothing is
written to production.

## What is not copied

- **Native mail passwords and other secrets** (`SCRUBBED_COLUMNS` in
  `src/server/lib/dev-db-pull.ts`, pinned by a test): `mailboxes.smtp_password_encrypted`
  and `imap_password_encrypted`, `email_accounts` SMTP/IMAP passwords, `smtp_endpoints`
  passwords, Outlook access/refresh tokens, `system_integrations.telegram_bot_token`,
  `webhooks.secret`, `users.password_hash` and `two_factor_secret`. The columns exist but
  hold NULL (or an empty string where the column is NOT NULL).
- **Sign-in state** (`EXCLUDED_TABLES`): `xmail_identity_owned_sessions` and
  `xmail_identity_browser_challenges`. They reference `users`, so they are emptied, not
  refilled. Dev Auth is a different Supabase project, so copied users cannot sign in
  with production credentials; create a dev user in the dev project's Auth.
- **Attachment files.** Only the `inbox_attachments` rows are copied. Object storage is
  read-only in development (`readOnlyObjectStorage`): downloads and signed URLs work if
  you configure R2 and allow its host, uploads and deletes always fail.
- The migration ledger (`supabase_migrations.schema_migrations`, outside `public`).

## Dev can never send or receive real mail

`src/server/index.ts` imports `src/server/lib/dev-guard-entry.ts` second, before any mail
code. When `NODE_ENV=development` it:

- forces `ENABLE_MAIL_SERVER=false` and blanks `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`. The
  embedded SMTP/IMAP/MX servers and the background jobs already stay off in development;
- installs a fail-closed network guard on `net.Socket#connect` (`dev-outbound-guard.ts`).
  Every TCP connection to a host that is not loopback, the dev database or the dev
  Supabase project is destroyed with `EDEVOUTBOUND` before a byte is sent. That covers
  direct MX delivery on port 25, SMTP submission, IMAP account sync, Outlook/Graph,
  webhooks, Telegram, Xphere, AI and verification APIs.

`XMAIL_DEV_OUTBOUND_ALLOW_HOSTS` (comma-separated, exact hosts) opens a single host. There
is no wildcard and no "allow everything" switch.

## First time: empty migration ledger

If the dev database has no `supabase_migrations.schema_migrations`, step 3 stops. Create
and baseline it once, mark the migrations the dev schema already contains, and run
`npm run db:dev:plan` to check nothing is pending.

## Rehearsal

`npm run test:dev-db-pull` runs the policy tests offline. CI also rehearses the whole copy
between two throwaway databases on a disposable PostgreSQL (job `dev-db-pull`), including
the secret scrubbing, the rollback on error and the schema-drift abort. The SSH and tunnel
path has no automated test and has never been run against production.
