#!/usr/bin/env bash
#
# Resolves the Telegram credentials the external probe will alert with, and
# exports them to $GITHUB_ENV for later steps.
#
# ## Why this exists at all
#
# The credentials live in the ADMIN PANEL (`system_integrations`), which is the
# single place an operator edits them — change the chat id there and every
# layer follows. But the external probe's entire purpose is to survive the app
# being down, and the panel is *inside* the app. Reading credentials from the
# thing you are monitoring is circular: exactly when the alert matters most,
# the source of the credentials is unreachable.
#
# So the panel is read while the app is HEALTHY and the result is cached on
# GitHub's side. During an outage the cached copy is what actually delivers the
# alert. Resolution order:
#
#   1. /api/admin/integrations/monitor-config   — live panel, authoritative
#   2. the restored cache                        — last known good, used when down
#   3. TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID repo secrets — manual override
#
# Step 3 exists for the cold-start case: the very first run, or a run after a
# cache eviction that happens to coincide with an outage. Without it, that one
# scenario is silent. It is optional; leaving the secrets unset simply means the
# panel is the only source.
#
# NEVER FAILS. An unresolvable credential set is a silent no-op — the probe
# still runs, still files its outage issue, and telegram-notify.sh prints a
# warning annotation. Monitoring must never be the reason a job goes red.
set -uo pipefail

CACHE_FILE="${CACHE_FILE:-.alert-creds/creds.env}"
APP_URL="${APP_URL:-}"
MONITOR_API_TOKEN="${MONITOR_API_TOKEN:-}"

token=""
chat_id=""
source_used="none"

# ── 1. the live panel ────────────────────────────────────────────────────────
if [ -n "${APP_URL}" ] && [ -n "${MONITOR_API_TOKEN}" ]; then
  # --max-time keeps a hung app from stalling the probe; a non-2xx or a
  # timeout simply falls through to the cache below.
  response=$(curl -sS --max-time 15 \
    -H "x-monitor-token: ${MONITOR_API_TOKEN}" \
    "${APP_URL%/}/api/admin/integrations/monitor-config" 2>/dev/null) || response=""

  if [ -n "${response}" ]; then
    enabled=$(printf '%s' "${response}" | jq -r '.telegramEnabled // false' 2>/dev/null)
    if [ "${enabled}" = "true" ]; then
      token=$(printf '%s' "${response}" | jq -r '.telegramBotToken // empty' 2>/dev/null)
      chat_id=$(printf '%s' "${response}" | jq -r '.telegramChatId // empty' 2>/dev/null)
      [ -n "${token}" ] && [ -n "${chat_id}" ] && source_used="panel"
    else
      echo "Panel reachable but Telegram is not enabled there (telegramEnabled=${enabled})."
    fi
  fi
fi

# ── 2. the cache, for when the app is the thing that is broken ───────────────
if [ "${source_used}" = "none" ] && [ -f "${CACHE_FILE}" ]; then
  # shellcheck disable=SC1090
  cached_token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "${CACHE_FILE}" | tail -n1)
  cached_chat=$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "${CACHE_FILE}" | tail -n1)
  if [ -n "${cached_token}" ] && [ -n "${cached_chat}" ]; then
    token="${cached_token}"
    chat_id="${cached_chat}"
    source_used="cache"
  fi
fi

# ── 3. repository secrets, the cold-start safety net ─────────────────────────
if [ "${source_used}" = "none" ] && [ -n "${FALLBACK_BOT_TOKEN:-}" ] && [ -n "${FALLBACK_CHAT_ID:-}" ]; then
  token="${FALLBACK_BOT_TOKEN}"
  chat_id="${FALLBACK_CHAT_ID}"
  source_used="secrets"
fi

if [ "${source_used}" = "none" ]; then
  echo "::warning::No Telegram credentials could be resolved. Alerts will be skipped. Configure them at /admin/integrations, enable the toggle, and set the MONITOR_API_TOKEN secret."
  echo "creds_source=none" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

# Mask before export. Without this the token would appear in plain text in any
# later step that echoes the environment, and in the run log forever.
echo "::add-mask::${token}"

{
  echo "TELEGRAM_BOT_TOKEN=${token}"
  echo "TELEGRAM_CHAT_ID=${chat_id}"
} >> "${GITHUB_ENV:-/dev/null}"

echo "creds_source=${source_used}" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "Telegram credentials resolved from: ${source_used}"

# Refresh the cache only when the panel gave us something different, so the
# common case saves nothing. Writing a new cache entry every 15 minutes would
# churn ~96 entries a day for no benefit; GitHub cache keys are immutable, so
# "changed" is expressed as a new key derived from the credential hash.
if [ "${source_used}" = "panel" ]; then
  mkdir -p "$(dirname "${CACHE_FILE}")"
  {
    echo "TELEGRAM_BOT_TOKEN=${token}"
    echo "TELEGRAM_CHAT_ID=${chat_id}"
  } > "${CACHE_FILE}"
  hash=$(printf '%s|%s' "${token}" "${chat_id}" | sha256sum | cut -c1-16)
  echo "creds_hash=${hash}" >> "${GITHUB_OUTPUT:-/dev/null}"
fi

exit 0
