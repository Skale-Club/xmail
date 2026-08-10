#!/usr/bin/env bash

# Daily Hermes state backup without invoking an LLM.
# This script preserves the files backed up by the former agent-driven job
# and stays silent when there is nothing to commit.

set -Eeuo pipefail
umask 077

HERMES_HOME="${HERMES_HOME:-/opt/data}"
BACKUP_REPO="${HERMES_BACKUP_REPO:-${HERMES_HOME}/hermes-memories-backup}"

report_failure() {
    local exit_code=$?
    printf '🚨 Backup do Hermes falhou (linha %s, código %s).\n' "${BASH_LINENO[0]}" "$exit_code" >&2
    exit "$exit_code"
}
trap report_failure ERR

test -d "$BACKUP_REPO/.git"

# Preserve the same state copied by the old agent prompt.
for memory_file in MEMORY.md USER.md; do
    if test -f "$HERMES_HOME/memories/$memory_file"; then
        cp -f "$HERMES_HOME/memories/$memory_file" "$BACKUP_REPO/$memory_file"
    fi
done

LEGACY_HOME="$HERMES_HOME/home/.hermes"
for config_file in .env supermemory.json; do
    if test -f "$LEGACY_HOME/$config_file"; then
        cp -f "$LEGACY_HOME/$config_file" "$BACKUP_REPO/$config_file"
    fi
done

git -C "$BACKUP_REPO" add -A

if git -C "$BACKUP_REPO" diff --cached --quiet; then
    exit 0
fi

BACKUP_DATE="$(date -u +'%Y-%m-%d %H:%M UTC')"
git -C "$BACKUP_REPO" commit -m "Backup automático - $BACKUP_DATE" >/dev/null
git -C "$BACKUP_REPO" push origin main >/dev/null

printf '✅ Backup do Hermes atualizado no GitHub em %s.\n' "$BACKUP_DATE"
