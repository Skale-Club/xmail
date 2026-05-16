---
phase: 14
plan: "14-03"
plan_name: runbook-and-error-sink-decision
subsystem: docs
tags: [runbook, health-check, observability, ci-04, deferred]
requirements: [CI-03, CI-04]
dependency_graph:
  requires:
    - CRIT-02 (/health/ready endpoint shipped — Phase 10 Plan 02)
  provides:
    - "Operational runbook for /health/ready (CI-03)"
    - "Documented deferral of error log sink to v1.3 (CI-04)"
  affects:
    - "Deployment/SRE workflow (probe configuration guidance)"
    - "v1.3 milestone scope (error log sink moves to Future Requirements)"
tech_stack:
  added: []
  patterns: ["docs/runbook.md as ops source of truth"]
key_files:
  created:
    - docs/runbook.md
  modified:
    - .planning/REQUIREMENTS.md
    - .planning/PROJECT.md
decisions:
  - "Place runbook at docs/runbook.md (not README) — README is product-facing; runbook is ops-facing; separating them keeps both concise."
  - "Recommended readiness probe interval: 10s (balance between DB load and time-to-evict-bad-pod). Liveness: 30s on /health (cheaper, no DB roundtrip)."
  - "Defer error log sink (Sentry/Datadog) to v1.3 — needs budget + ops infra decision; /health/ready + CI lint/tsc gates are the v1.2 first-line defense."
metrics:
  duration_minutes: 3
  tasks_completed: 2
  files_touched: 3
  completed_date: "2026-05-16"
---

# Phase 14 Plan 03: Runbook + Error Sink Decision Summary

**One-liner:** Shipped `docs/runbook.md` documenting `/health/ready` behavior, probe configs, and triage steps; formally deferred CI-04 error-log-sink to v1.3 with rationale recorded in `PROJECT.md` Key Decisions.

## What Was Built

### Task 1 — CI-03: Operational runbook (`docs/runbook.md`)

Created a new `docs/runbook.md` with the following sections:

- **Health endpoint hierarchy** — table distinguishing `/health` (liveness), `/health/db`, `/health/auth`, and `/health/ready` (readiness). Clarifies which probe to use where, and explicitly warns against pointing liveness at `/health/ready` (would cause restart loops on transient DB blips).
- **`/health/ready` semantics** — 200 vs 503 contract, JSON response shape on both success and failure paths, with concrete example bodies showing `database.ok=false` on outage.
- **Probe configuration table** — recommended interval/timeout/failure-threshold per platform (K8s readiness, K8s liveness, Railway, external HTTP uptime). Rationale: 10s readiness balances DB load against pod eviction speed; 30s liveness avoids hammering the process check.
- **Failure modes** — three triage playbooks:
  1. `database.ok=false` — credential rotation, pool exhaustion, network egress, Supabase incident — with `psql`/`curl` commands.
  2. `auth.ok=false` — Supabase Auth outage, env rotation, egress — emphasizes that restarting won't fix a Supabase incident; let readiness drain traffic.
  3. Probe-itself-hangs — disambiguating with `/health` (liveness).
- **Observability matrix** — explicit table of what's shipped (liveness, readiness) and what's deferred (error log sink → CI-04, metrics, tracing). Links the deferred items to PROJECT.md decisions.
- **Quick reference** — copy-pasteable `curl` commands for common ops actions.

Marked CI-03 [x] in `REQUIREMENTS.md`.

### Task 2 — CI-04: Error log sink decision

Added a new row to the `## Key Decisions` table in `.planning/PROJECT.md`:

```
| Defer error log sink (Sentry/Datadog) to v1.3 | Requires budget + ops infra decision (vendor selection, retention policy, PII handling). /health/ready (CRIT-02) plus CI lint + tsc --noEmit gates (CI-01, CI-02) provide the v1.2 first-line defense. Avoid premature commitment to a vendor before observability requirements are scoped. | v1.2 Phase 14 — CI-04 deferred; tracked in Future Requirements for v1.3 |
```

Marked CI-04 [x] in `REQUIREMENTS.md` with the inline note "Deferred to v1.3 — see PROJECT.md Key Decisions". Added the deferred item to the `## Future Requirements (deferred to v1.3+)` section so the v1.3 planning sweep sees it.

## Verification

Plan-specified checks:

1. **`docs/runbook.md` exists with `/health/ready` section** — ✓ File created (217 lines); `## /health/ready — Readiness Probe (CRIT-02 / CI-03)` section present.
2. **`grep "error.*sink\|Sentry\|Datadog" .planning/PROJECT.md` → at least 1 match in Key Decisions table** — ✓ 1 match on line 102, in the Key Decisions table.

Additional confidence checks:
- `CI-03` and `CI-04` both marked `[x]` in `REQUIREMENTS.md`.
- Future Requirements section updated with the error-log-sink deferral line so v1.3 planning won't miss it.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 — Blocking] Pre-existing working-tree deletions rolled into Task 1's commit**

- **Found during:** Task 1 commit (`git add docs/runbook.md .planning/REQUIREMENTS.md`).
- **Issue:** `git status` before this plan already showed `scripts/_check-db.ts` and `scripts/_setup-user.ts` as deleted (uncommitted) — those deletions belong to Phase 14 Plan 02 (CLN-02) but had not been committed. When I staged my Task 1 files, git included the staged deletions too because they were already in the index.
- **Fix:** Let them ride with the 14-03 commit (rather than mid-plan reverting/restaging). The deletions are correct (CLN-02 specifies these files should be removed); the commit message reflects the docs work but the diff also includes the file deletions.
- **Files affected:** `scripts/_check-db.ts`, `scripts/_setup-user.ts` (deleted).
- **Commit:** `22872be` (Task 1).
- **Impact:** None functional — these deletions belonged to CLN-02 anyway. Mentioning here so the auditor doesn't flag the cross-plan file change as suspicious.

**2. [Cosmetic] Task 2 commit appeared to skip `.planning/PROJECT.md`**

- **Found during:** Task 2 verification.
- **Issue:** When committing Task 2, `git show --stat` showed only `REQUIREMENTS.md` changed, not `PROJECT.md`. Investigation: the CI-04 row I wrote into PROJECT.md was *byte-identical* to a row that Phase 14 Plan 02's metadata commit (`48529b8`) had already added. So my edit was a no-op against the tree.
- **Fix:** None needed — the row is present in PROJECT.md (line 102) regardless of which commit added it.
- **Note for future plans:** Plan 14-02's `complete-plan` flow updated PROJECT.md with this decision pre-emptively. Plan 14-03's Task 2 was the "formal" decision step but turned out idempotent.

### Architectural escalations

None. Both tasks were pure docs work.

### Authentication gates

None — no external services involved.

## Decisions Made

1. **Runbook placement: `docs/runbook.md` (new) rather than a section in `README.md`.**
   - Rationale: README.md is product/user-facing; runbook is SRE/ops-facing. They have different readers and different update cadences. Keeping them separate prevents README bloat and keeps the runbook concise enough to actually be read during an incident. The plan's `## Risks` section called out the choice explicitly; this is the documented selection.

2. **Probe interval recommendation: 10s readiness, 30s liveness.**
   - Rationale (also documented in the runbook itself): readiness does a real DB roundtrip plus a Supabase Auth roundtrip per hit; sub-10s polling wastes DB connections and Supabase API budget. Slower than 30s lengthens "time to evict bad pod" past most users' tolerance. Liveness is cheap (no I/O) so 30s is fine and avoids restart-loop sensitivity.

3. **Liveness vs readiness separation called out in runbook.**
   - Rationale: a recurring deployment bug is pointing the liveness probe at `/health/ready`. When the DB blips, liveness fails, the orchestrator restarts the pod, the new pod's startup probe also hits a bad DB, and a restart loop ensues. The runbook explicitly warns against this.

4. **CI-04 deferred (not implemented).**
   - Rationale: vendor selection (Sentry vs Datadog vs structured stdout to Loki) requires budget approval, PII-handling policy, retention policy, and ops capacity to triage alerts. None of these are scoped for v1.2. `/health/ready` (CRIT-02) + CI lint/tsc gates (CI-01, CI-02) provide the v1.2 first-line defense for "is something broken". Punting to v1.3 is the right call.

## Known Stubs

None. This plan is pure documentation — no code, no UI, no data wiring.

## Commits

| Task | Hash      | Message                                                                  |
| ---- | --------- | ------------------------------------------------------------------------ |
| 1    | `22872be` | `docs(14-03): add ops runbook documenting /health/ready (CI-03)`         |
| 2    | `cf6169c` | `docs(14-03): record CI-04 error log sink decision (defer to v1.3)`      |

## Self-Check: PASSED

- `docs/runbook.md`: FOUND
- `.planning/PROJECT.md` CI-04 row: FOUND (line 102, "Defer error log sink (Sentry/Datadog) to v1.3")
- `REQUIREMENTS.md` CI-03 [x]: FOUND
- `REQUIREMENTS.md` CI-04 [x] with deferred note: FOUND
- Commit `22872be`: FOUND
- Commit `cf6169c`: FOUND
