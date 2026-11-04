# Owned startup and native admission preparation

Server modules can now import the hosted-provider wrapper without constructing
an Auth SDK client. Legacy development still validates the dedicated development
settings before consumers can use production aliases. Owned startup publishes no
legacy Auth browser configuration from this wrapper and needs no hosted Auth
credentials merely to import it. Legacy clients are constructed only on explicit
use, with session persistence, URL-session detection and automatic refresh disabled.
Owned authority refuses server SDK Auth access and per-user hosted Auth clients.

Readiness preserves the existing bounded SQL probe and checks the explicitly
selected identity authority. Legacy uses its existing Auth settings probe; owned
uses the existing Google runtime ADC/token and API-key provenance readiness check.
The selected identity probe has an absolute eight-second deadline and aborts its
signal on completion/failure. Owned failure or invalid configuration never tries
the old provider. Public readiness errors are static and cannot include SDK
request headers, provider bodies or connection details. These probes do not
establish user ownership, create accounts, change roles or activate a login.

The browser `/login` entry navigates to `/auth/identity` when owned is selected.
This uses the existing identity page's Google-popup isolation headers rather than
embedding popup login under the legacy page's document headers.

SMTP AUTH and both IMAP login paths already call the same
`authenticateNativeUser` helper. Under explicit owned authority the helper now
requires an existing reviewed active local control **and** the existing active
native mailbox/hash. It rechecks the control and mailbox after bcrypt so a
concurrent deactivation cannot pass on a stale pre-password read. Missing controls,
disabled controls, invalid configuration and owned SQL errors return the protocols'
existing generic failure. The legacy default keeps its native admission behavior.

No native hash, mailbox flag, user UUID, membership, SMTP/IMAP port or database
record is modified by this check. Existing native sessions/command processing are
not rewritten by an authentication-helper change. Unit fixtures exercise this
shared helper without sockets; they are not live SMTP/IMAP acceptance evidence.

This does not finish the provider exit. The explicit legacy Storage driver still
uses `supabaseAdminClient.storage` when R2 is absent; object inventories/private
attachments/branding still need an independently verified storage cutover. Owned
onboarding/invitations, reviewed recovery, deletion, self-service native credential
management, SSE delivery revocation, production pool sizing and controlled
runtime activation remain separate gates. Candidate roles remain NOLOGIN and
all production flags/configuration remain unchanged by this preparation.
