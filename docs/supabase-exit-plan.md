# Supabase exit plan — Skale Club applications

Date: 2026-11-03, America/New_York.
Status: phase 0 started; Xpot development database separation in implementation. No production changes under this plan.
Program home: this document in Xmail. Implementation and operational evidence belong to each application's repository.

## 1. Objective and scope

Remove Supabase as a production runtime dependency across the principal applications. Retain Supabase PostgreSQL as the development database: npm run dev must read and write the explicitly configured development project. Adopt Google Identity Platform/Firebase Authentication with phone/SMS as the primary entry and Google as the alternative in both environments. Retire email/password and email-link login. Keep production application data in self-managed PostgreSQL and files in independent object storage.

User amendments: Supabase is allowed and desired for development databases. Use Google Cloud project skaleclub by default, unless a suitable specific project is already configured. Keep local work light: one task/test process at a time, no local Docker databases, no portfolio-wide builds or parallel agents. Delegate expensive build verification to each repository's existing remote CI when available; focused local checks remain sequential.

Email addresses remain business data where needed: contact information, billing, notifications, invitations and mailboxes. Xmail's SMTP/IMAP mailbox authentication and Outlook integration are separate protocols; changing platform login must not disable them.

In scope: Xpot, Xkedule, Xmail, Xpend, Xcraper, Xpeed, Stuscle, Xareable, XmartMenu, Xtimator, Xphere, Xplore, Skale Club and the Apps Dashboard in skaleclub-apps. Alternate worktrees are not additional products. Inventory public sites and auxiliary services during discovery; add any actual Supabase consumers to the register before program closure.

This plan authorizes no bulk account deletion, source database reset or automatic destruction of retired projects. Migration execution follows the user's ongoing instruction to finish the program, with validated, reversible cutovers before final resource retirement.

## 2. Evidence baseline

The initial assessment examined tracked source and repository documentation, not a live audit of deployed configurations. Before execution, verify the production image, environment, database target, migrations and resource inventory for each app. Documentation stating that a backup exists is not proof of a successful restore.

At the planning snapshot, local HEAD, local main and fetched origin/main agreed on the commits below. Working branches and unrelated working changes were retained. No push or deployment was performed to align repositories. Re-fetch and record the actual baseline before each implementation; these SHAs are historical evidence, not frozen release targets.

| Repository | Baseline commit | Current state and remaining scope |
| --- | --- | --- |
| xpot | e6feb84646d2 | Self-managed PostgreSQL and Google phone/Google login. Supabase public Storage, private fallback and mandatory configuration remain. |
| xkedule | b7f2f5b46897 | Self-managed PostgreSQL. Supabase Auth, invitations and residual storage/configuration need replacement. |
| xmail | 5cc007855df8 | Supabase PostgreSQL via Drizzle, Auth and storage fallback. Existing organization access checks are in application code. |
| xpend | edb5e0045aad | Supabase PostgreSQL via Prisma, Auth and private statement storage. |
| xcraper | f371b06d48e9 | Supabase PostgreSQL via Drizzle and Supabase token verification. |
| xpeed | db3e57004422 | Google phone/Google login implemented. Supabase Data API, PostgreSQL, Storage, functions and temporary legacy-auth compatibility remain. |
| stuscle | 9c3d082f33a3 | Production PostgreSQL and R2 independent of Supabase. Development DB remains on Supabase. Medusa email/password and optional Google differ from the target login. |
| xareable | ef85405ee58f | Supabase DB/Auth; R2 implemented with Supabase file fallback. |
| xmartmenu | e5b1fb54ddc5 | Supabase DB/Auth/Storage, SQL RPCs and Realtime. Admin email/password and Google; customer email OTP. |
| xtimator | d9e622e78085 | Supabase DB/Auth, RLS, RPCs, Realtime and files. S3/R2 abstraction exists but does not prove completed storage migration. |
| xphere | eb6080001f15 | Supabase Data API, Auth, RLS, Realtime, Storage, Edge Functions and pgvector. Broadest platform coupling. |
| xplore | 106c439c27af | Supabase PostgreSQL/Auth, email/password and SSR sessions; user ownership enforced with RLS. |
| skaleclub | c3d804caf5a0 | Supabase Auth and residual data/file consumers. Confirm live PostgreSQL host; direct SQL support does not prove where production data lives. |
| skaleclub-apps | 2669c46dc026 | Dashboard uses Basic Auth; optional Supabase metrics/history consumers require runtime inventory. |

Unrelated changes observed during alignment include Xkedule planning notes, Xpeed launch configuration and rc-car/, and Skale Club business-card references. Preserve these and all subsequent user changes. Existing dev and feature upstreams may differ from origin/main; equal source commits do not imply every remote branch was updated.

Primary source references:

- [Xpot identity](https://github.com/Skale-Club/xpot/blob/main/docs/auth/google-identity.md) and [README](https://github.com/Skale-Club/xpot/blob/main/README.md).
- [Xpeed identity](https://github.com/Skale-Club/xpeed/blob/main/docs/auth-google-cloud/README.md).
- [Xkedule database migration](https://github.com/Skale-Club/xkedule/blob/main/docs/runbooks/db-to-hetzner.md).
- [Stuscle databases](https://github.com/Skale-Club/stuscle/blob/main/docs/DATABASE.md) and [Medusa configuration](https://github.com/Skale-Club/stuscle/blob/main/apps/backend/medusa-config.ts).
- [Xtimator file migration](https://github.com/Skale-Club/xtimator/blob/main/docs/STORAGE-MIGRATION.md).
- [Shared infrastructure record](https://github.com/Skale-Club/skaleclub-apps/blob/main/COOLIFY.md).

Old shared-host records describe an 80 GB constraint and discourage local databases. The user's self-managed database direction supersedes that placement recommendation; verify actual capacity and update the infrastructure record during implementation instead of assuming the old numbers are current.

## 3. Target architecture and identity contract

### Authentication and accounts

- Use the existing Google Cloud identity project as the initial reference; verify provider settings, billing, authorized domains and shared hooks before extending it. Keep OAuth clients/app registrations separate per product and platform. Separate OAuth clients do not isolate the identity directory or application permissions.
- Keep organizational tenancy in each application. Do not map application organizations onto Identity Platform tenants as part of this change. Preserve Xpot's customer/team boundaries and all other role boundaries.
- Show phone/SMS first and Google second. No email/password, email OTP or magic-link authentication in the final product.
- Keep an immutable application user ID and an explicit binding from verified provider project/issuer and subject to that ID. Phone is a verified, mutable login attribute, not a primary key. Never use a phone number or email as the sole durable foreign key.
- Match Xpot's protection for existing accounts: first association requires verified ownership; matching an email alone never claims an account. Inventory Google-only and email-only accounts before choosing their migration path. Phone-primary UI does not by itself require every Google user to supply a phone: record that onboarding rule per product in phase 0, retaining already-correct Xpeed behavior unless a change is necessary.
- Existing users prove ownership through a still-valid legacy session plus the new identity, an already-linked provider, a verified phone already bound to the account under the product's access rules, or a documented operator-assisted recovery process. Ambiguous matches enter a reconciliation queue; never merge automatically by email or an unverified profile phone.
- Email-only users must have an accessible transition/recovery path before legacy login is disabled. Preserve UUIDs, memberships, approvals, purchases, credits and file ownership.
- Require recent verification to change phone or bind/unbind Google. Define lost-phone recovery, recycled-number handling, duplicate identities, blocked accounts, unlinking, account deletion and session revocation. Sensitive/admin access needs stronger recent verification appropriate to the product.
- Validate signed Google tokens server-side against expected issuer, audience, expiry and allowed provider. Do not treat provider claims as app roles. Derive roles from the app DB.
- Use per-app secure HttpOnly cookies for web sessions where supported, following Xpot's backend-session model. Define explicit token/session handling for Android and machine clients. Preserve CSRF/origin checks, rate limits and tenant resolution. Logout must clear private client caches and invalidate the appropriate server session; define all-device revocation separately.
- Share the protocol and acceptance tests first. Avoid introducing a new central login gateway or a new shared package during the pilot; extract reusable implementation only after two applications validate the contract.

### Data, files and background processing

- Use supported PostgreSQL versions compatible with each source and extension set. Keep each application's database and credentials separate; infrastructure may be shared only after capacity and failure-domain review. No public database ports.
- Keep current ORMs where present. For Data API applications, introduce server-side query/repository boundaries incrementally, preserving transaction behavior and authorization. Browser clients must never connect directly to PostgreSQL.
- Preserve RLS protection where it currently enforces tenancy. With direct SQL, supply verified transaction-local identity context to policies or implement equivalent server authorization before switching each route. Connection-pool reuse must not leak one user's context to another. Do not disable policies as a shortcut.
- Replace Supabase-specific identity/storage schemas and helpers deliberately; retain useful plain SQL functions, constraints, triggers and pgvector. A dump alone does not remove PostgREST, auth.uid() or auth.users dependencies.
- Store files in R2 or equivalent independent S3-compatible storage: private by default, signed access for private objects, public delivery only for intentionally public assets. Authorize upload/download server-side. Preserve references with redirects, application URLs or an audited rewrite.
- Move Edge Functions to app routes or isolated workers, preserving authentication, timeouts, retries and idempotency. Replace Realtime with authenticated SSE, WebSocket or bounded polling according to the actual feature. Keep existing unrelated queues/providers where suitable.
- Keep machine authentication, MCP/OAuth clients, cron jobs, webhooks and service-to-service permissions distinct from interactive login.
- Production, staging, development and test databases must be separate. Use explicit development Supabase connection settings before migrations or connections; never fall back to production URL aliases. Keep compatible PostgreSQL schemas across Supabase development and self-managed production, without coupling application identity to Supabase Auth. A local write changes only the development database. Production snapshots are separate, explicit operations and must suppress email, campaigns, billing and other external side effects; never auto-copy live data merely because npm run dev was invoked. Prefer isolated per-app development projects; inventory shared development schemas before migrating them.

## 4. Execution phases and dependencies

Phases are sequential by default. Each application uses its own isolated codex/ branch or worktree, follows its AGENTS.md/CLAUDE.md and migration conventions, and ships reviewable increments. Do not combine identity, database and file cutovers in one release. No auto-deploying push is needed for planning.

### Phase 0 — verify live state and size the destination

Deliverables:

1. Per-app execution dossier: source commit and deployed SHA, topology, Google/Supabase projects, DB version/size/growth, migrations/extensions, active users, missing/duplicate phones, roles, service keys, Storage buckets and persisted URLs, SQL RPCs, RLS policies, functions, Realtime channels, jobs and client versions.
2. Infrastructure measurements: free RAM/CPU/disk, volume growth, connections/IO, backup storage and restore duration. Produce a placement and monthly cost model covering DB hosts, R2, SMS, monitoring and backup retention. Do not place every new database on the existing shared host by default.
3. App-specific recovery point and recovery time objectives. Use daily backups plus pre-cutover snapshots as the minimum; enable WAL archiving/PITR where daily loss exceeds the objective, especially for mail, orders and financial data. Test one real restore per destination design.
4. Identity migration/cohort rules, including Google-only accounts, invitations, owners/admins and recovery. Determine SMS regions from actual users rather than inheriting the current US/BR allowlist blindly; account for PT and other supported countries.
5. A per-app dependency inventory and estimates based on measured scope. Dates are assigned after this phase; do not promise a portfolio completion date from repository inspection alone.

Exit: each app has a known source, reachable target design, ownership migration path, measured storage needs, test strategy and rollback procedure. Track unknowns explicitly instead of treating them as complete.

### Phase 1 — close the reference implementation: Xpot

Keep the working phone/Google login, approvals and private team/customer sessions. First protect development migrations and connections with an explicit Supabase development target. Inventory all public and private Supabase objects; copy and reconcile production files into R2, update references, remove production fallback and required Supabase boot variables, and retire dead frontend/configuration paths. Prove production boot, login and all file operations with Supabase unavailable. Retain the isolated Supabase development database.

Exit: Xpot is the first end-to-end reference with no production Supabase dependency and a verified Supabase development database; the identity/data/file test matrix is reusable.

### Phase 2 — migrate Xkedule authentication

Keep its current production PostgreSQL. Integrate phone/Google identities and existing app sessions, including tenant domains, custom domains, staff invitations, customer ownership, role selection and super-admin recovery. Retire Supabase Auth and residual file consumers. Confirm external backup status rather than relying on the old runbook's local-only backup record.

Exit: owner, staff and client journeys work across distinct tenants/domains; existing bookings and account IDs are preserved; password login is retired after reconciliation.

### Phase 3 — direct-SQL applications: Xmail, Xpend, Xcraper

Execute in that order by default. For each: implement and validate identity bindings, cut over authentication, provision/restore PostgreSQL, cut over data, then close files and remaining dependencies in distinct releases. Preserve Drizzle/Prisma instead of changing ORM during migration.

- Xmail: preserve access.ts organization boundaries, multi-account behavior, native mailbox users/ownership, encrypted credentials and encryption keys, SMTP/IMAP/MX, UID allocation, queues, tracking, agent scopes and health/deploy probes. Drain or explicitly queue inbound mail and suspend writers/jobs before the final copy; reconcile received mail before resuming. Rehearse raw mail ports as well as HTTP. Read the Hermes system map before changing any affected prospecting path; update its canonical docs if behavior changes.
- Xpend: preserve statement privacy, file access, balances, transactions, imports, extraction/AI jobs and deduplication. Reconcile financial totals, not just row counts.
- Xcraper: preserve credit balances/ledger, search history, contacts, active searches and service integrations; prove retries do not double-charge.

Exit: production core flows and reconciliation pass per application, including restoration, with Supabase unavailable; development uses its isolated Supabase database.

### Phase 4 — Xpeed, Stuscle and Xareable

Execute as separate application migrations:

- Xpeed: keep phone/Google login; introduce backend data access replacing Data API/RPC authentication; migrate PostgreSQL, objects and Edge Functions. Preserve vehicle/trip IDs, reports, processing, AI, MCP and OAuth. Migrate SQL authorization before removing Firebase-to-Supabase role compatibility. Validate Android/web and offline synchronization; publish a supported Android version and define a minimum-version policy before closing legacy sessions/endpoints.
- Stuscle: retain the isolated Supabase development DB and verify the development/production guards. Implement Identity Platform as a Medusa-compatible identity provider/adapter, retaining Medusa actor authorization and customer/admin separation. Preserve carts, orders, guest checkout, Stripe identities, refunds and customer records. Retire Medusa email/password only after customer and admin replacement/recovery flows pass.
- Xareable: replace Supabase verification and DB target; complete R2 migration and remove fallback. Preserve asset privacy, quotas/credits, scheduled publishing and third-party social account OAuth, which is separate from platform login.

Exit: each product has no production Supabase dependency, retains its Supabase development DB and preserves native/mobile/commerce behaviors.

### Phase 5 — deeper platform consumers: XmartMenu, Xtimator, Xphere

For each, inventory and replace the data boundary feature by feature before database cutover. Keep old and new paths selectable during rehearsal with one authoritative writer; no ad-hoc dual writes.

- XmartMenu: cover customer email OTP, admin/staff login, tenant roles and waiter access; move images, SQL order transactions, Realtime waiter calls and OAuth integrations. Preserve menus, active orders, restaurant boundaries, subscriptions and Xphere sync.
- Xtimator: cover phone/Google, organization memberships and invitations; move query/RPC authorization, Realtime notifications and storage browser uploads/reads. Reuse existing storage abstraction only after proving all call sites honor it. Preserve estimates, PDFs/shared links, price books, WhatsApp/media, credits, Stripe and Inngest processing. Reconcile previously persisted Supabase URLs.
- Xphere: migrate domain slices behind server repositories, preserve active organization per tab and all API-key scopes, pgvector/search, SQL functions, Storage, Realtime and embedding workers. Verify each connected integration and org boundary. Do not attempt a global client replacement or database-only dump as the complete migration.

Exit: acceptance evidence covers every inventoried platform service, not only login and health checks.

### Phase 6 — Xplore and internal systems

- Xplore: replace SSR login, user provisioning/deletion, RLS ownership and query paths; preserve game libraries, progress, avatars and public/shared catalog behavior.
- Skale Club: confirm DB location, replace Auth and file consumers, preserve administrator restrictions, OAuth integrations, public pages and lead intake.
- Apps Dashboard: replace Basic Auth with restricted Google-backed staff access under the common phone/Google contract. Replace any enabled Supabase history/disk consumers. Preserve independent infrastructure probes so app login failures do not suppress incident detection.
- Re-scan auxiliary repos, deployment workflows, cron monitors and shared infrastructure for active Supabase consumers. Register and migrate any omitted service before claiming portfolio completion.

### Phase 7 — observation, retirement and cost closure

Keep each app under observation for at least seven days after its final cutover, including a real scheduled job and backup cycle; extend to fourteen days for Xpeed's client rollout and Xphere's integration breadth. Check slower periodic jobs with controlled executions rather than waiting silently for a monthly cycle.

Record old-project traffic and classify production consumers separately from approved development usage. Once the exit criteria pass, disable legacy production consumers and keep an immutable independent archive and audit record. Revoke obsolete production credentials, remove production deployment/build/monitor variables and keepalives, update docs and remove unused SDK/runtime dependencies. Retain the keys, projects and settings needed by isolated development databases. Never repurpose a source production project as development until its production consumers and rollback role are retired. Delete genuinely unused hosted projects only after data retention and account reconciliation are complete and that destructive action is explicitly authorized.

Exit: production runtime and production recovery no longer require Supabase; approved development usage remains operational and costed. CI uses disposable databases or isolated test targets. Paid resources/subscriptions are accounted for and obsolete ones retired when authorized. Check actual invoices/usage against the phase-0 cost model.

## 5. Required procedure for every production cutover

1. Capture source/deployed commits and target configuration references without exposing secrets. Confirm unrelated local work is preserved and CI passes for the release.
2. Rehearse migrations and restore into a disposable isolated target. Compare IDs, row counts, key totals, constraints, sequences, functions and sampled content; validate files by manifest/checksum, permissions and working links.
3. Complete app-specific browser/API/data flows in staging. Test forged/expired identity tokens, blocked/unapproved users, cross-user/tenant access, invitations and recovery. Test Google and a real permitted SMS flow where available; test numbers alone do not prove carrier delivery or physical Android behavior.
4. Measure the final-copy duration, publish the expected maintenance behavior and confirm external monitoring. Validate a recoverable backup and preserved encryption keys. Establish one authoritative writer.
5. For auth cutover, deploy additive account mappings and run a controlled legacy transition. For data cutover, suspend/drain all writers, jobs and webhook ingestion or queue them durably; take the final copy, reconcile, switch the DB target, verify and resume. Treat a webhook's acknowledged delivery as data that must be preserved.
6. For files, copy first, verify manifests and references, switch reads/writes, then verify old links and private authorization. Retain source objects through the observation period.
7. Collect production smoke evidence and error/latency/job/credit/SMS metrics. Revert on identity/tenant boundary failure, missing data/files, persistent core-flow failure or exceeded predeclared recovery thresholds. Record precise numeric thresholds in the app dossier before cutover.
8. Rollback before new writes may use the old target. After new writes, do not simply point back to a stale DB: freeze writers and reconcile/replay the new changes or repair forward, preserving queued events and idempotency. Keep old images compatible with additive schema changes during the transition.

## 6. Completion criteria and evidence

An application is complete only when all applicable items pass:

- [ ] Live production configuration and baseline recorded; new image SHA verified.
- [ ] Phone-first and Google-alternative login work; legacy email login is retired.
- [ ] Existing accounts, roles, memberships and recovery paths reconcile without accidental duplicate ownership.
- [ ] PostgreSQL and files operate independently; all required functions, jobs and real-time features are replaced or retained independently.
- [ ] Cross-tenant/user tests, browser-to-API-to-data flows and product-specific regression tests pass.
- [ ] Backup restore demonstrated against the declared recovery objectives; development/tests cannot write production.
- [ ] Production boots and core flows succeed with Supabase unavailable; production telemetry shows no required Supabase calls. npm run dev reads/writes only its approved Supabase development DB.
- [ ] Repository scan reviewed: remaining mentions are historical migrations/docs/fixtures or explicitly approved development database configuration, not production runtime or recovery dependencies. Keep migration history intact rather than deleting files to satisfy a grep.
- [ ] Observation period, scheduled jobs and supported mobile versions pass; legacy consumers are identified and retired.
- [ ] Obsolete production Supabase credentials/build variables/keepalives removed after transition; production recovery no longer depends on the hosted source. Development credentials remain separate and usable.
- [ ] Operational docs, monitoring, costs and project-retirement disposition updated.

Per-app evidence includes a sanitized migration manifest, release SHAs, reconciliation results, test output, restore timing, cutover timestamps, rollback procedure and remaining exceptions. No tokens, connection strings, raw production user data or database dumps go into Git.

## 7. Program tracker and next executable work

| Stage | Status | Depends on |
| --- | --- | --- |
| Repository mapping and initial alignment | Complete for the 14 baseline repositories | None |
| Execution plan | Updated for Supabase development, skaleclub Google default and light local execution | Mapping |
| Phase 0: live verification, account/capacity/cost inventory | Started: Xpot dev target and shared-host capacity inspected; full dossiers pending | Plan |
| Phase 1: finish Xpot | Production cutover deployed and verified; observation and shared-development review remain | Phase 0 for Xpot and shared identity/infra |
| Phase 2: Xkedule | Pending | Reference contract and Xkedule phase 0 |
| Phase 3: Xmail, Xpend, Xcraper | Pending | Reference implementation and respective dossiers |
| Phase 4: Xpeed, Stuscle, Xareable | Pending | Reference contract and respective dossiers |
| Phase 5: XmartMenu, Xtimator, Xphere | Pending | Data/service replacement contracts and respective dossiers |
| Phase 6: Xplore, Skale Club, Apps Dashboard, auxiliary sweep | Pending | Reference contracts and respective dossiers |
| Phase 7: observation and retirement | Pending per app | Its completed cutovers and evidence |

Current work: Xpot branch codex/xpot-development-database protects npm run dev, dev:server, development migrations and snapshot destinations with an explicit Supabase development target. Its local environment now explicitly selects the existing Supabase development project through the session pooler; read-only access verified PostgreSQL 17.6, 108 public tables and 57 recorded Xpot migrations. Public Google SDK settings were configured locally from the running Xpot setup (skaleclub); browser/SMS verification remains pending. The local shortcut's production snapshot refresh is now opt-in and still needs a separate sanitization/side-effect review. Twenty-two focused tests passed sequentially; no build, migration or server startup ran. Shared-host read-only probe on 2026-11-03 showed approximately 7.6 GiB RAM total, 1.4 GiB available, 1.2 GiB swap used and 20 GiB disk available (73% used). Xpot and Xpeed running image tags matched their baseline commits. These measurements do not establish capacity for all remaining databases. Full object manifests and backups/restore checks remain pending. Detailed evidence and next tasks are in xpot/docs/supabase-production-exit.md in the Xpot repository.

Second increment: commit 4374449 on Xpot prepares public R2 avatar/branding uploads with a separate public bucket, owner cleanup and legacy-link compatibility. [Draft PR 178](https://github.com/Skale-Club/xpot/pull/178) completed the main CI job successfully: full types, print pipeline, unit tests, NFC tests, real-PostgreSQL integration tests and production build. GitGuardian passed; the separate SonarCloud analysis was cancelled and is not claimed as validated. Local focused validation passed 49 tests across six files, sequentially. Full local TypeScript checking exceeded a deliberately capped 768 MiB heap, so it was moved to CI without increasing local memory use. Google public configuration confirmed localhost, xpot.place and xpot.skale.club authorized. The metadata-only production inventory found 3 public objects (489,672 bytes) and 47 private print objects (27,381,500 bytes); public database references exist in favicon, avatar, profile-image and audio columns. No stored supabase: references were found in the inspected file/reference columns; this is not authorization to delete orphan candidates. The temporary manifest remains in the running container and must be archived durably before retirement. No source objects, production data or configuration were changed. Read-only migrate:dev:plan confirmed 29 pending files; integration-enable/admin-grant and organization/stock backfills require review before application to the shared dev schema.

### Xpot production release record

The user explicitly authorized publishing validated increments to production on 2026-11-03. PRs [178](https://github.com/Skale-Club/xpot/pull/178) and [179](https://github.com/Skale-Club/xpot/pull/179) were merged after successful full remote CI. The final production commit is 414030f34a991d3a3c362aae82d16e3d25b2bed5. Deployment workflow 41689297002 published the final code; workflow 41689999177 restarted it after obsolete production environment variables were removed. Both are successful. Local main and origin/main were aligned to this commit.

Production now uses its existing private PostgreSQL, Google phone/Google identity, public xpot-assets at https://media.xpot.place and private xpot-files. The Xpot credential retains object read/write permission restricted to those two buckets. The private bucket has no custom public domain and its public development URL is disabled. No other application's access was expanded.

Before the reference cutover, a 951,302-byte PostgreSQL dump was restored into a temporary isolated database (76 public tables, 2 users, 85 migration records); the temporary database was then removed. The dump was uploaded to private R2 and SHA-256 verified as 3045019c1d04e9a1c8f381398ffe54771927868f27f8e2b39948f92f74711f51. All 50 source objects (27,871,172 bytes) were archived and copied directly on the server and SHA-256 verified; source Supabase objects were not deleted. Four database fields were switched atomically using compare-and-set updates, with a private rollback manifest written first. No remaining Supabase URL or stored-reference use was found in the inspected production file/reference columns.

Durable recovery material is in private xpot-files: migration-backups/xpot-pre-r2-20261103.dump, migration-backups/xpot-pre-r2-runtime-20261103.json, migration-backups/xpot-r2-reference-rollback-20261103.json, and migration-archive/20261103/manifest.json with its archived source objects. Runtime backups contain sensitive settings and must never be committed or made public.

Final production checks: the exact expected commit and health endpoints returned 200, favicon followed to the media domain with 200, Google configuration endpoint returned 200, unauthenticated account/file reads returned 401, retired Supabase config/password-login endpoints returned 410, malformed Google identity tokens returned 401, and private audio was absent from the public bucket (404). Signed private storage reads succeeded; unsigned S3 requests were rejected (400). A live process inspection confirmed all three production SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY variables absent while Google remained enabled. The browser displayed phone entry first and Google second, without an email/password form. No real SMS or interactive account sign-in was performed. Fifty-eight focused tests passed sequentially before PR 179; its full types/unit/integration/build CI passed remotely. Supabase development remains configured and its 29 pending migration files remain unapplied pending shared-schema review.

Observation, periodic backup policy review, interactive Google/SMS testing and eventual legacy-source retirement remain tracked follow-up work. No other app has been claimed migrated by this Xpot release.

## 8. Provider references

- Google Identity Platform authentication: https://cloud.google.com/identity-platform/docs/concepts-authentication
- Google Identity Platform pricing (SMS is usage-based; model costs explicitly): https://cloud.google.com/identity-platform/pricing
- Supabase self-hosted service architecture (inventory reference, not the target deployment): https://supabase.com/docs/guides/self-hosting/docker

Running Supabase's complete stack on a VPS would preserve platform dependencies. The target here is PostgreSQL, independent application authorization, independent object storage and Google-backed identity.
