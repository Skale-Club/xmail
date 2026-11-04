# Prepared Xmail owned deployment admission

This patch prepares deployment; it does not complete the migration or execute a
freeze, refresh/import, role LOGIN, flag change, deploy or provider cutover.
Production still uses its original runtime. Final freeze/import/control
acceptance needs a separately reviewed producer of the private receipts below.
Do not manufacture successful receipts from these examples or from unit tests.

The SSH action receives the public `.github/scripts/deploy-xmail.sh` code as
base64 and SHA256 derived from the checked-out revision. Its short wrapper
verifies that hash before execution on stdin; no host script file, secret
source/eval or large inline workflow string is required. Policy fixtures execute
the same Python heredoc from that public script.

## Deployment paths

Without `/opt/xmail/owned-runtime-ops/owned-runtime.env`, the existing legacy
deployment path is preserved. A present invalid profile fails closed. A valid
profile selects the owned path and never reaches the legacy blue/green handoff
or its rollback function. The existing Google-only host file remains separate.

`XMAIL_OWNED_AUTH_PHASE=data` keeps browser/admin authority explicitly `legacy`.
For the first SQL cutover (`sourceKind=supabase`), Google must remain false and
the old runtime's actual SQL/Auth URLs must identify the pinned Supabase project.
Existing users continue their existing login while business SQL moves to the
private database. Zero Google bindings do not prevent this data-only phase.

After that data cutover, a controlled Google pilot can run on the already-owned
SQL target while both authorities stay explicitly legacy (`sourceKind=owned`).
The existing link flow requires an online exact-UUID legacy proof plus fresh
Google proof and current local controls. The reader preview is never used for
linking. No additional identity SQL pool, hosted project or matching by contact
is introduced. An owned cookie cannot administer the explicitly legacy admin
surface during this pilot; the separate legacy session remains available.

Only `authPhase=identity` switches both authorities to owned. It requires the old
runtime already using the exact owned SQL URLs, Google true and a fresh private
admin-acceptance receipt. A bounded read-only SQL check independently requires
the exact active admin/control/binding/session, a direct `legacy-session:<UUID>`
link proof, project `skaleclub`, current unrevoked session and authentication
within five minutes. Zero bindings or an unaccepted admin therefore refuses
this phase. Hash/UUID inputs travel on stdin; no raw session token is used.

The owned candidate uses the existing isolated `staging-http` entry selector and
the dedicated reader role, with a two-connection pool, internal temporary Docker
network, read-only root filesystem, no host ports and no production routes.
Only `reader.env` is delivered. It receives no writer URL, baseline native/R2
credentials, Google certificate mount or hosted Auth credential. Its Docker
metadata and actual loopback HTTP health/readiness are verified; the temporary
container/network are removed before a full runtime can begin. No preview is
ever placed behind Traefik.

The reader guard requires exactly **74 public tables: 70 business tables and
the four named identity tables with RLS enabled**. A real read-only query on
2026-11-04 confirmed this state on the pinned private candidate. It does not
accept a range or silently increase grants. The existing privilege checks and
read-only SQL proof remain in force.

`preview` stops after that isolated validation. `promote` additionally consumes
the pinned receipt chain, proves the immutable old container ID stopped, rejects
another live full application/target writer, and retains the old stopped
container under `xmail-frozen-<old-id-prefix>`. The new full runtime starts only
after preview cleanup and a second live preflight. One full process is allowed:
the declaration cannot pretend the existing 18-connection process budget fits
two overlapping processes under the role ceiling 20.

## Fixed private files

All files below belong to root:root, mode0600, one hard link, regular files with
no symlinks, under the root0700 directory `/opt/xmail/owned-runtime-ops`.
Parent directories must be root-owned and not writable by group/others. Files
are never sourced/evaluated. The consumer accepts no alternate CLI root.

| File | Contract |
| --- | --- |
| `owned-runtime.env` | Exact allowlist: both private runtime URLs; explicit browser/admin authorities; six pool-budget declarations; auth phase; deploy mode; approved image ID/source SHA; cutover-receipt SHA256 |
| `reader.env` | Exact six fields: production NODE_ENV, staging HTTP true, loopback origin9001, private reader URL, both Google enable flagsfalse |
| `production-base.env` | Allowlisted existing native/R2/integration/runtime values, compared in memory with the stopped OLD container's actual environment; no SQL targets, Google settings or authority overrides |
| `cutover-receipt.json` | SHA256 pinned by the profile; exact receipt v1 described below |
| `freeze-receipt.json`, `snapshot-receipt.json`, `controls-receipt.json` | Exact filenames and SHA256s referenced in every cutover receipt |
| `final-import-receipt.json` | Required only for the first Supabase→owned SQL cutover; never reimport managed-source data after the owned writer starts |
| `admin-acceptance-receipt.json` | Required only when switching to owned browser/admin identity |
| `deploy.lock` | Empty root0600 file; nonblocking flock serializes this deployment path |

The profile URL validator requires the exact private candidate
`e12scyfsrp822dag7m9wwd4x:5432/xmail` and `xmail_runtime`; the reader URL uses
`xmail_staging_reader`. URI options/fragments are refused. The role limit is20,
reserve at least2, process count1, admin pool1–2, jobs at least12, and the full
declared total plus reserve must fit20. Pool settings are explicit declarations,
not automatic downsizing or evidence of measured production capacity.

`XMAIL_OWNED_APPROVED_IMAGE_ID` is an exact Docker image SHA256, and
`XMAIL_OWNED_APPROVED_SOURCE_SHA` is an exact 40-character Git SHA. The image's
OCI revision label and the workflow revision must match it; hashes have no
ordering/version semantics. The build adds that public revision label. Secrets
reach the owned container only through fixed `--env-file` paths; no secret value
is inserted into a new command argument, shell source/eval or log.

## Receipt v1 producer contract

The cutover receipt has exactly: `version=1`, `app=xmail`, fixed `target`,
`database=xmail`, `role=xmail_runtime`, pinned `postgresImage`, exact
`applicationImage` and `sourceSha`, immutable `oldContainerId`, `oldImageId`,
`authPhase` (`data` or `identity`), `sourceKind` (`supabase` or `owned`),
`profileDigest`, `baseEnvironmentSha256`, `createdAt`, `expiresAt`, and `proofs`.
Each proof pointer has only its fixed `file` and `sha256`.

`profileDigest` hashes UTF-8 canonical JSON of the parsed profile excluding
`XMAIL_OWNED_RECEIPT_SHA256` (sorted keys, separators`,` and`:`, no spaces).
The baseline and all receipt-file hashes cover their exact bytes. This avoids
a circular profile/receipt hash dependency. Timestamps are strict UTC second
precision. Every receipt/proof must be currently valid, at most15 minutes old,
with a positive validity interval no longer than15 minutes. Proof creation order
is freeze→snapshot→final-import (when required)→controls→admin-acceptance (when
required)→cutover, allowing equal seconds.

Each proof has the exact common fields `version`, `app`, `kind`, `target`,
`database`, `role`, `postgresImage`, `applicationImage`, `sourceSha`,
`authPhase`, `sourceKind`, `oldContainerId`, `createdAt`, `expiresAt`, and `facts`. All scope fields must
agree with the cutover receipt/profile. Facts are typed exactly:

- Freeze: `allSourceWritersStopped=true`, `oldContainerStopped=true`.
- Snapshot: `sourceReadOnlySnapshotComplete=true`, SHA256 `snapshotDigest`,
  `businessTables=70`.
- Final import: exact snapshot-receipt SHA, `restoredAndReconciled=true`,
  `nativeHashesPreserved=true`, `referenceMetadataPreserved=true`,
  `identityTables=4`, `businessTables=70`.
- Controls: exact snapshot-receipt SHA, `exactUuidControlsReviewed=true`,
  `disabledStatePreserved=true`, `noContactAutoLinks=true`,
  `runtimeGrantsReviewed=true`.
- Admin acceptance: exact `adminUserId`, `bindingId`, `sessionHash`, and typed
  true `independentLegacyProof`, `freshGoogleProof`, `ownedSessionAccepted`,
  `applicationAdminVerified`. The consumer rechecks these identifiers in SQL;
  a producer assertion alone cannot admit an absent binding/session/admin.

These are producer attestations backed by the future reviewed operation, not
work performed by this consumer. The consumer independently rechecks Docker
image/state/other writers, private file integrity and baseline environment.
The final producer must coordinate with the same deployment lock; no external
writer may be restarted between its freeze and deployment.

## Failure and remaining actual work

Promotion requires the separately validated Google host profile in the selected
phase's explicit state: false for the first SQL-only cutover, true for owned
identity. A controlled pilot is permitted only after SQL is already owned.
It preserves the original native/R2 credentials, verifies the full container's
actual environment, original published ports, image and read-only Google mount,
and requires selected SQL/Auth/R2 readiness before recording success. It never
automatically resumes the frozen writer or runs a pre-owned image on the private
database. A failed new runtime is stopped; recovery requires reviewing the
owned database and failed container, not reverting blindly to Supabase.

Receipts do not reserve database contents against an uncoordinated root writer.
The final operator still must quiesce every source writer, perform and verify
the final snapshot/import/control refresh, establish the role/cluster connection
budget and workload acceptance, deliver the private files, and validate real
login/native/HTTP behavior. SQL/Auth cutover does not change the already-active
R2 backend or require a new KMS service, bucket, ACL or object copy.
