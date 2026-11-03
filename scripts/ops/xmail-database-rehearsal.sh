#!/usr/bin/env bash
# Run on the already approved Xmail host ONLY AFTER independent review.
# Default mode has no SSH, Docker, filesystem or database side effects.
set +x
set -Eeuo pipefail

if [[ $# == 0 || ( $# == 1 && $1 == --plan ) ]]; then
  cat <<'PLAN'
PLAN ONLY. Review this script before explicitly running it on the Xmail host.
Requires an already-present, operator-approved immutable PostgreSQL17 image ID.
No automatic image pull, app startup, migration, production config or deploy.
Source: running xmail DATABASE_URL, same Auth project, direct/session5432,
verified Supabase public CA + hostname, read-only transactions/pg_dump.
Archive: public + migration ledger only, host-private directory,256MiB limit.
Target: network none/no ports/no volumes,768MiB RAM+no swap,0.5CPU,128PIDs,
512MiB PGDATA tmpfs plus small socket/tmp mounts; no production credentials.
Target-only authenticated NOLOGIN role and auth.uid() NULL compatibility stub.
Require restored39users/38memberships/70publictables/ledger78latest078.
Separate source counts are not the pg_dump exported snapshot; concurrent data
changes preclude a claim of exact whole-database fingerprint reconciliation.
Cleanup removes only names with this run's ownership label and its own tempdir.
PLAN
  exit 0
fi
if [[ $# != 3 || $1 != --execute-reviewed-rehearsal || $2 != --image || ! $3 =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo 'Refused: use --plan or --execute-reviewed-rehearsal --image sha256:<approved-local-image-id>.' >&2
  exit 2
fi
image=$3
[[ $(id -u) == 0 ]] || { echo 'Refused: expected approved host root session.' >&2; exit 2; }
for binary in docker timeout awk df mktemp; do command -v "$binary" >/dev/null || { echo 'Missing required host tool.' >&2; exit 2; }; done
docker image inspect "$image" >/dev/null 2>&1 || { echo 'Approved image must already exist; no pull performed.' >&2; exit 2; }

# Hard admission limits; do not tune these during a live run to bypass a refusal.
check_capacity() {
  local available_kib swap_used_kib disk_available_kib
  available_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  swap_used_kib=$(awk '/^SwapTotal:/ {total=$2} /^SwapFree:/ {free=$2} END {print total-free}' /proc/meminfo)
  disk_available_kib=$(df -Pk /tmp | awk 'END {print $4}')
  (( available_kib >= 1572864 && swap_used_kib <= 524288 && disk_available_kib >= 2097152 )) || { echo 'Capacity gate refused; production unchanged.' >&2; exit 2; }
}
check_capacity

umask 077
work=$(mktemp -d /tmp/xmail-db-rehearsal.XXXXXXXX)
[[ $work =~ ^/tmp/xmail-db-rehearsal\.[a-zA-Z0-9]{8}$ && -d $work && ! -L $work ]] || exit 2
nonce="$(date -u +%Y%m%dT%H%M%SZ)-$$"
target_name="xmail-db-rehearsal-$nonce-target"
dump_name="xmail-db-rehearsal-$nonce-dump"
probe_name="xmail-db-rehearsal-$nonce-probe"
label_key=com.skale.xmail-db-rehearsal
cleanup() {
  local name owner
  for name in "$dump_name" "$target_name" "$probe_name"; do
    owner=$(docker inspect --format "{{index .Config.Labels \"$label_key\"}}" "$name" 2>/dev/null || true)
    if [[ $owner == "$nonce" ]]; then docker rm -f "$name" >/dev/null 2>&1 || true; fi
  done
  # This exact directory was created by mktemp above; never enumerate other runs.
  if [[ $work =~ ^/tmp/xmail-db-rehearsal\.[a-zA-Z0-9]{8}$ && -d $work && ! -L $work ]]; then rm -rf -- "$work"; fi
  unset source_environment
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
trap 'echo "Rehearsal failed; private diagnostics remain host-local until cleanup. No raw database error was emitted." >&2' ERR

ca_program=$(cat <<'NODE'
const {X509Certificate}=require('node:crypto');
(async()=>{
 const r=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt',{redirect:'error',signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error();const pem=await r.text();if(pem.length>32768)throw Error();const cert=new X509Certificate(pem);
 if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||!cert.ca||!/Supabase/i.test(cert.subject)||cert.fingerprint256.replaceAll(':','')!=='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'||Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now())throw Error();
 process.stdout.write(pem);
})().catch(()=>{process.stderr.write('Public CA validation failed.');process.exitCode=1;});
NODE
)
docker exec xmail node -e "$ca_program" >"$work/source-ca.crt" 2>"$work/ca.log"

environment_program=$(cat <<'NODE'
const postgres=require('postgres'),fs=require('node:fs');
const deadline=setTimeout(()=>{process.stderr.write('Source admission deadline exceeded.');process.exit(124);},35000);deadline.unref();
(async()=>{
 if(process.env.NODE_ENV!=='production'||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error();
 const u=new URL(process.env.DATABASE_URL||'');
 const ref=/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(process.env.SUPABASE_URL||'')?.[1];
 const expected='zzbudkfkcmqkavgwselc',user=decodeURIComponent(u.username);
 const direct=u.hostname==='db.'+expected+'.supabase.co'&&user==='postgres';
 const pooler=/^aws-[0-9]+-[a-z0-9-]+[.]pooler[.]supabase[.]com$/.test(u.hostname)&&user==='postgres.'+expected;
 if(ref!==expected||!['postgres:','postgresql:'].includes(u.protocol)||!(direct||pooler)||u.pathname!=='/postgres'||!['5432','6543'].includes(u.port)||u.hash||!u.password)throw Error();
 for(const [key,value] of u.searchParams){if(!['sslmode','application_name'].includes(key)||u.searchParams.getAll(key).length!==1||(key==='sslmode'&&!['require','verify-ca','verify-full'].includes(value)))throw Error();}
 u.port='5432';u.search='';u.hash='';
 const ca=fs.readFileSync(0,'utf8');
 const sql=postgres(u.href,{max:1,prepare:false,ssl:{ca,rejectUnauthorized:true,servername:u.hostname},connect_timeout:8,idle_timeout:1,onnotice:()=>{}});
 try{await sql.begin('isolation level repeatable read read only',async tx=>{
  await tx.unsafe("SET LOCAL statement_timeout='8000ms'");await tx.unsafe("SET LOCAL lock_timeout='500ms'");
  const [visibility]=await tx.unsafe("SELECT count(*)::int AS tables,count(*) FILTER (WHERE has_table_privilege(c.oid,'SELECT'))::int AS readable,count(*) FILTER (WHERE c.relrowsecurity AND NOT (r.rolsuper OR r.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE'))))::int AS filtered FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.rolname=current_user WHERE n.nspname='public' AND c.relkind IN ('r','p')");
  if(visibility.tables!==70||visibility.readable!==70||visibility.filtered!==0)throw Error();
  const [r]=await tx.unsafe("SELECT current_setting('transaction_read_only') AS ro,(SELECT count(*)::int FROM public.users) AS users,(SELECT count(*)::int FROM public.organization_users) AS memberships,(SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p'))::text AS bytes");
  if(r.ro!=='on'||r.users!==39||r.memberships!==38||BigInt(r.bytes)>209715200n)throw Error();
 });}finally{await sql.end({timeout:2});}
 const env={PGHOST:u.hostname,PGPORT:'5432',PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGSSLMODE:'verify-full',PGSSLROOTCERT:'/source-ca.crt',PGCONNECT_TIMEOUT:'8',PGAPPNAME:'xmail-readonly-rehearsal',PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=2000'};
 if(!env.PGPASSWORD||Object.values(env).some(v=>/[\r\n]/.test(v)))throw Error();
 process.stdout.write(Object.entries(env).map(([k,v])=>k+'='+v).join('\n'));
})().then(()=>clearTimeout(deadline)).catch(()=>{clearTimeout(deadline);process.stderr.write('Verified source admission failed.');process.exitCode=1;});
NODE
)
# Credentials use remote memory/stdin, never a separate env file/argv/log. Docker
# holds the dump client's transient environment metadata until that client is removed.
source_environment=$(docker exec -i xmail node -e "$environment_program" <"$work/source-ca.crt" 2>"$work/source-admission.log")
[[ $source_environment == *'PGSSLMODE=verify-full'* ]] || exit 2

image_probe=$(timeout 15s docker run --rm --pull=never --name "$probe_name" --label "$label_key=$nonce" --log-driver=none \
  --network none --read-only --memory 32m --memory-swap 32m --cpus 0.1 --pids-limit 32 --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint sh "$image" -c 'id -u postgres; id -g postgres; pg_dump --version' 2>"$work/image.log")
mapfile -t image_details <<<"$image_probe"
[[ ${#image_details[@]} == 3 && ${image_details[0]} =~ ^[1-9][0-9]{0,5}$ && ${image_details[1]} =~ ^[1-9][0-9]{0,5}$ && ${image_details[2]} == 'pg_dump (PostgreSQL) 17.'* ]] || exit 2
uid=${image_details[0]}; gid=${image_details[1]}

# The dump client is the only new process allowed source connectivity. It shares
# Xmail's network namespace, has no server/listener and only read-only libpq options.
(
  ulimit -f 262144 # Bash file-size units are KiB: archive hard limit256MiB.
  printf '%s\n' "$source_environment" | timeout --kill-after=5s 150s docker run --rm --pull=never --name "$dump_name" \
    --label "$label_key=$nonce" --log-driver=none --network container:xmail --read-only --memory 128m --memory-swap 128m \
    --cpus 0.5 --pids-limit 64 --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=8388608 \
    --mount "type=bind,src=$work/source-ca.crt,dst=/source-ca.crt,readonly" --env-file /dev/stdin "$image" \
    pg_dump --format=custom --compress=6 --schema=public --schema=supabase_migrations --strict-names \
      --no-owner --no-acl --no-comments --serializable-deferrable --lock-wait-timeout=5s >"$work/source.dump" 2>"$work/dump.log"
)
unset source_environment
[[ -s $work/source.dump ]] || exit 2

check_capacity # Recheck after the source dump before reserving target resources.
docker run -d --rm --pull=never --name "$target_name" --label "$label_key=$nonce" --log-driver=none \
  --network none --read-only --memory 768m --memory-swap 768m --cpus 0.5 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges \
  --user "$uid:$gid" --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=xmail_rehearsal \
  --tmpfs "/var/lib/postgresql/data:rw,nosuid,nodev,size=536870912,uid=$uid,gid=$gid,mode=0700" \
  --tmpfs "/var/run/postgresql:rw,nosuid,nodev,size=8388608,uid=$uid,gid=$gid,mode=0700" --tmpfs /tmp:rw,nosuid,nodev,size=16777216 \
  "$image" postgres -c listen_addresses='' -c shared_buffers=32MB -c work_mem=2MB -c maintenance_work_mem=16MB \
    -c max_connections=8 -c max_wal_size=64MB -c min_wal_size=32MB -c wal_level=minimal -c max_wal_senders=0 \
    -c archive_mode=off -c autovacuum=off >"$work/target.id" 2>"$work/target-start.log"
for attempt in {1..80}; do
  if docker exec "$target_name" sh -c 'test "$(head -n 1 /var/lib/postgresql/data/postmaster.pid 2>/dev/null)" = 1 && pg_isready -q -U postgres -d xmail_rehearsal'; then break; fi
  sleep 0.25
done
# Initdb's temporary server also answers a socket probe. Only PID1 identifies the
# final entrypoint exec; never bootstrap during the temporary server's shutdown.
docker exec "$target_name" sh -c 'test "$(head -n 1 /var/lib/postgresql/data/postmaster.pid 2>/dev/null)" = 1 && pg_isready -q -U postgres -d xmail_rehearsal'

# Compatibility is confined to the isolated target. It cannot authenticate anyone.
docker exec -i "$target_name" psql -X -v ON_ERROR_STOP=1 -U postgres -d xmail_rehearsal >"$work/bootstrap.log" 2>&1 <<'SQL'
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
SQL
# --schema=public emits CREATE SCHEMA public, while initdb/pg_trgm need that
# existing schema. Exclude exactly that one TOC entry; never ignore restore errors
# or filter tables, functions, policies, data, indexes or constraints.
docker exec -i "$target_name" pg_restore --list <"$work/source.dump" >"$work/archive.list" 2>"$work/archive-list.log"
awk '/^[0-9]+; [0-9]+ [0-9]+ SCHEMA - public / { print ";" $0; count++; next } { print } END { if (count != 1) exit 2 }' \
  "$work/archive.list" >"$work/restore.list"
docker exec -i "$target_name" sh -c 'umask 077; cat > /tmp/restore.list' <"$work/restore.list"
timeout --kill-after=5s 180s docker exec -i "$target_name" pg_restore --exit-on-error --no-owner --no-acl --single-transaction --use-list=/tmp/restore.list \
  -U postgres -d xmail_rehearsal <"$work/source.dump" >"$work/restore.log" 2>&1

# Only aggregate results leave the host; no rows/UUIDs/contact hashes are printed.
target_report=$(docker exec -i "$target_name" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d xmail_rehearsal 2>"$work/validation.log" <<'SQL'
DO $$ BEGIN
 IF (SELECT count(*) FROM public.users)<>39 OR (SELECT count(*) FROM public.organization_users)<>38
 OR (SELECT count(*) FROM pg_tables WHERE schemaname='public')<>70
 OR (SELECT count(*) FROM supabase_migrations.schema_migrations)<>78
 OR (SELECT max(version) FROM supabase_migrations.schema_migrations)<>'078'
 OR EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='f' AND NOT c.convalidated)
 OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'xmail_identity_%')
 THEN RAISE EXCEPTION 'Aggregate restoration gate failed'; END IF;
 IF auth.uid() IS NOT NULL OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='authenticated') THEN RAISE EXCEPTION 'Compatibility cannot authenticate'; END IF;
END $$;
SELECT json_build_object('restore','passed','users',39,'organization_users',38,'public_tables',70,'ledger_count',78,'ledger_latest','078','owned_identity_tables',0,'network','none','source_snapshot_comparison','not_performed; concurrent rows may change','auth_cutover','not_tested','temporaryResourcesRemoved',true);
SQL
)
# Do not release a success report until removal is positively proved. On any
# failure the EXIT trap remains a best-effort retry and no success JSON is printed.
cleanup
if ! remaining=$(docker ps -aq --filter "label=$label_key=$nonce" 2>/dev/null); then
  echo 'Cleanup verification failed; success withheld.' >&2; exit 1
fi
if [[ -n $remaining || -e $work || -L $work ]]; then
  echo 'Temporary resources remain; success withheld.' >&2; exit 1
fi
trap - EXIT
printf '%s\n' "$target_report"
