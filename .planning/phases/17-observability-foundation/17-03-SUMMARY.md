---
phase: 17-observability-foundation
plan: "03"
subsystem: observability
tags: [observability, health-endpoint, metrics, sql-aggregates, platform-admin]
requirements:
  - HEALTH-ENDPOINT
dependency_graph:
  requires:
    - "src/server/lib/logger.ts (17-01) — createLogger + 3 outreach thresholds"
    - "src/server/jobs/processOutreachSequences.ts (17-02) — getRecentTickLatencies() ring buffer"
  provides:
    - "src/server/lib/outreach-metrics.ts (aggregate SQL helpers — reused by Plan 17-04 digest)"
    - "GET /api/admin/outreach/health — platform-admin observability endpoint"
    - "outreach_emails (sent_at, status) composite index"
  affects:
    - "Plan 17-04 (daily digest) imports computeOverallMetrics / computeByOrgMetrics / computeTopBouncingCampaigns / buildAlerts directly"
tech_stack:
  added:
    - "PostgreSQL FILTER aggregate pattern for one-round-trip rolling windows"
  patterns:
    - "Pure SQL helpers (no logger calls inside) — callers decide whether to log; helpers stay deterministic given (db state, now) for future testability"
    - "Defensive rowsOf<T>() handles both postgres-js (Array result) and node-pg ({rows: [...]}) shapes — same pattern used by processOutreachSequences"
    - "Sample-size floors on rate alerts (sent>=20 for 1h, sent>=100 for 24h) prevent thresholds firing on tiny windows"
    - "Two-layer auth: parent /api middleware validates JWT -> injects x-user-id; handler calls isPlatformAdmin -> 403 non-admin (rather than 200 empty)"
key_files:
  created:
    - "src/server/lib/outreach-metrics.ts (~290 lines)"
    - "src/server/routes/admin/outreach-health.ts (~96 lines)"
    - "supabase/migrations/022_outreach_emails_sent_at_status_idx.sql"
  modified:
    - "src/db/schema.ts (+1 composite index on outreachEmails table)"
    - "src/server/index.ts (+1 import + 1 mount line at /api/admin/outreach)"
decisions:
  - "Sample-size floors on bounce-rate alerts: 1h alert requires sent>=20 (CONTEXT spec); 24h alert requires sent>=100. Plan-suggested heuristic; prevents 1-bounce-out-of-2 firing a 'critical' alert."
  - "Org status threshold for 'warning' set to OUTREACH_BOUNCE_WARN_1H * 2 = 0.10 (same as ERROR_24H). Plan text suggested this; chose to keep it since the spec only defines TWO numerical thresholds and we need a 3-tier status. Could split into a separate ORG_WARN constant in 17-04+ if signal is too coarse."
  - "Module-level router with internal /health path, mounted at /api/admin/outreach — keeps the door open for future admin outreach endpoints (e.g. POST /api/admin/outreach/dry-run) under the same router file or sibling files in routes/admin/."
  - "Did NOT run npm run db:push. Per orchestrator instructions ('DO NOT apply migration to any DB'), migration 022 is committed as a SQL file under supabase/migrations/ and will be applied by the deploy pipeline / operator."
  - "Did NOT touch processOutreachSequences.ts even though it currently has uncommitted modifications from parallel Plan 17-02 — file ownership boundary respected per orchestrator instructions."
metrics:
  duration_ms: ~300000
  completed: "2026-05-17"
  tasks_completed: 3
  files_changed: 5
---

# Phase 17 Plan 03: Outreach Health Endpoint Summary

**One-liner:** `GET /api/admin/outreach/health` returns rolling-window outreach metrics (sent/open/click/bounce/reply/suppression rates, per-org + per-campaign breakdowns, processor tick percentiles, structured alerts) computed via aggregate SQL helpers reusable by Plan 17-04's digest.

## What was built

### 1. Composite index: `outreach_emails (sent_at, status)`

- Drizzle: `idxOutreachEmailsSentAtStatus: index('idx_outreach_emails_sent_at_status').on(table.sentAt, table.status)` appended to the existing `outreachEmails` table index block in `src/db/schema.ts`.
- SQL: `supabase/migrations/022_outreach_emails_sent_at_status_idx.sql` — `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_emails_sent_at_status ON outreach_emails (sent_at, status);`
- **Not applied to any DB** by this plan — per orchestrator instructions, the migration file is committed and the operator/deploy pipeline applies it.
- **Why:** every aggregate query in the health endpoint filters on `(sent_at >= cutoff AND status = ?)`. With a single-column `sent_at` or `status` index PG would scan many rows + filter; the composite makes 1h/24h/7d window scans index-only.

### 2. Shared aggregate helpers: `src/server/lib/outreach-metrics.ts`

Pure SQL-aggregate helpers — no logger, no side effects — so Plan 17-04's daily digest can reuse them verbatim.

```typescript
import {
    computeOverallMetrics,        // (now?: Date) => Promise<OverallMetrics>
    computeByOrgMetrics,          // (now?: Date) => Promise<OrgMetrics[]>
    computeTopBouncingCampaigns,  // (now?: Date) => Promise<TopBouncingCampaign[]>
    computeProcessorPercentiles,  // () => { p50: number|null, p95: number|null }
    buildAlerts,                  // (overall, byOrg, topBouncing, now?) => HealthAlert[]
    OUTREACH_BOUNCE_WARN_1H,
    OUTREACH_BOUNCE_ERROR_24H,
    OUTREACH_PROCESSOR_SLOW_MS,   // re-exported from logger.ts
} from '../lib/outreach-metrics'
```

**Type exports** (interfaces): `OverallMetrics`, `OrgMetrics`, `TopBouncingCampaign`, `HealthAlert`.

**Implementation highlights:**

- `computeOverallMetrics` runs a single `SELECT ... COUNT(*) FILTER (WHERE ...)` over `outreach_emails` to compute 9 numbers (sent_1h/24h/7d, opened_24h, clicked_24h, replied_24h, bounced_24h, bounced_1h, unsubscribed_24h) in one round-trip. Three additional COUNT queries hit `campaigns` and `email_accounts` for activeCampaigns / activeEmailAccounts / failedEmailAccounts.
- `computeByOrgMetrics` uses `LEFT JOIN outreach_emails ... HAVING COUNT > 0` so orgs with zero sends in the window don't appear (instead of appearing as rows of zeros).
- `computeTopBouncingCampaigns` ranks by raw bounce ratio descending and `HAVING COUNT >= 10` to drop noise from tiny-sample campaigns. `LIMIT 5`.
- `computeProcessorPercentiles` reads the 100-element ring buffer from Plan 17-02's `getRecentTickLatencies()`; returns `{p50: null, p95: null}` when fewer than 5 samples are present.
- `buildAlerts` applies the threshold constants from logger.ts (5% / 10% / 30000ms) with sample-size floors (1h alert requires sent>=20, 24h alert requires sent>=100). Emits `bounce_rate_1h`, `bounce_rate_24h`, `processor_slow`, `failed_email_accounts`, and `org_critical` alert kinds.

### 3. HTTP endpoint: `src/server/routes/admin/outreach-health.ts`

`GET /health` — mounted at `/api/admin/outreach` so the full path is `/api/admin/outreach/health`.

**Auth gate (two-layer):**
1. Parent `/api` middleware in `index.ts` validates JWT and injects `x-user-id`.
2. Handler calls `isPlatformAdmin(userId)` — non-admin gets 403, not 200 with empty data.

**Response shape** (annotated example):

```json
{
  "asOf": "2026-05-17T15:30:00.000Z",
  "overall": {
    "sent1h": 47,                "sent24h": 1203,             "sent7d": 8451,
    "openRate24h": 0.31,         "clickRate24h": 0.04,        "replyRate24h": 0.018,
    "bounceRate24h": 0.022,      "bounceRate1h": 0.0,         "suppressionRate24h": 0.005,
    "processorTickP50Ms": 412,   "processorTickP95Ms": 1830,
    "activeCampaigns": 7,        "activeEmailAccounts": 12,   "failedEmailAccounts": 0
  },
  "byOrg": [
    { "organizationId": "uuid", "name": "Acme",
      "sent24h": 540, "bounceRate24h": 0.018, "replyRate24h": 0.022, "status": "healthy" }
  ],
  "topBouncingCampaigns": [
    { "campaignId": "uuid", "name": "Q2 Outbound",
      "sent24h": 220, "bounceRate24h": 0.054 }
  ],
  "alerts": [
    { "severity": "warning", "kind": "processor_slow",
      "message": "Processor tick p95 31200ms exceeds 30000ms threshold",
      "since": "2026-05-17T15:30:00.000Z" }
  ],
  "thresholds": {
    "bounceWarn1h": 0.05, "bounceError24h": 0.10, "processorSlowMs": 30000
  },
  "_meta": {
    "latencyMs": 38,
    "notes": "All rates are fractions in [0,1]. Bounce-rate alerts require sent>=20 (1h) and sent>=100 (24h) to avoid noise. Processor p50/p95 returns null when fewer than 5 ticks recorded since last restart."
  }
}
```

**Logging:**
- `outreach.health.served` (info) — successful response with `latencyMs`, `alertCount`, `orgCount`
- `outreach.health.forbidden` (warn) — non-admin attempt with `userId`
- `outreach.health.error` (error) — internal exception with `error.message` + `error.stack`

## Mount point

```typescript
// src/server/index.ts
import outreachHealthRoutes from './routes/admin/outreach-health'
// ...
app.use('/api/admin/outreach', outreachHealthRoutes)
```

Mount is placed between `/api/outreach` and `/api/outlook` in the existing mount block — after the `/api` JWT middleware (which runs in registration order) so the handler receives a populated `x-user-id` header.

## Commits

| Task | Description                                           | Commit    |
| ---- | ----------------------------------------------------- | --------- |
| 1    | Composite index (sent_at, status) + migration 022     | `414872d` |
| 2    | Shared aggregate helpers — outreach-metrics.ts        | `cafd970` |
| 3    | Health endpoint route + mount in index.ts             | `1c8b5be` |

## Verification

- `grep -c "idxOutreachEmailsSentAtStatus" src/db/schema.ts` -> 1
- `grep -c "export async function computeOverallMetrics" src/server/lib/outreach-metrics.ts` -> 1
- `grep -c "export async function computeByOrgMetrics" src/server/lib/outreach-metrics.ts` -> 1
- `grep -c "export async function computeTopBouncingCampaigns" src/server/lib/outreach-metrics.ts` -> 1
- `grep -c "export function computeProcessorPercentiles" src/server/lib/outreach-metrics.ts` -> 1
- `grep -c "export function buildAlerts" src/server/lib/outreach-metrics.ts` -> 1
- `grep -c "isPlatformAdmin" src/server/routes/admin/outreach-health.ts` -> >=1
- `grep -c "/api/admin/outreach" src/server/index.ts` -> >=1
- `grep -c "outreachHealthRoutes" src/server/index.ts` -> 2 (import + mount)
- `npm run build` -> exits 0 (vite client build 7.4s, tsc server build clean)
- `test -f supabase/migrations/022_outreach_emails_sent_at_status_idx.sql` -> exists

**Manual smoke (post-deploy, not part of this plan):**
```bash
curl -fsS https://mail.skale.club/api/admin/outreach/health \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq 'keys'
# Expected: ["_meta","alerts","asOf","byOrg","overall","thresholds","topBouncingCampaigns"]
```

## Deviations from Plan

### Plan-recommended adjustments (Rule 1 — minor)

**1. [Rule 1 — Bug] Did not run `npm run db:push` / `db:generate`**
- **Found during:** Task 1 setup
- **Issue:** Plan text suggested running `npm run db:generate && npm run db:push`. Orchestrator instructions explicitly say "DO NOT apply migration to any DB" for this parallel-wave execution.
- **Fix:** Wrote the migration file `022_outreach_emails_sent_at_status_idx.sql` with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` directly (the same SQL drizzle-kit would emit). Skipped db:generate too because the working tree already has an in-flight modification to `processOutreachSequences.ts` from Plan 17-02 and drizzle-kit can't diff against an unstable state cleanly anyway.
- **Files modified:** none extra
- **Risk:** None — the index is purely additive and `IF NOT EXISTS` is idempotent. Deploy pipeline / operator applies migrations on schedule.

**2. [Rule 1 — Bug] Renamed `processorMetrics` import described in `<parallel_execution>` brief to `getRecentTickLatencies`**
- **Found during:** Task 2 implementation
- **Issue:** Parent orchestrator brief mentioned importing `processorMetrics` from `src/server/lib/processor-metrics.ts` (which would be created by parallel Plan 17-02). Reading the actual in-flight 17-02 work in `processOutreachSequences.ts` revealed 17-02 exposed the data directly as `export function getRecentTickLatencies(): readonly number[]` from `../jobs/processOutreachSequences`, not via a separate `processor-metrics.ts` module.
- **Fix:** Imported `getRecentTickLatencies` directly from `processOutreachSequences.ts` per the actual 17-02 implementation. PLAN frontmatter line 43 `via: 'import { getRecentTickLatencies } from '../jobs/processOutreachSequences''` confirms this is the correct shape.
- **Files modified:** none extra
- **Risk:** None — `getRecentTickLatencies` is already exported in the working tree (17-02 task committed it).

### Out-of-scope discoveries (logged, not fixed)

- Pre-existing untracked planning artefacts (`.planning/phases/15-*/.gitkeep`, `16-*/.gitkeep`, plus `17-02-PLAN.md`, `17-04-PLAN.md`) — belong to the planner / other plans, left untouched.
- `src/server/jobs/processOutreachSequences.ts` has unstaged modifications from parallel Plan 17-02 — explicitly NOT staged or touched per orchestrator file-ownership boundary.

## Known Stubs

None. The endpoint is fully wired: SQL helpers return real aggregates, the route returns a fully-typed response shape, and the mount line is live. No "TODO: wire data" placeholders. Plan 17-04's digest will simply import the helpers as-is.

## Self-Check: PASSED

- FOUND: `src/server/lib/outreach-metrics.ts`
- FOUND: `src/server/routes/admin/outreach-health.ts`
- FOUND: `supabase/migrations/022_outreach_emails_sent_at_status_idx.sql`
- FOUND: composite index `idxOutreachEmailsSentAtStatus` in `src/db/schema.ts`
- FOUND: mount `/api/admin/outreach` in `src/server/index.ts`
- FOUND: commit `414872d` (Task 1)
- FOUND: commit `cafd970` (Task 2)
- FOUND: commit `1c8b5be` (Task 3)
- VERIFIED: `npm run build` exits 0 (3 times — once per task)
- VERIFIED: all 5 required exports from outreach-metrics.ts present (grep returned 7 including imports/re-exports)
- VERIFIED: no edits to files owned by Plan 17-02 (processOutreachSequences.ts, processReplies.ts, processBounces.ts, track.ts, jobs/index.ts)
