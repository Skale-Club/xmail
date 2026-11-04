# Persistent candidate import — verified

`scripts/ops/import-private-postgres-candidate.sh` prepares the already-created
private candidate documented by the coordinator in
[xmail-private-postgres-target.md](xmail-private-postgres-target.md). The current
production `xmail` container remains on its existing Supabase source. This script
was executed by the coordinator after root and peer review. The run started
2026-11-03 at 23:24:09 UTC; independent verification was reported by 23:29 UTC.
It does not create another PostgreSQL server, change application environment/routing,
run identity migrations, broaden R2 permissions or create a paid Supabase project.

## Executed import evidence

The persistent target committed and reconciled all 70 public table counts and the
four canonical digest groups against the exported source snapshot: 39 users,
38 memberships, 37 native password hashes and one platform administrator. The
coordinator independently verified the commit acknowledgment and final receipt at
`/opt/xmail/backups/candidate-20261103T232409Z-3654333.CTKbuKFN/restore-proof.json`,
with status `candidate_committed_and_reconciled`, `applicationCutover=false` and
`offHostBackup=not_verified`. The private backup directory has mode 0700 and its
archive exists; the import verified archive SHA256/readback and recorded receipts.
No digest, row, credential or archive content was transferred to the desktop.

Independent post-run checks found zero temporary clients/work/code directories.
Production `xmail` remained healthy with the same observed image prefix
`sha256:93c4f328`; the exact persistent PostgreSQL candidate remained healthy,
private on un-published 5432, with its persistent volume. No reimport is permitted:
the now-populated destination fails the empty-target guard. The retained local
archive is not off-host disaster recovery; final sequence/write-pause reconciliation,
unrelated public row-content digests, runtime-role isolation and Auth/application
acceptance remain separate gates.

## Exact destination and refusal conditions

The script has no target/owner/database/image override arguments. It pins container
UUID `e12scyfsrp822dag7m9wwd4x`, database `xmail`, owner/session user `xmail_owner`
and approved local image
`sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`.
Execution requires that exact running/healthy container, 512MiB memory/combined-swap
limit, 0.75 CPU, a writable persistent Docker volume at PostgreSQL's data directory
and zero published ports. Source production credentials are never used at the target.

An initial READ ONLY SQL probe requires PostgreSQL17, exact database owner/current
user, no public relations/functions/types/extensions and no `auth` or migration-ledger
schema or `authenticated` role. The same empty guard runs again inside the import
transaction, after a fixed advisory lock. The default public schema itself may
exist. No reset, overwrite, DROP, TRUNCATE or clean restore is performed. A previously
populated or bootstrapped candidate is refused, including after a successful prior
import. A failed post-COMMIT verification is an operator incident, never permission
to run an automatic cleanup/reset of the candidate.

## Reuse of the reviewed snapshot protocol

The importer loads `xmail-database-protocol.sh`, which reads but never sources or
executes the sibling `xmail-database-rehearsal.sh`. Its exact LF-normalized reviewed
file SHA256 is pinned as
`154b8a09399548daed7ebe73df758a1f9b4ee5d44bcd5fea1f1ac2d4f297fdd2`.
Only the five fixed CA, environment, manifest, holder and comparator blocks are
extracted; offline tests require byte-identical contents. A changed file fails
closed. The existing successful V2 rehearsal script is unchanged.

The source uses its fixed production project, strict target/URL rules, pinned public
CA and hostname verification. One session/direct5432 REPEATABLE READ READ ONLY
snapshot supplies pg_dump, all 70 public counts, full users/membership digests,
application authority and native password-hash digests. The source holder closes
with explicit rollback before restoration, with its own 210-second deadline. No
row, UUID, credential or digest leaves the host. Source credentials use remote
memory/stdin and transient dump-client Docker environment metadata until removal,
never an independent env file, command argument or log.

## Import, transaction and resource limits

The persistent server is already resident, so host admission requires at least
768MiB additional available RAM, at most 512MiB swap used and at least 3GiB free
separately on both `/tmp` and `/opt`, even if they are different filesystems.
`/tmp` must not be tmpfs/ramfs or another explicitly memory-backed filesystem;
the archive plus two bounded SQL files can otherwise consume about 1.25GiB of RAM.
The persistent PGDATA filesystem must also have at least 2GiB free before target
writes and cannot be memory-backed. These gates repeat before the import begins.
The bounded CLI container uses 128MiB RAM/no extra swap,
0.5 CPU and 64PIDs. The custom archive is capped at 256MiB; generated restore SQL
is capped at 512MiB. No temporary 768MiB PostgreSQL instance is started. The
offline restore-CLI phase has network none; only the dump phase shares Xmail's
network to read the verified Supabase source.

The archive TOC omits exactly one CREATE SCHEMA public entry. All contained data,
functions, indexes, constraints and policies are preserved. pg_restore emits SQL;
only its four exact preamble statements disabling statement/lock/transaction/idle
timeouts are removed, requiring all four matches. Object definitions and COPY
contents are never filtered. Changed preambles fail before target writes.

One psql transaction includes the second empty check, a target-only `authenticated
NOLOGIN NOBYPASSRLS` role, NULL-returning `auth.uid()` with public execution revoked,
pg_trgm compatibility, full restore and canonical manifest. No identity can use
these compatibility objects to authenticate. The server enforces a 240-second
transaction deadline, 180-second statement limit, two-second lock limit and
45-second idle-in-transaction deadline. CLI processes are also bounded.

The psql pipe remains open awaiting reconciliation. The original V2 comparator
must match all 70 table counts and four SHA256 groups, and the candidate report
guard additionally requires 39 users, 38 memberships, 37 native hashes and one
platform admin. Only then can the script prepare a retained archive and send
COMMIT. Failure/EOF before COMMIT closes the psql transaction without committing.
After commit acknowledgment and successful client exit, a fresh READ ONLY session
recomputes the manifest and requires the same match again.

## Retained local backup and receipts

The script requires a nonsymlink, root-owned0700 `/opt/xmail/backups` directory,
creating it privately only if absent. It never changes an existing directory's
permissions or deletes older bundles. Each run creates an exclusive private bundle
containing a0600 custom archive, source/target manifests and archive SHA256 file.
The copied archive must match the original dump's SHA256 and pass a readback check.
Filesystem sync completes before requesting COMMIT.

Receipts distinguish matched-but-pending, commit acknowledged and committed plus
fresh reconciliation. A failure may leave an incomplete receipt or a populated
candidate after commit; these are retained for private operator review, without a
PASSED report. A final receipt records the checked 70/4/39/38/37/1 scope and explicitly
states that off-host backup and application cutover have not been performed. Local
archive retention is not off-host disaster recovery. Existing retention/pruning is
not changed, and no R2 permission expansion is attempted.

Final cleanup can remove only this run's labeled CLI container and validated
temporary directory, and closes its private source/target pipe descriptors. It
never removes/stops the persistent target or touches its volume or backup bundles.
Success is released only after proving temporary-label resources and directory are
gone, the exact persistent target remains healthy/private and production Xmail's
observed image is unchanged. The report contains aggregate booleans/counts only.

## Review and offline checks

Both default and `--plan` modes perform no operational work. Execution after review
requires the three LF static files to exist together on the approved host:

```bash
bash import-private-postgres-candidate.sh --plan
# After independent review of this exact revision and host window:
bash import-private-postgres-candidate.sh --execute-reviewed-import
```

Required siblings are `xmail-database-protocol.sh` and the pinned
`xmail-database-rehearsal.sh`. Transfer only reviewed static code; never export
source credentials, manifests or dump data to the desktop. The default mode does
not load those helper files or inspect Docker.

Six offline Node tests cover default/override refusal, exact helper extraction and
tamper refusal, separate host/PGDATA capacity and filesystem checks, cleanup scope,
timeout filtering preserving COPY content, and
strict candidate baseline reports. CI also checks Bash syntax and both plan modes.
The root-executed import above supplies the actual empty-target transaction,
reconciliation and retained-backup evidence; offline tests alone do not establish
those live invariants. Future execution requires a newly approved empty target
or explicit separately reviewed recovery, never an automatic overwrite/reset.
