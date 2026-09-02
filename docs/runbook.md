# Xmail — Operations Runbook

This runbook documents operational behavior of the Xmail service for
deployment, health monitoring, and triage. It is the source of truth for
ops/SRE concerns; product features live in `README.md` and code comments.

---

## Health Endpoints

The Express server exposes a hierarchy of health endpoints. Use the right one
for the right job:

| Endpoint        | Purpose                                                                 | Auth | Includes DB? | Includes Auth? |
| --------------- | ----------------------------------------------------------------------- | ---- | ------------ | -------------- |
| `/health`       | Liveness — process is up, event loop responding. Returns uptime/memory. | none | no           | no             |
| `/health/db`    | Database probe only (Drizzle/Postgres).                                 | none | yes          | no             |
| `/health/auth`  | Supabase Auth probe only.                                               | none | no           | yes            |
| `/health/ready` | **Readiness — full dependency check.** Use this for K8s/uptime probes.  | none | yes          | yes            |
| `/health/mail`  | Mail server env/TLS/port diagnostic.                                    | none | no           | no             |

> **Source:** `src/server/index.ts` (`app.get('/health/...')`) and
> `src/server/lib/health.ts` (`runReadinessChecks`).

---

## Production Routing

Production runs on a Hetzner VPS as a single Docker container named
`xmail`. GitHub Actions still owns the deploy flow; Coolify/Traefik
owns HTTP routing when the host has the `coolify` Docker network.

Current routing model:

| Traffic | Public entry | Runtime path |
| ------- | ------------ | ------------ |
| Web app/API | `https://mail.skale.club` | Traefik/Coolify -> `http://xmail:9001` |
| Health check from host | `http://localhost:9001/health` | host-published Docker port -> Express |
| SMTP MX inbound | `mx.skale.club:25` | direct Docker port -> Node MX server |
| SMTP submission | `mx.skale.club:587` | direct Docker port -> Node SMTP server |
| IMAP | `mx.skale.club:993` | direct Docker port -> Node IMAP server |

Mail ports `25`, `587`, and `993` do not pass through Traefik or Caddy.
TLS for those ports is loaded inside Node from `MAIL_TLS_CERT_PATH` and
`MAIL_TLS_KEY_PATH`.

Deploy details to remember:

- `.github/workflows/deploy-hetzner.yml` detects Docker network `coolify`.
- In Coolify mode it runs the container with `--network coolify`, attaches
  Traefik labels, and writes `/data/coolify/proxy/dynamic/xmail.yaml`
  when that directory exists.
- If Coolify is absent, Caddy remains a legacy fallback for HTTP only.
- Production sets `MAIL_HOST=mx.skale.club` and `MX_PORT=25`.

Useful commands:

```bash
# Container and port view
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"

# Mail TLS and port diagnostic
curl -sS http://localhost:9001/health/mail | jq

# Inbound delivery, route matching, and SPF/DKIM/DMARC logs
docker logs xmail --since 24h 2>&1 | grep -E '\[MX\]|\[RouteMatcher\]|\[mail-auth\]'

# SMTP submission and IMAP auth logs
docker logs xmail --since 24h 2>&1 | grep -E '\[SMTP\]|\[IMAP\]'
```

---

## `/health/ready` — Readiness Probe (CRIT-02 / CI-03)

**This is the probe you want for Kubernetes `readinessProbe`, Railway
healthcheck, Uptime Robot, Better Uptime, etc.** It returns 503 — *not 200* —
when a downstream dependency is unhealthy, so traffic stops being routed to a
sick instance.

### Status codes

| Code  | Meaning                                                                 | Action                                                                  |
| ----- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `200` | All checked services healthy (`database.ok=true`, `auth.ok=true`).      | Instance is ready to serve traffic.                                     |
| `503` | One or more services failed (`database.ok=false` and/or `auth.ok=false`). | Stop routing traffic. Triage the failing service (see below).           |

The endpoint **never returns 5xx for transient probe errors silently** —
`runReadinessChecks` uses `Promise.allSettled`, so a rejected probe is
mapped to `{ ok: false, error: "<message>" }` in the JSON body.

### Response body (both 200 and 503)

```json
{
  "ok": true,
  "checkedAt": "2026-05-16T23:00:00.000Z",
  "latencyMs": 42,
  "services": {
    "database": { "ok": true, "latencyMs": 18 },
    "auth": { "ok": true }
  }
}
```

On failure, the offending service's `ok` is `false` and an `error` string is
included:

```json
{
  "ok": false,
  "checkedAt": "2026-05-16T23:00:00.000Z",
  "latencyMs": 2103,
  "services": {
    "database": {
      "ok": false,
      "error": "Database healthcheck failed: connect ETIMEDOUT 10.0.0.42:5432"
    },
    "auth": { "ok": true }
  }
}
```

### Recommended probe configuration

| Platform               | Path             | Interval | Timeout | Failure threshold |
| ---------------------- | ---------------- | -------- | ------- | ----------------- |
| Kubernetes readiness   | `/health/ready`  | 10s      | 5s      | 3                 |
| Kubernetes liveness    | `/health`        | 30s      | 3s      | 5                 |
| Railway healthcheck    | `/health/ready`  | 10s      | 5s      | n/a               |
| External uptime (HTTP) | `/health/ready`  | 60s      | 10s     | 2                 |

Rationale for **10s** interval: the readiness probe runs a real DB roundtrip
plus a Supabase Auth roundtrip on each hit. Polling faster than 10s wastes
DB connections and Supabase API budget for no SLO benefit. Polling slower
than 30s lengthens "time to evict bad pod" past most users' patience.

> **Liveness vs readiness:** `/health` is the liveness probe — it should
> only restart the pod when the *process itself* is wedged. Do not point
> liveness at `/health/ready`, or a transient DB blip will trigger a pod
> restart loop.

---

## Failure modes and triage

### Mode 1: `database.ok = false`

**Symptom:** `/health/ready` → 503 with `services.database.ok=false`.

**Likely causes (in order):**

1. **DB credentials rotated / `DATABASE_URL` stale** — most common after env
   shuffles. Verify env: the app role bypasses RLS, so a wrong role can still
   *connect* and look healthy from the outside but fail authn at runtime.
2. **Connection pool exhausted** — long-running cron job leaking connections,
   or a runaway query. Check `pg_stat_activity` for `state = 'active'` with
   high `state_change` age.
3. **Network egress blocked** — VPC / firewall change between the app host
   and Supabase. Confirm with `nc -zv <db-host> 5432` from inside the
   container.
4. **Supabase incident** — check status.supabase.com.

**Triage commands:**

```bash
# From the app host
curl -sS http://localhost:9001/health/db | jq

# From your laptop against the live host
curl -sS https://<host>/health/ready | jq

# Inside the DB (using psql with DATABASE_URL)
psql "$DATABASE_URL" -c "select 1"
psql "$DATABASE_URL" -c "select state, count(*), max(now()-state_change) from pg_stat_activity group by state"
```

**Recovery:** Once DB is healthy, `/health/ready` flips back to 200 on the
next probe (no app restart required). The probe is stateless.

### Mode 2: `auth.ok = false`

**Symptom:** `/health/ready` → 503 with `services.auth.ok=false`.

**Likely causes:**

1. **Supabase Auth API outage** — check status.supabase.com.
2. **`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` rotated** but app not
   redeployed.
3. **Egress to Supabase blocked** — firewall change.

**Important:** When Auth is down, the JWT middleware in `src/server/index.ts`
will reject most requests with 401, but the app process itself keeps running.
`/health` (liveness) will still return 200 — that's intentional. Restarting
the pod will not fix a Supabase outage; let readiness drain traffic instead.

**Triage commands:**

```bash
curl -sS http://localhost:9001/health/auth | jq
# Check Supabase egress
curl -sS -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/auth/v1/health"
```

### Mode 3: `/health/ready` itself times out or hangs

**Symptom:** Probe client reports timeout (no HTTP response at all — the
external probe logs `HTTP /health/ready → 000`).

Since 2026-09-02 this should be rare: the database probe inside
`runReadinessChecks` is bounded to 10 s (`READINESS_DB_TIMEOUT_MS`), the auth
probe to 5 s, so a hung dependency produces a **503 with a body** naming it
rather than no response. If you still see `000`:

1. **Process is wedged** — event loop blocked. Liveness (`/health`) will
   also fail. Docker only restarts on exit, so redeploy to bounce it.
2. **Node process out of memory** — check container memory metrics; bump
   limits or fix the leak.
3. **Traefik/Coolify not routing** — `curl http://localhost:9001/health` on the
   host answers while `https://mail.skale.club/health` does not.

**Triage:** Use `/health` to disambiguate. If `/health` responds quickly but
`/health/ready` returns 503, the issue is downstream (DB or Auth) and the
body says which. If both hang, the issue is the Node process or the proxy.

#### The 2026-09-01 case: database hung, process alive

For ten hours `/health/ready` gave `000` while ports 587/993 stayed green.
Every query had stopped returning; nothing restarts a process for that. The
`db-liveness` watchdog (`src/server/lib/db-liveness.ts`) now probes
`select 1` through the application pool every 30 s and, after 5 minutes of
continuous failure, exits non-zero so `--restart unless-stopped` brings up a
fresh process with fresh connections. What to expect in Telegram: 🛑 after
the second failed probe, ♻️ at the exit, ✅ once queries answer again.

```bash
docker logs xmail --since 2h 2>&1 | grep -a 'db.liveness'
```

If the container restarts every few minutes, the database itself is down
(status.supabase.com); the restarts stop on their own when it returns.
`DB_LIVENESS_EXIT_AFTER_MS=0` disables the exit and keeps the alerts.

---

## Observability — what we have and what we don't

| Signal                | Status | Where                                             |
| --------------------- | ------ | ------------------------------------------------- |
| Liveness              | shipped | `/health`                                         |
| Readiness             | shipped | `/health/ready` (CRIT-02)                         |
| Structured access log | partial | `morgan` not enabled; ad-hoc `console.log` only.  |
| Error log sink        | **deferred to v1.3** | See PROJECT.md "Key Decisions" — CI-04 |
| Metrics (RED/USE)     | not shipped | Future. Candidate: `prom-client` exported from the long-running Node process. |
| Tracing               | not shipped | Future.                                        |

**Why no Sentry/Datadog yet?** See CI-04 decision in `.planning/PROJECT.md`.
Short version: needs budget + ops decision; `/health/ready` + CI lint/tsc
gates are the v1.2 first-line defense. Track in `Future Requirements` for
v1.3.

---

## Quick reference

```bash
# Is the pod alive?
curl -sf http://localhost:9001/health

# Should I send traffic to this pod?
curl -sf http://localhost:9001/health/ready

# Why is readiness failing?
curl -sS http://localhost:9001/health/ready | jq '.services'

# DB only
curl -sS http://localhost:9001/health/db | jq

# Auth only
curl -sS http://localhost:9001/health/auth | jq

# Mail ports/TLS diagnostic
curl -sS http://localhost:9001/health/mail | jq

# Recent inbound mail arrival/routing logs
docker logs xmail --since 24h 2>&1 | grep -E '\[MX\]|\[RouteMatcher\]|\[mail-auth\]'
```

---

*Last updated: 2026-05-16 — Phase 14 Plan 03 (CI-03).*
