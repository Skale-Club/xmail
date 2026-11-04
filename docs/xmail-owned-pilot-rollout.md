# Owned-to-owned Google pilot rollout

`scripts/ops/prepare-xmail-owned-pilot-rollout.py` defaults to an offline plan.
The explicit root/Linux `--apply --enable-pilot` operation prepares a new pinned
deployment on the **existing owned database**. It never imports, restores,
truncates or drops Supabase business data. Browser/admin authority remains
explicitly legacy; this operator cannot perform the global identity cutover.

Supply exact approved application image/revision, current immutable container ID
and public deployment-policy SHA256. The operator reuses the reviewed first-data
operator's pinned public primitives, schema/grant checks and private file writes.
It verifies the private PostgreSQL image/volume/resources, current profile and
application environment, single writer, current owned schema and safe delivery
queue. The target image must contain isolated staging and previous-account proof
code and run as the approved UID/GID. Incorrect passwords must actually produce
PostgreSQL password-authentication rejection before the current runtime stops.

A fresh complete owned database backup, prior profiles/receipts/Google config and
pending new credentials are root0700/root0600 and fsynced before stop. The old
runtime then exits cleanly with restart disabled. A separate acknowledged fence
transaction sets the existing two app roles NOLOGIN and requires no remaining
database clients. No unknown connection is killed. No error path restarts OLD.

The authoritative UUID list comes from current owned `public.users`, including
users created after phase1. While browser authority remains legacy, a bounded
GET-only Auth Admin lookup checks each exact UUID in the original Auth project.
The request uses the existing server credential in memory only, never a browser
key, source public-user list, admin SDK, contact search or source database import.
There are at most1000 users, four concurrent requests, eight-second per-request
limits and a55-second hard client bound; responses are capped at64KiB. Any missing
or mismatched user/status refuses the rollout. Official endpoint behavior is in
the [Supabase Auth API specification](https://github.com/supabase/auth/blob/master/openapi.yaml).

One target transaction checks exact UUID coverage, inserts missing controls and
ORs new provider bans into local controls. Existing local bans, future cutoffs,
review provenance and active admin cutoffs stay intact. Active existing controls
are not reset to the current time. Sessions of banned users are revoked; no
binding, application user, native password or organization permission is created
or changed. The same transaction rotates existing runtime/reader credentials and
enables LOGIN with the original limits20/2; reader expiry is15 minutes.

Readback requires all70 business fingerprints/schema and existing binding and
challenge digests unchanged, session counts unchanged, conservative controls and
actual rejection of the old SQL credential. New runtime and reader credentials
must work. No raw credential is logged. Only then are the fresh sourceKind=owned
receipt chain and pinned profiles published, with Google pilot true and browser/
admin legacy. The consumer requires the old-credential rejection proof. The
existing preview/promotion consumer must run before the15-minute receipt/reader
window closes; preparing a profile alone does not start an application.

Private attempt/ack artifacts and pending profiles remain after failure or an
ambiguous COMMIT. Inspect actual state before recovery; do not reimport data,
auto-retry, weaken guards, extend expired proof without a new review or restore
the old credential/writer. The original Supabase business fence stays installed.

After the pilot serves, a person must independently link Google/SMS to the
existing admin and verify a real owned session. Only a later reviewed operation
with fresh admin acceptance may select owned browser/admin authority. Once that
authority is owned, local controls and Google are authoritative; a new owned
account need not exist in the transitional old provider. This pilot operator
deliberately refuses already-owned browser authority.
