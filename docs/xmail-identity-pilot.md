# Xmail verified identity pilot — disabled

This branch adds `/auth/identity` and `/api/auth/identity/*` behind
`XMAIL_GOOGLE_AUTH_ENABLED=false`. `/login` and the current Supabase bearer flow
remain the default. No production environment, SQL, provider setting, deployment
or existing SMTP/IMAP credential was changed by this increment.

## Account and authority boundaries

Google project + Firebase UID binds to an **existing immutable Xmail UUID**.
No email/phone match, user creation, role claim or implicit control import exists.
Migration `079` requires a separately reviewed `xmail_identity_user_controls`
record; missing or disabled controls deny use. Preserve the previously inventoried
ban during that reviewed import. Migration `080` adds only a server-only RLS
challenge table; both migrations remain unapplied outside disposable CI.

First link requires a recent, live Google/verified-phone identity and an independent
existing account proof: an online Supabase `/auth/v1/user` result with the exact
application UUID, or a recent already-linked owned session. A supplied invalid owned
cookie cannot fall back to a legacy bearer. Neither proof grants admin/org access.
Unproved/mismatched IDs require a separate operator recovery process; that workflow
and a reviewed import tool are not implemented here.

Each owned request checks the exact bound provider UID online, provider disable/
validSince, SQL controls and local revocation again after the lookup. The API adapter
then loads fresh local user fields; current SQL `is_admin` and organization-membership
helpers retain authority. User synchronization in owned mode cannot recreate a deleted
user or copy provider contact attributes. Existing admin activation/deactivation
updates local controls only when the flag is enabled and never creates a control.
SMTP/IMAP password hashes, account UUIDs, mailbox credentials and data are preserved.

## HTTP and browser protocol

| Endpoint | Behavior |
| --- | --- |
| `GET /config` | Returns public Firebase fields only after keyless credentials and actual API-key project/domain proof succeed |
| `GET /session` | Live owned cookie + fresh local profile; anonymous returns `user:null`; invalid cookie denies |
| `GET /challenge?purpose=...` | Five-minute single-use challenge bound to independent HttpOnly browser cookie, exact origin and operation |
| `POST /session` | Recent provider proof + existing reviewed binding; rotates opaque session |
| `POST /link` | Independent exact-ID ownership proof + recent provider proof; then issues owned session |
| `POST /logout` | Revokes the local session and clears its host cookie; no provider credentials required |
| `POST /revoke-all` | Recent live owned proof, global SQL session cutoff, clears cookie |

Opaque session tokens are 32 random bytes; only SHA-256 hashes are persisted.
Production cookies are `__Host-`, HttpOnly, Secure, SameSite Strict and Path `/`,
without Domain. Loopback development has separate cookie names. Every mutation
requires exact Origin/Host, JSON with a strict schema, a 20 KiB body limit, five-second
body deadline, per-IP attempt limits and the one-use challenge. Protected application
writes additionally bind the challenge to the exact method/path. Provider and legacy
lookups combine caller cancellation with eight-second deadlines and reject redirects;
errors omit credentials/provider response details. Local SQL uses existing pool policy.

The phone-first UI offers Google as an alternative. Firebase uses `initializeAuth`
with **inMemoryPersistence** and popup flow only. Provider tokens are sent to the
server once, then discarded and the Firebase user signed out. There is no persistent
Firebase session, redirect flow or emulator. The browser rechecks `/config` before
Google, SMS request and SMS confirmation; changed configuration cannot confirm an
old SMS challenge. Only a non-secret preference boolean is kept in sessionStorage.
Owned mode does not restore saved legacy multi-account tokens after a denial; an
explicit return to current login first clears the owned cookie. Legacy mode retains
its existing multi-account/bearer behavior.

Owned SSE is denied until each long-lived stream can recheck revocation during
delivery. Refresh/read operations remain available. Supabase-dependent administrative
account management and native-mail credential management remain cutover gates.

## Explicit isolated development configuration

Development uses only `XMAIL_DEV_GOOGLE_AUTH_PROJECT_ID`, `PROJECT_NUMBER`,
`WEB_API_KEY`, `ORIGIN`, `ADC_MODE` and optional `ADC_FILE` under that prefix.
Its explicit approved SQL/Auth settings are also mandatory. The source production
Supabase project must be declared or identifiable, and a same-project DEV Auth
target is rejected. Google project `skaleclub`, number `937861185231`, and configured
production ID/number are denied in development. Production uses the equivalent
`XMAIL_GOOGLE_AUTH_*` prefix. Missing settings fail closed; no dotenv-source fallback
or provisioning occurs. Staging has not been provisioned or accepted by this pilot.

Before sending config to the browser, the server calls the fixed read-only
`https://identitytoolkit.googleapis.com/v1/projects` endpoint. The API key is in
`X-Goog-Api-Key`, never a URL. No project override query is accepted. The response
must contain string `projectId` equal to the approved ID or explicitly approved
legacy number, and `authorizedDomains` must contain `<ID>.firebaseapp.com` and the
canonical origin hostname. No success cache is used in this low-volume pilot.
Operator approval must also verify API restrictions, website/referrer restrictions,
authorized domains, OAuth redirect configuration, SMS regions/budgets and actual
carrier delivery. The read-only check alone is not that operational acceptance.

Live provider status needs `firebaseauth.users.get` via an explicitly selected
metadata or renewable external-account ADC credential. The adapter rejects service
account JSON keys, refresh tokens and executable/URL credential sources. No shared
service-account grant or trust configuration is modified. Codex OIDC is not renewable
Hetzner ADC; a deployable keyless credential path is still an operational gate.

## Validation and activation gates

Small local suites mock provider requests and use an ephemeral HTTP server; UI tests
mock Firebase and send no SMS. CI installs new Firebase/google-auth-library packages,
checks both TypeScript configurations, lint/build and the HTTP/client suites. A separate
loopback-only disposable PostgreSQL job uses the exact test database and sentinel;
it rehearses migrations, RLS, one-use challenge races, immutable competing links,
bans, revocation and preserved UUID/admin/native password fields. It never reads
repository dotenv files or production database settings.

Before activation: independent review + green exact-SHA CI, isolated provider/DB
provisioning, reviewed controls/bans, renewable runtime ADC, real Google/SMS/browser
flows, org/admin denial checks, mailbox/attachment flows, long-lived stream revocation,
recovery/invitation policy and a rollback rehearsal. Then an explicit deployment and
environment change may enable the pilot. Supabase retirement/database cutover remains
a separate release with the wider gates in `xmail-supabase-exit.md`.
