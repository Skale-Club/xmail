# Outreach + Hermes improvement roadmap

| Phase | Outcome | Status |
|---|---|---|
| 24 | Architecture, authority boundaries and rollout sequence | Complete |
| 25 | Tenant-bound, capability-scoped Hermes gateway and audit log | Complete |
| 26 | Durable ordered events for Hermes and Xphere | Complete |
| 27 | Apollo discovery, bounded enrichment, verification and deterministic ICP score | Complete |
| 28 | Durable human approvals, draft enrollment and campaign activation governance | Complete |
| 29 | Warm-up/compliance consolidation and automatic deliverability circuit breaker | Complete |
| 30 | Evidence-backed Hermes qualification/personalization with adversarial evals | Complete |
| 31 | Agent Ops UI, approval queue, candidate evidence and deliverability controls | Complete |
| 32 | Expiry/reconciliation, health metrics, MCP contract tests and operator runbook | Complete |

“Complete” means implemented and locally validated. Production verification is tracked separately.

**Production migrations: done.** As of 2026-09-05 the production ledger is reconciled through
`063_seed_native_inbox_rate.sql`. The Journey schema, cost ledger, outcome measurement,
external Xcraper run registration, and attribution fields are present in production.

> This paragraph used to cite a `056_prospecting_external_run_id.sql` as the head of the
> ledger. **No such file has ever existed** — `056` is
> `056_email_verification_rate_entry_tier.sql`, and the idempotency constraint that external
> runs actually depend on came from `046_prospecting_pipeline.sql`, generalized to
> non-Apollo providers by `054_generalize_prospecting_providers.sql`. The invented name
> survived two rounds of editing here because it *reads* plausible, which is exactly why a
> filename in prose is not evidence. Verify against `supabase/migrations/` and against
> `supabase_migrations.schema_migrations` — the same warning is recorded in
> [`docs/prospecting-journey.md`](prospecting-journey.md), and a number written down here
> goes stale the moment the next migration lands.

**Production wiring: done.** The scoped Hermes credential and Xmail MCP gateway are live, and
the Xphere/Xcraper external-run contract is implemented. The remaining action is the deliberately
controlled UAT in the runbook: create one approved run, verify its Journey facts/costs, and only
then approve a controlled-recipient outreach. No scrape or send is part of preflight validation.
