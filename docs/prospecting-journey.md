# Prospecting journey and cost ledger

How a prospecting run records what happened to it, what it cost, and what the next
run should learn from it.

## The problem this solves

Before this, a run that found nothing recorded `discovered_count: 12,
rejected_count: 10, last_error: null` — indistinguishable from a lukewarm run that
worked. The single most valuable output of a failed run is the reason it failed, and
that was exactly what got thrown away. `last_error` is one overwritten text column, so
even the errors only survived one at a time.

The worked example that drove the design: prospecting barbershops in Massachusetts.
Apollo is a B2B contact database built around companies with domains and LinkedIn
presence. Barbershops are 1–3 person businesses, frequently with no domain at all. The
run is expected to return few people, mostly without usable email. The lesson — *this
source does not cover micro-local business* — is worth more than the leads, and it was
the one thing the system could not record.

## Three layers, deliberately separated

| Layer | Written by | Table |
| --- | --- | --- |
| **Facts** — what happened, as it happened | application code, no LLM | `prospecting_run_events` |
| **Outcome** — what it produced, weeks later | recompute job | `prospecting_runs.outcome_*` |
| **Cost** — what it consumed | ledger writes at each metered call | `outreach_cost_entries` |

Narrative prose is **generated on demand from these**, never stored as the source of
truth. A stored retrospective drifts from the facts and cannot be regenerated with a
better model later.

## Facts: the event stream

`prospecting_run_events` is append-only, ordered by a dedicated sequence, one stream
per run.

The important design rule: **`code` is a machine value, not prose.** `provider.zero_results`,
`enrich.no_email`, `score.candidate_below_threshold`. Prose can be read; only codes can
be aggregated. `GROUP BY code` across fifty runs turns into *"`enrich.no_email` fired
380 times in local-business segments"* — that is a learnable signal. Free text never
becomes one.

`phase` is **derived from the code**, never passed in, so a caller cannot record a
mismatched phase/code pair. Severity comes from an explicit override map, not from
sniffing substrings.

Both `recordRunEvent` and `recordCost` are **telemetry and must never break their
caller**: every database failure is caught and returned, never thrown. A failure to
record the story must not fail the prospecting.

Per-candidate events are batched (`recordRunEvents`) — a 100-candidate run costs one
round trip, not a hundred.

## Outcome: recomputed, never incremented

`measureProspectingOutcomes` runs every 6 hours and **recomputes** each run's
`outcome_*` counters from the source tables. It does not consume the event outbox and
keeps no cursor.

That choice is the point: recomputation is idempotent and self-healing. A missed event,
a replayed one, or a job that died halfway cannot corrupt the totals, because the next
pass derives them from scratch. There is no cursor to lose and no drift to reconcile.
Runs are few, so the cost is trivial.

The join walks `prospect_candidates.lead_id → leads → campaign_leads → outreach_emails`.
Attribution filtering and per-lead deduplication happen in a **pure function**
(`aggregateRunOutcomes`), not in SQL, so the rules that matter most are unit-testable
without a database.

Journey events (`outcome.*`) are emitted **only for metrics that actually changed**.
Re-emitting identical outcome events every six hours would drown the narrative in noise.

This is the layer that closes the loop: a reply arriving three weeks after the run walks
back and credits the filters that sourced it. Without it the system documents but does
not learn.

## Cost: micros, and frozen at write time

Two decisions worth understanding before touching this.

**Micros, not cents.** Costs are stored in USD micros (1e-6 USD) because per-token LLM
prices are a small fraction of a cent and a cents-denominated column rounds real spend
to zero.

**Entries freeze their price.** `outreach_cost_entries` copies `unit_cost_micros` onto
the row at write time. The price book (`outreach_cost_rates`) can then change without
rewriting what past runs cost.

### Changing a price

**Insert a new rate row with a later `valid_from`. Never `UPDATE` an existing rate.**

Rate resolution is deterministic: an org-specific row beats a platform default
(`organization_id IS NULL`); the validity window must contain the timestamp; when
several still match, the greatest `valid_from` wins. The table intentionally permits
overlapping windows, and that tie-break is what keeps the answer unambiguous.

### What is priced today

| Category | Status |
| --- | --- |
| `inbox_subscription` | icemail, USD 2.50/inbox/month. 5 inboxes ⇒ **USD 12.50/month**, posted by the monthly amortization job |
| `lead_source` | provider-agnostic (renamed from `apollo_credits` in migration 054 — the real production source is xcraper/Apify, not Apollo). An xcraper run posts its **actual** reported cost via `amountMicrosOverride`, not a rate-book estimate; Apollo enrichment still posts an estimated ceiling and remains otherwise unpriced |
| `email_verification` | MillionVerifier at USD 0.0037/credit — the 10k entry package (migration 056, superseding 055's 0.0005). **An estimate, not a confirmed purchase**: tiers span ~8× and stacking bonuses (+10% auto top-up, 1M free per 5M) put the true effective rate below any sticker. Chosen because it is the likeliest tier at pilot scale and errs high, so spend can only be overstated. **Quantity must be credits the provider reports as consumed, not emails submitted**: MillionVerifier charges only for conclusive results, never for risky (unknown/catch-all) ones |
| `llm_tokens` | rate not yet seeded; Kimi is a flat plan (`amortized`, ~0 marginal), the OpenRouter fallback is per-token |
| `domain`, `infrastructure` | not yet priced |

Unpriced usage is **still written**, with zeros and `detail.rate_missing = true`. Absent
prices must be visible, not silently missing from the ledger. Guessing a price would
produce a confident report that is wrong, which is worse than an incomplete one.

Inbox cost is amortized monthly at a full month per inbox with no proration, keyed
`inbox:<accountId>:<YYYY-MM>` so re-running mid-month writes nothing.

## Attribution: the rules that keep the numbers honest

These three exist to stop the learning loop from teaching itself something false.

**1. Only `imported_as = 'created'` counts.** Lead import uses
`onConflictDoNothing` on `(organization_id, email)`, so an accepted candidate may
resolve to a lead an *earlier* run already sourced. `prospect_candidates.imported_as`
records which happened. Crediting an `'existing'` candidate would let two runs claim the
same human. Rows with `imported_as IS NULL` predate the column and are excluded too —
we cannot prove they were new.

**2. The denominator is leads actually emailed, never leads imported.** A lead that was
imported but never sent to is not a lead that "did not reply". Counting it as one
understates every reply rate.

**3. Small samples report uncertainty, not a point estimate.** Reply rate is reported as
a Wilson 95% interval. One reply in twelve is `[1.5%, 35.4%]` — a spread that correctly
says *there is no signal here*. Without this, the system learns superstition from its
first run and repeats it forever.

Lead email is normalized explicitly at the import boundary, and migration 052 adds a
`CHECK (email = lower(email))` guarantee. The path was already safe, but only because
the Apollo provider happens to lowercase upstream — a second provider that does not
would silently produce duplicate leads and false `'created'` attributions.

## The advisory: learning that cannot be skipped

Prior-run statistics are returned **in the response of `POST /prospecting/searches`** —
the call the agent already makes — rather than in a separate endpoint it has to remember
to query. An optional lookup gets skipped; a field in the response you already receive
does not.

```jsonc
"advisory": {
  "similar_runs": 3,
  "scope": "similar",              // "similar" | "organization" | "none"
  "sample": { "imported": 112, "emailed": 98, "replied": 2, "bounced": 6,
              "verified_email_rate": 0.08 },
  "reply_rate": { "point": 0.020, "low": 0.006, "high": 0.071, "n": 98 },
  "warnings": [
    { "code": "segment_low_email_yield",
      "evidence": "8% verified/likely across 112 candidates (n=112)" }
  ]
}
```

Runs are "similar" when their search filters share a normalized token. With no similar
runs it falls back to organization scope; with no prior runs at all, `scope: "none"` and
no warnings.

`insufficient_data` (fewer than 30 leads emailed) is emitted **instead of** any
performance warning, never alongside one.

Every warning's `evidence` states its sample size, so a reader can always discount it.

The advisory never blocks or delays a run: any failure falls back to an empty advisory.

### Known limitation

The advisory is returned on the `201` (run created) path only. An idempotent replay
(`200`/`202`, `idempotentReplay: true`) does not carry it. This is defensible — the
advisory is a *pre-flight* signal and on a replay the search already ran — but it does
mean a client that lost the original response never sees it.

## The hypothesis field

`prospecting_runs.hypothesis` is stated **before** the run:

```json
{ "premise": "barbershops in MA respond to an online-booking offer",
  "expected": { "discovered": ">=50", "verified_email_rate": ">=0.4", "reply_rate": ">=0.03" },
  "basis": "none — first run in this segment" }
```

Without it, every retrospective is written already knowing the result, which is
hindsight bias with extra steps. With it, the outcome layer reports **deviation from
expectation**: *"expected 40% verified email, got 8%"* is a self-contained lesson that
needs no narrator. The barbershop run stops being "lukewarm" and becomes *hypothesis
refuted, decisively* — which is high-value information.

It is advisory only. Nothing in the pipeline branches on it.

## Reading a run's story

```sql
-- the narrative, in order
SELECT sequence_number, phase, level, code, summary, detail
FROM prospecting_run_events WHERE run_id = $1 ORDER BY sequence_number;

-- what it cost
SELECT category, basis, sum(amount_micros)/1e6 AS usd
FROM outreach_cost_entries WHERE run_id = $1 GROUP BY 1, 2;

-- what recurs across runs (the actual learning query)
SELECT code, count(*) FROM prospecting_run_events
WHERE organization_id = $1 AND level IN ('warn','error')
GROUP BY 1 ORDER BY 2 DESC;
```

## Migrations

| | |
| --- | --- |
| `051_prospecting_journey_and_costs.sql` | hypothesis, outcome counters, `imported_as`, assessment tokens, run events, cost rates + entries |
| `052_lead_email_normalization.sql` | `CHECK (email = lower(email))` on leads |
| `053_seed_cost_rates.sql` | seeds the icemail inbox rate |

All three are validated but **not yet applied**. They were verified by running them in
sequence against the real production schema inside a transaction and rolling back,
including a negative test proving the `CHECK` rejects mixed case and an end-to-end pass
proving the inbox total resolves to exactly USD 12.50.
