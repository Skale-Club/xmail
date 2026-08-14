#!/usr/bin/env bash

# Daily Hermes state backup without invoking an LLM.
# This script preserves the files backed up by the former agent-driven job
# and stays silent when there is nothing to commit.
#
# SCOPE: only the agent's memory files are published. The backup repository
# lives inside the agent home (/opt/data), which also contains config.yaml,
# config/auth.json and .env — so the previous `git add -A` published 534 files
# (including OAuth tokens and 500+ cron output logs) to a GitHub remote, rather
# than the handful this script actually copies. Adding paths explicitly, plus
# the deny-by-default .gitignore installed below, keeps the two in agreement.

set -Eeuo pipefail
umask 077

HERMES_HOME="${HERMES_HOME:-/opt/data}"
BACKUP_REPO="${HERMES_BACKUP_REPO:-${HERMES_HOME}/hermes-memories-backup}"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# The only files this backup may publish. Keep in sync with backup-repo.gitignore.
BACKED_UP_FILES=(MEMORY.md USER.md)

report_failure() {
    local exit_code=$?
    printf '🚨 Backup do Hermes falhou (linha %s, código %s).\n' "${BASH_LINENO[0]}" "$exit_code" >&2
    exit "$exit_code"
}
trap report_failure ERR

test -d "$BACKUP_REPO/.git"

# Install/refresh the allow-list. Without it a stray `git add -A` — by this
# script, by the agent, or by hand — re-publishes the whole agent home.
if test -f "$SCRIPT_DIR/backup-repo.gitignore"; then
    cp -f "$SCRIPT_DIR/backup-repo.gitignore" "$BACKUP_REPO/.gitignore"
fi

# Preserve the same memory state copied by the old agent prompt.
staged=()
for memory_file in "${BACKED_UP_FILES[@]}"; do
    if test -f "$HERMES_HOME/memories/$memory_file"; then
        cp -f "$HERMES_HOME/memories/$memory_file" "$BACKUP_REPO/$memory_file"
        staged+=("$memory_file")
    fi
done

if test -f "$BACKUP_REPO/.gitignore"; then
    staged+=(.gitignore)
fi

if test ${#staged[@]} -eq 0; then
    exit 0
fi

# Explicit pathspec only — never a bare `-A`, which would sweep the agent home.
# Scoped to these paths, `-A` still handles create/modify/delete for each.
git -C "$BACKUP_REPO" add -A -- "${staged[@]}"

if git -C "$BACKUP_REPO" diff --cached --quiet; then
    exit 0
fi

BACKUP_DATE="$(date -u +'%Y-%m-%d %H:%M UTC')"
git -C "$BACKUP_REPO" commit -m "Backup automático - $BACKUP_DATE" >/dev/null
git -C "$BACKUP_REPO" push origin main >/dev/null

printf '✅ Backup do Hermes atualizado no GitHub em %s.\n' "$BACKUP_DATE"
