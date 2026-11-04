#!/usr/bin/env python3
"""Prepare reviewed UUID/ban controls on the existing private candidate; offline by default."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

SOURCE_PROJECT = "zzbudkfkcmqkavgwselc"
CANDIDATE = "e12scyfsrp822dag7m9wwd4x"
PG_IMAGE = "sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"
APP_IMAGE = "sha256:93c4f3284e452b518dfd7f7363152976cd1d1e3d1a28f76814b8a0ea9797b58d"
REVIEW_DIRECTORY = Path("/opt/xmail/identity-controls-review")
SQL_SHA256 = "a3dab37aa8488f03fd1af4a8540a7902cc37badd78475a1a384d2a60f083dd2a"
ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C"}
MAXIMUM = 2 * 1024 * 1024
AUTH_STATUS_SQL = """SELECT p.id::text AS id,a.id IS NOT NULL AS present,
  (coalesce(a.banned_until>transaction_timestamp(),false) OR a.deleted_at IS NOT NULL
    OR coalesce(a.raw_app_meta_data->'xmail_disabled'='true'::jsonb,false)) AS disabled,
  coalesce(jsonb_typeof(a.raw_app_meta_data->'xmail_disabled') IN ('boolean','null'),true) AS valid
  FROM public.users p LEFT JOIN auth.users a ON a.id=p.id ORDER BY p.id LIMIT 10001"""

SOURCE_PROGRAM = r'''
const postgres = require('postgres');
const {X509Certificate}=require('node:crypto');
const hard=setTimeout(()=>process.exit(124),35000);hard.unref();
(async()=>{
  if(process.env.NODE_ENV!=='production'||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error();
  const expected='zzbudkfkcmqkavgwselc', url=new URL(process.env.DIRECT_URL||process.env.DATABASE_URL||'');
  const auth=/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(process.env.SUPABASE_URL||'')?.[1];
  const user=decodeURIComponent(url.username);
  if(auth!==expected||!['postgres:','postgresql:'].includes(url.protocol)||url.pathname!=='/postgres'
    ||!url.password||!['','5432'].includes(url.port)||url.hash
    ||!((url.hostname==='db.'+expected+'.supabase.co'&&user==='postgres')
      ||(/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)&&user==='postgres.'+expected)))throw Error();
  for(const[k,v]of url.searchParams)if(!['sslmode','application_name'].includes(k)||url.searchParams.getAll(k).length!==1
    ||(k==='sslmode'&&!['require','verify-ca','verify-full'].includes(v)))throw Error();
  url.port='5432';url.search='';
  const response=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt',{redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error();const ca=await response.text();if(ca.length>32768)throw Error();
  const cert=new X509Certificate(ca);
  if(!cert.ca||cert.fingerprint256.replaceAll(':','')!=='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
    ||Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now())throw Error();
  const sql=postgres(url.href,{max:1,prepare:false,connect_timeout:8,idle_timeout:1,onnotice(){},
    ssl:{ca,rejectUnauthorized:true,servername:url.hostname}});
  let connection;
  try{
    connection=await sql.reserve();
    await connection.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='8000ms'; SET LOCAL lock_timeout='500ms'; SET LOCAL timezone='UTC'");
    const [state]=await connection.unsafe("SELECT current_setting('transaction_read_only') AS ro,date_trunc('second',transaction_timestamp()) AS captured,(SELECT count(*)::int FROM auth.users) AS auth_count");
    const users=await connection.unsafe(__AUTH_STATUS_QUERY__);
    if(state.ro!=='on'||!users.length||users.length>10000||state.auth_count!==users.length
      ||users.some(row=>!row.present||!row.valid||typeof row.disabled!=='boolean'))throw Error();
    const [digests]=await connection.unsafe(`SELECT
      (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.id)::text,'[]'),'UTF8')),'hex') FROM public.users u) AS users,
      (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id)::text,'[]'),'UTF8')),'hex') FROM public.organization_users m) AS memberships`);
    const review={version:1,app:'xmail',sourceProjectRef:expected,capturedAt:state.captured.toISOString(),
      usersDigest:digests.users,membershipsDigest:digests.memberships,
      users:users.map(({id,disabled})=>({id,disabled})),readOnlySnapshot:true};
    await connection.unsafe('ROLLBACK');connection.release();connection=undefined;
    process.stdout.write(JSON.stringify(review));
  }finally{if(connection){await connection.unsafe('ROLLBACK').catch(()=>{});connection.release();}await sql.end({timeout:2});}
})().then(()=>clearTimeout(hard)).catch(()=>{clearTimeout(hard);process.exitCode=1;});
'''.replace("__AUTH_STATUS_QUERY__", json.dumps(AUTH_STATUS_SQL))


def require(value):
    if not value:
        raise ValueError("Identity control operation refused")


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("Invalid identity control arguments")


def validate_review(value, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    fields = {"version", "app", "sourceProjectRef", "capturedAt", "usersDigest", "membershipsDigest", "users", "readOnlySnapshot"}
    require(isinstance(value, dict) and set(value) == fields and type(value["version"]) is int
            and value["version"] == 1 and value["app"] == "xmail" and value["sourceProjectRef"] == SOURCE_PROJECT
            and value["readOnlySnapshot"] is True)
    require(isinstance(value["capturedAt"], str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z", value["capturedAt"]))
    captured = dt.datetime.fromisoformat(value["capturedAt"].replace("Z", "+00:00"))
    require(-5 <= (now - captured).total_seconds() <= 1800)
    require(all(isinstance(value[key], str) and re.fullmatch(r"[a-f0-9]{64}", value[key]) for key in ("usersDigest", "membershipsDigest")))
    require(isinstance(value["users"], list) and 0 < len(value["users"]) <= 10000)
    ids = set()
    for user in value["users"]:
        require(isinstance(user, dict) and set(user) == {"id", "disabled"} and type(user["disabled"]) is bool
                and isinstance(user["id"], str) and re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", user["id"])
                and user["id"] not in ids)
        ids.add(user["id"])
    return value


def private_read(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(fd)
        require(not path.is_symlink() and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= MAXIMUM)
        if os.name == "posix":
            require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o600)
        data = os.read(fd, MAXIMUM + 1)
        require(len(data) == info.st_size)
        return data
    finally:
        os.close(fd)


def check_directory(path, exact=None):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid == 0 and info.st_gid == 0
            and not info.st_mode & 0o022 and (exact is None or stat.S_IMODE(info.st_mode) == exact))


def command(args, data=None, timeout=20):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=timeout, env=ENV, check=False)
    require(result.returncode == 0 and len(result.stdout) <= MAXIMUM)
    return result.stdout


def app_snapshot(command_fn=command):
    template = '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"started":{{json .State.StartedAt}},"mounts":{{json .Mounts}}}'
    state = json.loads(command_fn(["/usr/bin/docker", "inspect", "--format", template, "xmail"]))
    require(state["running"] is True and state["health"] == "healthy" and state["image"] == APP_IMAGE)
    return state


def candidate_guard(command_fn=command):
    template = '{"image":{{json .Image}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"memory":{{json .HostConfig.Memory}},"swap":{{json .HostConfig.MemorySwap}},"cpu":{{json .HostConfig.NanoCpus}}}'
    state = json.loads(command_fn(["/usr/bin/docker", "inspect", "--format", template, CANDIDATE]))
    require(state["running"] is True and state["health"] == "healthy" and state["image"] == PG_IMAGE
            and not state["ports"] and state["memory"] == state["swap"] == 536870912 and state["cpu"] == 750000000)
    mounts = [item for item in state["mounts"] if item.get("Destination") == "/var/lib/postgresql/data"]
    require(len(mounts) == 1 and mounts[0].get("Type") == "volume" and mounts[0].get("RW") is True)
    base = Path("/opt/xmail/backups")
    check_directory(base)
    valid = 0
    for folder in base.glob("candidate-*"):
        check_directory(folder, 0o700)
        proof = json.loads(private_read(folder / "restore-proof.json"))
        if (proof.get("status") == "candidate_committed_and_reconciled" and proof.get("candidate") == CANDIDATE
                and proof.get("database") == "xmail" and proof.get("publicTableCounts") == 70 and proof.get("digestGroups") == 4):
            require((folder / "snapshot.dump").is_file() and not (folder / "snapshot.dump").is_symlink())
            valid += 1
    require(valid == 1)
    return state


def import_sql(review, source):
    validate_review(review)
    # Strict allowlisting above excludes SQL quoting/dollar delimiters from every
    # value; quote again anyway. Input never enters argv or psql variable flags.
    encoded = json.dumps(review, sort_keys=True, separators=(",", ":")).replace("'", "''")
    return ("BEGIN; DO $review$ BEGIN PERFORM set_config('xmail.identity_status_review','" + encoded
            + "',true); END $review$;\n" + source + "\nCOMMIT;\n").encode("ascii")


def readback_sql(review):
    validate_review(review)
    encoded = json.dumps(review, sort_keys=True, separators=(",", ":")).replace("'", "''")
    return ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='8s'; SET LOCAL timezone='UTC';\n"
            + "WITH review AS (SELECT '" + encoded + "'::jsonb AS payload), expected AS ("
            + "SELECT r.* FROM review,jsonb_to_recordset(payload->'users') AS r(id uuid,disabled boolean))\n"
            + "SELECT jsonb_build_object(\n"
            + "'controlsMatch', (SELECT count(*) FROM public.xmail_identity_user_controls)=(SELECT count(*) FROM expected) AND NOT EXISTS("
            + "SELECT FROM expected r LEFT JOIN public.xmail_identity_user_controls c ON c.user_id=r.id,review "
            + "WHERE c.user_id IS NULL OR c.disabled_at IS DISTINCT FROM CASE WHEN r.disabled THEN (payload->>'capturedAt')::timestamptz ELSE NULL END "
            + "OR c.sessions_valid_after IS DISTINCT FROM (payload->>'capturedAt')::timestamptz "
            + "OR c.reviewed_at IS DISTINCT FROM (payload->>'capturedAt')::timestamptz "
            + "OR c.review_source IS DISTINCT FROM 'legacy-auth-review:'||encode(sha256(convert_to(payload::text,'UTF8')),'hex')),\n"
            + "'userDigestMatched',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.id)::text,'[]'),'UTF8')),'hex') FROM public.users u)=(SELECT payload->>'usersDigest' FROM review),\n"
            + "'membershipsDigestMatched',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id)::text,'[]'),'UTF8')),'hex') FROM public.organization_users m)=(SELECT payload->>'membershipsDigest' FROM review),\n"
            + "'providerBindingsAbsent',NOT EXISTS(SELECT FROM public.xmail_identity_bindings),"
            + "'ownedSessionsAbsent',NOT EXISTS(SELECT FROM public.xmail_identity_owned_sessions));\nROLLBACK;\n").encode("ascii")


def run(mode):
    require(sys.platform.startswith("linux") and os.geteuid() == 0)
    for path in (Path("/"), Path("/opt"), Path("/opt/xmail")):
        check_directory(path)
    before = app_snapshot()
    if mode == "capture":
        # The source program alone reads the running source URL/Auth project.
        # It emits private UUID/ban evidence only to this root process, not chat.
        review = validate_review(json.loads(command(["/usr/bin/docker", "exec", "xmail", "node", "-e", SOURCE_PROGRAM], timeout=45)))
        require(not REVIEW_DIRECTORY.exists() and not REVIEW_DIRECTORY.is_symlink())
        REVIEW_DIRECTORY.mkdir(mode=0o700)
        check_directory(REVIEW_DIRECTORY, 0o700)
        data = (json.dumps(review, sort_keys=True, indent=2) + "\n").encode("ascii")
        for name, content in (("review.json", data), ("review.sha256", (hashlib.sha256(data).hexdigest() + "\n").encode())):
            fd = os.open(REVIEW_DIRECTORY / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as output:
                output.write(content); output.flush(); os.fsync(output.fileno())
        require(app_snapshot() == before)
        return {"reviewCaptured": True, "sourceReadOnly": True, "users": len(review["users"]),
                "disabledUsers": sum(user["disabled"] for user in review["users"]), "candidateChanged": False,
                "productionContainerUnchanged": True, "loginEnabled": False}
    check_directory(REVIEW_DIRECTORY, 0o700)
    import fcntl
    fd = os.open(REVIEW_DIRECTORY / ".import.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and info.st_gid == 0
                and stat.S_IMODE(info.st_mode) == 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        data = private_read(REVIEW_DIRECTORY / "review.json")
        require(private_read(REVIEW_DIRECTORY / "review.sha256").decode().strip() == hashlib.sha256(data).hexdigest())
        review = validate_review(json.loads(data))
        candidate = candidate_guard()
        source = private_read(Path(__file__).with_name("xmail-identity-controls.sql"))
        require(hashlib.sha256(source).hexdigest() == SQL_SHA256)
        psql = ["/usr/bin/docker", "exec", "-i", CANDIDATE, "psql", "-X", "-w", "-qAt",
                "-v", "ON_ERROR_STOP=1", "-U", "xmail_owner", "-d", "xmail"]
        raw = command(psql, import_sql(review, source.decode("ascii")), 35)
        proof = json.loads(raw)
        expected = {"controlsImported", "applicationUsersChanged", "nativePasswordsChanged", "organizationPermissionsChanged",
                    "providerBindingsCreated", "loginEnabled", "users", "disabledUsers"}
        require(isinstance(proof, dict) and set(proof) == expected and proof["controlsImported"] is True
                and all(proof[key] is False for key in expected - {"controlsImported", "users", "disabledUsers"})
                and type(proof["users"]) is int and type(proof["disabledUsers"]) is int
                and proof["users"] == len(review["users"]) and proof["disabledUsers"] == sum(user["disabled"] for user in review["users"]))
        readback = json.loads(command(psql, readback_sql(review), 15))
        require(isinstance(readback, dict) and set(readback) == {"controlsMatch", "userDigestMatched", "membershipsDigestMatched", "providerBindingsAbsent", "ownedSessionsAbsent"}
                and all(value is True for value in readback.values()))
        require(candidate_guard() == candidate and app_snapshot() == before)
        return {**proof, "commitAcknowledged": True, "readbackVerified": True, "productionContainerUnchanged": True,
                "sourceChanged": False, "applicationCutover": False}
    finally:
        os.close(fd)


def main(argv=None):
    parser = Parser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--capture-review", action="store_true")
    mode.add_argument("--apply-reviewed-candidate", action="store_true")
    args = parser.parse_args(argv)
    if not args.capture_review and not args.apply_reviewed_candidate:
        print(json.dumps({"planOnly": True, "networkCallsMade": False, "inputRead": False,
                          "candidate": CANDIDATE, "sourceProjectRef": SOURCE_PROJECT,
                          "requiresSeparateReviewedMigrations079And080": True,
                          "createsProviderBindings": False, "changesNativePasswords": False, "loginEnabled": False}))
        return 0
    print(json.dumps(run("capture" if args.capture_review else "apply"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print('{"identityControlOperationSucceeded":false,"credentialBearingDiagnosticsEmitted":false}')
        sys.exit(1)
