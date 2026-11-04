#!/usr/bin/env bash
set +x
set -Eeuo pipefail
if [[ $# == 0 || ( $# == 1 && $1 == --plan ) ]]; then
  echo 'PLAN ONLY: prepare NOLOGIN DML/runtime and SELECT-only staging roles on the reconciled private Xmail candidate. No connection, password or application cutover.'
  exit 0
fi
[[ $# == 1 && $1 == --prepare-reviewed-candidate ]] || exit 2
[[ $(id -u) == 0 ]] || exit 2
target=e12scyfsrp822dag7m9wwd4x
expected=sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
state=$(docker inspect --format '{{.State.Running}}|{{.State.Health.Status}}|{{.Image}}' "$target")
[[ $state == "true|healthy|$expected" && -z $(docker port "$target") ]] || exit 2
mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}:{{.RW}}{{end}}{{end}}' "$target")
[[ $mount == volume:true ]] || exit 2
python3 - <<'PY'
import glob,json,os,stat
base='/opt/xmail/backups'
assert not os.path.islink(base)
valid=0
for folder in glob.glob(base+'/candidate-*'):
    if os.path.islink(folder): continue
    metadata=os.stat(folder)
    if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o700: continue
    path=folder+'/restore-proof.json'
    if not os.path.isfile(path) or os.path.islink(path): continue
    data=json.load(open(path))
    if (data.get('status')=='candidate_committed_and_reconciled'
        and data.get('candidate')=='e12scyfsrp822dag7m9wwd4x'
        and data.get('database')=='xmail' and data.get('publicTableCounts')==70
        and data.get('digestGroups')==4 and os.path.isfile(folder+'/snapshot.dump')):
        valid+=1
assert valid==1, 'Exactly one reconciled candidate receipt is required'
PY
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ -f $directory/xmail-runtime-role.sql && ! -L $directory/xmail-runtime-role.sql ]] || exit 2
# No credentials are required/created. SQL execution is local Unix-socket owner
# authentication inside the exact private container; no production app changes.
if ! docker exec -i "$target" psql -X -q -v ON_ERROR_STOP=1 -U xmail_owner -d xmail < "$directory/xmail-runtime-role.sql" >/dev/null 2>&1; then
  echo 'Role preparation refused/failed. No password or application setting changed.' >&2
  exit 1
fi
proof=$(docker exec "$target" psql -X -qAt -v ON_ERROR_STOP=1 -U xmail_owner -d xmail -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('xmail_runtime','xmail_staging_reader') AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND rolbypassrls")
[[ $proof == 2 ]] || exit 1
echo '{"runtimeRolesPrepared":true,"roles":2,"loginEnabled":false,"passwordsCreated":false,"applicationCutover":false}'
