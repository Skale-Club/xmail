#!/usr/bin/env bash
# Existing persistent candidate only. No production cutover or automatic reset.
set +x
set -Eeuo pipefail
if [[ $# == 0 || ( $# == 1 && $1 == --plan ) ]]; then
  cat <<'PLAN'
PLAN ONLY: no filesystem, Docker, SSH or database operation is performed.
Candidate UUID e12scyfsrp822dag7m9wwd4x; database xmail; owner xmail_owner.
Require the exact healthy PG17 image,512MiB/no extra swap,0.75CPU,private volume,
zero published ports, empty public and absent auth/ledger/authenticated bootstrap.
Existing V2 source protocol is read from its pinned sibling file, never executed.
Source stays READ ONLY with strict CA/TLS and one exported RR snapshot.
Dump client128MiB; archive256MiB; no temporary PostgreSQL server is started.
Require3GiB free separately on /tmp and /opt; /tmp cannot be memory-backed.
Require2GiB free on the persistent PGDATA filesystem before target writes.
Bootstrap+restore+70 counts/four digest groups run before candidate COMMIT.
New private0600 archive/manifests/checksum/receipt retained in /opt/xmail/backups.
Never remove/reset the persistent candidate or volume; never prune old backups.
No production URL/env, app connection, migration079/080, off-host backup or deploy.
PLAN
  exit 0
fi
if [[ $# != 1 || $1 != --execute-reviewed-import ]]; then
  echo 'Refused: use --plan or --execute-reviewed-import after independent review.' >&2; exit 2
fi
target=e12scyfsrp822dag7m9wwd4x
database=xmail
owner=xmail_owner
image=sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
[[ $(id -u) == 0 ]] || { echo 'Refused: approved host root session required.' >&2; exit 2; }
for binary in docker timeout awk df mktemp base64 sha256sum install sync stat; do command -v "$binary" >/dev/null || exit 2; done
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# These are reviewed static code files, without credentials or data.
[[ -f $script_dir/xmail-database-protocol.sh && ! -L $script_dir/xmail-database-protocol.sh ]] || exit 2
source "$script_dir/xmail-database-protocol.sh"
load_xmail_v2_protocol "$script_dir/xmail-database-rehearsal.sh" || { echo 'Reviewed source protocol checksum mismatch.' >&2; exit 2; }

check_capacity() {
  local available swap opt_disk work_disk work_fs
  available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  swap=$(awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {print t-f}' /proc/meminfo)
  opt_disk=$(df -Pk /opt | awk 'END {print $4}')
  work_disk=$(df -Pk /tmp | awk 'END {print $4}')
  work_fs=$(stat -f -c '%T' /tmp)
  case "$work_fs" in tmpfs|ramfs|hugetlbfs|devtmpfs) echo 'Memory-backed work filesystem refused.' >&2; exit 2 ;; esac
  (( available >= 786432 && swap <= 524288 && opt_disk >= 3145728 && work_disk >= 3145728 )) || { echo 'Candidate capacity gate refused.' >&2; exit 2; }
}
check_capacity
umask 077
work=$(mktemp -d /tmp/xmail-candidate-import.XXXXXXXX)
[[ $work =~ ^/tmp/xmail-candidate-import\.[a-zA-Z0-9]{8}$ && -d $work && ! -L $work ]] || exit 2
nonce="$(date -u +%Y%m%dT%H%M%SZ)-$$"
client="xmail-candidate-import-$nonce-client"
label_key=com.skale.xmail-candidate-import
holder_input='' holder_output='' holder_pid='' target_input='' target_output='' target_pid=''
backup_dir='' committed=false
cleanup() {
  local resource_owner
  # EOF aborts either unfinished transaction. Both sessions also have independent
  # deadlines; this function NEVER stops/removes the persistent target/volume.
  if [[ ${holder_input:-} =~ ^[0-9]+$ ]]; then exec {holder_input}>&-; holder_input=''; fi
  if [[ ${target_input:-} =~ ^[0-9]+$ ]]; then exec {target_input}>&-; target_input=''; fi
  if [[ ${holder_output:-} =~ ^[0-9]+$ ]]; then exec {holder_output}<&-; holder_output=''; fi
  if [[ ${target_output:-} =~ ^[0-9]+$ ]]; then exec {target_output}<&-; target_output=''; fi
  resource_owner=$(docker inspect --format "{{index .Config.Labels \"$label_key\"}}" "$client" 2>/dev/null || true)
  if [[ $resource_owner == "$nonce" ]]; then docker rm -f "$client" >/dev/null 2>&1 || true; fi
  if [[ $work =~ ^/tmp/xmail-candidate-import\.[a-zA-Z0-9]{8}$ && -d $work && ! -L $work ]]; then rm -rf -- "$work"; fi
  unset source_environment
  # Backup bundles are never deleted, including an incomplete current receipt.
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
trap 'echo "Candidate import failed; success withheld. Source/app unchanged; persistent target and any backup receipts were preserved. No raw database error was emitted." >&2' ERR

assert_target() {
  local details ports mount
  details=$(docker inspect --format '{{.Name}}|{{.State.Running}}|{{.State.Health.Status}}|{{.Image}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.NanoCpus}}' "$target" 2>"$work/target-inspect.log")
  [[ $details == "/$target|true|healthy|$image|536870912|536870912|750000000" ]] || { echo 'Exact candidate runtime gate refused.' >&2; exit 2; }
  ports=$(docker port "$target" 2>"$work/target-ports.log"); [[ -z $ports ]] || exit 2
  mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}:{{.RW}}{{end}}{{end}}' "$target" 2>"$work/target-mount.log")
  [[ $mount == volume:true ]] || exit 2
  docker exec "$target" sh -c 'test "$(head -n 1 /var/lib/postgresql/data/postmaster.pid 2>/dev/null)" = 1' 2>"$work/target-postmaster.log"
}
assert_target
check_target_capacity() {
  local target_free target_fs
  target_free=$(docker exec "$target" df -Pk /var/lib/postgresql/data 2>"$work/target-disk.log" | awk 'END {print $4}')
  target_fs=$(docker exec "$target" stat -f -c '%T' /var/lib/postgresql/data 2>"$work/target-filesystem.log")
  case "$target_fs" in tmpfs|ramfs|hugetlbfs|devtmpfs) echo 'Memory-backed persistent data filesystem refused.' >&2; exit 2 ;; esac
  (( target_free >= 2097152 )) || { echo 'Persistent candidate disk margin refused.' >&2; exit 2; }
}
check_target_capacity
source_image=$(docker inspect --format '{{.Image}}' xmail 2>"$work/source-image.log")
[[ $source_image =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2

empty_guard=$(cat <<'SQL'
DO $$ BEGIN
 IF current_database()<>'xmail' OR current_user<>'xmail_owner' OR session_user<>'xmail_owner'
 OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())<>'xmail_owner'
 OR current_setting('server_version_num')::int/10000<>17
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','supabase_migrations'))
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
 OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public')
 OR EXISTS(SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE n.nspname='public')
 THEN RAISE EXCEPTION 'Candidate must be the exact empty unbootstrapped destination'; END IF;
END $$;
SQL
)
printf 'BEGIN READ ONLY;\n%s\nROLLBACK;\n' "$empty_guard" | timeout 15s docker exec -i "$target" psql -X -w -v ON_ERROR_STOP=1 -qAt -U "$owner" -d "$database" >"$work/empty-check.log" 2>&1

docker exec xmail node -e "$ca_program" >"$work/source-ca.crt" 2>"$work/ca.log"
source_environment=$(docker exec -i xmail node -e "$environment_program" <"$work/source-ca.crt" 2>"$work/source-admission.log")
[[ $source_environment == *'PGSSLMODE=verify-full'* ]] || exit 2
coproc SNAPSHOT_HOLDER { docker exec -i xmail node -e "$holder_program" 2>"$work/snapshot-holder.log"; }
holder_pid=$SNAPSHOT_HOLDER_PID
exec {holder_input}>&"${SNAPSHOT_HOLDER[1]}"; exec {holder_output}<&"${SNAPSHOT_HOLDER[0]}"
original_input=${SNAPSHOT_HOLDER[1]}; original_output=${SNAPSHOT_HOLDER[0]}
exec {original_input}>&-; exec {original_output}<&-
base64 -w 0 "$work/source-ca.crt" >&"$holder_input"; printf '\n' >&"$holder_input"
printf '%s' "$manifest_sql" | base64 -w 0 >&"$holder_input"; printf '\n' >&"$holder_input"
IFS= read -r -t 40 snapshot_id <&"$holder_output"
[[ $snapshot_id =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{8}-[0-9]+$ ]] || exit 2
IFS= read -r -t 40 source_manifest <&"$holder_output"
[[ ${#source_manifest} -le 64000 && $source_manifest == \{* ]] || exit 2
printf '%s\n' "$source_manifest" >"$work/source-manifest.json"; unset source_manifest
(
 ulimit -f 262144
 printf '%s\n' "$source_environment" | timeout --kill-after=5s 150s docker run --rm --pull=never --name "$client" --label "$label_key=$nonce" \
  --log-driver=none --network container:xmail --read-only --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=8388608 \
  --mount "type=bind,src=$work/source-ca.crt,dst=/source-ca.crt,readonly" --env-file /dev/stdin "$image" \
  pg_dump --format=custom --compress=6 --schema=public --schema=supabase_migrations --strict-names --no-owner --no-acl --no-comments \
   --snapshot="$snapshot_id" --lock-wait-timeout=5s >"$work/source.dump" 2>"$work/dump.log"
)
unset source_environment
[[ -s $work/source.dump ]] || exit 2
printf 'DUMP_COMPLETE\n' >&"$holder_input"; exec {holder_input}>&-; holder_input=''
IFS= read -r -t 10 holder_status <&"$holder_output"; [[ $holder_status == SOURCE_CLOSED ]] || exit 2
wait "$holder_pid"; holder_pid=''; exec {holder_output}<&-; holder_output=''

offline_restore() {
 timeout --kill-after=5s 45s docker run --rm --pull=never --name "$client" --label "$label_key=$nonce" --log-driver=none \
  --network none --read-only --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 64 --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$work,dst=/archive,readonly" "$image" pg_restore "$@"
}
offline_restore --list /archive/source.dump >"$work/archive.list" 2>"$work/archive-list.log"
awk '/^[0-9]+; [0-9]+ [0-9]+ SCHEMA - public / {print ";" $0;count++;next} {print} END {if(count!=1)exit 2}' "$work/archive.list" >"$work/restore.list"
(
 ulimit -f 524288
 offline_restore --no-owner --no-acl --use-list=/archive/restore.list --file=- /archive/source.dump >"$work/restore.sql" 2>"$work/restore-generate.log"
)
# pg_restore's SQL preamble disables timeouts. Drop only those four exact
# preamble SETs so the enclosing persistent-target transaction keeps its caps.
# COPY data and object definitions are never filtered or rewritten.
awk '
 /^-- Name:/ {body=1}
 !body && ($0=="SET statement_timeout = 0;" || $0=="SET lock_timeout = 0;" || $0=="SET idle_in_transaction_session_timeout = 0;" || $0=="SET transaction_timeout = 0;") {removed++;next}
 {print}
 END {if(removed!=4)exit 2}
' "$work/restore.sql" >"$work/restore-bounded.sql"
check_capacity
assert_target
check_target_capacity

# Keep psql's transaction open until external manifest reconciliation succeeds.
# Server-side transaction/idle deadlines protect against a lost Docker CLI/pipe.
coproc CANDIDATE_TRANSACTION { timeout --kill-after=5s 270s docker exec -i "$target" psql -X -w -v ON_ERROR_STOP=1 -qAt -U "$owner" -d "$database" 2>"$work/candidate-transaction.log"; }
target_pid=$CANDIDATE_TRANSACTION_PID
exec {target_input}>&"${CANDIDATE_TRANSACTION[1]}"; exec {target_output}<&"${CANDIDATE_TRANSACTION[0]}"
original_input=${CANDIDATE_TRANSACTION[1]}; original_output=${CANDIDATE_TRANSACTION[0]}
exec {original_input}>&-; exec {original_output}<&-
{
 printf "BEGIN; SET LOCAL transaction_timeout='240s'; SET LOCAL statement_timeout='180s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='45s'; SET LOCAL maintenance_work_mem='16MB'; SET LOCAL work_mem='2MB';\n"
 printf "DO \$\$ BEGIN IF NOT pg_try_advisory_xact_lock(hashtextextended('xmail-candidate-e12scyfsrp822dag7m9wwd4x',0)) THEN RAISE EXCEPTION 'Candidate import already active'; END IF; END \$\$;\n"
 printf '%s\n' "$empty_guard"
 cat <<'SQL'
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
CREATE EXTENSION pg_trgm WITH SCHEMA public;
\o /dev/null
SQL
 cat "$work/restore-bounded.sql"
 printf "\n\\o\nSET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex';\n"
 cat <<'SQL'
DO $$ BEGIN
 IF auth.uid() IS NOT NULL OR (SELECT rolcanlogin OR rolbypassrls FROM pg_roles WHERE rolname='authenticated')
 OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'xmail_identity_%')
 OR EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='f' AND NOT c.convalidated)
 THEN RAISE EXCEPTION 'Candidate compatibility or constraint gate failed'; END IF;
END $$;
SQL
 printf '%s;\n' "$manifest_sql"
 printf '\\echo CANDIDATE_READY_FOR_RECONCILIATION\n'
} >&"$target_input"
IFS= read -r -t 180 target_manifest <&"$target_output"
[[ ${#target_manifest} -le 64000 && $target_manifest == \{* ]] || exit 2
IFS= read -r -t 5 target_status <&"$target_output"; [[ $target_status == CANDIDATE_READY_FOR_RECONCILIATION ]] || exit 2
printf '%s\n' "$target_manifest" >"$work/target-manifest.json"; unset target_manifest
comparison=$({ cat "$work/source-manifest.json"; cat "$work/target-manifest.json"; } | timeout 10s docker exec -i xmail node -e "$compare_program" 2>"$work/compare.log")
candidate_report_program=$(cat <<'NODE'
const fs=require('node:fs');
try{
 const r=JSON.parse(fs.readFileSync(0,'utf8'));
 if(r.restore!=='passed'||r.users!==39||r.organization_users!==38||r.public_tables!==70||r.native_password_hashes!==37||r.platform_admins!==1||r.table_counts_matched!==70||r.digest_groups_matched!==4||r.source_snapshot_comparison!=='matched_exported_repeatable_read_snapshot')throw Error();
 process.stdout.write(JSON.stringify({candidateImport:'passed',candidate:'e12scyfsrp822dag7m9wwd4x',database:'xmail',owner:'xmail_owner',users:r.users,organizationUsers:r.organization_users,publicTables:r.public_tables,nativePasswordHashes:r.native_password_hashes,platformAdmins:r.platform_admins,tableCountsMatched:r.table_counts_matched,digestGroupsMatched:r.digest_groups_matched,sourceSnapshot:'exported_repeatable_read',persistentTargetPreserved:true,localArchiveRetained:true,archiveChecksumVerified:true,committedRestoreProofRecorded:true,temporaryResourcesRemoved:true,applicationCutover:false,offHostBackup:'not_verified'}));
}catch{process.stderr.write('Candidate baseline reconciliation failed; values omitted.');process.exitCode=1;}
NODE
)
printf '%s' "$comparison" | timeout 10s docker exec -i xmail node -e "$candidate_report_program" >"$work/uncommitted-report.json" 2>"$work/baseline-check.log"

# Retain a new private bundle without touching any existing backup or retention.
[[ ! -L /opt/xmail && ! -L /opt/xmail/backups ]] || exit 2
if [[ ! -e /opt/xmail/backups ]]; then install -d -m 0700 /opt/xmail/backups; fi
[[ $(stat -c '%u:%a' /opt/xmail/backups) == 0:700 ]] || exit 2
backup_dir=$(mktemp -d "/opt/xmail/backups/candidate-$nonce.XXXXXXXX")
[[ $backup_dir =~ ^/opt/xmail/backups/candidate-[a-zA-Z0-9.-]+$ && ! -L $backup_dir ]] || exit 2
install -m 0600 "$work/source.dump" "$backup_dir/snapshot.dump"
install -m 0600 "$work/source-manifest.json" "$backup_dir/source-manifest.json"
install -m 0600 "$work/target-manifest.json" "$backup_dir/target-manifest.json"
archive_sha=$(sha256sum "$work/source.dump" | awk '{print $1}')
[[ $(sha256sum "$backup_dir/snapshot.dump" | awk '{print $1}') == "$archive_sha" ]] || exit 2
printf '%s  snapshot.dump\n' "$archive_sha" >"$backup_dir/snapshot.sha256"
(cd "$backup_dir" && sha256sum -c snapshot.sha256 >/dev/null)
printf '%s\n' '{"status":"matched_pending_commit","candidate":"e12scyfsrp822dag7m9wwd4x","database":"xmail","owner":"xmail_owner","sourceSnapshot":"exported_repeatable_read","publicTableCounts":70,"digestGroups":4}' >"$backup_dir/restore-proof.pending.json"
chmod 0600 "$backup_dir/snapshot.sha256" "$backup_dir/restore-proof.pending.json"
sync -f "$backup_dir/snapshot.dump"; sync -f "$backup_dir"
printf 'COMMIT;\n\\echo CANDIDATE_COMMITTED\n' >&"$target_input"
exec {target_input}>&-; target_input=''
IFS= read -r -t 15 target_status <&"$target_output"; [[ $target_status == CANDIDATE_COMMITTED ]] || exit 2
wait "$target_pid"; target_pid=''; exec {target_output}<&-; target_output=''; committed=true
printf '%s\n' '{"status":"candidate_commit_acknowledged","candidate":"e12scyfsrp822dag7m9wwd4x","postCommitReconciliation":"pending"}' >"$backup_dir/restore-proof.commit-ack.json"
chmod 0600 "$backup_dir/restore-proof.commit-ack.json"
sync -f "$backup_dir/restore-proof.commit-ack.json"

# A post-COMMIT proof uses a fresh read-only session and the same canonical SQL.
{
 printf "BEGIN READ ONLY; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL statement_timeout='30s';\n"
 printf '%s;\nROLLBACK;\n' "$manifest_sql"
} | timeout 40s docker exec -i "$target" psql -X -w -v ON_ERROR_STOP=1 -qAt -U "$owner" -d "$database" >"$work/committed-manifest.json" 2>"$work/committed-check.log"
comparison=$({ cat "$work/source-manifest.json"; cat "$work/committed-manifest.json"; } | timeout 10s docker exec -i xmail node -e "$compare_program" 2>"$work/committed-compare.log")
final_report=$(printf '%s' "$comparison" | timeout 10s docker exec -i xmail node -e "$candidate_report_program" 2>"$work/committed-baseline-check.log")
install -m 0600 "$work/committed-manifest.json" "$backup_dir/committed-manifest.json"
printf '%s\n' '{"status":"candidate_committed_and_reconciled","candidate":"e12scyfsrp822dag7m9wwd4x","database":"xmail","owner":"xmail_owner","sourceSnapshot":"exported_repeatable_read","publicTableCounts":70,"digestGroups":4,"users":39,"memberships":38,"nativePasswordHashes":37,"platformAdmins":1,"offHostBackup":"not_verified","applicationCutover":false}' >"$backup_dir/restore-proof.json"
chmod 0600 "$backup_dir/restore-proof.json"
sync -f "$backup_dir/restore-proof.json"; sync -f "$backup_dir"
assert_target
[[ $(docker inspect --format '{{.Image}}' xmail 2>"$work/source-image-final.log") == "$source_image" ]] || exit 2
cleanup
remaining=$(docker ps -aq --filter "label=$label_key=$nonce" 2>/dev/null)
[[ -z $remaining && ! -e $work && ! -L $work && $committed == true ]] || { echo 'Candidate cleanup proof failed; success withheld.' >&2; exit 1; }
trap - EXIT
printf '%s\n' "$final_report"
