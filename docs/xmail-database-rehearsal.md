# Xmail host-local PostgreSQL17 rehearsal

The reviewed host-local restore rehearsal passed; its aggregate result was reported
by the coordinator on 2026-11-03 at 22:19 UTC. Production configuration/schema and
application deployment were unchanged. Both scripts still default to an offline
plan; execution requires review and an explicit flag.
Existing eligible development Supabase targets are being inventoried separately;
the user rejected new paid projects/costs. This rehearsal creates no Supabase project.

## Verified live read-only baseline — 2026-11-03 22:12:31 UTC

The inventory connected from the running `xmail` container using its runtime source.
It pinned the expected Xmail project, exact direct/pooler user, database `postgres`
and accepted ports, rejecting unknown/duplicate URL options before removing URL TLS
parameters. The production process was unchanged. `NODE_ENV=production`, the identity
flag was false, and the read-only helper had a 35-second absolute process deadline.

The first exploratory collection used postgres.js `ssl:'require'`; that option turns
off certificate verification and was insufficient acceptance evidence. It was replaced
by a successful verified collection using the explicit public Supabase CA, pinned
SHA256, validity checks, `rejectUnauthorized:true` and exact hostname. No weaker TLS
fallback is implemented. The verified result supersedes that exploratory collection.

| Measurement | Verified result |
| --- | --- |
| Source PostgreSQL / database bytes |17.6 / 188,320,915 |
| Public tables / total relation bytes |70 / 172,728,320 |
| Tables with SELECT access / possibly RLS-filtered |70 / 0 |
| Connection role |not superuser; BYPASSRLS true |
| RLS-enabled public tables / public policies |69 / 161 |
| Policies directly referencing hosted schemas |38 |
| Application users / organization_users |39 / 38 |
| Public owned-identity tables |0 |
| Migration ledger |78 records, 001 through 078 |
| Public foreign keys outside public |0 |
| Non-extension public functions |8; all SECURITY DEFINER; hosted dependency `auth.uid()` |
| User triggers / public views |0 / 0 |
| Column defaults referencing hosted schemas |0 |
| Policy roles |authenticated, public |

Extensions are `pg_trgm` in public; `pgcrypto`, `uuid-ossp` and
`pg_stat_statements` in extensions; `supabase_vault` in vault; and `plpgsql`.
Installed extensions alone do not establish application dependencies. The eight
application helpers and policies still need deliberate authorization migration.
No function bodies, user rows, addresses, mailbox contents, passwords or keys were
printed. The snapshot contained only catalog measurements and aggregate counts.

The host capacity sample supplied by root was 3819 MiB total RAM, 1861 MiB
available, 389 MiB swap used and approximately 10.8 GiB free disk. This is a dated sample,
not a capacity reservation. The script rechecks limits before work and again before
starting the restore target. Coolify's existing PostgreSQL15 database is never used.

## Executed rehearsal and independent cleanup check

Root executed the reviewed shell once with an outer 420-second deadline and
15-second kill grace. The official PostgreSQL17 Alpine image was already present
and pinned to local ID
`sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`.
The command exited 0, had no stderr and did not time out. Its report contained:

| Aggregate result | Value |
| --- | --- |
| Restore |passed |
| Users / organization memberships / public tables |39 / 38 / 70 |
| Ledger count / latest |78 / 078 |
| Owned-identity tables |0 |
| Restore target network |none |
| Temporary resources removed |true, verified before releasing the report |
| Shared-snapshot source comparison |not performed |
| Auth cutover |not tested |

A second independent SSH check confirmed production `xmail` was running, its
observed image prefix `sha256:93c4f3284e45` remained the same, and zero containers
or temporary directories remained in the rehearsal label/path scopes. The host-local
archive and restored database were destroyed. This verifies a temporary public-schema
and ledger restore under the stated gates, not a retained backup, full immutable-ID/
content reconciliation or durable self-managed database deployment. No mail, campaign,
Telegram job, application migration or provider configuration was executed.

## Read-only launcher

`scripts/ops/xmail-database-rehearsal.mjs` loads no dotenv module and imports no
application/database pool. Its default/`--plan` mode reads no configuration and
starts no child process. Its only connected mode is:

```powershell
node scripts/ops/xmail-database-rehearsal.mjs --inventory --ssh-env-file C:\Users\Vanildo\Dev\xmail\.env
```

The launcher extracts only `HETZNER_IP` from that explicit file. SSH uses the existing
agent/default identity, BatchMode and StrictHostKeyChecking=yes; no key is exported
and the placeholder `HETZNER_SSH_KEY` is ignored. The source URL and credentials stay
inside the remote runtime. The inventory uses one REPEATABLE READ READ ONLY
transaction, 8-second statement limits and 500ms lock limits. It checks SELECT and
RLS visibility before accepting counts. Remote errors are reduced to safe stage/code
diagnostics, and the helper exits within 35 seconds even if the local 45-second SSH
deadline/disconnect cannot terminate a remote command.

## Reviewed rehearsal design

The separate shell script runs **on the existing Xmail host**, with an
already-present, approved immutable PostgreSQL17 image ID. It never pulls an image:

```bash
bash xmail-database-rehearsal.sh --plan
# Only after the script and execution window are approved:
bash xmail-database-rehearsal.sh --execute-reviewed-rehearsal --image sha256:<approved-local-image-id>
```

| Resource/boundary | Planned enforcement |
| --- | --- |
| Host capacity admission |at least 1536MiB available RAM, at most 512MiB swap used, at least 2GiB free in /tmp |
| Source connection |same fixed Xmail project, direct/session5432, CA+hostname verification; no transaction-pooler snapshot reliance |
| Source dump |libpq sslmode=verify-full, explicit CA; default_transaction_read_only=on, bounded statements/locks; pg_dump consistent serializable snapshot |
| Dump scope |public and migration ledger only; excludes Auth directory, Storage, vault and platform schemas |
| Archive |private 0700 temporary host directory, umask 077; custom archive hard limit 256MiB |
| Dump client |128MiB RAM, no swap, 0.5 CPU, 64 PIDs; shares existing xmail network solely to read source; no server/listener |
| Restore server |768MiB RAM, no swap, 0.5 CPU, 128 PIDs; network none, listen_addresses empty, no published port |
| Target data |512MiB tmpfs plus 8MiB socket/16MiB temporary mounts; read-only root filesystem; no persistent volume or source credentials |
| Privileges |non-root PostgreSQL user, all Linux capabilities dropped, no-new-privileges; image PostgreSQL major and UID/GID checked |
| Timeout |dump 150 seconds, restore 180 seconds plus five-second termination grace |
| Restore behavior |single transaction, exit on any error; TOC omits exactly one CREATE SCHEMA public entry, preserving all contained objects/data/constraints |
| Target readiness |final postmaster PID1 plus ready Unix socket; initdb temporary server cannot admit bootstrap |
| Cleanup |unique names + exact run-ownership labels; only own containers and validated mktemp directory removed; success withheld until Docker listing succeeds and is empty and directory removal is proven |

The target alone gets `authenticated NOLOGIN NOBYPASSRLS`, an `auth` schema and
`auth.uid()` returning NULL. Public execution is revoked. These objects let the
dump's existing policies/functions be reconstructed; they cannot authenticate an
identity, create an application account or grant provider claims. No app connects
to the target. This is **not** proof of an Auth cutover or usable RLS identity context.

The target gate requires exactly 39 users, 38 memberships, 70 public tables, 78 ledger
records ending 078, no invalid FK and no owned-identity tables. Existing UUIDs,
native password hashes and encrypted fields are intended to be copied as data
without rewriting; their complete integrity has not been verified by this plan.
No migration 079/080 is applied. The archive and private diagnostics never leave
the host. Credentials use remote memory/stdin with no separate env file, argv or
log; Docker retains the dump client's ephemeral environment metadata until cleanup.
The success report is captured with quiet psql, cleanup is explicitly verified,
and only then is aggregate JSON with temporaryResourcesRemoved=true printed.
Failure traps retry cleanup without claiming that removal succeeded.

## Evidence limits and acceptance still required

The inventory/pre-dump checks and pg_dump do **not** share an exported snapshot.
Each collection is internally repeatable and pg_dump is internally consistent, but
production can write between them. The 39/38 target gate is a preservation check
against the approved baseline; it is not exact all-row fingerprint reconciliation.
No source/dump fingerprint equality is claimed. A future full-fidelity rehearsal
must hold an exported snapshot on direct/session5432 through dump completion and
derive source aggregates/fingerprints from that same snapshot, or perform the final
copy during a coordinated write pause. Sequence changes also require explicit
reconciliation. The actual rehearsal evidence above is limited accordingly.

Local checks here are five offline Node policy/syntax tests, Bash syntax validation
and both default plan modes; CI now repeats these offline checks. Heavy build/tests
remain CI work. Independent
review found the selected-public-schema restore conflict; the TOC now removes only
the schema-creation entry and keeps strict restoration errors. No error is ignored.

Primary references: [PostgreSQL17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html),
[Docker runtime resource constraints](https://docs.docker.com/engine/containers/run/),
[Supabase Studio public CA URL declaration](https://raw.githubusercontent.com/supabase/supabase/master/apps/studio/hooks/custom-content/custom-content.json).
The accepted public CA SHA256 is
`807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`.
