---
phase: 23
phase_name: ai-inbox-automation-and-guardrails
reviewed_at: "2026-07-16T19:30:00Z"
reviewers: 3 (AI send-path safety, tenant-isolation/audit-redaction, requirements verification)
range: 0ee07f8..295f41a
status: fixes_required
findings: 1 critical, 1 milestone-gate gap, 4 minor
---

# Phase 23 Code Review

Three independent reviewers over `git diff 0ee07f8..HEAD` (18 commits, ~9200 insertions). This is the
final and highest-stakes phase (autonomous AI sending).

**The AI safety architecture is genuinely well-built and mostly clean.** The tenant-isolation/audit
lens found ZERO findings (cross-tenant context, audit reads, secret storage, DTO redaction, settings
scope, injection all sound). The send-path lens confirmed: `executeInboxSendCommand` is the sole path
to the wire from an autonomous decision (AI modules import zero send primitives — grep = 0); the
suggestion path is structurally incapable of sending; recipients/account come from the persisted
thread not the model; the model's proposal is stripped to `{action,subject,body,outcome,followUpMinutes}`;
untrusted bodies are fenced; effective autonomy is a re-checked default-off intersection of
org+campaign+unpaused; Xphere is fail-closed; ambiguous outcomes are held-not-resent; retries are
bounded. The eval suite drives the REAL functions (not trivial mocks) and its 51 assertions genuinely
prove the four adversarial classes (immediate-send, cross-tenant exfiltration, recipient hijack,
policy-denial override) result in no send. The verifier confirmed all six requirements AI-01..06 on
code+test evidence.

The two blocking items are a guardrail that silently does nothing and a non-deterministic suite.

## CRITICAL

### C-1 — The `max_autonomous_follow_ups` per-thread ceiling is inoperative; autonomous AI replies are effectively uncapped

`src/server/lib/inbox-ai-automation-runtime.ts:325` (read as `autonomousFollowUpsSent`), enforced at
`src/server/lib/inbox-ai-automation.ts:364` (`>= max → no_action`). Root cause in the 23-03 refactor
of `processFollowUps.ts`.

The ceiling reads `campaign_leads.follow_up_count`, but **nothing increments that column anywhere in
the codebase** (verified: `grep followUpCount|follow_up_count` over `src/` returns only the schema
definition at `schema.ts:892` and the two reads at `runtime:223,325` — no write, no trigger, no
migration). The legacy direct-send job DID `set({ followUpCount: cl.followUpCount + 1 })` on each send;
that increment was deleted in this phase's refactor and never re-homed onto the new durable-command
path (the new send carries `origin:'unified_inbox'` with no campaign-lead increment).

So the check is always `0 >= N` → false for any positive N. An operator opts an org+campaign into
autonomy and sets `max_autonomous_follow_ups = 1` (or the default 2), believing the AI replies at most
once/twice per prospect thread. Because the counter is frozen at 0, **every genuine inbound prospect
reply spawns another autonomous AI send indefinitely** — an unbounded AI back-and-forth, braked only
by the coarse per-account daily limit, not the per-thread guardrail the UI advertises. (Setting the
limit to `0` still blocks via `0 >= 0`, so "disable" works — but any positive limit is silently
treated as unlimited, the more dangerous misbehavior.)

The evals miss it because `inbox-ai-automation.test.ts` / `inbox-ai-evals.test.ts` inject
`autonomousFollowUpsSent` directly into the resolution fixture — they prove the predicate works but
never exercise the production wiring that reads a never-incremented column.

**Fix:** derive `autonomousFollowUpsSent` from an actually-advancing, tenant-scoped source rather than
the dead column — e.g. `COUNT(outreach_ai_runs WHERE campaign_lead_id = … AND run_kind='autonomous'
AND status='completed' AND <resulted in a send: send_command_id/outreach_email_id present>)`, or
increment a dedicated per-lead counter when the durable command reports `sent`. Must count only
SENT autonomous replies (not drafts/failed/held), be org+lead scoped, and the ceiling test must
exercise the real counting path (drive N successful autonomous sends and assert the N+1th is
`no_action`), not an injected value.

## MILESTONE-GATE GAP

### G-1 — The full test suite is non-deterministic (fails the "run twice, identical" gate)

`src/server/routes/outreach/__tests__/campaign-sequences.db.test.ts` (Phase 20 suite).
Cold run = 898/898; two re-runs = 888/898, all 10 failures in that suite with
`relation "outreach_settings" does not exist` (500 ≠ 201). Root cause: it seeds only migration 040 in
`beforeAll` and depends on a SIBLING suite (which applies migration 024) having created
`outreach_settings` earlier in the one shared disposable database. With `fileParallelism:false`,
Vitest reorders files by cached timing across runs; Phase 23 adding `inbox-ai-migration.db.test.ts`
perturbed the sequencer and exposed the latent flake.

This is the SAME hidden-cross-suite-migration-dependency class fixed earlier this session for the
notification-policy suite (commit a87ee0b) — the convention is that every `.db` suite applies every
migration its seed touches. It is a test-harness isolation defect in a NON-AI suite (no AI-01..06 or
production impact — migration 024 is always applied in prod), but it fails the explicit milestone
criterion and contradicts the recorded "898 passed" evidence.

**Fix (root-cause, class-eliminating):** add `024_outreach_settings.sql` to
`OUTREACH_TEST_BASELINE_MIGRATIONS` in `src/test/postgres-harness.ts` so `outreach_settings` exists
for every suite (it is a small idempotent table create — low blast radius; the notification-policy
suite's own 024 apply becomes a harmless idempotent no-op). Alternatively self-seed 024 in the one
suite. After the fix, run `npm run test` at least twice (ideally 3×) and confirm identical 898/898.
While there, quickly audit for any other suite that reads a table its `beforeAll` never creates.

## Minor (fold in — small hardening)

### M-1 — The `attribution_mismatch` guard is dead code on the suggestion path
`loadInboxAiContextInput` (`unified-inbox.ts:948-963`) stamps `organizationId`/`conversationId` onto
each message from the function ARGS, not the DB row, so `buildInboxAiContext`'s "throws
`attribution_mismatch` on any foreign row" contract can never fire there — the real protection (the
org-scoped query) is present and correct, so there is no isolation gap, but the defense-in-depth guard
is inert. The autonomous runtime resolver stamps from the actual row (`inbox-ai-automation-runtime.ts:273`)
where the guard IS live. Fix: stamp from the DB row on the suggestion path too so the guard is a real
second line of defense.

### M-2 — `reloadAutonomy` default returns stale autonomy
`inbox-ai-automation.ts:426` — the pure processor's `reloadAutonomy` default
`(async () => resolution!.autonomy)` returns the STALE pre-model autonomy, defeating the
before-dispatch pause recheck. Production wires a fresh DB reader so this is latent only, but a future
caller that omits the dep silently loses the pause race. Fix: make `reloadAutonomy` a required
parameter (or make the default fail-closed / throw), so the pause recheck can't be silently skipped.

### M-3 — Within-org idempotency-key reuse across conversations replays the first draft
`inbox-ai-audit.ts:167`, `inbox-ai-suggestions.ts:162` — `createAiRun` matches on
`(organizationId, idempotencyKey)` and returns the existing run ignoring a differing `conversationId`,
so a caller reusing one client-chosen key across two of its OWN conversations replays the first
conversation's draft. Strictly within a single org, self-inflicted, never cross-tenant. Fix (optional):
include `conversationId` in the suggestion idempotency identity, or document the key-per-conversation
contract. Low priority.

### M-4 — Stale source-guard comment
`inbox-ai-automation.ts:20-21` claims "a source-level test asserts the forbidden send primitives never
appear here," but the source-guard test only covers `processFollowUps.ts`, not
`inbox-ai-automation.ts`. The module IS clean (type-only import), so this is a coverage/wording nit.
Fix: extend the source-guard test to also assert `inbox-ai-automation.ts` / `-runtime.ts` import no
send primitive (cheap, and locks the invariant), or correct the comment.

## Clean categories (recorded so they are not re-litigated)

- No AI path to a direct send; `executeInboxSendCommand` is the sole chokepoint; legacy direct-send
  retired and unreachable.
- Suggestion path structurally no-send; accept endpoint only records approval.
- Prompt injection cannot change recipient/account, trigger a send, or exfiltrate — recipients from
  persisted thread, model output stripped, bodies fenced, context org+conversation attribution-checked.
- Effective-autonomy gate: org-first intersection, re-checked at schedule + claim + before dispatch;
  campaign flag cannot override org-off/paused; defaults OFF.
- Terminal policy denial not overridable by the model; retries bounded (maxAttempts=5); ambiguous →
  held and never re-claimed.
- Eval suite drives real code; four adversarial classes genuinely asserted no-send.
- Xphere fail-closed (missing config/timeout/unreachable/non-2xx/bad-JSON/schema-fail → typed no-send,
  single 15s-timeout fetch, no retry loop).
- Lease/idempotency collapse crash/replay onto one send.
- Tenant isolation + audit/secret redaction: ALL clean (cross-tenant context/history, secret storage,
  public DTO, settings mutation scope, injection, hash references) — zero findings from that lens.
- Migration 043 idempotent, applies twice to disposable Testcontainers, NOT applied to prod, schema
  mirror matches; the two harness column-stub deviations are sound (full-043 suite still applies every
  constraint/index/RLS).

## Fix scope for this phase

Fix C-1 (critical guardrail bypass) and G-1 (suite determinism) — both block phase/milestone close.
Fold in M-1, M-2, M-4 (small hardening); M-3 optional. Re-review C-1 and G-1, confirm the suite is
deterministic (run 2-3×), then close Phase 23 and the v1.4 milestone.
