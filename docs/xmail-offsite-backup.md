# Xmail: encrypted copy of the reconciled snapshot on an existing second host

Status: the reviewed controller completed one real encrypted off-host copy and
byte-exact decryption proof. An independent read-only SSH audit on 2026-11-04 at
02:20 UTC verified the published artifact and metadata described below.

The controller is `scripts/ops/xmail-offsite-backup.mjs`. Default and `--plan` are
offline. `--self-test` exercises the orchestration/proof guards with mocked SSH.
It requires existing native Node/OpenSSH on the controller, its existing SSH agent
and trusted known-host entries. It does not install anything or forward the agent.

```powershell
node scripts/ops/xmail-offsite-backup.mjs --plan
node scripts/ops/xmail-offsite-backup.mjs --self-test
# After code review and explicit execution authorization:
node scripts/ops/xmail-offsite-backup.mjs --execute
```

The fixed source is host `49.13.197.250`, bundle
`/opt/xmail/backups/candidate-20261103T232409Z-3654333.CTKbuKFN`.
Its `snapshot.dump` is 23,009,087 bytes, SHA-256
`a78f4b001411b10d6a050e403194107d391e46626ebdcd79f0aedd9562b5671a`.
Read-only inspection found `candidate_committed_and_reconciled`, 70 public table
counts, four digest groups, exported repeatable-read, and application cutover false.
The source dump and receipts remain unchanged. No database export or writer freeze
is part of this operation.

The separate target is `188.245.112.3`, accessed with strict host-key checks.
Both remote programs verify their SSH server IP and root identity. A fresh
read-only admission requires at least 256 MiB free. `/opt/xmail/offsite-backups/v1`
and its directories must be root-owned 0700 without symlinks; files are 0600.
Unrecognized existing state and an already published archive stop execution.

The target creates or verifies one independent RSA-3072 recipient key/certificate
under `recipient/`. The private key stays there, under the existing host's accepted
root custody. Only its public certificate and DER fingerprint cross to the source,
in memory. These keys are independent of the Google runtime CAs and source host.
Published recipient keys are retained on failure. Loss of that key loses access
to the encrypted copy; a separate key-escrow/rotation policy remains a gate.

The source encrypts the existing dump using CMS AuthEnvelopedData, AES-256-GCM and
RSA-OAEP SHA-256/MGF1 SHA-256. OpenSSL's `-stream` emits an indefinite-length BER
CMS envelope, accepted by `-inform DER`. Binary mode preserves the dump's bytes.
Native Node pipes source SSH stdout to target SSH stdin with backpressure; neither
plaintext nor ciphertext is logged, buffered as a whole, or written on Windows.
The target bounds ciphertext to 32 MiB and fsyncs its exclusive staging file.
[OpenSSL CMS reference](https://docs.openssl.org/3.0/man1/openssl-cms/)

Publication requires successful source encryption/unchanged-source proof and a
complete receiver. The target verifies cipher checksum and CMS algorithms, then
decrypts into an exclusive private staging file. It accepts no plaintext until
OpenSSL returns zero after AEAD tag validation. It then checks the exact source
size/SHA-256, removes the temporary plaintext, fsyncs a receipt, and atomically
publishes the directory with Linux `renameat2(RENAME_NOREPLACE)`. A successful
controller result is emitted only after publication and directory fsync.

Failure cleanup is limited to nonce-owned staging/lock directories, explicit
allowed filenames and verified root modes/markers. It never removes a published
archive or recipient key. Unknown/stale locks require review. A lost acknowledgement
can leave a valid published archive; it must be inspected, not overwritten on retry.
Raw SSH, OpenSSL and remote errors are suppressed; failures return a static error.

## Recorded live proof and independent verification

The controller's completed execution reported authenticated decryption, byte-exact
recovery, publication and receipt fsync. The separate SSH audit verified both
server IP pins, recomputed the source/ciphertext hashes and the public recipient
certificate fingerprint, and inspected only file metadata and allowed receipt
fields. It did not repeat encryption/decryption, export a database or restore PG.

| Artifact | Verified bytes / SHA-256 |
| --- | --- |
| Original `snapshot.dump` | 23,009,087 / `a78f4b001411b10d6a050e403194107d391e46626ebdcd79f0aedd9562b5671a` |
| Published `snapshot.dump.cms` | 23,032,183 / `78a2f0f08c4a9a24104e37a396e75f7c84022493c8f520e257a1e1e1fde23e1d` |
| Recipient public certificate DER | `2efbf3fc906a50317413cb6994842229b81062897a3d3849dd3f835abbdfa0cb` |

The published directory is
`/opt/xmail/offsite-backups/v1/archives/candidate-20261103T232409Z-3654333.CTKbuKFN`
on the target. Its `receipt.json` reports AuthEnvelopedData, AES-256-GCM and
RSA-OAEP-SHA256, with `aeadVerified`, `recoveryByteExact`, `published` and
`receiptFsynced` true. `newPgRestore`, `r2Backup`, `dailySchedule` and
`applicationCutover` remain false.

All six inspected target directories were root-owned 0700 without symlinks.
All four published files plus the recipient key/certificate were root-owned 0600
without symlinks. There were zero staging/recipient-staging directories, operation
locks or `plaintext.partial` files. The original source directory remained 0700
and its dump root-owned 0600, with the exact original size/hash. Its import receipt
still says `candidate_committed_and_reconciled`, cutover false and
`offHostBackup: not_verified`: it was intentionally preserved. The new off-host
evidence is the separate target receipt, not a rewritten original import receipt.

Both application containers were running and healthy on the original image IDs:
Xmail `sha256:93c4f3284e452b518dfd7f7363152976cd1d1e3d1a28f76814b8a0ea9797b58d`
and XmartMenu `sha256:06645e194800d6ed0ef8e2e729991affd14c6bec057a1e98e71359062d4a58b6`.

The result proves an off-host encrypted copy whose decrypted bytes match the
snapshot already restored and reconciled earlier. It does **not** prove another
PostgreSQL restore, daily scheduling, retention, R2 backup policy, current live-data
coverage or application cutover. App containers, images and connections are untouched.
