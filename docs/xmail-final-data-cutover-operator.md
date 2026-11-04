# First Xmail SQL-only cutover operator (prepared, not executed)

`scripts/ops/prepare-xmail-final-data-cutover.py` defaults to an offline plan.
It does not run the application or complete browser-identity migration. Actual
`--apply` requires independent review of the exact public code, green disposable
PostgreSQL rehearsal and a coordinated quiet window on the shared host.

The baseline release on main `3c130b249649df22f5f884344e1a118723d5cc78` was
published successfully by [deploy41861205434](https://github.com/Skale-Club/xmail/actions/runs/41861205434),
with [CI41861205612](https://github.com/Skale-Club/xmail/actions/runs/41861205612)
successful. Read-only runtime checks confirmed image
`sha256:1af00c1f61e4fe90f60e7bebe73068509da511bdbf85d56ae8a253d05468b416`,
source SQL/Auth still pinned to the existing Supabase project, Google false and
endpoint disabled, legacy browser authority, read-only Google mount, healthy
HTTP/readiness, authenticated R2 metadata access and SMTP25/587 + valid-TLS
IMAP993. No credential was included in that evidence. Obtain a fresh immutable
OLD container ID for the actual operation; a later deployment changes it.

## Admission and operation

The explicit public arguments are `--approved-image-id`,
`--approved-source-sha`, `--policy-sha256`, `--old-container-id`, and
`--http-pool` (one through four). They are metadata, not credentials. The current
legacy baseline and intended data runtime must use that same approved image and
OCI revision. `policy-sha256` covers normalized-LF public
`.github/scripts/deploy-xmail.sh`; the source-read protocol is independently
pinned to its reviewed V2 checksum. No private env file is sourced/evaluated.

Before production changes the operator verifies:

- Exact healthy application ID/image and legacy SQL/Auth source project;
  Google remains false. No other known Docker application/source writer is live.
- Existing private PostgreSQL17 image, exact persistent named volume, no
  published ports, resource limits, disk/RAM margins, owner/ledger80 and74 tables.
  Both prepared application roles must be NOLOGIN with no other target sessions;
  bindings, owned sessions and browser challenges must all be empty.
- Exact source/candidate schema fingerprints for70 business tables, function
  definitions and enum metadata; actual FK definitions/modes, user-trigger modes
  and sequence definitions. Drift refuses the operation.
- A new root0700 private bundle containing a complete candidate backup,
  SHA256 and metadata, fsynced before the first production mutation.

The shared deployment lock prevents this operator and the owned deploy path
from running together. The operator disables the OLD container's restart policy
and stops it by immutable ID. It requires a clean exit (no OOM/forced exit).
It never restarts OLD automatically. Source schema, all70 row fingerprints and
fresh exact-UUID Auth status are captured in one exported repeatable-read,
read-only snapshot held by an ephemeral Node client; the stopped application is
not restarted to obtain credentials or run a snapshot holder. A bounded PG17
client writes a new private source archive with verified CA/hostname TLS.

Docker stop alone does not enforce this freeze: the existing Supabase REST and
GraphQL entrypoints retain their original grants. A read-only source inventory
confirmed70 writable tables, eight read-only SQL RLS helpers, a GraphQL wrapper,
no noninternal Auth/public triggers and no active cron job. Full definitions and
ACLs remain only on the host in root0700/root0600 private metadata; output is
limited to counts/hashes. This inventory does not itself change any permission.

After OLD stops, one source transaction takes ACCESS EXCLUSIVE locks on all70
tables, rechecks exact schema/catalog metadata and installs a BEFORE STATEMENT
INSERT/UPDATE/DELETE/TRUNCATE rejection trigger on each table. ENABLE ALWAYS
covers replica sessions too. A private schema holds the fixed invoker function;
no existing ACL, RLS policy, public function or Auth setting is rewritten. The
operator refuses new Auth hooks, active cron, partitions/foreign relations,
unexpected owners and pre-existing BEFORE STATEMENT hooks. Old in-flight table
writes must finish before those locks can be acquired. All70 empty DELETE
statements must then fail with the exact fence SQLSTATE/message, proving the
actual committed barrier before the frozen snapshot starts. This blocks normal
REST, GraphQL, RPC, SQL and COPY business writes without disabling Auth reads or
old-account possession proof. Deliberate owner/admin DDL can remove a barrier;
administrative changes must remain excluded during this coordinated window.

Each later source snapshot rechecks the exact function and70 ALWAYS triggers.
Only those exact fence trigger names are omitted from business-schema parity,
after that independent check; other drift still refuses. The private archive
includes the fence schema so its trigger dependencies are self-contained. A
source-fence attempt without acknowledgement is treated as ambiguous and never
retried automatically. The consumer requires an explicit verified source-fence
fact for the initial Supabase data cutover; a Docker-only receipt is rejected.

The private bundle includes an exact noncascading release SQL artifact. It is
never run automatically. Releasing the source requires a separate reviewed
recovery decision proving that no owned writer started and no target COMMIT is
ambiguous; after owned writes begin, source remains frozen. No application or
database role is restarted to manufacture that proof. Statement trigger and
ALWAYS behavior are documented in PostgreSQL's
[CREATE TRIGGER](https://www.postgresql.org/docs/17/sql-createtrigger.html) and
[ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html).

The legacy delivery queue has no durable in-flight marker. The operator therefore
requires no unheld dispatchable pending/queued deliveries, no sending/claimed
inbox commands and no claimed/started pending outreach sends, both before stop
and in the frozen snapshot. Held mail stays held. Ambiguous work refuses the
operation; it is never canceled, reset or resent by this tool.

## Atomic refresh and preservation

The destination keeps its database, volume, schemas, ledger79/80, grants and four
identity-table definitions. One transaction locks all74 tables, rechecks target
guards/schema, captures prior controls, drops only the captured public FKs,
disables user triggers and truncates the70 business tables plus controls.
Only the archive's70 whitelisted `TABLE DATA` entries are streamed to psql;
customer COPY bytes are never searched/replaced. No schema, table, ledger or
external dependency is dropped, and no CASCADE is used.

Controls are reseeded from the frozen source's exact UUID/status set. Existing
bans remain; future cutoffs are preserved with `greatest`, using the frozen
snapshot time as the conservative new cutover cutoff. No email/phone identity
link is created. All captured FK definitions and deferrability are restored and
validated; original trigger modes O/D/R/A are restored. All70 complete-row
fingerprints must match source before COMMIT, preserving native password hashes,
UUID memberships, object-reference metadata and all other business rows.

Sequence `setval` entries are excluded. Sequence definitions remain unchanged;
transactional `ALTER SEQUENCE RESTART` preserves the **next value**, which may
change the representation of `last_value/is_called`. This is deliberate and is
verified by next-value equivalence. PostgreSQL documents the transactional
behavior in [ALTER SEQUENCE](https://www.postgresql.org/docs/17/sql-altersequence.html).
An exhausted noncycling sequence refuses the operation.

New random runtime/reader passwords stay in private host files/memory; SCRAM
verifiers are sent on stdin with SQL statement/error logging suppressed. Role
LOGIN is enabled in the same transaction only after data reconciliation and
explicit role/grant checks. Runtime retains its existing ceiling20; the reader
has ceiling2 and a15-minute credential expiry. This is an explicit reviewed
activation path, not a runtime grant escalation or silent pool reduction.

After an acknowledged COMMIT, fresh read-only checks repeat all70 fingerprints,
schema/FKs/triggers and sequence equivalence, and recheck source stability. Only
then are the private phase-data receipt chain and SHA-pinned deployment profile
published. They keep browser/admin authority explicitly legacy and Google false.
The original native/R2/integration values are copied from the real stopped
container and verified by the deployment consumer. No new bucket, provider,
project, KMS key, notification or message is created.

## Failure, evidence and remaining acceptance

An unacknowledged COMMIT is ambiguous: the operator does not retry or claim
rollback. Private commit-attempt/ack records and backups remain for review.
An incomplete profile cannot admit a deployment; no final success is printed
until bounded temporary-client cleanup succeeds. No failure path starts a new
writer or resumes the frozen legacy writer. Never delete/reset the candidate,
volume, backup or failed state to force a retry.

Actual phase1 still requires running the reviewed operator, deploying its pinned
profile and validating real HTTP/native behavior and workload. Phase2 requires
refreshing controls against **all current owned-SQL users**, independently linked
admin acceptance and a dedicated late-link possession-proof path for users whose
old local bearer expired. The data-only operation does not claim those identity
steps complete and never reimports Supabase after an owned writer begins.
