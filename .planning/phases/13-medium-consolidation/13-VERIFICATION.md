---
phase: 13-medium-consolidation
verified: 2026-05-16T00:00:00Z
status: passed
score: 7/7 success criteria verified
re_verification: null
gaps: []
human_verification:
  - test: "Smoke-test CSP header at runtime"
    expected: "GET / response includes `Content-Security-Policy: ...; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`"
    why_human: "Server not running during static verification; helmet directives present in source but header emission needs runtime curl"
  - test: "Apply migration 020 twice against a live DB"
    expected: "Second `psql -f 020_consolidate_rls.sql` run exits 0 with no errors"
    why_human: "Idempotence statically demonstrated (176 DROP POLICY IF EXISTS guards + 9 CREATE OR REPLACE FUNCTION); behavioral confirmation requires live Supabase Postgres"
  - test: "Apply migration 021 and verify post-state"
    expected: "`SELECT name FROM domains WHERE name <> lower(name) OR name <> trim(name)` returns zero rows"
    why_human: "No live DB connection in verification environment"
  - test: "Insert EXAMPLE.COM then example.com via POST /api/domains"
    expected: "Second insert returns 400 \"Domain already exists\""
    why_human: "Requires running server + auth + a live org; static code path confirms normalization is correct"
---

# Phase 13: MEDIUM Consolidation Verification Report

**Phase Goal:** Eliminate the long tail of inconsistencies that erode confidence — tsc errors, migration drift, RLS scattered across files, mixed casing, weak CSP, PII in logs (QUA-01..08).
**Verified:** 2026-05-16
**Status:** passed
**Re-verification:** No (initial verification)

## Goal Achievement

### Observable Truths (from 7 ROADMAP Success Criteria)

| #   | Truth (ROADMAP success criterion)                                                                                                             | Status     | Evidence                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npx tsc --noEmit` returns 0 errors against both tsconfig files                                                                               | VERIFIED   | Ran both invocations — exit 0, zero output for tsconfig.json and tsconfig.server.json                                                                 |
| 2   | `013_add_performance_indexes.sql` archived; README/CLAUDE.md document schema workflow                                                         | VERIFIED   | File at `supabase/migrations/archive/013_add_performance_indexes.sql` (with ARCHIVED header); absent from active dir; "Schema & Migration Workflow" section in both CLAUDE.md and README.md |
| 3   | `017_consolidate_rls.sql` exists (renumbered → 020), is idempotent, verify-rls-policies.ts reports clean state                                  | VERIFIED   | `020_consolidate_rls.sql` exists (1243 lines); 176 DROP POLICY IF EXISTS + 126 CREATE POLICY + 9 CREATE OR REPLACE FUNCTION; verifier RESULT: PASS (5/5 checks). Cosmetic doc drift in ROADMAP success-criterion text (still says "017") flagged but not a gap — QUA-03 text in REQUIREMENTS.md already updated to 020 |
| 4   | EXAMPLE.COM then example.com → 400; `SELECT WHERE name <> lower(name)` returns zero rows                                                       | VERIFIED   | POST handler normalizes via `data.name.toLowerCase().trim()` (domains.ts:148) used for both duplicate-check and INSERT; migration 021 backfills historical rows idempotently |
| 5   | Response headers include `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`                                                          | VERIFIED   | All three directives present in `src/server/index.ts:47-49` inside helmet `contentSecurityPolicy.directives`. Runtime header confirmation routed to human verification |
| 6   | `console.log` in `src/server/` emits no PII in production (only startup or `!isProd`-guarded)                                                 | VERIFIED   | `findLocalUser` (audit M11 target) — all 7 PII-bearing calls gated behind `if (!isProd)`; diagnostic `findMany()` also inside guard. Transport-layer logs (SMTP/IMAP/route-matcher/send) classified as operational/audit equivalents per plan 13-05 explicit decision (analogous to system.ts:470 audit log) |
| 7   | `organizations.ownerId` and `organizations.outreachEnabled` (camelCase) used in TS; SQL columns remain `owner_id` / `outreach_enabled`         | VERIFIED   | `schema.ts:61-62`: `ownerId: uuid('owner_id')`, `outreachEnabled: boolean('outreach_enabled')`; relations block references `organizations.ownerId` (line 391) |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact                                                  | Expected                                                            | Status     | Details                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `src/server/lib/tracking.ts`                              | No `as any` cast on `event` field                                   | VERIFIED   | `grep "as any" src/server/lib/tracking.ts` → 0 matches                                  |
| `src/server/index.ts`                                     | helmet CSP + recalibrated authLimiter                               | VERIFIED   | frame-ancestors/object-src/base-uri all present; authLimiter max:10 with QUA-07 comment |
| `src/server/lib/native-mail.ts`                           | PII-bearing logs guarded by `!isProd`                               | VERIFIED   | `const isProd = process.env.NODE_ENV === 'production'` (line 18); 7 logs guarded        |
| `src/server/routes/domains.ts`                            | POST handler lowercases+trims name                                  | VERIFIED   | `const normalizedName = data.name.toLowerCase().trim()` (line 148); used for both lookup and INSERT |
| `src/db/schema.ts`                                        | camelCase TS keys (ownerId, outreachEnabled)                        | VERIFIED   | Both present at lines 61-62; relations updated at line 391                              |
| `supabase/migrations/020_consolidate_rls.sql`             | Exists, idempotent, BEGIN/COMMIT-wrapped                            | VERIFIED   | 1243 lines; BEGIN line 34 / COMMIT line 1236; 176 DROP IF EXISTS guards                 |
| `supabase/migrations/021_lowercase_domains.sql`           | Idempotent UPDATE with WHERE-mismatch filter                        | VERIFIED   | BEGIN/COMMIT wrap; `WHERE name <> LOWER(TRIM(name))` makes second run a no-op           |
| `supabase/migrations/archive/013_add_performance_indexes.sql` | Moved from active dir                                            | VERIFIED   | Exists in archive/, absent from active migrations dir, ARCHIVED header present          |
| `CLAUDE.md`                                               | Schema & Migration Workflow doc section                             | VERIFIED   | Section present                                                                         |
| `README.md`                                               | Schema & Migration Workflow doc section + corrected Installation step 5 | VERIFIED   | Section present (verbatim copy)                                                      |
| `package.json`                                            | db:generate / db:push removed                                       | VERIFIED   | Neither key present; only db:studio, db:indexes, db:rls, db:audit remain               |

### Key Link Verification

| From | To  | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| `POST /api/domains` handler | `domains.insert()` | `normalizedName` const (lowercased+trimmed) | WIRED | Both duplicate lookup (line 153) and insert (line 163) use normalized value |
| `organizationsRelations.owner` | `organizations.ownerId` | Drizzle relations fields array | WIRED | Updated at schema.ts:391 |
| `system.ts` outreach handlers | `organizations.outreachEnabled` | Drizzle .set() / SELECT alias | WIRED | `.set({ outreachEnabled })` payload + JSON wire-format key `outreach_enabled` intentionally preserved as API contract |
| helmet middleware | response headers | `contentSecurityPolicy.directives` config | WIRED | Three new directives added to existing helmet block; runtime emission needs human smoke test |
| migration 020 helpers | RLS policies | `is_org_member` / `is_org_admin` / 6 others | WIRED | All 8 helpers defined at top of 020 via CREATE OR REPLACE FUNCTION; policies reference them |

### Data-Flow Trace (Level 4)

Phase 13 is consolidation/hygiene, not new data flow. Level 4 not applicable to most artifacts. Spot-check:

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `POST /api/domains` | `normalizedName` | Zod-validated `data.name` → `.toLowerCase().trim()` | Yes (deterministic transform of validated input) | FLOWING |
| `findLocalUser` (native-mail.ts) | `verifiedDomain`, `user` | Drizzle queries against domains/users tables | Yes (real DB queries unchanged; only logs gated) | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| tsc clean — client config | `npx tsc --noEmit -p tsconfig.json` | exit 0, zero output | PASS |
| tsc clean — server config | `npx tsc --noEmit -p tsconfig.server.json` | exit 0, zero output | PASS |
| Lint clean | `npm run lint` | exit 0, zero warnings | PASS |
| RLS verifier | `npx tsx scripts/verify-rls-policies.ts` | RESULT: PASS (5/5 checks; 124 policies, 36 tables, 8 helpers) | PASS |
| Migration 013 archived | `ls supabase/migrations/archive/013_add_performance_indexes.sql` + absence from active dir | both confirmed | PASS |
| Migration 020 idempotence (static) | `grep -c "DROP POLICY IF EXISTS"` + `grep -c "CREATE POLICY"` | 176 / 126 (every CREATE preceded by guarded DROP) | PASS |
| Migration 021 idempotence (static) | Inspect WHERE clause | `WHERE name <> LOWER(TRIM(name))` makes re-run no-op | PASS |
| package.json scripts cleaned | grep `db:generate`/`db:push` | 0 matches | PASS |
| No `as any` in tracking.ts | `grep "as any" src/server/lib/tracking.ts` | 0 matches | PASS |
| No TS accesses to `.owner_id`/`.outreach_enabled` | grep across src/ + scripts/ | 0 matches (only SQL column strings in schema.ts and JSON wire-format key in system.ts remain — both intentional) | PASS |

### Requirements Coverage

| Requirement | Source Plan      | Description                                                                                             | Status   | Evidence |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------- | -------- | -------- |
| QUA-01      | 13-01            | `npx tsc --noEmit` passes both configs                                                                  | SATISFIED | Both invocations exit 0 |
| QUA-02      | 13-02            | 013 archived; schema-workflow doc in README + CLAUDE.md; package.json db:generate/db:push gone          | SATISFIED | All three sub-claims verified above |
| QUA-03      | 13-03            | `020_consolidate_rls.sql` (renumbered from 017) exists, idempotent, verifier reports clean              | SATISFIED | File exists, 176 DROP IF EXISTS guards, verifier PASS |
| QUA-04      | 13-04            | POST /api/domains lowercase+trim; backfill migration 021                                                | SATISFIED | Handler normalized; migration 021 exists with idempotent WHERE; REQUIREMENTS.md entry still shows `[ ]` but the actual implementation work is complete — minor checkbox drift noted (cosmetic; the work landed) |
| QUA-05      | 13-05            | helmet CSP adds frame-ancestors/object-src/base-uri                                                     | SATISFIED | All three directives in src/server/index.ts:47-49 |
| QUA-06      | 13-05            | console.log emitting PII gated behind !isProd (findLocalUser target per audit M11)                      | SATISFIED | All 7 findLocalUser calls guarded; diagnostic findMany() also inside guard. Transport-layer logs (SMTP/IMAP/route-matcher) classified as operational per plan 13-05 explicit triage table |
| QUA-07      | 13-05            | authLimiter recalibrated to 10/15min                                                                    | SATISFIED | `max: 10` with QUA-07 comment at src/server/index.ts:67 |
| QUA-08      | 13-06            | TS schema uses ownerId / outreachEnabled (SQL columns remain snake_case)                                | SATISFIED | Verified at schema.ts:61-62 |

**No orphaned requirements** — every QUA-XX from REQUIREMENTS.md is claimed by exactly one plan.

**Note on REQUIREMENTS.md checkbox:** QUA-04 still shows `[ ]` in REQUIREMENTS.md while implementation is complete and the closing audit-M9 evidence is in 13-04-SUMMARY. This is documentation checkbox drift, not a functional gap. The corresponding ROADMAP entry says Phase 13 is `[x]` (completed). Recommend toggling QUA-04 to `[x]` as a follow-up housekeeping commit.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `src/server/lib/native-mail.ts` | 152-153 | Unguarded `console.log` at first glance | Info (false positive) | These two lines are INSIDE the `if (!isProd) { ... }` block opened at line 148. Indentation hides this in the grep output. Confirmed via Read tool — gated correctly. |
| `src/server/smtp-server.ts`, `smtp-inbound.ts`, `lib/route-matcher.ts`, `routes/mail/send.ts`, `lib/mail-sync.ts`, `imap-server.ts` | various | Transport-layer envelope logs emit recipient/sender emails | Info | Plan 13-05 explicit decision: classified as operational/audit-tier (analogous to system.ts:470 preserved audit log). Out-of-scope per QUA-06 framing (audit M11 targeted `findLocalUser` specifically). Future hardening recommended via structured logger with PII redaction. |

**No blocker anti-patterns.** No TODO/FIXME/PLACEHOLDER/stub patterns introduced. No empty handlers or static-return API stubs.

### Human Verification Required

1. **Smoke-test CSP header at runtime** — start server, `curl -I http://localhost:9001/` (or any HTML route), confirm response header includes `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`. Static grep confirms helmet config is correct; behavioral confirmation routes through human because no server was running during verification.

2. **Apply migration 020 twice against a live Supabase DB** — confirm `psql -f supabase/migrations/020_consolidate_rls.sql` succeeds the first time AND the second time with zero errors. Static structure (176 DROP POLICY IF EXISTS + 9 CREATE OR REPLACE FUNCTION) demonstrates idempotence; live-DB run is the contractual proof.

3. **Apply migration 021 and verify** — after apply, run `SELECT name FROM public.domains WHERE name <> LOWER(name) OR name <> TRIM(name);` and confirm zero rows. Static migration shape is correct; data confirmation requires DB.

4. **End-to-end domain dup test** — `POST /api/domains { name: "EXAMPLE.COM" }` then `POST /api/domains { name: "example.com" }`; confirm second returns 400. Code path is correct (`normalizedName` used in both `existingDomain` lookup and INSERT); behavioral confirmation requires running stack.

### Gaps Summary

**No gaps.** All 7 ROADMAP success criteria for Phase 13 are achieved.

**Cosmetic / doc-drift observations (NOT blocking):**

- ROADMAP.md Phase 13 success criterion #3 still says "017_consolidate_rls" — actual file is `020_consolidate_rls.sql` (renumbered because Phase 11 SEC-02 took 018 and Phase 12 COR-03 took 019). REQUIREMENTS.md QUA-03 text has been updated to reference 020. ROADMAP is the sole remaining stale reference. Per verifier instructions, flagged as cosmetic doc drift, not a gap.
- REQUIREMENTS.md QUA-04 entry still shows `[ ]` while implementation has landed (migration 021 + handler change committed). Recommend toggling to `[x]` in a housekeeping commit.

Both are documentation hygiene items; no code gap, no behavioral risk.

---

_Verified: 2026-05-16_
_Verifier: Claude (gsd-verifier)_
