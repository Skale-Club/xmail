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

“Complete” means implemented and locally validated. Production remains a separate release action:
apply migrations 045–049, configure the Apollo secret, deploy Xmail, rotate/create the Hermes
credential, and perform the controlled-recipient smoke path in the runbook.
