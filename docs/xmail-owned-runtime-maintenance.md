# Xmail owned runtime maintenance

This is a release path for the already active own SQL/browser/admin authority.
It does not repeat the Supabase migration, query Source Auth accounts, refresh
ownership timestamps, or require a new Google/SMS authentication. Current own SQL
UUIDs and reviewed controls are authoritative, including users created locally
after the migration. Source public tables remain frozen.

The operator defaults to an offline plan:

```sh
python3 -B scripts/ops/prepare-xmail-owned-runtime-maintenance.py --plan
```

## One-time adoption of the actual authority COMMIT

Before the first maintenance release, the root operator stages the reviewed
public five-file bundle and records the existing healthy owned runtime. This
reads the original immutable COMMIT acknowledgment and ready proof from
`/opt/xmail/backups/owned-authority-20261104T235544Z-e82cc86e`, the current private
profile/receipt, actual Docker ID/image, and own SQL metadata. It does not renew
the old receipt or modify the application/database. All files stay root-only.

```sh
python3 -B scripts/ops/prepare-xmail-owned-runtime-maintenance.py \
  --capture-authority \
  --prior-authority-bundle owned-authority-20261104T235544Z-e82cc86e \
  --old-container-id "$ACTUAL_PUBLIC_CONTAINER_ID" \
  --policy-sha256 "$REVIEWED_PUBLIC_DEPLOY_SCRIPT_SHA256"
```

The resulting `/opt/xmail/owned-runtime-ops/owned-authority-current.json` records
the real prior release. Subsequent successful consumer readbacks replace this
anchor with the actually healthy new owned runtime and the new immutable COMMIT
acknowledgment. Existing mismatched adoption files are refused.

## Official pipeline

`build-deploy.yml` builds and pulls the main OCI image as before. It transports
only the public deploy script, maintenance operator, and the three existing
hash-pinned helpers. The remote script verifies the bundle checksum, exact file
allowlist, main source SHA and actual OCI revision; it stages root-only files
without sourcing any environment file. Legacy/data-phase behavior is preserved.

The five public files travel in one compressed bundle. The bootstrap extracts
the deploy script from that same bundle only after checking both archive and
script SHA256; it never forwards a second raw deploy-code base64 variable.
The previous duplicated public payload was160812bytes before private configuration,
exceeding Linux's single exec argument limit when drone-ssh concatenates exports
and script. CI reproduces that E2BIG failure using public bytes only, then proves
the single-bundle export command executes safely with apostrophes, dollar signs,
backticks and newlines preserved as literal configuration.

Before the SSH action connects, a step using the exact same YAML-aliased
environment measures the real quoted command length without printing values.
It refuses a command that cannot fit the Linux exec argument budget. This
preflight does not contact or mutate a host; the existing producer/consumer
receipts and all application/database guards remain unchanged.

For an identity-phase owned profile, the workflow holds the existing deploy
lease throughout producer and consumer. If the DR31 backup lease exists it also
holds that lease, preserving backup configuration/schedules while preventing a
simultaneous heavy restore or snapshot.

The producer requires the exact currently healthy owned runtime/profile/receipt
and historical authority anchor, current physical PostgreSQL pins, current
controls for every local UUID, an active local administrator binding, and a
bounded read-only Google account lookup. It performs an actual negative password
probe before stopping service. No Source inventory or session age is consulted.

It refreshes only the existing two-connection reader credential for an isolated
`staging-http` preview of the new OCI image. This preview has no mail/jobs, writer
URL, legacy secrets, Google certificate, or published ports. A private running
backup precedes stop. After the exact old runtime stops with restart disabled,
both existing runtime roles are fenced; a complete frozen backup and manifest
are taken. One transaction rotates their SCRAM credentials without changing
privileges or any business/identity row. Actual connection probes must reject
the old password and accept the new runtime/reader passwords.

Full hashes of all seventy business tables and all four identity tables must
remain equal across that transaction. Native password hashes, memberships,
disabled state, future cutoffs, bindings, sessions and challenges remain intact.
A new version-2 `owned-maintenance` receipt is valid for fifteen minutes and pins
the new image/source/profile, prior anchor, frozen state, private backup and
acknowledged COMMIT. The existing consumer enforces it before starting one full
owned runtime, validates HTTP readiness and physical/env pins, and persists the
actual healthy readback. No generic legacy rollback is available.

## Failures and recovery

The private attempt pointer and phase journals distinguish preview/backup,
stop/fence, COMMIT intent, acknowledged COMMIT, receipt preparation and actual
runtime readback. Automatic retries are refused until the previous attempt has
an independently verified successful anchor. A failed preview leaves the old
full runtime serving; its reader credential may have changed. After stop or any
ambiguous COMMIT, keep the old writer stopped and reconcile actual SQL/role/file
state before continuing. Never restart an old writer, reimport Source tables,
extend a receipt TTL or manufacture a fresh authentication timestamp.

The frozen custom dump is private root-0600 and is retained with its SHA256;
DR31 independently encrypts, transfers and rehearses the current authoritative
database. Maintenance does not change storage buckets, ACLs, SMTP/IMAP native
credentials, provider scopes, Google identity configuration, or paid resources.

Offline Python fixtures run locally. PostgreSQL regression runs only in CI with
the explicit disposable loopback URL/sentinel, covering a native user absent
from Source, complete row preservation, rollback and missing-control refusal.
This preparation does not itself authorize or claim a live maintenance rollout.
