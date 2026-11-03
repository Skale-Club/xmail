# Private candidate database roles

The migration owner is not the application's connection role. Preparation is
additive on the reconciled private candidate, never the Supabase source.

`prepare-xmail-runtime-roles.sh` defaults to an offline plan. Its explicit
`--prepare-reviewed-candidate` operation verifies container
`e12scyfsrp822dag7m9wwd4x`, the healthy pinned PG17 image, private port, persistent
volume and exactly one committed/reconciled import receipt before applying
`xmail-runtime-role.sql`. SQL additionally checks database `xmail`, owner
`xmail_owner`, PG17 and absence of either role. It refuses reuse or rotation.

| Role | Allowed | Initial login |
| --- | --- | --- |
| `xmail_runtime` | Public-table SELECT/INSERT/UPDATE/DELETE, sequence use and application functions | Disabled |
| `xmail_staging_reader` | Public-table SELECT only; two connections; read-only transaction default | Disabled |

Both roles have BYPASSRLS because the copied Supabase policies depend on
`auth.uid()`, which deliberately returns NULL in the private server. They are
trusted server roles; application authorization must continue to scope every
organization operation. Neither role is a superuser, replication role, database
owner or role administrator. They cannot create schema objects or truncate
tables, and the staging reader cannot execute public functions, including
SECURITY DEFINER writers. PUBLIC database CREATE/TEMP and public-schema CREATE
are revoked. Future owner-created tables, sequences and functions inherit the
same grants. Explicit grants by later migrations still require review.
The function EXECUTE default is revoked globally for the migration owner: a
schema-only revoke would leave PostgreSQL's global PUBLIC default effective.

The CI integration test uses a dedicated loopback PG17 database and real
nonsuperuser connections. It exercises DML under deny-all RLS, forbidden DDL,
TRUNCATE, owner escalation, migration-ledger access, staging writes even after
disabling its read-only session default, a SECURITY DEFINER writer, future
grants and refusal to rerun. It never reads `.env` or `DATABASE_URL`.

Preparation creates no passwords and changes no app URL. Enabling LOGIN requires
separately reviewed secret generation and protected storage, followed by real
authentication/network/privilege checks. Staging HTTP probes and production
cutover remain separate gates.

## Execution evidence — 2026-11-03

The PG17 CI integration test passed at commit
`51745c9f40462ffd782a014f4dc5cdbab72016b9`, with one runtime-role test and zero
skips, after all 11 identity-store tests passed:
[Actions job](https://github.com/Skale-Club/xmail/actions/runs/41740247275/job/126280243666).
The new future SECURITY DEFINER writer was denied to the staging reader;
the runtime's explicitly granted function execution remained available.

The reviewed preparation then ran successfully on the exact private candidate.
A separate READ ONLY catalog probe confirmed both roles remain NOLOGIN,
NOSUPERUSER, NOCREATEDB, NOCREATEROLE and NOREPLICATION, with zero memberships.
Connection limits are 20 for runtime and 2 for staging. Staging INSERT, database
CREATE and public-schema CREATE were false; it can execute zero public
functions. Runtime TRUNCATE was false. A transaction using
`SET LOCAL ROLE xmail_staging_reader` read 39 users, 38 memberships, 37 nonempty
native password hashes and 1 platform administrator. These aggregate values
match the committed import receipt; no customer rows or hashes were emitted.

No login password has been generated, no app URL changed and no source write
performed. This proves candidate role preparation and database privileges,
not a separately authenticated TCP connection or an HTTP staging boot.
