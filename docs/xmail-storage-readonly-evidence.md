# Xmail storage evidence and remaining admission gates

This is a read-only observation from 2026-11-04. Production already uses R2;
the planned SQL/browser-identity change does not change the storage backend,
buckets, domain, public-access settings or object encryption.
No object content, message body, attachment body, raw object key, filename,
personal URL or credential was exported. No bucket/object/configuration was
created, changed or deleted. No new paid service or key was provisioned.

## Observed runtime and source

The real `xmail` production container on the existing host was pinned to image
`sha256:93c4f3284e452b518dfd7f7363152976cd1d1e3d1a28f76814b8a0ea9797b58d`.
Its ID, image and StartedAt stayed unchanged and health remained healthy around
each read. Runtime R2 configuration, not old Coolify settings or a local R2
configuration, selected the account/endpoint. Credentials stayed in memory;
the original `.env` was not changed.

The source PostgreSQL project was pinned to `zzbudkfkcmqkavgwselc`, using the
existing approved Supabase CA fingerprint, hostname verification, one bounded
connection and `REPEATABLE READ READ ONLY` with statement/lock timeouts. Only
storage metadata and SQL-projected reference fields were selected. Native
attachment JSON was projected inside SQL to `storageKey`/size; full JSON,
message bodies and recipients were not fetched.

| Observation | Count / bytes |
| --- | ---: |
| Source `storage.buckets` rows | 0 |
| Source `storage.objects` rows | 0 |
| Current R2 private-attachment objects | 523 / 4,383,950 bytes |
| Audited active attachment references | 518 |
| Unique referenced R2 keys present | 518 |
| Referenced R2 keys missing | 0 |
| Invalid reference size metadata / size mismatches against R2 | 0 / 0 |
| Objects without a reference in the audited set | 5 |
| Legacy-source attachment references | 0 |
| Current R2 branding objects / branding references | 0 / 0 |

The 518 references came from native message metadata. The audit also checked
the explicit inbox-attachment table, message storage-key projection and branding
storage references. Five objects lacking a reference in this set are **not**
proven disposable orphans. Do not delete or rewrite them. Listing/reference
reads were bounded to 10,000 entries and did not hit that bound.

These counts are a point-in-time observation; live mail ingestion can change
them. PostgreSQL reference reads share one snapshot. R2 listing and SQL do not
share an atomic snapshot, and matching a key does not prove body integrity,
successful decryption, complete historical reference coverage or candidate-DB
parity. No content/checksum download was performed. Preserve the existing R2
buckets and original references; there is no evidence here requiring a bulk
Supabase-to-R2 copy.

## Administrative privacy verification is limited

The relevant local Cloudflare API token was used only for HTTPS GET requests to
`api.cloudflare.com`, against the account derived from the real pinned runtime
and the two exact application buckets. Bucket metadata, managed `r2.dev` domain
metadata and custom-domain metadata all returned **403** for both buckets.
This says access was denied; it does not mean the buckets/domains do not exist.
Scopes, accounts, settings and credentials were not expanded or changed.

Anonymous HEAD requests to three real referenced existing private-object keys
on the unsigned S3 endpoint returned **400, 400, 400**. There was no anonymous
200, but these 400 responses do not establish privacy. No object GET or response
content download occurred. HEAD against the configured public base was skipped
because its binding to the intended branding bucket was not verified by
authorized Cloudflare metadata.

This administrative limitation alone is not a new blocker for the SQL/Auth
change, which preserves the existing storage backend and access configuration.
It also does not establish that private attachments are public. A future
administrative review should verify the private bucket's `r2.dev`/custom-domain
settings and the branding public-base binding. Actual evidence of an exposed
private attachment or an authorization regression would require remediation.
Cloudflare documents the managed/custom routes separately in its
[public-bucket guidance](https://developers.cloudflare.com/r2/buckets/public-buckets/).
An application credential capable of S3 reads does not itself prove the public
access configuration.

## Encryption and references remain unchanged

R2 documents provider-managed encryption at rest and TLS in transit in its
[data security reference](https://developers.cloudflare.com/r2/reference/data-security/).
This does not establish application-managed KMS envelope encryption. No KMS
key, permission, encryption/decryption call or billable resource was added.
The Google browser-identity runtime's read-only Firebase grant is not a KMS
grant and must not be broadened implicitly.

Additional encryption or object rewrites are not requirements of this SQL/Auth
change. Existing object locations and credential-encryption keys are preserved.
Any separately proposed content rewrite would need its own reviewed recovery,
integrity and conditional-reference plan; this receipt authorizes no copy/delete.
Private candidate reference parity remains part of the SQL snapshot admission.

## Owned-mode code gate (prepared, not activated)

With explicit owned browser authority, object operations require valid R2
credentials and a matching HTTPS Cloudflare R2 account endpoint. Missing or
invalid configuration fails closed before either SDK is contacted; it never
selects Supabase Storage. Existing legacy/default selection remains compatible.
A retained legacy adapter also refuses hosted operations after an authority
change. An owned public URL requires a safe configured HTTPS public base and
cannot take the historical Supabase-URL fallback.

Readiness adds authenticated `HeadBucket` requests to the two existing buckets,
with no object reads, writes, retries or new resources. SQL/Auth checks remain;
storage has an overall four-second bound, per-request deadlines, abort and
client cleanup, and static errors. Successful readiness proves availability,
not privacy, object-body integrity or decryption. Existing attachment handlers,
tenant/ownership authorization and native-mail contracts are unchanged.

The pinned live container's configuration passed the same destination/credential
shape checks. A standalone read-only check obtained authenticated `HeadBucket`
success for both existing buckets with these request bounds; the production
container remained unchanged and healthy. This is an availability observation,
not deployment of this code. Thirty focused unit/readiness tests passed locally,
including deadline abort, static errors, unsafe destination rejection and no
hosted fallback. Full types/build and the existing PostgreSQL suites run in CI.
