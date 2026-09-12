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
| 33 | Deterministic filters before spending credit or analysis | Complete |
| 34 | Verification as a run step, cost in the ledger | Complete (nunca exercitada em produção — ver abaixo) |
| 35 | Full scorer, hypothesis calibrated by the median | Complete |
| 36 | Territory queue with a daily budget | Complete |
| 37 | Automatic import of verified leads, one-touch approval | Complete |
| 38 | Daily destination for leads without e-mail (Meta Audiences) | Complete |
| 39 | Hermes off the critical path | Complete |
| 40 | Engine silence and daily digest | Complete |

“Complete” means implemented and locally validated. Production verification is tracked separately.

Phases 33–40 are the daily prospecting engine, planned in
[`prospecting-engine-plan.md`](prospecting-engine-plan.md) on 2026-09-08 from three real runs
(Framingham, Worcester, Boston: 455 businesses, US$ 2.83, 80 sendable emails, nothing sent) and
executed between 2026-09-08 and 2026-09-12. Each phase there is anchored to something that broke
or needed a human in those runs.

**O que "Complete" ainda não quer dizer, medido em produção em 2026-09-12:**

- `prospecting_runs.verified_ok_count` é **NULL nas dez runs existentes**. A fase 34 está no
  código e nunca rodou de verdade — nenhuma run passou pelo passo de verificação ainda.
- `outreach_event_outbox` tem **zero linhas na história**. A entrega Xmail→Xphere continua sem
  nunca ter sido exercitada, exatamente como o plano já registrava.
- A fila tem **30 territórios `queued` sem nenhuma tentativa** e processa um por dia: um mês de
  fila no ritmo atual.
- Hudson (11/09) e Maynard (12/09) ficaram presos em `running` porque o Xcraper só entrega
  quando alguém faz `GET /scrape/:id`. O conserto (`c3ab0d6`) subiu e **já recuperou as duas**:
  às 17:47 de 12/09 o poll registrou as runs `b301ddcc…` (10 resultados) e `aafe53e4…` (4). A
  virada do território para `done` acontece no tick seguinte, por desenho — o passo 1 (join)
  roda antes do passo 1b (poll) no mesmo tick.

**Production migrations: done.** As of 2026-09-12 the production ledger is reconciled through
`067_dmarc_aggregate_reports.sql`. The Journey schema, cost ledger, outcome measurement,
external Xcraper run registration, attribution fields, run verification (`064`), the territory
queue (`065`) and DMARC aggregate report ingestion (`067`) are present in production.

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
