# Xmail production Supabase exit

## Baseline — 2026-11-03

Read `AGENTS.md`, `CLAUDE.md` and `supabase-exit-plan.md` before execution.
Fetched origin: local main and origin/main both `5cc007855df807fc21418e60af2d208b03e52e55`.
Starting branch `codex/supabase-production-plan` was clean at `804cf923df9abd425c7fb44bc2394f3ec5be4a9b`, containing the portfolio plan only.
Implementation branch: `codex/xmail-development-database`.

Public production `/health` returned 200 with version `92ca3fd` and deployed timestamp
`2026-11-01T21:39:39Z`. The latest successful Build and Deploy run is
`41353126741` at full SHA `92ca3fd1eedc7a328cd614037921e59f516de7b7`.
This differs from main by subsequent documentation, not a verified new deployment.

Two short read-only transactions against the locally configured source candidate found:

| Measurement | Result |
| --- | --- |
| PostgreSQL / database size | 17.6 / 188,189,843 bytes |
| Application users / matching Supabase Auth UUIDs | 39 / 39 |
| Organizations / memberships / platform admins | 12 / 38 / 1 |
| Auth identities | 39 email; zero confirmed phones |
| Currently banned Auth users | 1 — preserve this denial during identity migration |
| Native mailbox password hashes | 37 — preserve separately from platform login |
| Migration ledger | 78 records, latest `078` |
| Public-schema foreign keys to `auth.users` | 0 |
| Storage buckets in this source candidate | 0; this does not inventory R2 or prove no persisted legacy URLs |

Installed extensions: `pg_stat_statements`, `pg_trgm`, `pgcrypto`, `plpgsql`,
`supabase_vault`, `uuid-ossp`. Classify actual extension use before restoring to plain PostgreSQL.
No rows or identity attributes were printed or modified. The local source target has
not yet been compared with the running production environment, so these counts are
not a complete production dossier. Explicit development target variables are absent.

The XmartMenu chat reported a newer read-only shared-host sample: 7,751 MiB RAM,
1,257 MiB available, 1,450 MiB swap used and 12 GiB disk free (85% used).
This is coordination evidence supplied by that chat, not an independent Xmail probe
or sufficient capacity approval for a new PostgreSQL instance.

No Xmail production cutover has been demonstrated. Repository evidence still shows:

- Drizzle database pools using `DATABASE_URL` and a separate `DIRECT_URL` job target.
- Supabase interactive login, refresh, auth cache, user creation/invitations/deletion and password administration.
- Application user UUIDs, organization ownership and memberships managed by the application; `access.ts` remains authoritative for tenant authorization.
- Native SMTP/IMAP password hashes and mailbox creation coupled to current platform password routes. Preserve these protocol credentials independently when retiring platform password login.
- R2 object-storage abstraction with Supabase fallback. Stored links and objects require a live inventory and reconciliation before fallback removal.
- Production deployment on push to main; feature branches and PR CI do not deploy.

## Increment 1 — development pool separation

`npm run dev:server` forces `NODE_ENV=development`, even if the parent shell or `.env` says production.
Both Drizzle pools then require `XMAIL_DEV_SUPABASE_PROJECT_REF` and `XMAIL_DEV_DATABASE_URL`.
Optional `XMAIL_DEV_DIRECT_URL` must identify the same approved project; otherwise jobs use the development URL.
Production aliases and `XMAIL_ALLOW_REMOTE_DB` cannot bypass this selector in development.
URLs are validated before either postgres client is constructed; failures omit URL values and passwords.
Production/test selection remains compatible during this additive stage.

Local validation: 24 focused database-selector/legacy-guard tests passed sequentially;
targeted ESLint and `git diff --check` passed. Draft PR:
https://github.com/Skale-Club/xmail/pull/23. Remote CI supplies full client/server
type checks and the build; do not interpret a pending run as validation.

The project reference is an operator declaration, not proof of isolation. Do not configure it to the active production source or a shared schema without inventory and approval of that target. No local database connection, server startup, migration, user update or production configuration change was performed for this increment.

`npm run db:dev:plan` uses the same selector and lists pending migrations without applying them. `npm run db:dev:apply` is the explicit development write operation; do not use it until that schema has been inventoried. Both replace inherited production aliases before invoking the runner.

Other operational scripts using raw `DATABASE_URL`, direct invocation of the original migration runner and Drizzle Studio are **not yet migrated** to this selector. Do not run them locally against production. Supabase Auth settings and background side effects still need independent development isolation before starting the server. This increment does not claim full development isolation or a completed production exit.

## Next required work

### Cloud continuation — 2026-11-03

Remote main was reconfirmed at `5cc007855df807fc21418e60af2d208b03e52e55`
and the existing implementation branch at `dc3cf24c99e377e071d944edac6a19dd4402c963`.
The cloud checkout was clean before continuation; no other repository was changed.
Native Git read works through the injected proxy. GitHub CLI PR queries returned
`Forbidden` from GraphQL, so current PR checks/merge state could not be independently
read through that API. No production SSH, Google identity, development database or
Auth bindings are present in this cloud runtime. The user requested completion of
independent work before that access boundary.

Increment 2 selects development Auth for Vite, backend clients, CSP and the runtime
browser configuration from the same explicit project ref as the development DB.
It requires dedicated `XMAIL_DEV_SUPABASE_ANON_KEY` and
`XMAIL_DEV_SUPABASE_SERVICE_ROLE_KEY`, ignoring production aliases. Development
credential encryption requires `XMAIL_DEV_OUTLOOK_TOKEN_ENCRYPTION_KEY`; production
encryption and native mailbox password hashes are unchanged. Cron registration,
native mail listeners, startup Telegram registration/alerts and DB watchdog startup
are disabled in development. Production scheduling remains covered by a test.

This is still not full development isolation. Manual send/sync, OAuth callbacks,
route-driven webhooks/alerts, R2 selection, stored integration credentials and
operational scripts need separate sandboxing/review. Do not start development
with a raw production copy or production integration secrets. No development
project has been provisioned or verified, and no migration has been applied.

Cloud validation used Node 24.19.0 and the locked dependency graph: 43 focused tests
passed, full ESLint passed, both TypeScript configs passed, and client/server build
passed. CI now includes the isolation tests. Before this increment, the full suite
on the clean main checkout completed with 174 files passing and 22 failing:
2,620 tests passed and 77 failed. Failures include missing `content_language`,
`enrichment_approval_id` and `warmup_only` columns in the disposable database,
plus non-database assertions; no full-suite green result is claimed. These
pre-existing failures were not hidden or repaired as part of Auth isolation.

Next operational prerequisite: configure scoped SSH/Google access and the dedicated
development target securely in cloud environment settings. Then verify the actual
running production SHA/source and host capacity before provisioning or cutover.
The historical source inventory above has not been promoted to a live verification.
Phone/Google account bindings, sessions, recovery, storage reconciliation, backup
restore and production cutover remain unimplemented/unverified by this increment.

1. Read-only live dossier: deployed SHA, DB metadata/version/size/extensions/ledger, user and membership counts, identity cohorts, object manifest and encrypted-key references. Never commit personal records or secrets.
2. Select and verify an isolated Supabase development project; guard migration and diagnostic entry points. Review mail, campaign, cron and webhook side effects before local startup.
3. Implement additive issuer/project + subject bindings to immutable application UUIDs and per-app sessions. First association needs a valid legacy session plus recent verified Google/phone identity or documented operator recovery. Never claim by email or an unverified profile phone. Keep registration disabled and roles in the application database.
4. Add phone-first/Google login, recovery, invitations and separate native mailbox credential management. Retain a controlled legacy transition until existing account access reconciles.
5. Rehearse restore and authenticated flows against an isolated PostgreSQL target. Coordinate shared-host capacity and deployment windows before provisioning or cutover. Preserve encryption keys, mail UIDs, agent scopes and machine credentials.
6. Separate auth, database and file releases. During final data copy drain/queue inbound mail and suspend all writers; reconcile before resuming. Define numeric rollback thresholds and recovery objectives from measured evidence.

Google default is `skaleclub` unless a suitable product project already exists. No global Google changes or shared-host reservation is included here. XmartMenu reported code-only work with no server reservation on 2026-11-03; recheck coordination before any operational change.
