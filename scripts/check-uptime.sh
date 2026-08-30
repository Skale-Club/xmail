#!/usr/bin/env bash
#
# The external probe. Exits non-zero when production is not answering, which is
# the ONLY thing allowed to colour the uptime workflow's run — every other step
# in that workflow is forbidden from failing, because the run history is read
# back as outage state.
#
# Checks two independent surfaces:
#
#   HTTP  $APP_URL/health/ready   — 200 when the app and its dependencies are up;
#                                   the endpoint already returns 503 otherwise.
#   TCP   $MAIL_HOST:587 (SMTP submission)
#   TCP   $MAIL_HOST:993 (IMAP)
#
# ## Why port 25 is not probed by default
#
# GitHub-hosted runners block OUTBOUND port 25 to prevent spam from Actions.
# A probe of mx:25 from here fails whether or not the MX listener is healthy,
# so enabling it would produce a permanent false alarm — and a channel with a
# permanent false alarm is a channel that gets muted, which costs the alerts
# that matter. 587 and 993 are not blocked and prove the same thing: the
# container's raw TCP listeners are bound and reachable from the internet.
#
# Set PROBE_PORT_25=true only from a self-hosted runner that can egress on 25.
set -uo pipefail

APP_URL="${APP_URL:-https://mail.skale.club}"
MAIL_HOST="${MAIL_HOST:-mx.skale.club}"
FORCE_FAILURE="${FORCE_FAILURE:-false}"
PROBE_PORT_25="${PROBE_PORT_25:-false}"
TCP_TIMEOUT="${TCP_TIMEOUT:-8}"

failed=()

# ── HTTP ─────────────────────────────────────────────────────────────────────
# --max-time bounds a HUNG app, which is the failure mode that matters most: a
# hung process keeps the socket open and would otherwise hold this probe until
# the job timeout, turning a clear "down" into an ambiguous cancelled run.
http_code=$(curl -sS -o /tmp/health.json -w '%{http_code}' --max-time 25 \
  "${APP_URL%/}/health/ready" 2>/dev/null) || http_code="000"

if [ "${http_code}" != "200" ]; then
  failed+=("HTTP /health/ready → ${http_code}")
  echo "HTTP probe FAILED (${http_code})"
  head -c 500 /tmp/health.json 2>/dev/null || true
  echo
else
  echo "HTTP probe ok (200)"
fi

# ── raw TCP mail ports ───────────────────────────────────────────────────────
# Bash's /dev/tcp needs no extra tooling on the runner. `timeout` bounds a host
# that accepts the connection but never completes the handshake.
check_tcp() {
  local host="$1" port="$2" label="$3"
  if timeout "${TCP_TIMEOUT}" bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
    echo "${label} (${host}:${port}) ok"
    return 0
  fi
  echo "${label} (${host}:${port}) FAILED"
  failed+=("${label} ${host}:${port}")
  return 1
}

check_tcp "${MAIL_HOST}" 587 "SMTP submission" || true
check_tcp "${MAIL_HOST}" 993 "IMAP" || true

if [ "${PROBE_PORT_25}" = "true" ]; then
  check_tcp "${MAIL_HOST}" 25 "SMTP MX" || true
else
  echo "SMTP MX (:25) not probed — GitHub-hosted runners block outbound port 25."
fi

# ── forced failure, for testing the alert path end to end ────────────────────
if [ "${FORCE_FAILURE}" = "true" ]; then
  failed+=("forced failure (workflow_dispatch test)")
  echo "Forced failure requested via workflow_dispatch."
fi

# ── report ───────────────────────────────────────────────────────────────────
if [ ${#failed[@]} -gt 0 ]; then
  summary=$(printf '%s; ' "${failed[@]}")
  summary="${summary%; }"
  echo "failed_checks=${summary}" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "PROBE FAILED: ${summary}"
  exit 1
fi

echo "failed_checks=" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "All probes green."
exit 0
