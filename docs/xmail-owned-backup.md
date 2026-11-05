# Current owned SQL disaster recovery

This operator covers the current authoritative Xmail SQL database, including all
70 business tables, four identity tables and the 80-entry migration ledger. It
does not re-export the frozen Supabase public database. R2 objects, mail TLS,
Google CA keys and application environment files are outside this database
archive. Existing R2 storage settings are preserved.

The implementation is prepared for reviewed execution; a real current snapshot,
authenticated offsite restore proof and timer-active readback must be recorded
before calling this daily disaster recovery operational. The historical
candidate backup under `offsite-backups/v1/archives` remains untouched.

## Protocol and custody

`scripts/ops/xmail-owned-backup.py` defaults to an offline plan. Explicit
`--backup` runs on source `49.13.197.250`; `--receive` is the forced SSH receiver
on existing target `188.245.112.3`. No new service, bucket or paid resource is
created. A dedicated Ed25519 transport key is generated and retained root0600
only on source49. Its public key is authorized on188 with
`from="49.13.197.250",restrict` and a single fixed Python receiver command.
There is no interactive shell, agent forwarding or forwarded port. The source's
dedicated known-hosts file pins the already trusted188 Ed25519 host key.

The existing recipient under188
`/opt/xmail/offsite-backups/v1/recipient` is reused unchanged. Its certificate DER
SHA256 is `2efbf3fc906a50317413cb6994842229b81062897a3d3849dd3f835abbdfa0cb`.
The RSA private key remains on188. Only its public certificate is copied to49.
The reviewed existing CMS guards are loaded by normalized source SHA256 from
`xmail-offsite-backup.mjs`, without executing its historical fixed-snapshot
dispatch. Encryption remains CMS AuthEnvelopedData, AES-256-GCM and RSA-3072
OAEP-SHA256/MGF1-SHA256. No private key is sent to Windows or another host.

A PostgreSQL exported repeatable-read snapshot keeps the custom `pg_dump` and
schema/full-row fingerprints at the same database snapshot. The private tar
contains exactly `snapshot.dump` and `manifest.json`. It is encrypted before
transport. The receiver accepts a bounded JSON header followed by ciphertext;
only version2/appXmail, fresh timestamps, bounded sizes and strict nonce/hash
fields are accepted. Neither SQL rows, filenames from customer data, credentials
nor keys are printed. The source streams host-to-host; no backup bytes pass
through the controller.

The receiver verifies ciphertext hash, CMS algorithms and completed AEAD
decryption before trusting plaintext size/hash. Tar extraction admits exactly
two regular filenames and no links or traversal. It then restores into a fresh
temporary PostgreSQL container using the exact cached PG image, no network,
no published ports, no host data mounts, read-only root filesystem, tmpfs data,
384MiB memory and half a CPU. The exact image Config.Volumes path
`/var/lib/postgresql/data` is tmpfs, with no anonymous data volume. Readiness
probes TCP127.0.0.1 so the temporary initdb socket server cannot pass admission.
Cleanup removes only the nonce-owned container and its anonymous volumes. Restore uses one transaction and stops on error.
All74 table schema/full-row fingerprints, public function/type signatures,
referenced policy roles and the complete migration ledger hash are compared.
No object is restored over either application's real database. Temporary
plaintext and the restore container are removed before success publication.

The schema/data comparison is an isolated recovery rehearsal. Runtime SQL roles,
credentials and application secrets remain a separate host provisioning concern;
the archive intentionally does not restore global role passwords or grants.

## Paths and schedule

The installed design is **push from49 to188**, with the transport private key
only on49. An earlier pull proposal was discarded before installation.

Both hosts use `/opt/xmail/owned-backup-ops` root0700, with public reviewed code
under `code/` and files root0600. Source49 retains `transport.key`, `known_hosts`,
the public `recipient.crt` and a flock file. Target188 retains only a receiver
flock in this directory; its existing recipient stays at the original v1 path.
Each SSH key is app-scoped; another app must use a separate key, forced receiver,
directory and profile rather than this source/IP/database allowlist.

Verified archives are atomically published under188
`/opt/xmail/offsite-backups/owned-v1/owned-<UTC>-<nonce>`. Source49 keeps encrypted
fallback copies under `owned-backup-ops/local-archives` after offsite proof.
Both retain the latest seven verified copies. Retention only recognizes this
exact version/app/nonce layout, exact two-file contents and matching ciphertext
checksums; it never traverses or removes historical v1/cutover backups. Unknown
contents refuse deletion. Failed source/target private staging is removed only
after checking its nonce-owned path, allowed filenames and root modes.

The source-only systemd service `xmail-owned-backup.service` invokes the fixed
backup command; `xmail-owned-backup.timer` schedules daily03:15UTC plus up to15
minutes random delay, with missed-run persistence. The installer enables the
timer but leaves it stopped until the first real verified backup. Start and
read back the timer only after that proof. The service has CPU/memory/time bounds
and writes only aggregate outcome/static errors to the journal. Locks reject
overlapping runs. A failed run preserves the app and all published backups.
Future schema/ledger changes require reviewing these explicit count guards.

## Installation and verification

`install-xmail-owned-backup.py` is also offline by default. Reviewed `--apply`
requires source/target role and the exact normalized backup-script SHA256.
`--prepare-transport --role source` creates/verifies the host-only transport key
and returns only its public key for the target's forced-command authorization.
All other installer input is public metadata on stdin. Existing files/units must
match exactly; conflicting state refuses. Other authorized keys are preserved.

Offline unit tests cover no-I/O defaults, pinned crypto/helper loading, all-table
manifest scope, malformed/stale/cross-app headers, forced-command/host-key guards
and retention that preserves historical or unexpected files. A real execution
must additionally prove current source/image health before and after, matching
decrypted bytes, isolated restore equivalence, temporary-container removal,
offsite/local verified receipts and an enabled/active daily timer. Do not infer
those facts from offline tests alone.
# Restore diagnostics and production-width rehearsal

The initial diagnostic restore used384 MiB memory/swap,0.5CPU, five connections,
network-none and its exact tmpfs data directory. Production PostgreSQL settings
and the temporary process's default lock budget remain unchanged. An initial CI
hypothesis test restored a synthetic74-table,
309-index and two-sequence snapshot successfully under both 64 and 256 lock
budgets. That result does not establish shared-lock exhaustion as the cause of
the real receiver's manifest-readback error; the proposed lock change was removed.

Only the failing manifest psql call requests `VERBOSITY=sqlstate`. A failed
query can add the optional `sqlState` field, exactly five uppercase letters or
digits, to the existing public component/function/line diagnostic. Raw stderr,
SQL, values, exception messages and stdout rows are never forwarded. The SSH
receiver validates the field strictly before propagating it. An unknown or
malformed transport error produces only the existing code coordinates.

The CI-only `rehearse-xmail-owned-backup-locks.py` keeps the production-width
regression: it invokes actual `restore()` on disposable synthetic data, requires
complete manifest equivalence under the original64 budget, and compares256 as a
fixture-only measurement. Its containers expose no ports, use no persistent
volumes or external network, and are removed after each attempt. Output contains
aggregate counts, booleans and parsed SQLSTATE only. Live diagnosis and any
subsequent correction remain subject to the actual observed error code.

## Measured PGDATA capacity correction

The real receiver returned SQLSTATE53100 during the preservation manifest query.
Root sampled the disposable process27 times: its262144KiB PGDATA reached258388KiB
used with3756KiB free; `/tmp` used0 of16384KiB and `/dev/shm` used1228 of65536KiB.
The cgroup memory peak was350400512bytes, about334MiB of384MiB. This identifies
PGDATA pressure rather than shared-memory exhaustion or a lock-slot error.

Only the disposable restore now receives512MiB PGDATA tmpfs and768MiB memory/swap.
The latter accounts for tmpfs pages plus PostgreSQL working memory. CPU remains
0.5, connection limit5, shared_buffers32MiB, work_mem2MiB and PIDs96. `/tmp`,
socket tmpfs, default `/dev/shm`, network-none, read-only root filesystem,
no persistent mounts and cleanup remain unchanged. Admission requires at least
2GiB host MemAvailable before any container access, and actual Docker resource
limits are checked after startup. No production database or application limit,
paid resource, schedule or provider setting changes.

The CI data-pressure mode uses the actual restore protocol and the same full
74-table/80-ledger manifest. It adds100000 synthetic rows to create a sort spill
and reserves an identical fixture-only file in PGDATA across both capacity
settings. Under the old256MiB data/384MiB RAM budget, only about1MiB remains free
before readback and the query must return53100. Under512MiB/768MiB, the identical
dump, rows and reserved bytes must produce complete manifest equality. The
reserve file exists only in disposable CI tmpfs and is removed with the exact
container; no real data or host filesystem is filled by this rehearsal.

## Safe manifest mismatch classification

After the SQL query and74-table/80-ledger validation succeed, exact manifest
inequality still refuses publication. The failure payload can include only a
strictly validated `comparison` object: five booleans for table-name equality,
functions, enum types, ledger and policy roles, and three bounded counts for
table-schema, row-count and row-hash differences. No table names, SQL,
definitions, account identifiers, row values or content hashes are forwarded.
Existing code coordinates and optional SQLSTATE remain compatible.

CI runs actual restores and deliberately changes one restored synthetic row,
then separately changes one restored column default without changing its rows.
Both copies must fail exact equivalence; the classification must distinguish
one row-hash mismatch from one table-schema mismatch. This diagnostic does not
normalize away a difference, change restoration ownership, rewrite fingerprints
or claim a real manifest mismatch is harmless. Actual component evidence is
required before any targeted semantic correction.
