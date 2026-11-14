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
server and the Firebase user is signed out. A successful SMS proof stays only in
the pending in-memory confirmation so a temporary Xmail failure can be retried
without consuming the same code again; disposal removes that proof. There is no persistent
Firebase session, redirect flow or emulator. The browser rechecks `/config` before
Google, SMS request and SMS confirmation; changed configuration cannot confirm an
old SMS challenge. Only a non-secret preference boolean is kept in sessionStorage.
Owned mode does not restore saved legacy multi-account tokens after a denial; an
explicit return to current login first clears the owned cookie. Legacy mode retains
its existing multi-account/bearer behavior.

### Login interaction fixes (2026-11-13)

The normal login page shows phone and Google sign-in without the migration/recovery
footer. Explicit account-link URLs retain their independent ownership proof. Sign
out requires an actual session user rather than the owned-authority preference.
SMS entry uses six individual numeric boxes with paste, mobile code autofill and
keyboard navigation. The destination number and entered code survive temporary
errors. A synchronous submission lock prevents overlapping SMS requests.
Before navigating to the inbox, sign-in reads the owned session back. A failed
cookie/session readback stays on the login screen with an actionable error rather
than silently redirecting through the protected route back to login.

Phone verification uses a single invisible `RecaptchaVerifier`, cleared immediately
after SMS dispatch. The provider may still require an interactive challenge; the app
does not bypass that verification. Incorrect codes can be corrected without a new
SMS. See [Firebase phone authentication](https://firebase.google.com/docs/auth/web/phone-auth).

Automatic service-worker/chunk-recovery reloads are deferred throughout sign-in,
including before the lazy login page mounts, so a deployment or focus-triggered
worker update cannot discard the pending SMS or Google popup state. Successful
sign-in still navigates normally and loads the current app. Manual refresh remains
a new authentication attempt: no OTP or provider credential is persisted to storage.

Read-only production checks found the reported Google and phone provider subjects
already bound and enabled for the same existing Xmail UUID. No account relinking,
production data changes or real provider sign-in was performed by these fixes.

Owned SSE is denied until each long-lived stream can recheck revocation during
delivery. Refresh/read operations remain available. Supabase-dependent administrative
account management and native-mail credential management remain cutover gates.

## Explicit isolated development configuration

Development uses only `XMAIL_DEV_GOOGLE_AUTH_PROJECT_ID`, `PROJECT_NUMBER`,
`WEB_API_KEY`, `ORIGIN`, `ADC_MODE` and optional `ADC_FILE` under that prefix.
X.509 additionally requires explicit `ADC_AUDIENCE`, `ADC_SERVICE_ACCOUNT` and,
for development only, `ADC_ROOT`, with the same environment prefix.
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

## Prepared X.509 runtime credential path — not provisioned

The external-account adapter now accepts Google's X.509 format with exact
`https://sts.mtls.googleapis.com/v1/token` and
`urn:ietf:params:oauth:token-type:mtls`. The existing file/OIDC branch still uses
the normal STS endpoint and a renewable token file. It now also requires
explicit audience/service-account expectations, the exact project number and
`hetzner-xmail` pool, a distinct approved OIDC provider and canonical per-app IAM
impersonation URL. All SDK configuration fields are allowlisted before construction;
camelCase overrides and arbitrary token/impersonation URLs fail closed. No currently
active ADC configuration is assumed. URL/executable and mixed certificate sources
remain denied; known Codex/OpenAI audiences are denied.
Both branches use the same canonical profile `adc.json` location. OIDC reads only
`subject-token.jwt`, or `subject-token.json` with an explicit JSON token field,
under that same production/development root. Its token file must be regular,
canonical, bounded and protected like a private key; FIFO/device/symlink/out-of-profile
sources and PEM/service-account JSON key material are refused before SDK construction.
File/config guards repeat before SDK token reads; changes require rebuilding the
supplier rather than retaining an old source configuration.
No ambient connection token, service-account JSON private key, refresh token,
default gcloud certificate configuration or environment-selected certificate file
can supply the X.509 branch.

Production fixes the read-only mount at `/run/secrets/xmail-google-identity`.
The allowed files are `adc.json`, `certificate-config.json`, `client.crt`,
`client.key` and optional `trust-chain.pem`. The ADC's explicit certificate location
must point to that exact configuration file; its only workload fields are
`cert_configs.workload.cert_path` and `key_path`, using those exact file names.
Files must be regular, canonical, without symlink escape, nonempty and at most
64 KiB each. POSIX private keys must have no group/other permissions. No key or
certificate is generated or installed by this code.

The explicit audience must equal
`//iam.googleapis.com/projects/937861185231/locations/global/workloadIdentityPools/hetzner-xmail/providers/x509`
for the current production project. The expected service account is
`xmail-firebase-auth-reader@skaleclub.iam.gserviceaccount.com`; impersonation must
use its canonical Google IAM endpoint. The project number/ID must also agree with
the separately approved identity configuration. The leaf certificate must be current,
not a CA, have explicit clientAuth EKU (`1.3.6.1.5.5.7.3.2`), match the private key
and have the **single exact SAN**
`URI:spiffe://skale.club/apps/xmail/production`. CN/wildcard/contact matching is
not used. GCP trust/mapping must separately bind that exact SAN and a reviewed CA;
local validation does not create or prove that trust. The complete subject chain
is limited to five certificates including the leaf. The adapter checks individual
validity and format; it does not claim local chain-signature/path verification.
Google STS must validate the chain against the separately configured trust store.

Development accepts an explicitly declared native absolute `ADC_ROOT` ending in
`xmail-google-identity/development/<DEV_PROJECT_ID>`, including a Windows drive
path. It has no production/root fallback and refuses UNC, traversal and canonical
escape. All files, audience project number, service-account project and the sole
SAN `URI:spiffe://skale.club/apps/xmail/development/<DEV_PROJECT_ID>` must agree
with the isolated development project. Windows ACL review remains an operator gate:
POSIX mode bits cannot establish NTFS key permissions. No DEV certificate or Google
project has been provisioned or accepted by these mocked tests.

The portable `google-x509-access-token.ts` core receives only validated buffers,
audience, service-account email and certificate-chain subject token. It performs
the documented mTLS STS exchange and 600-second service-account impersonation with
`node:https`, verified server TLS and fixed Google endpoints. It follows no
redirects, uses no shared/proxy agent and bounds each JSON response at64 KiB.
The same absolute eight-second signal covers STS, IAM and the final exact-UID
lookup/body read; cancellation destroys the active request and response. There is
no initial token cache. This avoids the SDK10.9.1 internal mTLS STS transporter,
which creates a new Gaxios instance without the configured timeout defaults.
Metadata/file OIDC retain the existing SDK path. Renewed X.509 files are validated
again on every token request. Tokens, key bytes and provider diagnostics are never
logged, returned to the browser or written by the adapter.

Sources: [Google's X.509 WIF and plain-mTLS protocol](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-x509-certificates),
[official Node certificate-source format](https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/identitypoolclient.ts)
and [IAM generateAccessToken](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken).
The published10.9.1 package was inspected in memory against the lockfile SHA512;
no dependency installation or production/provider request was needed.

This is code preparation only. GCP administration/API access, exact CA/SAN trust,
the per-app least-privilege `firebaseauth.users.get` role, private read-only mounts,
certificate issuance/renewal/revocation, quota/load behavior and real end-to-end
provider liveness remain unverified activation gates. No host/GCP mutation, private
key generation, new cost, shared Codex-service-account grant, flag change or login
cutover has occurred. The `/config` route still projects only projectId/apiKey/
authDomain after readiness; it does not expose ADC fields or certificate paths.

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
