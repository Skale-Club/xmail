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

“Complete” means implemented and locally validated. Production remains a separate release action.

**Migrations: done.** As of 2026-08-13 the schema ledger is reconciled — every migration through
`050_campaign_content_language.sql` is registered in `supabase_migrations.schema_migrations`, and
`node scripts/apply-pending-migrations.mjs` reports nothing pending. The 045–049 objects were
already present in production; the run only backfilled the ledger, which had stopped recording at
`022` for everything applied out-of-band via `psql -f`.

Still outstanding for the production release: configure the Apollo secret, deploy Xmail,
rotate/create the Hermes credential, and perform the controlled-recipient smoke path in the runbook.
