#!/usr/bin/env bash
#
# Pushes one ops alert to the Xmail Telegram chat from GitHub Actions.
#
# This is the OUTSIDE-the-server half of Xmail's alerting. The in-app half
# (src/server/lib/ops-alert.ts, plus the error-spike detector) knows far more —
# queue depth, memory, which cron failed — but it dies with the process it is
# meant to report on. A crashed or hung container cannot tell anyone it is
# down. Anything routed through this script runs on GitHub's infrastructure
# instead, so it survives the container, the host, and Hetzner.
#
#   bash scripts/telegram-notify.sh "<b>Title</b>" "Body, \n for newlines"
#
# Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from the environment. The calling
# workflow resolves those from the ADMIN PANEL via /api/admin/integrations/
# monitor-config (see .github/workflows/uptime.yml), falling back to repository
# secrets. TELEGRAM_THREAD_ID is optional and only used for a group with Topics
# enabled.
#
# ALWAYS EXITS 0. Callers are workflows whose red/green state means something
# specific — uptime.yml reads its own previous conclusions to decide whether an
# outage is new — so a Telegram problem must never colour the run that carries
# it. A bad token would otherwise inflate the failure history and make a
# healthy app look like it is flapping. Failures surface as ::error::
# annotations instead, visible in the run without changing its conclusion.
set -uo pipefail

TITLE="${1:?usage: telegram-notify.sh <title> [body]}"
BODY="${2:-}"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "::warning::Telegram credentials unavailable — '${TITLE}' was not delivered. Configure them at /admin/integrations and set MONITOR_API_TOKEN, or set the TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID repository secrets."
  exit 0
fi

# The body goes to curl through a FILE, not through the command line.
#
# `--data-urlencode "text=$var"` is the obvious form and it works on Linux, but
# curl built for Windows (mingw32) re-encodes command-line arguments through the
# ANSI codepage: an emoji becomes '??' and 'ç' becomes U+FFFD, and Telegram then
# rejects the whole message with "text must be encoded in UTF-8". Every alert
# title here carries an emoji, so that is not a corner case. Reading the value
# from a file bypasses argument encoding entirely and behaves identically on
# both platforms — which also means this script can be run by hand from a
# Windows dev box to test the channel.
#
# printf '%b' expands the \n the caller wrote; the file must contain REAL
# newlines, because curl escapes a literal '%0A' into '%250A' and the message
# would then show the escape sequence as text.
# Deliberately a RELATIVE path in the working directory rather than mktemp's
# /tmp. Windows curl cannot open an MSYS-style '/tmp/...' path (it wants a
# Windows path), while a relative one resolves identically under both. The pid
# suffix keeps concurrent runs from colliding.
body_file="./.tg-notify-$$.txt"
trap 'rm -f "${body_file}"' EXIT
printf '%b' "${TITLE}\n\n${BODY}" > "${body_file}"

thread_arg=()
[ -n "${TELEGRAM_THREAD_ID:-}" ] && thread_arg=(-d "message_thread_id=${TELEGRAM_THREAD_ID}")

response=$(curl -sS --max-time 20 -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  -d "parse_mode=HTML" \
  -d "disable_web_page_preview=true" \
  "${thread_arg[@]}" \
  --data-urlencode "text@${body_file}" 2>&1)

case "${response}" in
  *'"ok":true'*)
    echo "Telegram alert sent: ${TITLE}"
    ;;
  *)
    # Print Telegram's own explanation: the status code alone rarely says what
    # to fix. The one that matters most is the supergroup migration — when a
    # group is upgraded its chat id changes, every later alert fails, and ops
    # alerting dies silently unless the replacement id is surfaced. Telegram
    # returns it in parameters.migrate_to_chat_id, which is inside this dump.
    echo "::error::Telegram refused the alert: ${response}"
    ;;
esac

exit 0
