# Private database connection budget preparation

The prepared `xmail_runtime` role is still `NOLOGIN`, with `CONNECTION LIMIT 20`.
Preparing code does not enable login, change passwords/roles, or cut over a
database. A declared connection budget is a startup admission check, not a load
test or proof that a production deployment is ready.

The full runtime currently declares these pools:

| Pool | Existing default | Role/process |
| --- | ---: | --- |
| HTTP/shared queries | 20 | Main application; also used by identity, SMTP/IMAP and foreground work |
| Background jobs | 12 | Main application, separate transaction client |
| Owned user administration | 2 | Lazy private pool, created only for an owned administrative action |
| Isolated staging HTTP | 2 | Separate process and `xmail_staging_reader` role; does not import the production server |

Identity reuses the HTTP client and adds no independent SQL pool. The full
application's potential runtime demand is therefore **34 per process**, plus
operational reserve. Staging's two belong to its different role, not to the
runtime's limit 20. PostgreSQL's total cluster budget must still include both.

`DB_POOL_MAX` keeps its existing HTTP default 20. `DB_JOB_POOL_MAX` now makes the
existing job default 12 explicit/configurable; it is not silently reduced. The
existing code records a measured peak of ten concurrent jobs plus two headroom,
so a reduction needs workload evidence. `XMAIL_ADMIN_DB_POOL_MAX` defaults to two
and permits one or two. All declared sizes must be positive finite integers.

The budget is enforced when either SQL target uses `xmail_runtime`, browser
authority is explicitly owned, or `XMAIL_DB_ROLE_CONNECTION_LIMIT` is declared.
The reviewed role ceiling is at most 20. `XMAIL_DB_CONNECTION_RESERVE` defaults to
two and cannot be smaller; `XMAIL_DB_PROCESS_COUNT` defaults to one and must count
every simultaneous application process, including deployment overlap.

The admission formula is:

`(HTTP + jobs + admin) * simultaneous_processes + reserve <= reviewed_role_limit`

For example, an explicit declaration of four HTTP, twelve jobs and two admin
connections totals 18, with two reserved slots under limit 20. This arithmetic
example is **not an approved production size**: HTTP/native/identity throughput,
job behavior, failover and actual connection use still need testing. The same
declaration for two overlapping processes fails closed. No role limit is raised
and no application pool is shrunk automatically to make the formula pass.

Private runtime HTTP and job targets must identify the same host, port, database
and `xmail_runtime` role, without URI option overrides. This prevents a future
`DATABASE_URL` cutover from leaving `DIRECT_URL` jobs writing the old Supabase
database. Matching targets may use separate reviewed credentials without exposing
them; errors never print URLs/passwords. Legacy Supabase HTTP/direct target pairs
remain supported under their existing explicit development/production selection.

Remaining concrete gates for an actual provider exit:

- Server SDK import and selected-provider readiness have a separate prepared
  boundary in `xmail-owned-startup-readiness.md`; legacy Storage use still remains.
- `src/server/lib/object-storage.ts` still chooses Supabase Storage when R2 is
  absent. SMTP/MX, sync and attachment routes use this interface. Existing object
  inventories, private downloads and public branding must be preserved before an
  explicit storage cutover; missing R2 settings cannot imply a completed exit.
- Owned invitation/onboarding, reviewed recovery, self-service credential
  management and destructive deletion still return explicit unavailable states.
- Owned SSE has a separate bounded, revalidated preparation in
  `xmail-owned-streams.md`; production workload/capacity remains unverified.
- Candidate/runtime activation, actual role/cluster counts, replica/rollout
  strategy, workload validation and backups remain operational work. No LOGIN,
  reimport, flags or deployment is performed by this budget preparation.
