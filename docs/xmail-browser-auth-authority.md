# Explicit browser identity authority (prepared, not activated)

`XMAIL_BROWSER_AUTH_AUTHORITY` defaults to `legacy`. Selecting `owned` also
requires `XMAIL_GOOGLE_AUTH_ENABLED=true` and
`XMAIL_USER_ADMIN_AUTHORITY=owned`; invalid or partial owned configuration fails
closed. Owned user administration also requires the global authority, so local
deactivation cannot be enabled while generic legacy bearer admission survives.
This patch changes no environment, database role, native password, deployment or
production setting.

`GET /api/auth/authority` exposes only the chosen authority and availability,
with `Cache-Control: no-store`. After the existing public and explicitly scoped
service/agent checks, protected HTTP API requests in owned mode require an owned
cookie. Missing, expired, invalid or unavailable cookie admission never calls
the legacy bearer resolver. Public branding/monitor/autoconfiguration routes keep
their existing method-bound behavior, and service/agent credentials retain their
own authorization paths. SMTP/submission/IMAP authentication and ports are untouched.

The legacy `/api/auth` login/register/refresh/password-recovery/update/logout
routes are terminal `409` in owned mode; `/me` projects only the server-admitted
local principal. The separate `/api/auth/identity` routes keep their strict
origin, cookie, CSRF and independently reviewed local-control requirements.
The organization-member endpoint keeps its existing authorized membership CRUD,
but its missing-user provisioning branch returns `409` instead of creating a
hosted Auth account. Existing local membership assignment is not identity binding.

The browser resolves server authority before attempting legacy session reads,
restoration, listeners, sign-in, refresh, recovery or logout. Importing the legacy
SDK wrapper is inert; its lazy client refuses construction until a valid server
response explicitly confirms legacy authority. Owned mode routes `/login` to the
phone/Google entry. An absent/expired session, status error, malformed status, or
status timeout cannot restore saved legacy credentials. A response arriving after
the eight-second bootstrap deadline cannot authorize that late initialization.
Legacy status is valid for ten seconds, rechecked on window focus and immediately
before SDK login/refresh/logout/session restoration. The SDK's automatic refresh
is disabled; the existing API client performs guarded explicit refreshes instead.
An owned status is sticky until reload. Entering owned mode or an unavailable
status stops any existing refresh timer locally, without a hosted logout request.
Generation checks discard delayed legacy session/profile/restore results and
clear stale browser user/cache state when the authority changes. Exiting a pilot
also navigates/reloads rather than silently unblocking the same legacy client.
Owned logout uses only the owned cookie endpoint. Protected browser API requests
strip stale legacy Authorization while preserving other machine headers.

An explicit first-link action may read an existing locally stored access token
and submit it only to `/api/auth/identity/link`. It never refreshes that token or
logs into the old provider in an owned browser. The server alone verifies the
old token online, obtains its exact existing UUID, verifies fresh Google proof,
and requires current reviewed local controls before binding. An expired or absent
old proof requires independently reviewed recovery; email/phone never select an
account. A newly created local UUID has no hosted proof automatically.

This is preparation for a later controlled cutover. Owned invitation/onboarding,
reviewed recovery and destructive deletion remain incomplete and explicit `409`
actions. Owned SSE has a separate prepared boundary in `xmail-owned-streams.md`.
Server startup/readiness and
pool budgeting have separate prepared boundaries; the legacy Storage exit and
complete production admission remain work, and the runtime is still `NOLOGIN`.
Do not describe this batch as a
completed provider exit or activate it without those operational gates.

Focused tests use mocked transports/providers only and verify SDK inactivity
before status, unavailable/expired ownership, preserved machine/public paths,
terminal legacy routers, first-link proof confinement and legacy compatibility.
The preceding administration batch also has 11 PostgreSQL tests in the isolated
CI service. Production flags remain off throughout these checks.
