# Reviewed Xmail identity-control import — prepared, not executed

The owned login pilot requires `xmail_identity_user_controls` for every existing
application UUID. Migration 079 deliberately creates no controls; the reconciled
candidate imported the legacy application data without these new identity tables.
The legacy inventory included one banned Auth user, whose denial must survive the
transition. An absent control denies login, so this is an activation prerequisite.

`scripts/ops/prepare-xmail-identity-controls.py` prepares that import without
matching contacts, creating provider bindings or altering account authority. Its
default invocation is an offline plan and reads no environment/input file, starts
no child process and makes no connection. The existing Google/owned flag remains
false. No production operation or migration was executed by preparing this code.

## Two explicit, separately reviewed operations

1. Run `--capture-review` as Linux root on the existing Xmail host. The fixed
   healthy production image must match its approved ID. The subprocess inside
   that container selects its current direct/session database URL and validates
   source project `zzbudkfkcmqkavgwselc`, hostname/user/database/5432 and the running
   Auth project. It loads no dotenv file. TLS verifies the source chain and
   hostname against the pinned official Supabase CA. One REPEATABLE READ READ ONLY
   transaction reads matching public/Auth UUIDs and status, computes private full
   user/membership digests and rolls back. Non-boolean app-disable metadata,
   unmatched or extra Auth users and ambiguous status refuse the review.
2. Review the aggregate result, then separately invoke
   `--apply-reviewed-candidate`. The operator pins private container
   `e12scyfsrp822dag7m9wwd4x`, PG17 image, persistent volume, resource bounds, no
   published ports and exactly one reconciled import receipt. SQL runs through
   its local Unix socket as owner `xmail_owner` in database `xmail`; no database
   password, connection URL, data, hash or token is passed in argv or output.

Capture creates `/opt/xmail/identity-controls-review` root:root 0700 and stores
`review.json` plus its checksum as root:root regular 0600 files. UUIDs and private
digests stay on the host: do not copy them into Git, chat, CI or logs. Existing
review directories are never replaced. Interrupted/stale captures require an
operator to inspect and archive them before a separately reviewed new capture;
the script has no automatic delete, refresh or target override.

The review must be at most 30 minutes old, with no more than five seconds of
future clock skew. A current/future source ban, soft deletion or explicit
`xmail_disabled=true` becomes a local disabled control. Ban expiry does not
automatically reactivate it; that requires a later explicit local review.
The source database is never written. SMTP/IMAP/native password hashes are not
exported or transformed; their preservation is covered by the private full-user
digest. Organization membership UUIDs/roles are similarly reconciled.

## Candidate transaction and refusal policy

Migrations **079 and 080 must already have been separately reviewed and applied
on this candidate**. The importer neither installs schema nor changes grants or
the migration ledger. It refuses if any required table is missing, the controls
schema/owner/RLS differs, user triggers/rules exist on controls, or bindings,
sessions or browser challenges already exist. It is an initial import operator,
not a recovery or live account-administration service.

`xmail-identity-controls.sql` is SHA-pinned by the operator. One transaction takes
bounded advisory/table locks, checks the exact complete UUID set and full
user/membership digests, and inserts only missing control rows. Existing controls
must already match this same review byte-for-byte in meaning, including ban,
cutoff, source reference and review time; otherwise every insert rolls back.
Matching replay is idempotent while the review remains fresh. No existing local
decision is overwritten, no provider subject is guessed and no contacts are read
for identity matching. The session cutoff is the review time: initial account
linking requires a fresh independent proof after that cutoff.

After commit acknowledgment, a separate read-only transaction verifies every
control field, both content digests and absent provider bindings/sessions. It
rolls back. Container/image/health/start time/mount snapshots must stay identical
and the candidate remains private. Output is aggregate booleans/counts only;
raw driver, SQL, provider or credential diagnostics are suppressed. An uncertain
commit/readback failure is never retried automatically. Inspect the candidate
with the retained review before deciding whether to replay.

## Validation and remaining gates

Fourteen lightweight offline tests cover review schema/freshness, duplicate or
unmatched UUID shapes, excluded contacts/roles/token fields, exact host/image
admission, private SQL transport, read-only readback and default-offline behavior.
The source Node program is syntax-checked without executing it. CI additionally
runs the real SQL on a fresh loopback-only PG17 fixture, including bans,
idempotency, conflicting local decisions, UUID/content mismatch, freshness,
existing bindings, unreviewed triggers and atomic constraint failure. The fixture
creates and removes only its own database/owner before the existing runtime-role
test; it never reads repository dotenv or production aliases.

This preparation has not captured real Auth status or changed the candidate.
Live status/ban import, migrations, independent review and exact-SHA CI remain
required before activation. Account linking/recovery/invitations, legacy
Supabase-dependent administration and native credential-management endpoints,
Google/SMS browser acceptance, long-lived-stream revocation, final writer freeze,
database cutover and continued backup/restore proof remain separate work. This
operator does not claim a complete database/login migration.

Sources: [PostgreSQL 17 locking](https://www.postgresql.org/docs/17/explicit-locking.html),
[JSON processing](https://www.postgresql.org/docs/17/functions-json.html), and the
existing [candidate dossier](xmail-private-postgres-target.md) and
[identity pilot](xmail-identity-pilot.md).
