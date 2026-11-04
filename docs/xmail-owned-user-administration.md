# Owned user administration preparation

This server-side batch prepares local user administration. It does not activate
Google login, change application database targets, send mail, or change production
configuration. Existing Supabase startup dependencies and other legacy Auth
routes still require separate migration work before a complete provider exit.

`XMAIL_USER_ADMIN_AUTHORITY=owned` selects this branch explicitly and also requires
`XMAIL_GOOGLE_AUTH_ENABLED=true`. Both are operational cutover decisions; this
patch sets neither variable. With the pilot off, an unset administration authority
preserves legacy behavior. With the pilot on and the authority unset or invalid,
administrative actions fail closed. Explicit `legacy` accepts only the legacy
principal on administrative routes; a cookie authenticated as owned identity
cannot reach a legacy provider mutation.

Owned administration requires the server-local principal produced by the owned
admission middleware, including an exact user UUID, session hash, and provider
authentication no older than five minutes. Caller headers cannot supply this
principal. Existing origin and one-use CSRF admission remains required for
mutations. Inside each SQL transaction, the adapter locks reviewed local controls
and users in stable UUID order, checks the current session/binding/control state,
and rechecks current local platform or organization permissions. SQL statements
and lock waits are bounded; mutation failures have no automatic retry or legacy
fallback. The lazy runtime uses a separate two-connection pool, a five-second
connection timeout, and disables SQL parameter logging. A lost commit
acknowledgement is an ambiguous result: inspect the local
state before retrying a create or reset.

The candidate runtime role remains `NOLOGIN` with connection limit 20 for staging
preparation. That is not an approved production connection budget: the existing
HTTP pool can request 20, jobs 12, identity-related clients add their own usage,
and this administrator adds two. Production admission must account for their
combined limits before enabling login or changing that role. This patch does not
alter roles, credentials, pool settings of other services, or production state.

Implemented operations are list, create, administrative profile update, activate,
deactivate, and explicit native password reset. List output contains local safe
profile fields and organization memberships, never credential or provider proof
fields; more than 2,000 accounts requires pagination before listing. A missing
reviewed target control is an error rather than permission to create one silently.

Creation requires `sendInvite=false`. A new native mailbox additionally requires
an explicit password and a verified domain in the selected organization. The new
local UUID, profile, reviewed control, requested membership, native mailbox and
six canonical folders commit together or all roll back. Local email verification
starts false. A matching contact is rejected as a duplicate, never used to link
an identity. Creation returns `inviteSent=false` and `identityLinkRequired=true`;
it creates no Google/Supabase account or provider binding and grants no browser
access until an independent reviewed identity proof is available. Platform admin
creation does not create a native password or mailbox implicitly.

Deactivate revokes owned sessions, advances the admission cutoff and disables
native mailboxes in one transaction. Activate preserves revocation of previous
sessions, preserves native hashes and memberships, and requires fresh browser
authentication afterward. An administrator cannot deactivate themselves or an
existing platform admin; remove the target's platform role separately first.
Role changes revoke the target's previous owned sessions, and self-demotion is
refused.

The existing `PUT /api/users/:id/password` contract in owned mode resets **only
the native SMTP/IMAP credential**. It does not change the user's Google password
or browser identity. Authorization requires a current platform admin, or a current
organization admin sharing the target's exact organization; organization admins
cannot reset a platform administrator. Platform administrator native resets are
explicitly unavailable (`409`), even to another platform administrator, preserving
the legacy contract that such a reset never creates a native mailbox/hash.
Native provisioning during an allowed non-admin reset keeps
a disabled account disabled. Ordinary profile/status changes preserve all native
hashes. The current UI's generic password wording has not been changed, so this
authority must remain off until that wording and operational recovery are reviewed.
Activation also requires `XMAIL_BROWSER_AUTH_AUTHORITY=owned`; the dispatcher
rejects local administration without that matching global boundary. See
`xmail-browser-auth-authority.md` for the prepared bearer/SDK isolation and its
remaining operational and onboarding gates. No flags are activated by this work.

Invitation/resend, destructive account deletion, and the existing self-service
`POST /api/users/me/change-password` recovery/password flow are explicitly
unavailable in owned mode (`409 OWNED_ACTION_UNAVAILABLE`). Their UI actions get
an explicit server error and cannot send a hosted reset email or fall through to
Supabase. These workflows, a reviewed first-link path for newly created UUIDs,
and the remaining legacy Auth endpoints are still required for full migration.

Verification: the focused HTTP unit suite uses an injected store and no database
or provider. PostgreSQL integration uses only the fixed loopback CI URL/sentinel,
creates `xmail_owned_admin_test` only if absent, and drops only the database it
successfully created. It never loads `.env` or application database aliases.
The integration checks atomic provisioning/rollback, contact/domain refusals,
session revocation, current permissions (including concurrent demotion), disabled
native admission, safe projections, and tenant membership boundaries. A local
skip without the CI sentinel is not PostgreSQL acceptance evidence; require the
CI integration gate before considering activation.
