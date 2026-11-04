# Explicit linking when the previous browser session expired

The prepared endpoint is `POST /api/auth/identity/existing-account-link`. It is
available only under the existing Google pilot flag. The production SQL cutover
is already complete; this patch does not activate Google or change the current
legacy browser/admin authority, production environment, database or native mail
passwords.

The user opens `/auth/identity?action=existing-account-link`, enters the previous
account email/password and explicitly confirms Google or SMS. The server verifies
that recent provider identity and live account status, then proves possession of
the old account through the original project's public Auth API. A bounded
password-token request is followed by an uncached online user lookup. Only that
lookup's exact UUID selects the existing local account; form email, token claims,
profile email/phone and caller-supplied user IDs never select or merge accounts.
Development uses its explicitly isolated public project configuration only.

The endpoint keeps the identity router's strict JSON/body limits, per-IP attempt
limit, same-origin check and one-use browser/operation-bound CSRF challenge.
Passwords and provider access/refresh tokens are never returned, logged or saved
to browser storage. Both Auth requests and response bodies share an absolute
eight-second deadline; responses are size-bounded. The provider public key is
checked against accidental administrative keys. No Supabase admin SDK, native
password update, recovery email or generic legacy application session is used.

Local reviewed controls must exist and be active. The binding transaction locks
and rechecks the control cutoff and immutable provider binding; conflicts fail
closed. An existing owned cookie must still authenticate to the same exact user.
The endpoint returns only `linked: true`, with no application session cookie.
The user action then performs the regular owned login, which independently
rechecks provider status, binding and controls. Generic old login/refresh routes
remain unavailable after owned authority is selected.

Bindings from this path record `legacy-password:<exact UUID>`. The deployment
admin-acceptance guard accepts this and the existing `legacy-session` format
only for the same user UUID; an owned-session or contact-derived reference does
not qualify as independent old-account proof. No schema migration is needed.

Before identity activation, refresh controls for **all current owned-SQL users**,
including users created through legacy administration since the SQL cutover.
Deploy new code through a fresh owned-to-owned receipt with exact image/revision
pins; never reimport the frozen Supabase business database or resume its writer.
Google/SMS sign-in and admin acceptance still require the person's real provider
interaction. Users unable to prove old-account possession need reviewed recovery;
this endpoint does not silently create an account, link by contact or grant roles.
