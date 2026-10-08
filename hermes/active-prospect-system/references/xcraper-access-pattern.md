# Xcraper Access Pattern | How Hermes Uses Xcraper

**Status:** Updated 2026-10-08. Hermes drives Xcraper through its machine-to-machine service API. Google Maps extraction defaults exclusively to Vanildo's Home Lab.

## Non-negotiable extraction rule

- Every Google Maps `POST $XCRAPER_SERVICE_URL/scrape` MUST include:

```json
{"scrapeType":"homelab","niche":"barbershop"}
```

- `niche` is required by the service API. Use the business type as a lowercase singular slug such as `barbershop` or `nail_salon`. Missing or invalid niche returns 400; never guess after the run.
- Never omit `scrapeType`. An omitted value can fall back to Apify and fail or incur cost.
- `standard` and `enriched` are Apify-backed modes. Use either one only when Vanildo explicitly requests that mode for the current run.
- Do not use Apify modes for testing, comparison, fallback, or diagnosis without that explicit request.
- Home Lab extraction already collects company-site email addresses, so `enriched` is not needed for email discovery.

## Why this is the default

The Home Lab is Vanildo's own computer and does not create third-party scraping charges. Apify is paid, and its free balance was effectively exhausted on 2026-10-07. The Home Lab path was tested end-to-end through Xcraper and successfully pushed results into Xphere.

## Service boundary

- Talk only to Xcraper through `$XCRAPER_SERVICE_URL` (normally `https://xcraper.skale.club/api/service`).
- Authenticate with `X-Service-Key: $XCRAPER_SERVICE_KEY`.
- Never call `scraper.skale.club` directly. It is protected by Cloudflare, and only Xcraper owns the worker credential.
- Never inspect the Xcraper website bundle, source code, or GitHub to rediscover routes. This document is authoritative for the automation path.
- Do not use the Xcraper web UI, request browser cookies, or call Apify directly.

## Endpoints

### Start a Home Lab run

```http
POST $XCRAPER_SERVICE_URL/scrape
X-Service-Key: $XCRAPER_SERVICE_KEY
Content-Type: application/json

{
  "query": "barbershops",
  "location": "Waltham, Massachusetts, USA",
  "maxResults": 10,
  "scrapeType": "homelab",
  "niche": "barbershop",
  "hypothesis": {
    "premise": "Barbershops in Waltham need better online booking",
    "expected": { "discovered": ">=10" },
    "basis": "Nearby unprocessed city in the current pilot"
  }
}
```

The response includes `searchId`, `status`, queue information, and `poll`.

### Poll a run

```http
GET $XCRAPER_SERVICE_URL/scrape/<searchId>
X-Service-Key: $XCRAPER_SERVICE_KEY
```

Poll approximately every 20 seconds until a terminal state. A completed response includes saved-result counts and the Xphere push result.

### Idempotent Xphere push

```http
POST $XCRAPER_SERVICE_URL/scrape/<searchId>/push
X-Service-Key: $XCRAPER_SERVICE_KEY
```

Use only when the completed run did not auto-push or when verifying/retrying an idempotent push.

## Queue discipline

- The Home Lab processes one extraction at a time and can queue additional runs.
- The queue advances automatically every 2 minutes. Polling is for monitoring and collecting final state; it is no longer required to advance queued work.
- When several cities are submitted, continue monitoring until the last queued city reaches a terminal state.
- If the start response says the run is queued, monitor that same `searchId`. Never resubmit it.
- Do not start a replacement merely because monitoring was interrupted; first read the existing run by `searchId`.
- A job queued for more than 24 hours expires.

## Runtime expectations and failures

- Slow execution is normal: roughly a few minutes for 10 results, 10-15 minutes for 50, and 20-30 minutes for 100.
- `running` with `progress: 50` unchanged is not, by itself, evidence of a stuck job.
- Never monitor a Home Lab run with a command or timeout that stops after 3 minutes. Use durable/background monitoring or a timeout suitable for the requested count.
- A run lasting roughly more than 40 minutes is marked failed by the service.
- An HTTP 502 response that mentions the Home Lab means it is offline. Notify Vanildo and do not switch to Apify.

## Search planning

- Inspect recent Xcraper/Xmail Journeys before choosing a city.
- Infer the next sensible nearby city from the active campaign context when niche and region are already clear.
- Prefer 20-50 results per city for normal operation. During explicit preflight, 10 is appropriate.
- Repeat a city only for a changed geographic/semantic slice or an operator-requested refresh. An unchanged query soon after a completed run is expected to return the same businesses.
- For a large city, record each neighborhood/query slice so it is not repeated accidentally.

## Provenance and verification

Before reporting success, verify:

1. The start response identifies `scrapeType: homelab` and echoes the intended niche.
2. The same `searchId` reaches `completed`.
3. The completion response reports saved results.
4. The Xphere result reports a successful push.
5. Xmail Journey identifies `provider: xcraper`, the Home Lab template/actor and the niche.

The response can still use the legacy field name `apifyRunId` for a Home Lab worker UUID. That field alone does not prove Apify was used; trust `scrapeType` plus Journey provenance.

## Platform-email suppression

Booking-platform addresses are not company-owned prospect emails. Xcraper/Xphere classifies addresses such as Booksy, Vagaro, Square, Squire and the other configured platform domains as `platform_email`.

A `platform_email` address never counts as the business's email, is not verified, is not imported into Xmail and is not enrolled in outreach. Do not override this suppression.

## Read-back and downstream workflow

Use Xphere MCP for per-prospect review, email status, web-presence classification, scoring and outreach eligibility.

```text
Xcraper service API
  -> Home Lab Google Maps extraction
  -> contacts saved in Xcraper
  -> automatic Xphere push as lifecycle_stage=prospect, source=xcraper
  -> Xphere analysis and platform-email suppression
  -> Hermes triage and recommendation
  -> inactive Xmail staging
  -> formal human approval before campaign activation
```

The Xphere integration key is stored per Xcraper user under Xcraper Profile -> Xphere Integration. If the push reports `not configured`, Vanildo must configure that integration in the panel.
