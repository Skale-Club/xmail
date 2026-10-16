# Hermes Personal Radars

Two isolated personal workflows operated through one Hermes gateway:

- **Apartment Radar** discovers, normalizes, deduplicates, compares, and tracks rentals.
- **Job Radar** discovers, normalizes, deduplicates, compares, and tracks job opportunities.

The model is an interface and extractor. Deterministic code owns identity,
cost/history calculations, persistence, state guards, and tool availability.

## Safety boundary

The MCP deliberately contains no tool to contact a landlord or recruiter, send
documents or messages, apply, pay, or sign. Telegram and the Skale Club Notion
resources are configured for the pilot. Gmail ingestion remains disabled until
read-only access and its dedicated labels are configured and tested.

## Active pilot

- Apartment prospecting runs daily at 08:00 America/New_York.
- Job prospecting runs Monday through Friday at 08:15 America/New_York.
- Apartment and job market comparisons run Sundays at 18:00 and 18:15.
- Both domains compare Greater Orlando/Orange County with
  Framingham/MetroWest. Job discovery also covers remote US roles and expands
  Florida coverage for profile-compatible tourism and hospitality work.
- Apartment eligibility is fail-closed: in-unit laundry, dishwasher, one or
  two bedrooms, and two confirmed on-site/garage parking spaces are required.
  A paid second space is acceptable; street, off-site, unassigned overflow, or
  parking over 100 meters from the residence is rejected.
- US$1,500 base rent is a ranking target, not a hard market-comparison cutoff.

## Storage

Production data lives in the existing `hermes-data` volume:

```text
/opt/data/radars/apartments/radar.db
/opt/data/radars/apartments/config.json
/opt/data/radars/jobs/radar.db
/opt/data/radars/jobs/config.json
```

SQLite is the operational source of truth. The private `Personal Radars` page
inside the Skale Club workspace is a one-way Notion projection in the first
release. The two workflows remain isolated by database, Telegram group, skill,
runtime config, and SQLite registry even though they reuse the existing Skale
Club `notion` MCP connection.

## Notion resources

- Parent page: `3fab7a68-6121-8184-ab04-f0694325d060`
- Apartment Radar database: `669e69bc-685c-4769-ad85-ea5d3eeca9ed`
- Apartment Radar data source: `303fc987-eb42-4495-8684-6840467686eb`
- Job Radar database: `b4853d7f-e045-4a29-8614-9346ce22cac6`
- Job Radar data source: `750ee1e4-5f09-4eb9-8be1-9fac5d18bcca`
- Radar Activity database: `8fe7e462-07a8-4fa9-be1e-676964a2e535`
- Radar Activity data source: `82ab8acc-f37c-4c96-9565-6d5ddae3aa57`
- Job-search profile page: `3fab7a68-6121-8130-8a81-e3352260cced`

The initial migration copied 11 apartment listings and 49 job records from
Leila's published Notion hub. Imported records retain their source links and
are marked `Origem da importação = Notion da Leila`.

## Local verification

Requires Node.js 22.5 or newer because the registry uses `node:sqlite`.

```bash
cd hermes/personal-radars
npm test
node mcp/server.mjs --list-tools
```

## CLI

Every command emits JSON:

```bash
node src/cli.mjs --db ./runtime/apartments/radar.db apartment ingest --file listing.json
node src/cli.mjs --db ./runtime/apartments/radar.db apartment list
node src/cli.mjs --db ./runtime/jobs/radar.db job ingest --file job.json
node src/cli.mjs --db ./runtime/jobs/radar.db job list
```

## Hermes MCP registration

After deploying the files and before enabling schedules:

```bash
docker exec -e HERMES_ACCEPT_HOOKS=1 -it hermes hermes mcp add personal-radars \
  --command node --args /opt/personal-radars/mcp/server.mjs \
  --env PERSONAL_RADARS_DATA_DIR=/opt/data/radars
```

Use the existing Skale Club `notion` MCP. Do not add a Leila workspace token or
grant the Skale integration access to Leila's private workspace. The initial
copy was performed through the explicitly published source pages.

## Activation gates

1. Complete and approve both runtime configs.
2. Capture the two Telegram group IDs and verify explicit per-job delivery.
3. Run a read/write smoke test against the configured Skale Club databases.
4. Add Gmail read-only access and parsers using redacted fixtures.
5. Run ingestion and Notion sync in silent mode.
6. Review duplicates, false positives, and routing.
7. Enable digests first; enable immediate alerts only after approval.
