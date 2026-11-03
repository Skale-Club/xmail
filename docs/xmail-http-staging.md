# Restricted HTTP staging — prepared, disabled

The normal `dist/server/index.js` entry now selects a runtime before importing
legacy application modules. With the default `XMAIL_STAGING_HTTP_ONLY=false`, it
loads the unchanged production server from `production-server.js`. Its source
was moved byte-identically, retaining relative imports and existing deployment/
package entrypoints. With the explicit flag true, only the restricted staging
server is loaded. It imports no Supabase, legacy routes, mail listeners, scheduler,
Telegram/alert registration, watchdog, seed or integration modules.

This is a candidate connectivity/privilege/aggregate probe, not full application
acceptance or a new login surface. It has not been booted against the real candidate.
Production environment/source/routing and flags are unchanged.

## Explicit configuration and live reader proof

Staging requires `XMAIL_STAGING_DATABASE_URL` targeting only private container
`e12scyfsrp822dag7m9wwd4x`, port5432, database `xmail`, username
`xmail_staging_reader`, with a password and no query/hash overrides. It never reads
`DATABASE_URL`, `DIRECT_URL`, POSTGRES aliases or development Supabase settings.
The dedicated internal Docker database connection has no TLS configuration; it
cannot target a remote/public/source host. Production source export continues to
use strict verified Supabase TLS in the separate operational scripts.

`XMAIL_STAGING_ORIGIN` must be an exact HTTP loopback origin such as
`http://127.0.0.1:9002`. It determines the listener port, without generic PORT or
FRONTEND_URL fallback. The listener binds127.0.0.1 only and enforces exact Host.
Port0 is reserved for offline tests. Invalid/partial stage settings refuse startup
before either runtime is imported. NODE_ENV=development is refused rather than
repurposed as a staging escape hatch. Both Google identity flags must remain off.

The role-preparation SQL initially creates the staging reader NOLOGIN. A later
reviewed operation must securely enable that reader's LOGIN/password; no owner
credential, second login role or SET ROLE fallback is accepted here. The boot probe
requires current_user=session_user=xmail_staging_reader, LOGIN and BYPASSRLS, zero
role memberships and all70 public tables readable. It refuses SUPERUSER, database/
role creation, replication, database/table ownership, schema/database/TEMP creation,
any public-table DML/DDL privilege, sequence USAGE/UPDATE and public-function EXECUTE.
This last check prevents a SELECT-only reader invoking a SECURITY DEFINER writer.
The probe repeats before every aggregate read, not just at startup.

The pool has at most two connections. Startup parameters enforce default READ ONLY,
five-second statements and500ms locks; queries run in explicit read-only transactions.
Only fixed SQL runs. The mode performs no external HTTP calls, seeding, migration,
runtime-role mutation or application writes. Failure closes the pool before listening;
later reader/DB failures return sanitized503 without legacy fallback.

## HTTP surface

| Request | Behavior |
| --- | --- |
| GET /health |HTTP liveness, mode and sideEffectsEnabled=false |
| GET /health/ready |Live reader proof and aggregate counts |
| GET /api/staging/summary |Same live proof; users, memberships, platform-admin and native-hash counts only |
| Other GET paths |403, including Auth/config, tracking/unsubscribe, integrations and application routes |
| Other methods |405 before SQL; no request body is parsed |

No row, contact, identity token, password/hash or provider configuration is exposed.
Responses are no-store with restrictive security headers. Requests with bodies or
wrong Host are refused. Request/header/keepalive deadlines bound idle sockets. The
read-only role and restricted surface remain required even on a private Docker
network; a staging bootstrap must not mount production environment/TLS volumes or
publish public ports. The coordinator controls the isolated network and secret file.

## Tests and compiled artifact

Seven small tests load the **actual index selector and real Express listener**,
including NODE_ENV=production with ENABLE_MAIL_SERVER=true. Sentinels fail if legacy
DB/Auth/mail/jobs/watchdog/alerts/Telegram modules are imported; SQL is mocked, dotenv
loading is disabled and external fetch is forbidden. Tests also cover default legacy
dispatch, source/owner URL refusal, mutation/tracking denial, live privilege drift,
startup pool closure and error redaction. These passed locally with targeted lint.
No local heavy build or real database was used.

After a successful full build, CI uploads `xmail-staging-http-${github.sha}` for one
day containing `dist/package.json` and only the compiled index/selector/config/HTTP
files. The coordinator can mount this code read-only on an existing dependency image
using its existing Express/postgres/dotenv packages. The artifact does not include
legacy production-server.js: a missing staging flag therefore fails closed in that
isolated artifact rather than starting mail/jobs. Do not treat the artifact as an
application deployment. Its listener origin/port must match any overridden Docker
healthcheck; default production health checks may assume a different port.

Real candidate boot, reader authentication/privilege evidence, host network isolation,
artifact verification and aggregate smoke checks remain operational gates. Full
Auth/application flows, final-write-pause/sequence reconciliation, off-host backup
and production cutover remain separate releases.
