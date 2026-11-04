# Xmail final browser authority

The production SQL cutover and Google pilot are already complete. The current
pilot keeps browser and user-administration authority explicitly `legacy`.
Global `owned` authority is a separate operation and has not been applied by
this change. Production keeps the existing R2 backend, native password hashes,
SMTP/IMAP contracts, application UUIDs and memberships.

The personal pilot is `https://mail.skale.club/auth/identity?action=link`.
Link Google first, then return to the same page and link the phone by real SMS.
Each successful normal `/link` creates an owned cookie. It replaces and revokes
the preceding owned cookie. If the old session expired, the explicit previous
account email/password flow proves possession online at the original Auth
origin, obtains the exact old UUID and then issues the owned session. Neither
path matches accounts by an email/phone claim or changes the native password.

## Acceptance

`scripts/ops/prepare-xmail-owned-authority-cutover.py` is offline by default.
It accepts explicit `--capture` or `--apply`, plus the exact approved current
application image digest, OCI source SHA, reviewed consumer SHA256 and immutable
current container ID. These are public pins; credentials never go in arguments.
It imports the unchanged reviewed pilot helper (`f730...`) and first-cutover
primitives (`6e9a...`) by their full normalized source SHA256.

Capture reads actual SQL bindings/sessions and fresh Google account status. It
does not sign in, manufacture a provider token, create sessions or mark a user
confirmed. A private capture under `/opt/xmail/owned-runtime-ops` is root0600;
only aggregate booleans are printed. Missing personal proofs refuse before any
application stop, role mutation or authority change.

The final operator requires one unambiguous admin UUID with two distinct
provider subjects. The original Google binding must have exact
`legacy-session:<UUID>` or `legacy-password:<UUID>` provenance; the phone child
must have exact `owned-session:<same UUID>` provenance. The retained parent
session must have been unexpired and fresh when that child binding was created,
then revoked from child creation through 30 seconds afterwards. Current child
session, both bindings, current controls/cutoff and SQL admin role are checked
again. The Google ancestor must have been fresh within 300 seconds at the original
phone binding; its history is not aged out later. Current local cutoffs and live
Google validSince are still enforced against that original authentication.
Revocation before child creation, missing ancestry or a different UUID/project
refuses.

Only the API stores signed-provider-verified sessions. The legacy schema does
not store a parent token hash or provider kind. Consequently the operator
refuses ambiguous ancestry, merged/same-subject accounts, a phone child with
mixed provider capabilities, or a Google anchor also carrying phone capability.
Fresh read-only Google lookups must confirm an active Google-capable anchor and
a distinct phone-only child, with provider cutoffs no later than the recorded
authentication times. This is intentionally conservative. No contact is used
to infer a local owner. A future different account shape needs evidence and a
reviewed proof format rather than a relaxed acceptance flag.

## Reviewed execution boundary

Before a real `--apply`, publish and review code, pass disposable PostgreSQL CI,
and obtain the actual personal pilot proofs. The operator validates the current
healthy owned-SQL runtime, exact image/revision, exact private PG image/volume,
resource budget, role grants, unchanged nine-key Google configuration and all
current own-SQL UUIDs. It performs online legacy Auth status reads for those
exact UUIDs while authority is still legacy. The frozen Supabase public business
tables are never a user inventory and are never imported again.

Initial live acceptance requires a phone authentication at most 90 seconds old,
before the slow review and backup. A fresh private custom backup, previous
profiles/receipts and pending rotated credentials are durable before stopping
the old writer.
The exact same chain, current SQL admission and provider statuses are repeated
after backup and before stop within the unchanged 300-second session window.
This avoids spending the short entry margin on the operator itself. Clean stop,
role NOLOGIN fencing,
current controls refresh and SCRAM rotation follow the already reviewed pilot
protocol. Bans and cutoffs only stay or tighten. All 70 business fingerprints,
UUIDs, binding/challenge digests and session count are reconciled. The native
hashes and memberships are included in those full-row business fingerprints.

After controls commit the exact same admin chain and Google statuses are
rechecked within the original five-minute authentication window. Only then are
fresh 15-minute freeze/snapshot/controls/admin-acceptance receipts and the
`identity` profile published, with both authorities `owned`. Google configuration
is preserved. This prepares the profile; the separately reviewed official
consumer promotes the same already approved application image. No source
restore, new service, new bucket, paid resource or automatic legacy rollback is
part of this operation.

Failure after stop/COMMIT requires read-only reconciliation of the private
attempt/acknowledgment files before any recovery. There is no automatic old
writer restart, unfreeze, credential rollback or receipt TTL extension.

## Verification

Offline Python tests cover default no-I/O, pinned helpers, exact selected facts,
missing/ambiguous/stale chains and fixed-origin read-only provider transport,
including disabled, revoked, wrong-UID and mixed-capability refusal. The actual
deployment consumer SQL is executed by the disposable identity PostgreSQL CI
suite against a valid parent/child chain and broken ancestry/controls fixtures.
Local no-database runs skip that SQL suite and cannot establish live readiness.
Real personal factor acceptance and the final runtime readback remain required.
