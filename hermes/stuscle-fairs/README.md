# Stuscle craft fair radar (Hermes)

Skill + scripts that make Hermes watch craft fairs, holiday fairs and makers markets near Framingham, MA,
score each one against the owner's criteria, put the good ones in a Google Calendar, mirror them in Notion,
record how each fair went afterwards, and report in the Telegram group. The owner talks to Hermes in the same
group ("confirma a feira X", "descarta a Y", "o que tem pra dezembro?", "vendi 480 na Weston").

> **Status: ready to install, NOT yet installed on the server.** Nothing here has been run on the host.
> Hermes itself is described in [`../README.md`](../README.md).

Language: everything in the repository is English (code, comments, CLI help, this README, `SKILL.md`, JSON keys,
error messages). Only owner-facing text is Brazilian Portuguese: the Telegram templates the skill tells Hermes to send,
Google Calendar titles and descriptions, Notion property values and journal entries. The Notion property names are fixed
in Portuguese by the owner's workspace.

## How it works

```
cron (Mon and Thu, 08:00 ET)
  └─ fairs-precheck.py        cheap, no LLM: fetches the 15 sources, strips text that changes daily, diffs against
       │                      the last read and keeps only the NEW lines; also lists confirmed fairs that already
       │                      happened and still have no result
       ├─ nothing new, no source broken, weekly search not due, no result to ask for → {"wakeAgent": false}  (silence, zero cost)
       └─ something to do → Markdown report + {"wakeAgent": true}
            └─ Hermes agent (skill stuscle-fairs)
                 ├─ reads the report, extracts the facts of each new fair (web_extract for fee, deadline, contact)
                 ├─ weekly search: web_search with the queries from the report
                 ├─ stuscle_fairs.py upsert-batch  one call for all fairs (shell loops are blocked in cron); code validates, scores and decides
                 │       ├─ Google Calendar   "Fair Opportunities" (score >= 55) + a deadline event
                 │       └─ Notion            "Feiras" database (everything except `skip`)
                 ├─ stuscle_fairs.py sync     pushes anything that failed to reach Notion, flushes the journal queue
                 ├─ stuscle_fairs.py ack      last step, after all upserts and the sync
                 └─ Telegram message (or [SILENT]), including the "how did it go?" block for finished fairs
```

The LLM only **extracts facts**; the score (0 to 100) is computed in code, so it is reproducible:

| Criterion | Points |
|---|---|
| Type: craft / holiday / artisan | 30 (mixed and festival 18, farmers 5) |
| Town: tier A / B / C / unknown | 25 / 17 / 8 / 8 |
| Recurrence: one-off, annual, seasonal / monthly / weekly / unknown | 15 / 7 / 0 / 7 |
| Booth fee: up to US$ 75 / 76 to 150 / above | 20 / 8 / 0 |
| Booth fee unknown: 1-day fair / 2+ days (flag `taxa_desconhecida`) | 5 / 0 |
| Competition: juried / up to 40 vendors / more than 100 / the rest | 10 / 7 / 2 / 5 |
| Distance beyond 30 miles | −15 (town not in the list: 0 and flag `distancia_desconhecida`) |

Decision: **55 or more** = `opportunity` (goes to the calendar); **40 to 54** = `maybe` (reported only);
**below 40** = `skip` (kept in the registry so it is not re-evaluated every week, never created in Notion).
An opportunity with a known fee above US$ 75 or farther than 30 miles gets the flag `excecao` (⚠️ in the title).
An unknown fee also counts as "outside target": it needs `EXCEPTION_MIN_SCORE` (75) to stay an opportunity, otherwise it
becomes `maybe` (listings rarely show the fee, and the big expensive shows are the ones that hide it). The unknown-fee
case is signalled by `taxa_desconhecida`, not `excecao`.
Weights and cut-offs live in a constants block at the top of `scripts/stuscle_fairs.py`.

Caps (they only ever lower a decision, never raise one):

| Condition | Flag | Decision |
|---|---|---|
| More than `LONG_SEASON_DAYS` (14) days | `temporada_longa` | at most `maybe` |
| `application_status` = `closed` | `inscricao_encerrada` | at most `maybe` |
| `application_status` = `waitlist` | `lista_de_espera` | at most `maybe` |

`application_status` (`open`, `waitlist`, `closed`, `unknown`; default `unknown`) is extracted by the agent from the
organizer or application page. An incoming `unknown` or `null` never erases a status already known.

Example of the design: a juried US$ 300 fair in Wellesley scores 80 and becomes an opportunity with ⚠️, because
type, town and competition make up for the fee. Requiring more for exceptions is one more constant in the code.

### Fair status

`opportunity`, `maybe`, `skip` (from the score) → `confirmed` (the owner said yes) → `done` (results recorded).
`discarded` is the owner's veto and is permanent. Scoring never moves `confirmed`, `done` or `discarded`. Discarding a `confirmed` or `done` fair needs `--confirmed-ok`
and an explicit request from the owner in that conversation.

### Fair fields beyond the basics

`contact_email` (validated email or null) and `contact_other` (free text, at most 300 characters: phone, application
form URL, Instagram/Facebook, organizer name) are extracted by the agent whenever the listing or organizer page shows
them. `days` = last day − first day + 1, and `price_per_day` = booth fee / days (only when `days` > 1). Contacts, days
and price per day appear in the calendar description, in `compact()` output and in Notion.

## Notion mirror

Done in code (`scripts/stuscle_fairs.py`), never by the LLM through the Notion MCP, so registry, calendar and Notion
cannot drift apart.

| What | Notion |
|---|---|
| Fair rows | data source `c942d066-ec7d-43a4-86b9-93292e78cfac` (database "Feiras") |
| Result rows (one per fair) | data source `8afba059-0a31-4e1b-bb0b-3a7f84f53120` (database "Resultados por feira") |
| History | page `3f5b7a68-6121-81c0-99f2-ec6d668d3add` ("Diário das feiras") |

- REST API, `Notion-Version: 2025-09-03`, through `requests`, at most 3 requests per second, one retry on 429/5xx
  (honoring `Retry-After`). Pages are created with a `data_source_id` parent. The token is never printed.
- A record is mirrored when its status is `opportunity`, `maybe`, `confirmed`, `done` or `discarded`. A `skip` record is
  never created, but is updated if it already has a page. Key stored on the record: `notion_page_id`
  (and `notion_result_page_id`). If the id is lost, the next sync finds the page by its `Chave` property instead of
  creating a duplicate.
- Every registry change sets `notion_dirty`; a successful sync clears it. `upsert`, `confirm`, `discard` and `result`
  sync the record they touched and report `"notion": {"synced": true/false, "page_id": ..., "error": ...}`. A Notion
  failure never fails the command (the calendar logic is unchanged); the record just stays dirty.
- `sync` pushes every dirty record (and flushes the journal queue); `sync --all` forces every mirrored record. The cron
  procedure runs `sync` right before `ack`. After an authorization error (401/403) `sync` stops early.
- Formula columns are computed by Notion and never written: `Preço por dia` (fairs), `Custos totais`, `Lucro líquido`,
  `Lucro por hora`, `Receita por hora de feira`, `Ticket médio` (results).
- Disabled automatically (`"notion": {"enabled": false}`) when the token file or any of the three ids is missing; the
  rest keeps working and records stay dirty until Notion is configured and `sync` runs.

### Results after a fair

`result <key> --file -` (JSON on stdin) stores the figures under `rec["result"]`, sets the status to `done`, creates or
updates ONE row in "Resultados por feira" related to the fair's row, keeps the calendar event in "Stuscle · Confirmed Fairs"
with a `✅` title prefix, and prints a `summary` computed in code (`total_costs`, `profit`, `profit_per_hour`,
`revenue_per_open_hour`, `avg_ticket`; null when the inputs are missing).

Fields (all optional, at least one numeric, numbers ≥ 0, unknown fields rejected): `revenue`, `sales_count`,
`items_sold`, `booth_cost` (defaults to the fair's booth fee), `other_costs`, `cogs`, `payment_fees`, `hours_total`,
`hours_open`, `first_sale_minutes`, `visitors_stopped`, `contacts`, `orders`, `best_sellers`, `most_viewed_no_buy`,
`price_objections`, `weather` (Sol, Nublado, Chuva, Frio, Calor, Indoor), `would_return` (yes/maybe/no), `notes`.
Only for a `confirmed` or `done` fair whose first day is today or earlier. Calling it again merges: new non-null
values overwrite, nulls keep what is stored.

### Journal

`journal --text "..." [--date YYYY-MM-DD]` appends to the journal page a `heading_3` with the date as `DD/MM/YYYY`
(only when it differs from the last date written, kept in `state.json` as `last_journal_date`) followed by paragraphs
of at most 2,000 characters. `confirm`, `discard` and `result` add a one-sentence PT-BR entry automatically. Entries that
fail to reach Notion wait in `journal_pending.json` and are written, in order, by the next journal write or `sync`.

### Asking for the results

`fairs-precheck.py` also reads `fairs.json`. A confirmed fair whose last day is before today, with no result, that was
never asked about (or was asked 7 or more days ago, with fewer than 2 asks) is listed under
`## Past fairs without results`, and that alone wakes the agent. The agent adds a short block to the Telegram
message and runs `mark-asked <key>` for each fair (`result_ask_count`, `result_asked_at`). When the owner answers with
numbers, the agent calls `result`, replies with the summary and says what changed in Notion.

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | Agent instructions (English): criteria, authority rules, cron procedure, message format, interactive use |
| `scripts/fairs-precheck.py` | Cron gate: fetches sources, filters noise, diffs, lists finished fairs without results, decides whether to wake the agent |
| `scripts/stuscle_fairs.py` | Agent CLI: `upsert`, `upsert-batch`, `confirm`, `discard`, `result`, `mark-asked`, `journal`, `sync`, `rescore`, `get`, `find`, `town`, `list` (`--sort profit_per_hour`), `ack`, `doctor` |
| `config.example.json` | Template for `/opt/data/stuscle-fairs/config.json` (no secrets) |
| `references/sources.json` | 15 watched sources (verified on 2026-10-09) |
| `references/search-queries.json` | 14 weekly-search queries |
| `references/towns.json` | 105 towns with income tier (A/B/C) and approximate miles from Framingham |
| `references/sources.md` | Research notes: what was dropped and why, observed costs |
| `tests/test_fairs.py` | Offline tests (no network, no Google or Notion libraries; both services are faked) |

Inside the container, at runtime:

```
/opt/data/skills/skale-club/stuscle-fairs/    SKILL.md + references/
/opt/data/scripts/fairs-precheck.py           (cron only sees scripts in this folder)
/opt/data/scripts/stuscle_fairs.py
/opt/data/stuscle-fairs/config.json           configuration
/opt/data/stuscle-fairs/{state.json, pending.json, journal_pending.json, pages/, fairs.json}   state and registry
/opt/data/secrets/stuscle-calendar-sa.json    service account key (chmod 600)
/opt/data/secrets/notion-token                Notion integration token, one line (chmod 600)
```

`fairs.json` is the registry of every fair ever seen (discarded ones included, so they are never suggested again).
`--reset` on the precheck **never** deletes it.

## What the OWNER does once

1. **Telegram group** with the bot `@skaleclubhermesbot` as administrator (so it can read group messages). The group is "Hermes | Faires" (chat id -5496280561 at setup; re-check after promoting the bot, Telegram may migrate it to a supergroup with a new -100... id).
2. **Google Cloud**: create a project, enable the **Google Calendar API**, create a **service account** and download the JSON key.
   Note the service account email (`...@....iam.gserviceaccount.com`).
3. **Two calendars** in the `stuscle@gmail.com` account: **"Stuscle · Fair Opportunities"** and **"Stuscle · Confirmed Fairs"**.
   In each: Settings and sharing → Share with specific people → add the service account email with the permission
   **"Make changes to events"**. Under "Integrate calendar", copy each calendar's **calendar ID**.
   No domain-wide delegation or impersonation: sharing only.
4. **Tavily**: create a free account and copy the API key (about 1,000 credits per month).
5. **Notion**: the databases "Feiras" and "Resultados por feira" and the page "Diário das feiras" already exist. Create an
   internal integration named **Hermes**, copy its token, and share the hub page **"Feiras da Stuscle — radar, agenda e
   resultados"** with it (••• → Connections). The sub-pages inherit access.

## Installation on the host (operator)

Use the same host as Hermes (see [`../README.md`](../README.md)). Container: `hermes`; host files under `/opt/hermes/`.
Run read/exec commands as the Hermes user (uid 10000), **never as root**: a state file created by root breaks the cron.

```bash
# 1) From your machine to the host
scp -r hermes/stuscle-fairs root@<host>:/tmp/stuscle-fairs
scp stuscle-calendar-sa.json root@<host>:/tmp/stuscle-calendar-sa.json      # the key downloaded in step 2
printf '%s\n' '<notion integration token>' | ssh root@<host> 'umask 077; cat > /tmp/notion-token'

# 2) On the host: copy into the container and fix ownership
docker exec -u root hermes mkdir -p /opt/data/skills/skale-club /opt/data/scripts /opt/data/stuscle-fairs /opt/data/secrets
docker exec -u root hermes rm -rf /opt/data/skills/skale-club/stuscle-fairs
docker cp /tmp/stuscle-fairs hermes:/opt/data/skills/skale-club/stuscle-fairs
docker cp /tmp/stuscle-fairs/scripts/fairs-precheck.py hermes:/opt/data/scripts/fairs-precheck.py
docker cp /tmp/stuscle-fairs/scripts/stuscle_fairs.py  hermes:/opt/data/scripts/stuscle_fairs.py
docker cp /tmp/stuscle-calendar-sa.json hermes:/opt/data/secrets/stuscle-calendar-sa.json
docker cp /tmp/notion-token hermes:/opt/data/secrets/notion-token
docker exec -u root hermes sh -c '
  chown -R 10000:10000 /opt/data/skills/skale-club /opt/data/scripts /opt/data/stuscle-fairs /opt/data/secrets &&
  chmod 700 /opt/data/secrets && chmod 600 /opt/data/secrets/stuscle-calendar-sa.json /opt/data/secrets/notion-token &&
  chmod 755 /opt/data/scripts/fairs-precheck.py /opt/data/scripts/stuscle_fairs.py'
shred -u /tmp/stuscle-calendar-sa.json /tmp/notion-token

# 3) Configuration (replace the two calendar IDs with the real ones; the Notion ids are final)
docker exec -i -u 10000:10000 hermes sh -c 'cat > /opt/data/stuscle-fairs/config.json' <<'EOF'
{
  "state_dir": "/opt/data/stuscle-fairs",
  "skill_dir": "/opt/data/skills/skale-club/stuscle-fairs",
  "service_account_file": "/opt/data/secrets/stuscle-calendar-sa.json",
  "calendar_opportunities_id": "OPPORTUNITIES_CALENDAR_ID@group.calendar.google.com",
  "calendar_confirmed_id": "CONFIRMED_CALENDAR_ID@group.calendar.google.com",
  "notion_token_file": "/opt/data/secrets/notion-token",
  "notion_fairs_data_source_id": "c942d066-ec7d-43a4-86b9-93292e78cfac",
  "notion_results_data_source_id": "8afba059-0a31-4e1b-bb0b-3a7f84f53120",
  "notion_journal_page_id": "3f5b7a68-6121-81c0-99f2-ec6d668d3add",
  "timezone": "America/New_York",
  "discovery_interval_days": 6.5,
  "max_searches_per_run": 15,
  "max_extracts_per_run": 20
}
EOF

# 4) Tavily as the backend for web_search and web_extract
echo 'TAVILY_API_KEY=<the key>' >> /opt/hermes/hermes.env
docker exec hermes hermes config set web.backend tavily
docker exec hermes hermes config set web.search_backend tavily
cd /opt/hermes && docker compose up -d --force-recreate
```

`STUSCLE_FAIRS_CONFIG` overrides the config path (default `/opt/data/stuscle-fairs/config.json`).

**Telegram group.** For Hermes to answer in the group, the owner's id (today `5209892068`) must be in the group
allowlist: variable `TELEGRAM_GROUP_ALLOWED_USERS` in `/opt/hermes/hermes.env` (comma-separated ids), then
`docker compose up -d --force-recreate` again. If the bot stays mute in the group, check the exact variable name in the
Hermes documentation. The group id is a negative number (starts with `-100`); it usually shows up in the logs
(`docker logs hermes --since 5m`) when someone writes in the group, or can be found with an ID bot such as `@RawDataBot`.

### Verify before scheduling

```bash
# Config, state dir, sources, key, access to BOTH calendars (inserts and deletes a test event in Fair Opportunities),
# Notion token file, both data sources and the journal page
docker exec -u 10000:10000 hermes /opt/hermes/.venv/bin/python /opt/data/scripts/stuscle_fairs.py doctor

# Fetch the sources and print the report, writing nothing (takes about 40 s because of the pause between requests)
docker exec -u 10000:10000 hermes /opt/hermes/.venv/bin/python /opt/data/scripts/fairs-precheck.py --dry-run | head -80
```

`doctor` prints `ok`/failure per item and the service account email (not a secret). It never prints the key or the Notion
token. On a 403/404 from Notion it says: share the hub page "Feiras da Stuscle — radar, agenda e resultados" with the
Notion integration named "Hermes" (••• → Connections).

### Schedule the cron

The cron runs in the container's timezone (America/New_York): `0 8 * * 1,4` is Monday and Thursday at 08:00 Boston time.
Replace `<GROUP_ID>` with the group id (with the minus sign).

```bash
docker exec hermes hermes cron create "0 8 * * 1,4" \
  "Run the Stuscle craft fair radar exactly as the stuscle-fairs skill describes. The precheck report is above. Your final answer is the Telegram message, or exactly [SILENT]." \
  --skill stuscle-fairs --script fairs-precheck.py \
  --deliver telegram:<GROUP_ID> --name stuscle-fairs-radar

docker exec hermes hermes cron list          # note the job id
docker exec hermes hermes cron run <id>      # first test, runs now
```

On the first run every source is a "first read" and the report is large; the 35,000-character cap defers some
sources to the next run (they stay pending, no whole source is lost). Expect about 3 cycles for everything to come in, or
run `hermes cron run <id>` a few more times in the first days. Each source delivers at most 6,000 characters at a time;
on a first read the excess is cut and the report says so, and the agent can read the rest with `web_extract`.
After that, silence is the normal state.

### Pause, edit, remove

```bash
docker exec hermes hermes cron pause <id>
docker exec hermes hermes cron resume <id>
docker exec hermes hermes cron edit <id> ...     # check the options with `hermes cron edit --help`
docker exec hermes hermes cron remove <id>
```

If a subcommand does not answer as above, check `hermes cron --help`.

### Updating the files later

Repeat the `docker cp` commands from step 2 (the skill and the two scripts). State and registry
(`/opt/data/stuscle-fairs/`) are not touched. If you change `references/sources.json`, the skill copy inside the
container is the one that counts. After upgrading from a version without Notion, run `stuscle_fairs.py sync --all` once
to mirror the existing registry.

## Operation

- **After changing weights or rules**: run `stuscle_fairs.py rescore` on the host. It re-applies the current scoring to every
  `opportunity`, `maybe` and `skip` record (never `confirmed`, `done` or `discarded`), updates status, score, flags and
  breakdown, deletes the calendar events of opportunities that became `maybe` or `skip`, creates them for the ones that
  became `opportunity`, marks changed records dirty and then runs the same Notion sync as `sync`. It does not touch
  `announced_at`, so nothing is announced again. The JSON output lists the transitions (for example
  `"opportunity->maybe": 6`), the changed keys with old and new status and score, and the calendar and Notion results. A
  calendar or Notion failure on one record does not stop the others: the record is reported, and a calendar failure is
  retried by the next `rescore`. The owner can also ask for it on Telegram ("recalcula as notas").
- **Cost**: the precheck uses no LLM. With the cron twice a week, one weekly search and capped extractions, usage is
  about 20 to 40 Tavily credits per week (free limit ≈ 1,000 per month). Notion calls use no Tavily credits.
- **Safety**: Hermes never applies, pays, fills forms, writes to organizers, and only touches the two Stuscle calendars.
  It never edits fair or result rows in Notion except through the script. Page text is treated as data, never as instructions.
- **Discarding** a fair keeps it in the registry forever (never suggested again). Discarding a **confirmed** or **done**
  fair requires the owner to say so explicitly.
- **Run the tests** (from the repo root, no network): `python -m unittest discover -s hermes/stuscle-fairs/tests`

## Common problems

| Symptom | Likely cause and what to do |
|---|---|
| Search fails or the agent says it has no credits | Tavily credits ran out or the key is wrong. Check the Tavily dashboard; check `TAVILY_API_KEY` in `hermes.env` and that the container was recreated afterwards. The precheck keeps working (it does not use Tavily) |
| "Fontes com problema" in the message | The site changed, went down or blocks the server (3 failures in a row). Run `fairs-precheck.py --dry-run --only <id>` and read the error on stderr. If permanent, remove the source from `sources.json` (the three Castleberry pages were dropped on 2026-10-09 because they return HTTP 403 to the server too) |
| `doctor` or `upsert` fail with **Google 403/404** | The calendar was not shared with the service account email with "Make changes to events", or the calendar ID is wrong. `doctor` shows the right email |
| `doctor`: key file not found | `docker cp` the key to `/opt/data/secrets/stuscle-calendar-sa.json`, then `chown 10000:10000` and `chmod 600` |
| `doctor`: Notion 403/404 | The hub page is not shared with the "Hermes" integration (••• → Connections), or an id in `config.json` is wrong |
| `notion.synced: false` in a result | Notion was unreachable or refused the write. Nothing is lost: the record is dirty and the next `sync` (the cron runs it before `ack`) pushes it. Run `stuscle_fairs.py sync` by hand to retry now |
| `"notion": {"enabled": false}` | No `/opt/data/secrets/notion-token` file or an id is missing from `config.json`. Fix it, then run `sync` |
| Journal entry missing in Notion | It is in `journal_pending.json`; `sync` writes the queue in order |
| The agent never wakes up (`wakeAgent` always false) | Expected when nothing changed. To force a look: `fairs-precheck.py --dry-run` shows what it would see. Check `state.json` (a recent `last_discovery_at` suppresses the weekly search for 6.5 days) and `pending.json` |
| The agent wakes every time with the same content | The final `ack` is missing (the run broke before it). Check the cron log; pending content is re-delivered on purpose |
| The agent keeps asking for the results of a fair | It asks at most twice, a week apart. To stop it: record the result, or run `mark-asked <key>` twice |
| Every source fails with `ModuleNotFoundError` (requests or google) | The cron is running the script with a Python that lacks the libraries. The right Python is `/opt/hermes/.venv/bin/python`; check `hermes cron --help` / the Hermes docs for which interpreter the cron uses |
| State files owned by root | Someone ran the precheck/CLI as root. `docker exec -u root hermes chown -R 10000:10000 /opt/data/stuscle-fairs` |
| Start reading the sources from scratch | `docker exec -u 10000:10000 hermes /opt/hermes/.venv/bin/python /opt/data/scripts/fairs-precheck.py --reset --yes`. Deletes only `state.json`, `pending.json` and `pages/`; the registry `fairs.json` stays |
| Duplicate calendar event | Should not happen (each event carries the `fairKey` and `upsert` is idempotent). If it does, run the fair's `upsert` again: it deletes the extra copies |
