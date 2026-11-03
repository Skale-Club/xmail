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

## Increment 3 — development SQL transport validation

Continuation fetched the remote implementation branch at
`57d5dfdfe6bcb727714aae7955bb371f3ca9af24` and retained its existing SQL/Auth
isolation. Work is isolated in `codex/xmail-identity-preparation`; the main
checkout and the unrelated Xcraper documentation worktree remain untouched.

The development SQL selector previously accepted transaction-pooler/arbitrary
ports, direct connections with an arbitrary user, missing explicit passwords,
disabled/opportunistic TLS, and arbitrary driver/startup URI options. Both
runtime pools and the development migration wrapper now share a normalized
direct/session target: database `postgres`, port 5432, an explicit password,
and the project-specific user. Missing TLS mode becomes `sslmode=require`;
the only accepted URI option is one `sslmode` using `require`, `verify-ca` or
`verify-full`. Malformed URL encodings and invalid settings fail with sanitized
errors before client construction. Production/test target selection is unchanged.

Focused offline tests exercise both pool URLs, credential redaction and actual
postgres.js connection options without opening a connection. Local execution
uses the existing dependency installation, no dotenv files, database, Docker,
mail listener or external integration. Full lint/types/build remain CI work.
Sixty focused tests across six files passed sequentially with `--maxWorkers 1
--testTimeout 15000`; the pre-existing scheduler import exceeded its default
five-second limit on this PC, then passed with the stated cold-import allowance.
Targeted ESLint and `git diff --check` passed.

This is a preparation increment, not a production database or identity cutover.
The dedicated development project is still an operational prerequisite; declaring
its ref does not prove isolation. The live production source/capacity dossier,
restorable backup, Google/phone bindings and sessions, recovery, invitations,
independent mailbox credentials and Storage reconciliation remain required.

## Increment 4 — disabled owned identity foundation

The existing preparation commit `d4fd1a91c1a5005889ce3b432b09f193bacc28a4`
was pushed without force to `codex/xmail-development-database` after an immediate
remote-head check. Draft PR [23](https://github.com/Skale-Club/xmail/pull/23)
passed [CI](https://github.com/Skale-Club/xmail/actions/runs/41716300951)
(both TypeScript configs, lint, focused tests and build) and GitGuardian.

The new backend foundation adapts to Xmail's existing CommonJS/Express stack
using its installed `jsonwebtoken` library. It validates RS256 against Google's
fixed certificate endpoint, exact project/issuer/audience, bounded UID/timestamps,
and only Google or verified-phone sign-in. It rejects unconfigured Identity
Platform tenants and unsupported providers. Profile email, phone metadata and
custom claims never choose an application account or grant permission.

The live account adapter performs exact-UID `accounts:lookup` for the configured
Google project. It needs an injected short-lived ADC/federation access-token
supplier with `firebaseauth.users.get`; no JSON key, hardcoded bearer token,
provider-write permission or shared-project modification is introduced. The
production credential adapter is still an operational/integration prerequisite.
Provider failure, bans and revocation deny session admission and use.

Migration `079_owned_identity_foundation.sql` adds three server-only RLS tables:
exact project/UID bindings, reviewed local user controls, and hashed owned sessions.
It inserts no user, binding or control record and changes no existing UUID,
organization ownership/role, `isAdmin` or SMTP/IMAP password hash. The next free
migration number is now `080`; recheck the remote tree before reserving it.
An audited control import must preserve the previously observed banned account;
an absent reviewed control denies admission. First binding still requires a live
independent exact-ID legacy proof or reviewed operator recovery. No automatic
email/phone matching or account-creation function exists in this foundation.

Opaque sessions use 32 random bytes, persist only SHA-256 hashes and expire
absolutely after twelve hours. New-session admission requires recent provider
authentication and rechecks binding/user controls inside the insertion transaction.
User-wide revocation locks the same control row; each session read also checks
provider status and re-reads local revocation after that network round-trip.
The returned principal contains the existing application UUID only; the current
application authorization helpers remain responsible for organization/admin access.

The template flag `XMAIL_GOOGLE_AUTH_ENABLED=false` remains off. There is no pilot
HTTP route, cookie parser, CSRF adapter, frontend session consumer or sign-in UI
connected in this increment. Setting the flag alone does not change current login.
Do not activate or remove Supabase settings until those consumers, audited imports,
invitations/recovery and independent native mailbox credential management pass.

Fifty-seven identity/provider/session tests passed locally with mocked provider
requests and in-memory session storage. Targeted lint and diff validation passed.
Seven real PostgreSQL tests are intentionally skipped locally: a separate CI job
uses a loopback-only disposable database, an exact test-database name and a sentinel
to rehearse this additive migration, role privileges, ownership, session bounds and
concurrent revocation. No repository dotenv or production database is used. The
first [foundation CI run](https://github.com/Skale-Club/xmail/actions/runs/41718502224)
passed all seven PostgreSQL tests on `650dc95`. Its full lint/client types and
117 focused unit tests passed; server type-checking identified postgres.js's
non-callable `TransactionSql` declaration. The adapter now uses its supported
constant-SQL/parameter API, preserving transaction locks and bind parameters;
the complete CI run must be repeated after that compatibility correction.

Implementation references: [Firebase token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
[session revocation](https://firebase.google.com/docs/auth/admin/manage-sessions),
and [Google account lookup](https://cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/lookup).
No real Google/SMS authentication, migration apply, production cutover or deployment
has been performed by this increment.

## Increment 5 — disabled HTTP/cookie and phone/Google pilot

The foundation correction `99ac323af3a2b90fa324ef8cd8a6c6287f6069ed` passed
[complete CI](https://github.com/Skale-Club/xmail/actions/runs/41719104219), including
both TypeScript configurations, lint/build, 117 focused tests and seven disposable
PostgreSQL tests. The next uncommitted increment connects the isolated
`/auth/identity` UI, HTTP cookies/challenges and owned API admission while preserving
the default `/login`, immutable UUIDs, SQL roles/admin flags and native SMTP/IMAP.
It adds migration `080` without running SQL outside CI. The flag remains false.

See [the pilot contract and activation gates](xmail-identity-pilot.md) for exact-ID
linking, fresh provider/local controls, bounded external lookups, isolated DEV
API-key provenance, memory-only Firebase, body/Origin/CSRF guards and remaining
runtime ADC/recovery/stream gates. A Supabase-free production login or database
cutover is not claimed. Independent review identified an Accept-header bypass in
the initial SSE exclusion; both actual handlers now reject the server-owned
identity marker, and real mailbox-router HTTP tests cover absent/`*/*`/SSE Accept.
The remaining review found no additional concrete blocker. Locally, 101 focused
server tests and 11 client tests passed sequentially, plus targeted lint and diff
validation. Eleven disposable PostgreSQL cases and full types/build await the new
exact-SHA CI; no local integration SQL or heavy build was run.

## Increment 6 — verified live dossier and temporary restore rehearsal

The running source was independently inventoried over existing SSH access without
changing production. The final collection at 2026-11-03 22:12:31 UTC used a pinned
public Supabase CA, hostname/certificate verification and one REPEATABLE READ READ
ONLY transaction: PG17.6, 188,320,915 database bytes, 70 public tables/172,728,320
relation bytes, 39 users, 38 memberships, ledger 78 through 078. All 70 tables had SELECT
access, the role bypassed RLS and zero tables could filter the measured rows.
The identity flag remains false and no owned-identity table exists in production.

Eight SECURITY DEFINER helpers reference auth.uid(); 161 policies include 38 direct
hosted-schema references. There are no public foreign keys outside public, no
application triggers or public views. These dependencies are explicit restore and
authorization gates. See [the host-local rehearsal runbook](xmail-database-rehearsal.md)
for extension inventory, TLS evidence, scripts, resource/cleanup bounds and snapshot
comparison limits. The initial weaker-TLS exploratory sample was superseded by the
verified collection.

After independent script review, root executed the host-local PostgreSQL17 rehearsal
successfully (report received 2026-11-03 at 22:19 UTC): exit 0, no stderr/timeout,
39 restored users, 38 memberships, 70 public tables, ledger 78/latest 078 and zero
owned-identity tables. The target had no network or app process. Cleanup was verified
before success; an independent SSH check found zero rehearsal containers/directories
and the production container running with its observed image prefix preserved.
The temporary archive/database were destroyed. No retained backup, complete source
snapshot/ID/content reconciliation, Auth cutover or durable database deployment is
claimed. Production configuration/schema, SMTP/IMAP and deploy state were unchanged.

The user declined new paid Supabase projects/costs. Existing eligible targets from
the respective environment files will be assessed for safe isolated reuse; no new
project or account/organization lookup is needed for this preparation.

## Increment 7 — exported-snapshot reconciliation

The prior commit `51c9223a8eb1fe87d890cc6bc81cac9438ae755f` passed complete
[CI41730237683](https://github.com/Skale-Club/xmail/actions/runs/41730237683): lint,
both TypeScript configurations, build, offline operations checks, identity/UI tests
and the disposable PostgreSQL store suite.

The reviewed revision adds a bounded source holder on direct/session
5432: one REPEATABLE READ READ ONLY snapshot supplies pg_dump and all 70 source
table counts. The restored target must match full user/membership JSONB SHA256
digests, application admin/role fields and native password hashes, without exposing
any values or digests outside the host. The source holder rolls back/closes after
dump completion and has an independent 210-second deadline. The previous TLS,
resource, NULL Auth compatibility and verified-cleanup controls remain mandatory.

After root reviewed the code, the coordinator executed V2 successfully; the report
was received 2026-11-03 at 22:42 UTC. Exit 0, no stderr/timeout: all 70 public counts
and four SHA256 groups matched the same exported RR snapshot; 39 users, 38
memberships, 37 native password hashes, one platform admin and ledger 78/latest078
were preserved within that checked scope. No owned-identity tables existed. The
target had no network, and temporary resources/manifests were removed before success.
No data, UUID, credential or digest value left the host. Auth acceptance, unrelated
public row-content digests, final sequence state and retained/durable backups remain
separate gates. Production routing/configuration and persistent storage were unchanged.

Five expanded offline tests, including holder release/EOF and real local Bash pipe
descriptor checks, plus Bash syntax/diff checks passed. Exact-SHA CI is pending
publication. See [the snapshot protocol and coverage limits](xmail-database-rehearsal.md#exported-snapshot-reconciliation-protocol).

## Increment 8 — persistent candidate restored, application source unchanged

The reviewed import ran on the existing host starting 2026-11-03 at 23:24:09 UTC.
The coordinator independently confirmed the exact candidate's committed receipt
by 23:29 UTC: 70 public counts/four digest groups matched, preserving 39 users,
38 memberships, 37 native password hashes and one platform admin. A private local
archive/checksum/receipts were retained; temporary clients/work/code directories
were gone. The source stayed read-only during export and production Xmail remained
healthy on its existing Supabase source with its observed image unchanged.

The candidate remains private/healthy with persistent storage. It is populated and
must not be reimported by the empty-only script. No Auth/application cutover, off-host
backup or final sequence/write-pause reconciliation is claimed. Evidence is in
[the target dossier](xmail-private-postgres-target.md) and
[the import runbook](xmail-private-postgres-import.md). HTTP-only fail-closed staging
preparation follows separately; production flags/routing remain unchanged.
