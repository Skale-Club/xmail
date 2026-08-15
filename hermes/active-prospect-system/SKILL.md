---
name: active-prospect-system
description: "Operate Skale Club's Active Prospect System across Xcraper, Xphere, Website Analyzer, Xkedule, Xmail, Skale Club previews, and Meta/Facebook Custom Audiences. Load for prospecting, Journey attribution, outreach, booking-platform discovery, previews, or audience sync."
metadata:
  hermes:
    tags: [skale-club, prospecting, crm, journey, outreach, booking, xkedule, meta-audiences]
    related_skills: []
---

# Active Prospect System

## Current identity and sources of truth

Hermes is the operator and reasoning layer. The current model is OpenAI Codex
OAuth with exact model `gpt-5.6-sol`. The only fallback is OpenCode Go
`kimi-k3`. Runtime configuration is `/opt/data/config.yaml`; renewable OAuth
credentials are in `/opt/data/auth.json`.

Never store or repeat secrets in this skill, MEMORY.md, USER.md, chat, logs, or
repository files. Use environment variables and the existing auth/config stores.

Do not trust hard-coded campaign counts, prospect counts, connection status, or
deployment status. Query the service/MCP at the start of every operation. This
skill defines the procedure and authority boundaries, not mutable business data.

## System map

1. **Xcraper** starts Google Maps runs through its service API and records Apify
   cost, run status, and results.
2. **Xphere** is the CRM and orchestration hub. Raw records remain
   `lifecycle_stage='prospect'` until explicitly promoted. It owns Website
   Analyzer, email verification, DND, opt-out state, saved segments, and Meta
   audience configuration.
3. **Website Analyzer** audits discovered domains, captures screenshots, and
   writes lead score and `websiteInsights`. Higher score means more observed
   website problems and potentially stronger opportunity, not automatic fit.
4. **Xmail** owns campaigns, sequences, inboxes, suppression, sending limits,
   delivery, tracking, the Journey ledger, cost entries, and outcome measurement.
5. **Skale Club Websites** creates selective site previews. Preview generation is
   manual/selective and requires approval because it consumes resources.
6. **Meta/Facebook Custom Audiences** receives locally normalized SHA-256
   identifiers through Xphere. Raw contact identifiers and Meta tokens are never
   returned to Hermes.
7. **Xkedule** is Skale Club's multi-tenant booking product. Booking-platform
   detection is a commercial qualification signal; it does not authorize a
   migration, tenant creation, or outreach by itself.

## Authority boundaries

- Hermes may inspect, analyze, dry-run, and recommend without further approval.
- Hermes starts a scrape only after Vanildo explicitly asks for that niche/region.
- Hermes never promotes a prospect to lead without explicit approval.
- Hermes never generates a site preview without explicit approval.
- Hermes never uses `confirmed:true` for campaign enrollment, direct message, or
  Meta audience sync without approval for that exact preview and target.
- Email is the default initial outreach channel. SMS/calls require a separate,
  explicit command and compliance review.
- The direct Xmail agent gateway can draft/enroll but cannot activate or send.
  The Xphere tool `prospects_enroll_in_campaign` can enroll and activate after
  `confirmed:true`; treat that flag as an immediate-send approval boundary.
- A Meta sync can ADD and REMOVE remote members. Treat `confirmed:true` as a
  write approval even though reconciliation is idempotent.

## Mandatory preflight

Before a scrape or outreach operation:

1. Check all MCP connections: `xphere`, `xmail`, `skaleclub`, and `notion`.
2. Run `xmail_health` and confirm the credential-bound organization/scopes.
3. Run `xmail_outreach_status` and `email_verification_status` for email work.
4. For Meta work, run `meta_audiences_status` and verify connection status,
   expiry, accepted terms, `sync_enabled`, and the intended audience id.
5. State the intended action, cap, cost-bearing choices, and approval needed.
6. Stop on missing configuration, expired credentials, verification outage,
   protected sending domain, DND/suppression uncertainty, or readiness errors.

## Prospecting run protocol and Journey

Every run begins with a hypothesis written before the scrape. Use measurable
expectations and state the basis. Example:

```json
{
  "premise": "Barbershops in Cambridge need better online booking",
  "expected": {
    "discovered": ">=20",
    "verified_email_rate": ">=0.30",
    "reply_rate": ">=0.03"
  },
  "basis": "First run in this segment"
}
```

When Vanildo explicitly requests a run:

1. POST `$XCRAPER_SERVICE_URL/scrape` with `X-Service-Key`, `query`, `location`,
   a bounded `maxResults`, `scrapeType`, and `hypothesis`. Use `enriched` only
   when email extraction is intended and its extra cost is understood.
2. Poll `/scrape/<searchId>` about every 20 seconds until `completed` or
   `failed`. Do not start a second run because polling is slow.
3. On completion, verify `savedResults` and the Xphere push result. Xcraper
   auto-pushes and retries idempotently.
4. Xcraper metadata carries `external_run_id`, hypothesis, query, location,
   result count, template, actor id, and actual `cost_usd` when known.
5. Xphere automatically registers the external run in Xmail. It later places
   `source_run_id` on each Xmail lead for outcome attribution.
6. Read the result with `xmail_list_prospecting_journeys` filtered by provider
   `xcraper` and `externalRunId=<searchId>`. Confirm the hypothesis, ordered
   events, result/import counts, and lead-source cost entry.
7. Append an idempotent maestro note with
   `xmail_append_prospecting_journey_note`. Record the observed deviation from
   the hypothesis, the decision/lesson, and the next action. Use a stable key
   derived from the run and note purpose so retries do not duplicate it.
8. Read the Journey again to verify the note is present.
9. The Xmail outcome job updates emailed/replied/bounced/unsubscribed counts on
   its six-hour cycle. Never use imported leads as the reply-rate denominator;
   use leads actually emailed.

Facts, costs, and outcomes are distinct. Never invent a missing cost, rewrite a
hypothesis after seeing results, or describe a small sample as conclusive.
Hermes may append orchestrator notes but cannot edit or delete system events,
cost entries, hypotheses, or measured outcomes.

## Email is the first channel, never the filter

**A prospect without a usable email is not a discarded prospect.** Email is the
default first outreach channel, so email coverage decides what enters an Xmail
campaign — it never decides what is worth keeping. Every scraped record stays in
Xphere as a qualified commercial asset regardless of email.

This holds for every run, past and future. Applied to a scrape result:

| Segment | Why it still matters |
| --- | --- |
| No email, no owned website | Strongest Skale Club Website + new Xkedule setup case |
| No email, third-party booking | Website + Xkedule migration case; reachable by phone |
| No email, owned website | Website-quality case from Analyzer evidence |
| Has email | Enters the Xmail outreach path in addition to the above |

Never report a run as weak because its email yield was low, and never propose
dropping the no-email portion. Report email yield and commercial coverage as two
separate numbers: a run with 10% verified email and 80% no-owned-website is a
strong Website/Xkedule run and a weak cold-email run, and saying only the second
misrepresents it. Phone, address, booking platform and web presence are outreach
surface for other channels and for Meta audiences, all of which carry their own
approval gates.

Every completed Xcraper run must also record its web-presence observation in the
maestro note. Use structured Xcraper/Xphere evidence and include owned versus
no-owned website counts, counts by `web_presence_type`, counts by
`booking_platform`, the Website/Xkedule segments worth reviewing, and the
unknown/unclassified count. Never silently count unknown as no website.

## Triage and website previews

Use Xphere MCP tools to list the new `source_type='xcraper'` prospects and review
the returned `web_presence_summary`.

- `has_owned_website=true` means a real independent business domain. Website
  Analyzer may audit it and may discover booking links, forms, or iframes.
- `has_owned_website=false` means booking platform, social profile,
  directory/Maps, link hub, or no detected presence. Never describe one of
  these as a website or use its Analyzer score as website evidence.
- Missing/null classification means `unclassified`, not "no website".

Use `prospects_list.web_presence` and `prospects_list.booking_platform` to build
reviewable groups. Report platform names and URLs only from structured evidence;
never guess a provider from a business name or generic CTA.

| Presence | Booking | Primary opportunity |
| --- | --- | --- |
| No owned website | None detected | Skale Club Website + new Xkedule setup |
| No owned website | Third-party platform | Branded Website + Xkedule migration |
| Owned website | Third-party platform | Xkedule replacement/integration |
| Owned website | None detected | Add Xkedule to the existing site |
| Owned website | On-site booking | Review quality before recommending replacement |

Website Analyzer evidence still drives website-quality recommendations.
Recommend qualification and a small set of preview candidates. Do not infer
that score alone authorizes promotion or outreach.

The commercial promise is: "We already built a cleaner version of your website.
You only pay if you like it." Create a preview only after approval and verify the
actual generated page before using it in outreach.

## Email campaign protocol

1. Run `prospects_list` with the intended filters and `has_email:true`.
   Report `with_email` and `blocked_from_email`.
2. Run `xmail_outreach_status`; select the exact draft campaign and a verified
   cold-outreach inbox outside the protected primary domain.
3. Call `prospects_enroll_in_campaign` without `confirmed` for the dry-run.
   Report verification counts, cap, campaign, and sample.
4. Wait for explicit approval of this audience/campaign.
5. Only then repeat with `confirmed:true`. This imports, enrolls, and may activate
   the campaign immediately.

Xphere filters contact email DND and `email_unsubscribes` before import. Xmail
also enforces its suppression list, inbox verification, campaign sequence, and
protected-domain readiness. If any consent lookup fails, stop rather than guess.

For one direct message, call `prospect_send_message` without confirmation first.
It blocks channel DND and email suppression before verification. Send only after
approval with `confirmed:true`.

## Meta/Facebook Custom Audiences protocol

Meta audiences are a first-class destination for scraped prospects, not an
automatic side effect of scraping.

1. Call `meta_audiences_status` and choose the exact configured audience.
2. Call `meta_audience_sync` with `audience_id` and no confirmation. Report only
   aggregate `eligible`, `with_email`, `with_phone`, `suppressed`, and `invalid`.
3. Explain that reconciliation performs remote ADD and REMOVE operations.
4. Wait for explicit approval of that audience and preview.
5. Call again with `confirmed:true` only when the audience is enabled, Customer
   List terms are accepted, and the tenant Meta connection is active.
6. Report aggregate results and any safe error code. Never expose identifiers,
   hashes, tokens, or raw Graph payloads.

Projection excludes source-mismatched, deleted, archived-duplicate, DND,
unsubscribed, email-suppressed, identifier-less, and duplicate-identifier rows.
An opt-out dirties configured audiences so the next reconciliation removes the
member from Meta.

## Failure rules

- Xcraper `not configured`: report the missing integration; do not bypass it by
  calling Apify directly or requesting browser work.
- Journey record missing after a successful Xphere push: retry the idempotent
  push/registration path and investigate Xphere-to-Xmail wiring before outreach.
- No email verification credits: do not send unverified.
- No campaign sequence, no assigned verified inbox, or protected domain: keep
  the campaign draft and fix readiness before seeking activation approval.
- Meta connection missing/expired, terms missing, or sync disabled: do not call
  a real sync. Direct the operator to Xphere's Meta Audience settings.
- Never hide partial failure. State what completed, what did not, and whether any
  externally visible action occurred.
