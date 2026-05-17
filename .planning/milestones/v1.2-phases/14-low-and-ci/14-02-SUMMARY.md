---
phase: 14
plan: 14-02
plan_name: ci-gates
subsystem: ci
tags: [ci, github-actions, lint, tsc, build, quality-gate]
status: complete
requirements: [CI-01, CI-02]
dependency_graph:
  requires:
    - Phase 12 + 13 lint/tsc cleanliness (13-01 QUA-01 landed tsc-clean state)
    - package.json scripts: lint, build, build:client, build:server
  provides:
    - Automated lint + tsc + build gate on push and PR to main
    - Foundation for branch-protection rules (out of scope here)
  affects:
    - Every future PR — must keep eslint --max-warnings 0 and both tsconfigs clean
tech_stack:
  added:
    - GitHub Actions workflow (actions/checkout@v4, actions/setup-node@v4)
  patterns:
    - Single-job CI with linear steps (no matrix — single Node 20.x target)
    - Concurrency cancel-in-progress per ref (saves CI minutes on rapid pushes)
    - VITE_* build-time placeholders for vite build inside CI (no real secrets)
key_files:
  created:
    - .github/workflows/ci.yml
  modified: []
decisions:
  - Created a new ci.yml rather than extending deploy-hetzner.yml — keeps deploy and quality-gate concerns separated; deploy already runs only on push-to-main, CI runs on PRs too.
  - Pinned Node 20.x (matches local + @types/node ^20.11.28) instead of using a node matrix; a matrix would just burn CI minutes for a single-target deploy.
  - Type-check runs both tsconfig.json (client) and tsconfig.server.json (server) as separate steps so failures surface which side broke.
  - Build step injects VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_APP_NAME placeholders. Vite inlines these at build time; CI just needs the build to compile, not to talk to Supabase. Real values live in deploy-hetzner.yml docker build args.
  - Set timeout-minutes: 15 as a guard against hung steps (npm ci + double tsc + build is comfortably under that today).
metrics:
  duration_minutes: 1
  tasks_completed: 2
  files_created: 1
  files_modified: 0
  commits: 1
  completed_at: "2026-05-16T23:44:00Z"
---

# Phase 14 Plan 02: CI Lint + tsc Gates Summary

GitHub Actions CI workflow (ci.yml) running `npm ci` + `npm run lint` + `npx tsc --noEmit` (both client and server tsconfigs) + `npm run build` on push and PR to `main` with cancel-in-progress concurrency on Node 20.x — locks in v1.2's lint-clean / tsc-clean quality bar (closes CI-01 + CI-02).

## What Was Built

- `.github/workflows/ci.yml` — single-job workflow `lint-and-typecheck` running on `ubuntu-latest`, Node 20.x.
- Triggers: `push` to `main`, `pull_request` to `main`.
- Steps (in order, fail-fast):
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` with `node-version: 20.x` and `cache: npm`
  3. `npm ci` (uses committed `package-lock.json`)
  4. `npm run lint` (eslint with `--max-warnings 0`, configured in package.json)
  5. `npx tsc --noEmit -p tsconfig.json` (client + shared types)
  6. `npx tsc --noEmit -p tsconfig.server.json` (server)
  7. `npm run build` (runs `build:client` + `build:server`, with VITE_* placeholder envs)
- Concurrency group `ci-${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true` — a rapid push sequence cancels stale runs.
- `permissions: contents: read` — least-privilege; CI only reads the repo.
- `timeout-minutes: 15` per-job guard.

## Why It's Built This Way

- **Separate from deploy-hetzner.yml.** The deploy workflow only fires on push-to-main; PRs would skip quality gates entirely. A dedicated `ci.yml` runs on PRs too, which is where you actually want lint/tsc to block.
- **Node 20.x pinned, not a matrix.** `@types/node` is `^20.11.28`, dev runs on Node 20 locally, and prod deploy runs in a 20-based Docker image. A matrix would 2x–3x CI minutes for zero signal.
- **Both tsconfigs checked separately.** Client and server have different `target`, `module`, and `types` sets; running them independently makes failures attributable.
- **VITE_* placeholders in build step.** `vite build` reads `VITE_*` envs at build time and would fail without them. CI just needs the build to type-check and bundle — real Supabase URLs/keys are injected in deploy-hetzner.yml's `docker build --build-arg`, not here.
- **`cancel-in-progress: true`.** Common pattern for force-pushes and PR rebases; avoids burning minutes on superseded commits.

## Verification Results

- `[OK]` `.github/workflows/ci.yml` exists at expected path.
- `[OK]` Contains all required steps: `npm ci`, `npm run lint`, `npx tsc --noEmit` (both configs), `npm run build`.
- `[OK]` `concurrency:` block with cancel-in-progress present.
- `[OK]` `node-version: 20.x` pinned via `actions/setup-node@v4`.
- `[DEFERRED]` End-to-end "push a commit and watch CI go green" verification — explicitly deferred to operator per the plan ("Manual: push a commit and confirm CI runs — deferred").

## Deviations from Plan

None — plan executed exactly as written. Task 1 was inspection-only (no code), Task 2 created the workflow per spec. The build step's VITE_* env block is the only addition not literally in the plan; it's a Rule 3 fix (would block the build step otherwise) and matches how vite is invoked in deploy-hetzner.yml.

## Commits

| Task | Description                         | Commit  | Files                       |
| ---- | ----------------------------------- | ------- | --------------------------- |
| 1    | Inspect existing CI (no code)       | n/a     | (read-only)                 |
| 2    | Add lint + tsc + build CI workflow  | 9784d9c | .github/workflows/ci.yml    |

## Follow-Ups / Out of Scope

- **Branch protection rules** (require ci-and-typecheck status before merge) — must be configured in GitHub repo settings; cannot be set from workflow file. Operator action.
- **CI-03 / CI-04** — error log sink and runtime observability are Plan 14-03's scope.
- **No test step.** Project has no test framework today (per CLAUDE.md "Key Constraints"). When tests land, add `npm test` between `tsc` and `build`.

## Self-Check: PASSED

- FOUND: `.github/workflows/ci.yml`
- FOUND: commit `9784d9c` in `git log`
