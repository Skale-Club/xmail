---
phase: 18
phase_name: outreach-safety-and-execution-reliability
status: passed
score: "6/6 requirements; 26/26 declared must-haves"
verified_at: "2026-07-16T04:14:33Z"
verifier: gsd-verifier
---

# Phase 18 Verification — Outreach Safety and Execution Reliability

## Verdict

**Passed.** The implementation satisfies the Phase 18 goal and `SAFE-01` through `SAFE-06`. This verdict is based on direct source inspection and fresh verification runs, not on the plan summaries.

The resulting execution path is fail-closed at the organization switch, only email sequence actions can dispatch, logical sends have organization-scoped idempotency plus lease-safe bounded retries, ambiguous post-dispatch outcomes are held, campaign work is selected fairly, completion uses the shared exhaustive terminal-state contract, and the automated harness exercises tenant and PostgreSQL boundaries.

## Fresh verification evidence

| Check | Result |
|---|---|
| Focused Phase 18 suites | `npm run test -- ...` — **9 files, 82 tests passed**; includes policy, sequence, dispatch, migration, scheduling, entrypoints, review regressions, inbound tenant matching, and lifecycle concurrency |
| Complete suite | `npm run test` — **12 files, 94 tests passed** across Node, jsdom, and disposable PostgreSQL projects |
| Production build | `npm run build` — **exit 0**; Vite client (2776 modules) and TypeScript server built |
| Lint | `npm run lint` — **exit 0**, zero warnings |
| Direct-provider bypass scan | Three current outreach entrypoints each reported `direct_provider_calls=0`; all three call `dispatchOutreachMessage` |
| Migration provenance | Only hand-written `supabase/migrations/038_outreach_dispatch_state_machine.sql`; no generated migration path appeared in the Phase 18 diff |
| Patch hygiene before this report | `git status --short`, `git diff --check` — clean |

The PostgreSQL tests ran through Testcontainers against a loopback database named `xmail_test_*`. Migration 038 was applied twice and its columns, constraints, indexes, lease recovery, ambiguity hold, and shared capacity reservation were asserted.

## Requirement matrix

| Requirement | Status | Evidence |
|---|---|---|
| `SAFE-01` — organization kill switch blocks every outreach dispatch | PASS | Shared policy denies disabled organizations at `src/server/lib/outreach-delivery-policy.ts:214`; dispatcher checks before claim and immediately before provider at `src/server/lib/outreach-dispatch.ts:588` and `src/server/lib/outreach-dispatch.ts:599`; pause-race test proves no provider call at `src/server/lib/__tests__/outreach-dispatch.test.ts:183`; campaign/manual/agentic entrypoints call the dispatcher at `src/server/jobs/processOutreachSequences.ts:279`, `src/server/jobs/processFollowUps.ts:133`, and `src/server/routes/outreach/send-message.ts:61`. |
| `SAFE-02` — explicit email/delay/condition semantics | PASS | `resolveSequenceAction` emits transition-only delay and quarantines condition/malformed content at `src/server/lib/outreach-sequence-state.ts:209`; activation validator rejects unsupported conditions and invalid steps at `src/server/lib/outreach-sequence-state.ts:265`, wired at `src/server/routes/outreach/campaigns.ts:655`; processor resolves before claim and handles non-send actions at `src/server/jobs/processOutreachSequences.ts:213`. Ten sequence tests passed. |
| `SAFE-03` — leases, attempts, retry classification, backoff, stale recovery, no blind duplicate | PASS | Hand-written state schema at `supabase/migrations/038_outreach_dispatch_state_machine.sql:15`; stale post-dispatch claims become `held` at `src/server/lib/outreach-dispatch.ts:307`; atomic claim/retry eligibility at `src/server/lib/outreach-dispatch.ts:322`; capacity plus dispatch start is atomic at `src/server/lib/outreach-dispatch.ts:415`; failure classification/backoff/hold is enforced at `src/server/lib/outreach-dispatch.ts:640`. Migration/dispatch tests passed, including real PostgreSQL contention. |
| `SAFE-04` — deterministic fair selection beyond a blocked 200-row prefix | PASS | SQL ranks per account and orders deterministically before the hard cap at `src/server/jobs/processOutreachSequences.ts:58`; temporal denials persist concrete eligibility timestamps at `src/server/jobs/processOutreachSequences.ts:114`; the 250+250 backlog regression is at `src/server/lib/__tests__/outreach-scheduling.test.ts:89`. |
| `SAFE-05` — completion only when every enrolled lead is terminal/complete | PASS | Exhaustive status contract at `src/server/lib/outreach-sequence-state.ts:3`; completion uses the same set and requires at least one lead at `src/server/jobs/processOutreachSequences.ts:429`; outreach tick invokes completion even with no due work at `src/server/jobs/processOutreachSequences.ts:412`; disposable-PostgreSQL lifecycle and enrollment-lock tests passed at `src/server/jobs/__tests__/outreach-campaign-lifecycle.db.test.ts:49`. |
| `SAFE-06` — automated coverage including tenant isolation | PASS | Multi-project runner at `vitest.config.ts:10`; hard database guard at `src/test/postgres-harness.ts:45`; container lifecycle at `src/test/postgres-global-setup.ts:11`; tenant-scoped inbound Message-ID tests at `src/server/jobs/__tests__/outreach-inbound-matching.db.test.ts:111`; full result: 94/94. |

## Declared must-have verification

### Plan 18-01

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Every origin receives the same explicit allow/deny decision | PASS | `OutreachOrigin` includes campaign/manual/agentic/unified_inbox and all flow through `evaluateOutreachDeliveryPolicy`; all-origin table tests at `src/server/lib/__tests__/outreach-delivery-policy.test.ts:58`. |
| Truth | Disabled organization causes no provider call | PASS | Double policy boundary plus provider spy at `src/server/lib/__tests__/outreach-dispatch.test.ts:183`. |
| Truth | Node TS and jsdom TSX tests run | PASS | Full output includes the `server` and `client` projects and both smoke fixtures. |
| Truth | DB tests are disposable and cannot fall back to production `DATABASE_URL` | PASS | Guard rejects missing marker, remote host, non-test name, and configured URL at `src/test/postgres-harness.ts:45`; 9 harness tests passed. |
| Artifact | `src/server/lib/outreach-delivery-policy.ts` | PASS | Exists and implements stable denial codes, snapshot loading, tenant ownership, suppression, window, daily/warm-up, and spacing checks. |
| Artifact | `vitest.config.ts` | PASS | Exists with mutually exclusive server/client/postgres projects. |
| Artifact | `src/test/postgres-harness.ts` | PASS | Exists; migration helpers require an explicit guarded URL. |
| Key link | delivery policy → database schema/lookups | PASS | Organization/account/campaign/lead/suppression lookups are in `src/server/lib/outreach-delivery-policy.ts:268`. |

### Plan 18-02

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Only email steps request provider dispatch | PASS | Only `send_email` carries content at `src/server/lib/outreach-sequence-state.ts:246`; processor reaches dispatcher only after union handling at `src/server/jobs/processOutreachSequences.ts:220`. |
| Truth | Delay transitions/schedules; condition fails closed | PASS | Delay branch at `src/server/lib/outreach-sequence-state.ts:229`; condition quarantine at `src/server/lib/outreach-sequence-state.ts:223`; focused sequence suite 10/10. |
| Truth | Unsupported condition prevents activation | PASS | Stable `unsupported_condition_step` issue at `src/server/lib/outreach-sequence-state.ts:289`, consumed by activation readiness at `src/server/routes/outreach/campaigns.ts:655`. |
| Artifact | `src/server/lib/outreach-sequence-state.ts` | PASS | Exists with discriminated action, activation validation, fair selection helper, and terminality contract. |
| Key link | sequence processor → `resolveSequenceAction` before claim/send | PASS | Import at `src/server/jobs/processOutreachSequences.ts:11`, call at line 213, dispatcher only at line 279. |

### Plan 18-03

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Stable organization-scoped logical-send idempotency | PASS | Unique `(organization_id,idempotency_key)` at `supabase/migrations/038_outreach_dispatch_state_machine.sql:117`; stable Message-ID derives from organization+key at `src/server/lib/outreach-dispatch.ts:232`. |
| Truth | Retryable pre-acceptance failures use bounded attempts/backoff | PASS | Classification at `src/server/lib/outreach-dispatch.ts:52`, attempt bounds in migration line 77, capped backoff at `src/server/lib/outreach-dispatch.ts:226`, scheduling at line 652. |
| Truth | Stale post-dispatch claim is held and not resent | PASS | Atomic stale hold at `src/server/lib/outreach-dispatch.ts:307`; real PostgreSQL assertion at `src/server/lib/__tests__/outreach-dispatch-migration.db.test.ts:164`. |
| Artifact | `supabase/migrations/038_outreach_dispatch_state_machine.sql` | PASS | Exists, hand-written, rerunnable where practical, applied twice in disposable PostgreSQL. |
| Artifact | `src/server/lib/outreach-dispatch.ts` | PASS | Exists with claim → recheck → capacity reservation → provider → lease-token finalize state machine. |
| Key link | dispatcher → shared policy before claim and provider | PASS | Calls at `src/server/lib/outreach-dispatch.ts:588` and `src/server/lib/outreach-dispatch.ts:599`. |

### Plan 18-04

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Campaign/manual/agentic all enter durable dispatcher | PASS | Calls at sequence line 279, follow-up line 133, manual route line 61; direct-provider scan returned zero for all three files. |
| Truth | Due work is deterministic and blocked account cannot consume batch | PASS | Per-account `ROW_NUMBER` at `src/server/jobs/processOutreachSequences.ts:64`; pure fairness regression 26-test scheduling suite passed. |
| Truth | Campaign completion recognizes `completed_at` or exhaustive terminal status | PASS | Shared terminal list line 13 and SQL at `src/server/jobs/processOutreachSequences.ts:458`; lifecycle PostgreSQL tests passed. |
| Truth | Scheduler and completion import one exhaustive contract | PASS | Both selection and completion use `TERMINAL_CAMPAIGN_LEAD_STATUSES` imported at `src/server/jobs/processOutreachSequences.ts:13`. |
| Artifact | `src/server/jobs/processOutreachSequences.ts` | PASS | Exists with fair selector, explicit sequence actions, durable dispatch, deferrals, progress CAS, and completion. |
| Key link | agentic follow-up → dispatcher with `origin=agentic` | PASS | `src/server/jobs/processFollowUps.ts:133`. |
| Key link | manual route → dispatcher with `origin=manual` | PASS | `src/server/routes/outreach/send-message.ts:61`. |

## Tenant-isolation audit

- Policy snapshot validation rejects cross-organization accounts and also rejects campaign/lead organization mismatches (`src/server/lib/outreach-delivery-policy.ts:203`).
- Manual send resolves the verified account using both `organizationId` and sender address after organization role validation (`src/server/routes/outreach/send-message.ts:44`, `src/server/routes/outreach/send-message.ts:50`).
- Reply Message-ID matching is account-scoped and joins account organization to ledger organization (`src/server/jobs/processReplies.ts:590`).
- Bounce Message-ID matching requires both account and organization (`src/server/jobs/processBounces.ts:216`).
- Inbound mutations guard the ledger row by outreach-email id, account, and organization (`src/server/jobs/processReplies.ts:627`, `src/server/jobs/processBounces.ts:247`).
- A two-tenant disposable-PostgreSQL test with the same Message-ID confirmed that reply/bounce lookup cannot cross the active account/organization boundary: 2/2 passed.

## Migration discipline

- Migration 038 is a hand-written SQL file in `supabase/migrations/`; Drizzle is only the TypeScript mirror.
- No `drizzle-kit generate`, `db:generate`, or `db:push` was run or introduced.
- Migration helpers require a guarded URL argument and never fall back to application `DATABASE_URL`.
- Migration 038 applied twice successfully to disposable PostgreSQL; schema and runtime repository contention were exercised there.
- Applying migration 038 to production remains an explicit operator/deployment prerequisite and was intentionally not performed by phase execution or verification.

## Entrypoint bypass audit

Static inspection and a fresh scan found no direct `sendOutreachEmail`, `sendThreadedReply`, `relayMessage`, or `sendMessageWithOutlook` call in:

- `src/server/jobs/processOutreachSequences.ts`
- `src/server/jobs/processFollowUps.ts`
- `src/server/routes/outreach/send-message.ts`

Provider-specific calls remain behind `src/server/lib/outreach-dispatch-provider.ts`, which is invoked only after the durable dispatch state machine's second policy check and atomic capacity reservation.

## Gaps

None found within Phase 18 scope.

## Human verification

None required to accept Phase 18. Live-provider parity, Graph/MIME behavior, and deployment migration application are explicitly deferred operational or Phase 19 concerns, not unverified Phase 18 acceptance criteria.
