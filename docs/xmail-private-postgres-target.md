# Private PostgreSQL target — 2026-11-03

The existing Hetzner host now runs an additive private PostgreSQL candidate.
The running `xmail` application still uses its existing Supabase source.
No application environment, source data, mail credential or routing was changed.
No new server or paid Supabase project was created.

| Setting | Verified value |
| --- | --- |
| Coolify database | `e12scyfsrp822dag7m9wwd4x` / `xmail-private-postgres` |
| Existing project | `s5lw4a6mx6495n4i2uu7ocrx` |
| Existing environment | `anbzo3ytsf5hih8cnamth7sv` / production |
| Existing server | `ffavbanjl2mnykhlf2qhncci` |
| Image | `postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b` |
| Runtime version | PostgreSQL `17.11` |
| Database / migration owner | `xmail` / `xmail_owner` |
| Memory / combined swap limit | 512 MiB / 512 MiB; no additional swap |
| CPU limit | 0.75 CPU |
| Health | Running, healthy |
| Published ports | None; Coolify resource `is_public=false` |
| Storage | Persistent Docker volume at `/var/lib/postgresql/data` |
| Initial SQL probe | READ ONLY, zero public tables |

The randomly generated database password was sent directly to the existing
Coolify secret store over SSH and the host's loopback API. It was not written
to desktop files, repository content, command arguments or reports. Operate the
Coolify API through the authenticated SSH/loopback path; do not transmit its
token to the public plaintext HTTP origin in the old local configuration.

The old Coolify application resource `suux7xgfg3pvy8zbujotoccb`
(`skaleclub-mail`, exited) is not the currently running production container.
Production is the `xmail` container managed by the existing GitHub Actions
deployment workflow. Do not start the old resource or change its environment
to perform this migration.

The exported-snapshot rehearsal in `xmail-database-rehearsal.md` proved the
portable restore and critical identity/SMTP reconciliation in a disposable
target. It did not populate this persistent candidate. The next import must
lock onto this exact UUID/database, require an empty destination, preserve a
private snapshot manifest, restore transactionally and reconcile it before any
application uses the candidate. Schema compatibility helpers must not authorize
identities. Production routing and migrations remain separate release steps.

Before cutover, prepare a least-privileged runtime role separately from the
migration owner, verify all remaining data consumers and establish durable
backup/restore coverage and final-write-pause/sequence reconciliation. The
existing Cloudflare token denied R2 bucket metadata, and the existing Xmail
S3 credential denied account-level bucket inventory. No permissions were
expanded to work around either denial; a verified private backup destination
is still required. The healthy empty candidate is not evidence of a completed
production migration.

## Candidate populated — 2026-11-03

The initial empty state above is historical. After reviewed execution starting
23:24:09 UTC, this exact candidate was transactionally populated and independently
confirmed by the coordinator by 23:29 UTC. The committed receipt records matched
70 public counts/four digest groups, 39 users, 38 memberships, 37 native password
hashes and one platform admin against the same exported source snapshot.

The private retained archive and commit/final receipts are under
`/opt/xmail/backups/candidate-20261103T232409Z-3654333.CTKbuKFN/`; its final
`restore-proof.json` status is `candidate_committed_and_reconciled`. The directory
is 0700 and the archive exists. The import enforces 0600 archive/manifest/receipt
files and SHA256 readback. Temporary clients/work/code directories were absent
afterward. Production `xmail` retained its observed image prefix and healthy state;
the candidate remains healthy/private with its persistent volume and no published
port. No application uses the new database yet and no source/app environment was
changed. Do not reimport into this populated candidate.

`applicationCutover=false` and `offHostBackup=not_verified` remain explicit in
the receipt. A restricted HTTP-only staging mode, a least-privileged runtime role,
off-host backup, Auth acceptance and final write-pause/sequence checks remain
required before cutover. See [the import evidence](xmail-private-postgres-import.md).
