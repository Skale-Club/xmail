---
id: SEED-002
status: dormant
planted: 2026-07-15
updated: 2026-07-18
planted_during: v1.4 — Outreach Hardening (planning)
trigger_when: A security/reliability hardening pass, OR opportunistically when already working in the named files, OR when outreach un-parks (a few items need a live campaign). Testable-now items (P1-11, P1-16, MX fail-open, env one-liners) need no campaign.
scope: Medium
---

# SEED-002: Harvest still-open system-audit findings

## Status — read this first

The audit branch `origin/claude/system-error-analysis-9k0pyj` (report `docs/auditoria-sistema-2026-07.md`,
2026-07-09) was **fully re-verified against `main` on 2026-07-18** by 5 parallel agents, one per
subsystem. This seed now carries the *verified* map, not guesses. Result across ~31 P0–P2 findings:
**~10 FIXED · 2 OBSOLETE · 3 PARTIAL · ~16 OPEN.**

**Do NOT merge the source branch** — stale (forked 2026-07-08 pre-v1.4, ~210 commits behind, 13
conflicting files, migration `032` collides with main's `032`). Its value is the diagnostic report +
the `c2d4432` mail-tls diff as reference. Harvest the open items by re-implementing on current main.

## Already FIXED by v1.4 / branch-1 merge (do NOT redo)

P0-1 branding auth bypass · P0-2 idempotency unique indexes (migrations 035/037/038) · P0-4 dev-branch
deploy (`branches:[main]`) · P1-6 click-tracking open-redirect (token HMAC-bound) · P1-7 587 From
spoofing · P1-10 webhook SSRF-via-redirect (`redirect:'manual'`) · P1-13 template XSS (EmailHtmlViewer
sandbox) · suppression case-insensitivity · reply-match Message-ID brackets · **`/o/u/check` PII
endpoint — closed 2026-07-18 by merging branch `feat/magical-moore-f49987` into main**.

**OBSOLETE (mechanism rewritten in v1.4, bug gone):** stuck-lead-after-failure (dispatch state machine,
migration 038) · processBounces whole-inbox rescan (now cursor over `outreach_provider_events`).

## STILL OPEN — the actual work (ranked)

### Testable NOW (no live campaign needed)
1. **P1-11 — `trust proxy:1` + port 9001 internet-published** (`src/server/index.ts:43`). Direct
   connection to 9001 lets the client set `X-Forwarded-For` → `req.ip`, rotating the `authLimiter`
   key per request → **unlimited login brute-force**. Limiter was even weakened 5→10. *Highest live
   severity.* Fix = bind 9001 to loopback/Traefik-only, or pin `trust proxy` to the proxy subnet +
   spoof-resistant limiter key.
2. **P1-16 — `mail_messages` unique index = ACTIVE silent mail-loss.** SQL enforces
   `(mailbox_id, remote_uid)` (`006_mail_tables.sql`) but v1.4 allocates UID **per-folder**
   (`src/server/lib/folder-counts.ts`, each folder starts at 1). A Sent uid=1 collides with an Inbox
   uid=1 in the same mailbox → `onConflictDoNothing` (smtp-server/mx-server store paths) **silently
   drops** the 2nd message. `schema.ts` declares `(folder_id, remote_uid)` which no SQL creates.
   Fix = migration: drop old index, `CREATE UNIQUE INDEX ... (folder_id, remote_uid) WHERE remote_uid IS NOT NULL`.
   (psql is NOT installed — apply via postgres.js, see `xmail-applying-migrations` memory.)
3. **P0-3 residual — `processQueue.ts` double-send.** Outreach jobs now use `runWithLock` + the 038
   exactly-once ledger (FIXED), but the `deliveries` transactional sender still uses only an in-memory
   `running` boolean + non-atomic `findMany`. Blue-green overlap can double-send. Fix = atomic
   `UPDATE…SET status='sending'…RETURNING` claim.
4. **P2 MX fail-open** (`src/server/lib/mail-auth.ts:78` returns `null` on exception; `mx-server.ts`
   treats null as clean → INBOX, no DMARC). Fix = null → softfail/quarantine.

### Env / infra one-liners (add to `run_app_container` in `.github/workflows/build-deploy.yml`)
- **P1-8** `BASE_URL` unset → tracked `/api/messages` emit dead `localhost` links (or fall back to `FRONTEND_URL`).
- **P1-17** `MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI` unset → all `/api/outlook` OAuth 500s.
- **P1-9** deploy health gate polls `/health` (liveness) not `/health/ready` (DB+auth). Point it at the latter.

### Needs a live outreach campaign to test (outreach is parked — see [[xmail-outreach-sending-domain]])
- **Soft bounce kills the lead** (`processBounces.ts markAsBounced`): `bounceType` is classified then
  **discarded**; always sets terminal `bounced`. Thread `bounceType`, reschedule soft with backoff. STILL REAL.
- **Header injection in native send** (`src/server/routes/mail/send.ts`): no CRLF strip on
  `subject`/`inReplyTo`/`references`/recipient `name` (Zod only checks max). Add `.regex(/^[^\r\n]*$/)`.

### Other verified-open
- **P1-14 mail-api global logout on any 401** (`src/lib/mail-api.ts` → `lib/api.ts handleUnauthorized`
  hard `signOut()`, no refresh). Fix = route through `src/lib/api-client.ts` (refresh-on-401).
- **Mail TLS cert cached forever** (`src/server/lib/mail-tls.ts`, `resetMailTLSCache` has no caller).
  Branch commit `c2d4432` already implemented SNICallback + hourly refresh — use as reference.
- **viewer-can-send** (`src/server/routes/messages.ts` POST — membership check but no role guard).
- **Password-reset targets platform-admins** (`src/server/routes/users.ts:490` — no `targetUser.isAdmin`
  guard, min length 6 vs 8 elsewhere).
- **Auth-cache no invalidation** (`src/server/lib/auth-cache.ts` — 60s stale token after logout/delete/pw-change).
- **Relay failures swallowed as success** (smtp-server.ts + send.ts native paths return 250/success on relay throw).
- **PARTIAL — pagination clamp** done everywhere except `src/server/routes/outreach/campaigns.ts:1059`
  (`GET /:id/leads` still `parseInt||N`).
- **Low reach — route-matcher SSRF** (`route-matcher.ts:278` unguarded `fetch(cfg.url)`) — but the routes
  API can't create `http_endpoints` rows, so only legacy/direct-DB data reaches it.

## Reproducibility cluster (prod fine, clean rebuild breaks — DR/restore landmine, same root cause)

`supabase/migrations/` is NOT self-sufficient to build a DB; prod was seeded via old `db:push` and
migrations only `ALTER…IF EXISTS`. Three symptoms:
- **P0-5** `server_id`→`organization_id` never reconciled in SQL (`drizzle/0000_dear_wolverine.sql`
  still server-scoped; core tables lack `organization_id` there).
- **P1-15** migration runner `scripts/apply-pending-migrations.mjs` wraps each file in a txn → breaks on
  `022`'s `CREATE INDEX CONCURRENTLY` (masked only because 022 is already applied). Not on the deploy path.
- **email_provider enum** never `CREATE TYPE`d in migrations (012 makes it VARCHAR; 032 `ALTER TYPE`
  would hard-fail on a fresh DB).
Consider one "migrations self-sufficiency / DR rebuild" phase to retire `drizzle/0000` and make a clean
replay work end-to-end.

## Notes

Verified against `main` post-branch-1-merge (local commit `a1b955b`). Condensed live list in project
memory [[xmail-deferred-audit-backlog]]. The audit map historically errs ~1 in 3 — the 2026-07-18 pass
already filtered that out, but re-confirm any single finding before shipping its fix.
