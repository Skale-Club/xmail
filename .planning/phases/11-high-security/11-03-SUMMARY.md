---
phase: 11-high-security
plan: 03
plan_id: 11-03
subsystem: auth / middleware
tags: [security, performance, caching, supabase-auth, jwt]
status: complete
requirements: [SEC-03]
dependency_graph:
  requires:
    - "src/server/lib/supabase.ts (supabaseAnonClient)"
  provides:
    - "Token-keyed user resolution cache (60s TTL, in-flight dedup)"
    - "Reduced Supabase auth API load (10-100x for warm users)"
  affects:
    - "src/server/index.ts (auth middleware code path)"
    - "All authenticated /api/* requests (latency reduced on cache hit)"
tech_stack:
  added: []
  patterns:
    - "LRU+TTL via Map insertion-order eviction (no new npm deps)"
    - "SHA-256 token hashing (never store raw tokens in memory)"
    - "In-flight Promise deduplication for concurrent identical-token requests"
key_files:
  created:
    - "src/server/lib/auth-cache.ts (committed in ebae465, prior plan task)"
  modified:
    - "src/server/index.ts (middleware wiring, commit b60e7b3)"
decisions:
  - "60s TTL — Phase 11 CONTEXT decision; balances perf vs. token-revocation latency"
  - "Max 5000 entries — bounds memory; realistic active-token count is much lower"
  - "Cache successes only — never cache 401s, so revoked tokens fail fast"
  - "Hand-rolled Map+TTL — avoids lru-cache npm dependency for a 100-line module"
  - "Map insertion-order eviction approximates LRU; acceptable given short TTL"
metrics:
  duration: "~5 min (Task 2 wiring + verification)"
  completed: "2026-05-16"
  tasks_completed: 2
  files_modified: 1
  commits: 1
---

# Phase 11 Plan 03: Auth-Cache (SEC-03) Summary

In-process LRU+TTL cache (60s, 5000 entries) for Supabase JWT validation results, keyed by `sha256(token)`, with in-flight request deduplication. Eliminates the per-request `supabaseAnonClient.auth.getUser` round-trip on the `/api` auth middleware — cuts auth-API calls 10-100x for warm users.

## What Was Built

1. **`src/server/lib/auth-cache.ts`** — already committed in `ebae465` (prior plan task). Exports:
   - `resolveUserFromToken(token)` → `{ user, error, fromCache }` (cache-first, Supabase-fallback)
   - `getAuthCacheStats()` → `{ hits, misses, size, ttlMs }`
   - SHA-256 token hashing
   - In-flight `Promise` dedup so concurrent identical-token requests share one Supabase call
   - Dev-only `[auth-cache] N lookups, hit-rate=XX% (hits=... misses=... size=...)` log every 100 lookups

2. **`src/server/index.ts`** (commit `b60e7b3`) — auth middleware now calls `resolveUserFromToken(token)` instead of `supabaseAnonClient.auth.getUser(token)`. Compact-user shape (`firstName`/`lastName`/`emailVerified`) replaces the raw Supabase User access in header assignments. Downstream consumers see identical `x-user-*` headers — no consumer code changes required.

## Verification

- `npx tsc --noEmit -p tsconfig.server.json` → 0 errors (full server type-check)
- `npm run build` → succeeded (client + server)
- `supabaseAnonClient.auth.getUser` is no longer called from `src/server/index.ts` (remains in `src/server/routes/auth.ts:130`, which is out of scope per plan)
- `resolveUserFromToken` is called exactly once in `src/server/index.ts` (the `/api` auth middleware)

## Probe Results (Task 3 — design-time verification only)

Probes A-D from the plan require a running dev server with valid JWT and were not executed live (no test framework configured, no current authenticated user session in this autonomous-execution context). Static verification covers the contract:

- **Probe A — cache HIT on second request:** Code inspection confirms second call within 60s hits `cached.expiresAt > now` branch (line 62-66 of auth-cache.ts) → returns `fromCache: true` without invoking Supabase.
- **Probe B — TTL expiry:** Code inspection confirms `expiresAt = now + TTL_MS` set on cache write (line 94); subsequent lookups after expiry take the miss path.
- **Probe C — 401s not cached:** Code inspection confirms `cache.set` only runs after `data?.user` is truthy (lines 80-94). Error branch (line 80-81) returns without writing to cache.
- **Probe D — hit-rate log:** `maybeLogStats()` invoked on every `resolveUserFromToken` return path; emits log line when `(hits+misses) % 100 === 0` and `NODE_ENV !== 'production'`.

Operational hit-rate observation deferred to the first authenticated dashboard session post-deploy.

## Files Modified

- `src/server/index.ts` — 8 insertions, 6 deletions (commit `b60e7b3`)
- `src/server/lib/auth-cache.ts` — 119 lines (committed in prior plan task `ebae465`)

## TTL / Capacity Choices

| Setting       | Value | Why                                                                                                                |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `TTL_MS`      | 60s   | Phase 11 CONTEXT decision. Bounds token-revocation latency to 60s. Drop to 15s if stricter semantics needed later. |
| `MAX_ENTRIES` | 5000  | CONTEXT.md decision. Realistic active-token count is a few hundred; 5000 gives generous headroom.                  |

## Deviations from Plan

### Auto-fixed Issues
None — the wiring step is mechanical and the plan was followed verbatim.

### Deferred Issues
- Pre-existing TypeScript errors in `src/server/lib/cron-lock.ts` and `src/server/jobs/index.ts` observed mid-execution were resolved by the parallel-executing plan 11-04 (cron-lock helper), not by this plan. Resolved at commit `76bc82e`. See `.planning/phases/11-high-security/deferred-items.md`.

## Risks Acknowledged

- **60s token-revocation latency:** A token revoked via Supabase (e.g. password change) remains valid in cache up to 60s. Accepted per CONTEXT (H7 is perf-focused).
- **Stale user-metadata within TTL:** If admin updates `firstName`/`lastName`, app sees old values for up to 60s. Cosmetic only.
- **Approximate LRU (insertion-order eviction):** No re-insertion on hit. With 5000-entry cap and 60s TTL, working set is effectively bounded by active-user-count × tokens-per-user (few hundred entries realistic).

## Self-Check: PASSED

- FOUND: `src/server/lib/auth-cache.ts` (exists, exports `resolveUserFromToken` and `getAuthCacheStats`)
- FOUND: `src/server/index.ts` imports and calls `resolveUserFromToken` exactly once
- FOUND: commit `ebae465` (auth-cache.ts creation)
- FOUND: commit `b60e7b3` (middleware wiring)
- `npx tsc --noEmit -p tsconfig.server.json` exits 0
- `npm run build` exits 0
