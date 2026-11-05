#!/usr/bin/env python3
"""Owned-to-owned release maintenance. Offline default; no Source Auth inventory."""
import argparse
import contextlib
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time
from urllib.parse import unquote, urlsplit

PILOT_SHA = 'f7305667a88d79150ad6df8f0a9cd4c21977d407f62f23952fd7958e52a1cee7'
GOOGLE_KEYS = set('XMAIL_GOOGLE_AUTH_ENABLED XMAIL_GOOGLE_AUTH_PROJECT_ID XMAIL_GOOGLE_AUTH_PROJECT_NUMBER XMAIL_GOOGLE_AUTH_WEB_API_KEY XMAIL_GOOGLE_AUTH_ADC_MODE XMAIL_GOOGLE_AUTH_ADC_FILE XMAIL_GOOGLE_AUTH_ADC_AUDIENCE XMAIL_GOOGLE_AUTH_ADC_SERVICE_ACCOUNT XMAIL_GOOGLE_AUTH_ORIGIN'.split())
UUID = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
BUNDLE = r'owned-(?:authority|maintenance)-[0-9TZ]{16}-[a-f0-9]{8}'


def require(value):
    if not value: raise ValueError('Owned maintenance refused')


def libraries():
    file = Path(__file__).with_name('prepare-xmail-owned-pilot-rollout.py')
    require(hashlib.sha256(file.read_bytes().replace(b'\r\n', b'\n')).hexdigest() == PILOT_SHA)
    spec = importlib.util.spec_from_file_location('reviewed_owned_helpers', file)
    pilot = importlib.util.module_from_spec(spec); spec.loader.exec_module(pilot)
    return pilot, pilot.library()


def snapshot_sql(m, pilot):
    fields = []
    for table in m.IDENTITY:
        fields += ["'"+table+"'", "(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text COLLATE \"C\")::text,'[]'),'UTF8')),'hex') FROM public."+table+' r)']
    return 'SELECT ('+pilot.snapshot_sql(m)+")::jsonb || jsonb_build_object('identityDigests',jsonb_build_object("+','.join(fields)+'))'


def validate_snapshot(value, pilot):
    require(isinstance(value, dict) and 'identityDigests' in value)
    pilot.validate_snapshot({key: data for key, data in value.items() if key != 'identityDigests'})
    require(set(value['identityDigests']) == {'xmail_identity_bindings', 'xmail_identity_owned_sessions',
        'xmail_identity_browser_challenges', 'xmail_identity_user_controls'})
    require(all(isinstance(v, str) and re.fullmatch(r'[a-f0-9]{64}', v) for v in value['identityDigests'].values()))
    controls = value['controls']
    require(len(controls) == len(value['ids']) and {c['user_id'] for c in controls} == set(value['ids']))
    for control in controls:
        require(isinstance(control['review_source'], str) and control['review_source'] and control['reviewed_at'] is not None)
        for key in ['reviewed_at', 'sessions_valid_after']:
            parsed = dt.datetime.fromisoformat(control[key].replace('Z', '+00:00')); require(parsed.tzinfo is not None)


def preserved(before, after):
    # Native hashes/memberships are inside the seventy complete business hashes.
    # All four identity tables, including full sessions/controls, are immutable.
    return all(before[key] == after[key] for key in ['schema', 'fingerprints', 'ids', 'controls', 'identityDigests',
                                                    'bindingDigest', 'challengeDigest', 'sessionCount'])


def rotation_sql(m, pilot, frozen, runtime_password, reader_password, expiry, state_sql):
    deadline = dt.datetime.fromisoformat(expiry.replace('Z', '+00:00'))
    require(deadline.tzinfo is not None and 0 < (deadline-dt.datetime.now(dt.timezone.utc)).total_seconds() <= 900)
    expiry = deadline.isoformat(); require(re.fullmatch(r'[0-9T:+.\-]+', expiry))
    sql = "BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='2s'; "
    sql += 'LOCK TABLE public.users,public.organization_users,'+','.join('public.'+t for t in m.IDENTITY)+' IN SHARE MODE; '
    sql += pilot.owned_guard_sql(m, True)
    require(state_sql.startswith('SELECT EXISTS(') and ';' not in state_sql)
    sql += "DO $$ BEGIN IF NOT ("+state_sql+") THEN RAISE EXCEPTION 'Owned controls unavailable'; END IF; END $$; "
    sql += "ALTER ROLE xmail_runtime LOGIN PASSWORD '"+m.postgres_scram(runtime_password)+"' VALID UNTIL 'infinity'; "
    sql += "ALTER ROLE xmail_staging_reader LOGIN PASSWORD '"+m.postgres_scram(reader_password)+"' VALID UNTIL '"+expiry+"'; "
    return sql+"COMMIT;\n\\echo OWNED_MAINTENANCE_COMMITTED\n"


def current_owned(m, policy, old_id):
    old = m.inspect(old_id); env = policy['container_env'](old)
    profile, reader, *_ = policy['profiles'](m.OPS)
    require(old['Id'] == old_id and old['Name'] == '/xmail' and old['State']['Running'] is True
        and old['State'].get('Health', {}).get('Status') == 'healthy'
        and (old['Config'].get('Labels') or {}).get('com.skale.xmail.runtime') == 'owned-full')
    require(profile['XMAIL_OWNED_AUTH_PHASE'] == 'identity'
        and profile['XMAIL_BROWSER_AUTH_AUTHORITY'] == profile['XMAIL_USER_ADMIN_AUTHORITY'] == 'owned'
        and all(env.get(key) == value for key, value in profile.items())
        and old['Image'] == profile['XMAIL_OWNED_APPROVED_IMAGE_ID'])
    pg = m.inspect(m.TARGET); mounts = [row for row in pg.get('Mounts', []) if row.get('Destination') == '/var/lib/postgresql/data']
    require(pg['Image'] == m.PG_IMAGE and pg['State']['Running'] and pg['State'].get('Health', {}).get('Status') == 'healthy'
        and len(mounts) == 1 and mounts[0].get('Type') == 'volume' and mounts[0].get('Name') == 'postgres-data-'+m.TARGET and mounts[0].get('RW') is True
        and not any((pg['NetworkSettings'].get('Ports') or {}).values()) and pg['HostConfig']['Memory'] == pg['HostConfig']['MemorySwap'] == 536870912
        and pg['HostConfig']['NanoCpus'] == 750000000)
    base_raw = policy['secure_read'](m.OPS/'production-base.env')
    base = policy['env_file'](base_raw, policy['BASE_KEYS'], False)
    require({k: v for k, v in env.items() if k in policy['BASE_KEYS']} == base)
    google_file = Path('/opt/xmail/google-identity-ops/google-auth.env')
    policy['secure_directory'](google_file.parent, True)
    google_raw = policy['secure_read'](google_file, 16384); google = policy['env_file'](google_raw, GOOGLE_KEYS)
    require(google['XMAIL_GOOGLE_AUTH_ENABLED'] == 'true' and google['XMAIL_GOOGLE_AUTH_ADC_MODE'] == 'external_account'
        and google['XMAIL_GOOGLE_AUTH_ORIGIN'] == 'https://mail.skale.club' and all(env.get(k) == v for k, v in google.items()))
    prior_raw = policy['secure_read'](m.OPS/'cutover-receipt.json'); prior = policy['json_file'](prior_raw)
    require(m.sha(prior_raw) == profile['XMAIL_OWNED_RECEIPT_SHA256'] and prior['authPhase'] == 'identity'
        and prior['sourceKind'] == 'owned' and prior['applicationImage'] == old['Image']
        and prior['sourceSha'] == profile['XMAIL_OWNED_APPROVED_SOURCE_SHA'])
    # Original timestamps stay original. This verifies a historical committed
    # release, never treats its expired15m window as a new publication lease.
    require(policy['timestamp'](prior['createdAt']) <= dt.datetime.now(dt.timezone.utc)
        and policy['timestamp'](prior['expiresAt']) > policy['timestamp'](prior['createdAt']))
    return old, env, profile, reader, base_raw, google_raw, google, prior_raw


def authority_anchor(m, policy, old, profile, bundle_name=None):
    profile_raw = policy['secure_read'](m.OPS/'owned-runtime.env')
    receipt_raw = policy['secure_read'](m.OPS/'cutover-receipt.json')
    if bundle_name is None:
        raw = policy['secure_read'](m.OPS/'owned-authority-current.json')
        value = policy['json_file'](raw)
        require(value['version'] == 1 and value['app'] == 'xmail' and value['authPhase'] == 'identity'
            and value['runtimeId'] == old['Id'] and value['applicationImage'] == old['Image']
            and value['sourceSha'] == profile['XMAIL_OWNED_APPROVED_SOURCE_SHA']
            and value['profileSha256'] == m.sha(profile_raw) and value['receiptSha256'] == m.sha(receipt_raw))
    else:
        require(re.fullmatch(BUNDLE, bundle_name))
        bundle = Path('/opt/xmail/backups')/bundle_name; policy['secure_directory'](bundle, True)
        require(bundle_name.startswith('owned-authority-'))
        ack_file = 'controls-commit-acknowledged.json'
        ack = policy['secure_read'](bundle/ack_file)
        require(policy['json_file'](ack) == {'acknowledged': True})
        ready = policy['json_file'](policy['secure_read'](bundle/'authority-profile-ready.json'))
        require(ready.get('ownedAuthorityProfileReady') is True and ready.get('realAdminChainAccepted') is True)
        pending = policy['env_file'](policy['secure_read'](bundle/'pending-profile.env'), policy['PROFILE_KEYS'])
        require(all(pending[k] == v for k, v in profile.items() if k != 'XMAIL_OWNED_RECEIPT_SHA256'))
        value = {'version': 1, 'app': 'xmail', 'authPhase': 'identity', 'runtimeId': old['Id'], 'applicationImage': old['Image'],
            'sourceSha': profile['XMAIL_OWNED_APPROVED_SOURCE_SHA'], 'profileSha256': m.sha(profile_raw),
            'receiptSha256': m.sha(receipt_raw), 'commitBundle': bundle_name, 'commitAckFile': ack_file, 'commitAckSha256': m.sha(ack)}
        raw = m.encoded(value)
    require(re.fullmatch(BUNDLE, value['commitBundle']) and value['commitAckFile'] in ['controls-commit-acknowledged.json', 'maintenance-commit-acknowledged.json'])
    bundle = Path('/opt/xmail/backups')/value['commitBundle']; policy['secure_directory'](bundle, True)
    ack = policy['secure_read'](bundle/value['commitAckFile'])
    require(m.sha(ack) == value['commitAckSha256'] and policy['json_file'](ack) == {'acknowledged': True})
    return raw


def preview(m, policy, image_id, reader_file, nonce):
    name, network = 'xmail-maintenance-preview-'+nonce, None
    cid = None; attached = False
    try:
        network = m.call(['docker', 'network', 'create', '--internal', '--label', 'com.skale.xmail.maintenance='+nonce, name]).decode().strip()
        require(re.fullmatch(r'[a-f0-9]{64}', network))
        m.call(['docker', 'network', 'connect', '--alias', m.TARGET, network, m.TARGET]); attached = True
        cid = m.call(['docker', 'run', '-d', '--pull=never', '--name', name, '--restart', 'no', '--network', network,
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--memory-swap', '128m',
            '--cpus', '0.25', '--pids-limit', '64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--no-healthcheck', '--log-driver=none',
            '--label', 'com.skale.xmail.maintenance='+nonce, '--env-file', str(reader_file), '--entrypoint', 'node', image_id, 'dist/server/index.js']).decode().strip()
        require(re.fullmatch(r'[a-f0-9]{64}', cid))
        stage = m.inspect(cid); env = policy['container_env'](stage)
        values = policy['env_file'](policy['secure_read'](reader_file), policy['READER_KEYS'])
        require(stage['Image'] == image_id and stage['State']['Running'] and not any((stage['NetworkSettings'].get('Ports') or {}).values())
            and stage['HostConfig']['ReadonlyRootfs'] and stage['Config'].get('Entrypoint') == ['node']
            and stage['Config'].get('Cmd') == ['dist/server/index.js'] and all(env.get(k) == v for k, v in values.items())
            and not any(env.get(k) for k in policy['BASE_KEYS']-{'NODE_ENV', 'PORT'}) and not env.get('DATABASE_URL') and not env.get('DIRECT_URL')
            and not any(k.startswith(('GOOGLE_AUTH_', 'XMAIL_GOOGLE_AUTH_')) and k not in ['GOOGLE_AUTH_ENABLED', 'XMAIL_GOOGLE_AUTH_ENABLED'] for k in env)
            and all(x.get('Type') == 'tmpfs' and x.get('Destination') == '/tmp' for x in stage.get('Mounts', [])))
        probe = "(async()=>{const get=async p=>{const r=await fetch('http://127.0.0.1:9001'+p,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();return r.json()};const h=await get('/health');if(h.mode!=='staging-http-only'||h.sideEffectsEnabled!==false)throw Error();const r=await get('/health/ready');if(!r.summary||!['users','organization_users','platform_admins','native_password_hashes'].every(k=>Number.isInteger(r.summary[k])&&r.summary[k]>=0))throw Error()})().catch(()=>{process.exitCode=1});"
        for _ in range(12):
            try: m.call(['docker', 'exec', cid, 'node', '-e', probe], timeout=12); break
            except Exception: time.sleep(2)
        else: raise ValueError('Owned read-only preview unavailable')
        require(m.inspect(cid)['State']['Running'])
        return {'readOnlyPreviewVerified': True, 'applicationImage': image_id, 'productionStarted': False}
    finally:
        if cid:
            require((m.inspect(cid)['Config'].get('Labels') or {}).get('com.skale.xmail.maintenance') == nonce)
            m.call(['docker', 'rm', '-f', cid])
        if attached: m.call(['docker', 'network', 'disconnect', network, m.TARGET])
        if network: m.call(['docker', 'network', 'rm', network])


def probe_credentials(m, pilot, image, url):
    return m.json_result(m.call(['docker', 'run', '--rm', '--pull=never', '-i', '--log-driver=none', '--network', 'coolify', '--read-only', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image, '-e', pilot.AUTH_PROBE_JS], m.encoded({'url': url}), timeout=12))


BACKUPS = Path('/opt/xmail/backups')
RESTORED_OLD_EXIT = 10
ACCEPTED = {'allowed': True, 'passwordRejected': False}
REJECTED = {'allowed': False, 'passwordRejected': True}
MAINTENANCE_BUNDLE = r'owned-maintenance-[0-9TZ]{16}-[a-f0-9]{8}'
UNSAFE_MARKERS = ['fence-attempt.json', 'maintenance-commit-attempt.json', 'maintenance-commit-acknowledged.json', 'maintenance-profile-ready.json']
CHANGING_PROFILE_KEYS = {'DATABASE_URL', 'DIRECT_URL', 'XMAIL_OWNED_APPROVED_IMAGE_ID', 'XMAIL_OWNED_APPROVED_SOURCE_SHA', 'XMAIL_OWNED_RECEIPT_SHA256'}
STALE_LABELS = ['com.skale.xmail.maintenance', 'com.skale.xmail.runtime=isolated-preview']
ROLE_STATE_SQL = "SELECT string_agg(rolname||'='||rolcanlogin::text, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('xmail_runtime','xmail_staging_reader')"
RECOVERY = {'active': False, 'phase': 'not-detected', 'step': 'start'}


class Refused(ValueError):
    """Recovery refusal carrying only a fixed, non-private verification label."""
    def __init__(self, check):
        super().__init__('Owned maintenance recovery refused'); self.check = check


def need(value, check):
    if not value: raise Refused(check)


def at(step):
    RECOVERY['step'] = step


def emit(phase, action, **extra):
    RECOVERY['phase'] = phase
    print(json.dumps({'recoveryPhase': phase, 'action': action, **extra}, separators=(',', ':')), flush=True)


def deploy_lock(m, args, policy):
    import fcntl
    fd = os.dup(9) if args.parent_lock else os.open(m.OPS/'deploy.lock', os.O_WRONLY | os.O_NOFOLLOW)
    info = os.fstat(fd); require(info.st_uid == info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and info.st_size == 0)
    expected = (m.OPS/'deploy.lock').lstat(); require((info.st_dev, info.st_ino) == (expected.st_dev, expected.st_ino))
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


def check_candidate_image(m, image_id, source_sha):
    next_image = m.inspect(image_id)
    require(next_image['Id'] == image_id and (next_image['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') == source_sha)
    contract = "const fs=require('node:fs');const {browserAuthAuthority}=require('./dist/server/lib/identity/browser-auth-authority.js');if(process.getuid()!==0||process.getgid()!==0||!['dist/server/index.js','dist/server/staging-http.js','dist/server/lib/identity/runtime.js'].every(p=>fs.statSync(p).isFile())||browserAuthAuthority({XMAIL_BROWSER_AUTH_AUTHORITY:'owned',XMAIL_USER_ADMIN_AUTHORITY:'owned',XMAIL_GOOGLE_AUTH_ENABLED:'true'})!=='owned')process.exit(1);"
    m.call(['docker', 'run', '--rm', '--pull=never', '--network', 'none', '--log-driver=none', '--read-only', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image_id, '-e', contract], timeout=8)


def retry_is_safe(policy, previous):
    # An abandoned attempt that never stopped-and-fenced the roles changed nothing
    # durable except the preview reader credential, so a fresh attempt may proceed.
    name = previous.get('commitBundle')
    if not (isinstance(name, str) and re.fullmatch(MAINTENANCE_BUNDLE, name)): return False
    bundle = BACKUPS/name
    try: policy['secure_directory'](bundle, True)
    except Exception: return False
    return not any((bundle/marker).exists() or (bundle/marker).is_symlink() for marker in UNSAFE_MARKERS)


def publish(m, policy, bundle, old, image_id, source_sha, prior_raw, prior_profile_raw, anchor, base_raw,
            frozen, frozen_at, expiry, next_profile, next_reader, backup_sha):
    # Shared by the normal run and by interrupted-deploy recovery. Every call
    # writes brand new receipts inside a fresh window; no old receipt is extended.
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0); require(now < expiry)
    stamp = lambda value: value.strftime('%Y-%m-%dT%H:%M:%SZ')
    common = {'version': 2, 'intent': 'owned-maintenance', 'app': 'xmail', 'target': m.TARGET, 'database': 'xmail', 'role': 'xmail_runtime',
        'postgresImage': m.PG_IMAGE, 'applicationImage': image_id, 'sourceSha': source_sha, 'authPhase': 'identity',
        'sourceKind': 'owned', 'oldContainerId': old['Id'], 'createdAt': stamp(now), 'expiresAt': stamp(expiry)}
    maintenance = {'authorityAlreadyOwned': True, 'currentSqlControlsPreserved': True, 'fullIdentityStatePreserved': True,
        'providerStatusReviewed': True, 'previewReadyBeforeStop': True, 'noSourceAuthRequests': True,
        'previousReceiptSha256': m.sha(prior_raw), 'previousProfileSha256': m.sha(prior_profile_raw),
        'previousAuthoritySha256': m.sha(anchor), 'commitBundle': bundle.name,
        'commitAckSha256': m.sha(policy['secure_read'](bundle/'maintenance-commit-acknowledged.json')),
        'identityStateDigest': m.sha(m.encoded(frozen['identityDigests'])), 'backupSha256': backup_sha}
    facts = {'freeze': {'allSourceWritersStopped': True, 'oldContainerStopped': True, 'oldOwnedCredentialsRejected': True},
        'snapshot': {'sourceReadOnlySnapshotComplete': True, 'snapshotDigest': m.sha(m.encoded(frozen)), 'businessTables': 70},
        'controls': {'snapshotReceiptSha256': '', 'exactUuidControlsReviewed': True, 'disabledStatePreserved': True,
            'noContactAutoLinks': True, 'runtimeGrantsReviewed': True}, 'maintenance': maintenance}
    pointers = {}
    for kind in ['freeze', 'snapshot', 'controls', 'maintenance']:
        if kind == 'controls': facts[kind]['snapshotReceiptSha256'] = pointers['snapshot']['sha256']
        raw = m.encoded({**common, 'kind': kind, 'facts': facts[kind], 'createdAt': stamp(frozen_at if kind == 'freeze' else now)})
        name = policy['PROOF_FILES'][kind]; m.durable_file(m.OPS/name, raw, replace=True); pointers[kind] = {'file': name, 'sha256': m.sha(raw)}
    for name, raw in [('maintenance-prior-receipt.json', prior_raw), ('maintenance-prior-profile.env', prior_profile_raw),
        ('maintenance-prior-authority.json', anchor)]: m.durable_file(m.OPS/name, raw, replace=True)
    for path, value in [(m.OPS/'owned-runtime.env', next_profile), (m.OPS/'reader.env', next_reader)]: m.durable_file(path, m.env_bytes(value), replace=True)
    _, _, profile_digest, *_ = policy['profiles'](m.OPS)
    receipt = {**common, 'oldImageId': old['Image'], 'profileDigest': profile_digest, 'baseEnvironmentSha256': m.sha(base_raw), 'proofs': pointers}
    raw = m.encoded(receipt); m.durable_file(m.OPS/'cutover-receipt.json', raw, replace=True)
    next_profile['XMAIL_OWNED_RECEIPT_SHA256'] = m.sha(raw); m.durable_file(m.OPS/'owned-runtime.env', m.env_bytes(next_profile), replace=True)
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink): policy['execute']('inspect')


def optional(policy, path, maximum=65536):
    try: path.lstat()
    except FileNotFoundError: return None
    try: return policy['secure_read'](path, maximum)
    except Exception: raise Refused('marker-unsafe')


def sql_sessions_quiet(m):
    for _ in range(15):
        if m.read_only("SELECT count(*) FROM pg_stat_activity WHERE datname='xmail' AND pid<>pg_backend_pid()").strip() == b'0': return
        time.sleep(2)
    raise Refused('sql-sessions-linger')


def role_state(m):
    out = m.read_only(ROLE_STATE_SQL).decode().strip()
    if out == 'xmail_runtime=true,xmail_staging_reader=true': return 'login'
    if out == 'xmail_runtime=false,xmail_staging_reader=false': return 'fenced'
    raise Refused('roles-unexpected-state')


def unfence_sql(m, pilot):
    # Exact inverse of pilot.role_fence_sql: that statement only turns LOGIN off,
    # so this only turns it back on, from the fully fenced state and nothing else.
    sql = "BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='2s'; "
    sql += pilot.owned_guard_sql(m, True)
    return sql+"ALTER ROLE xmail_runtime LOGIN; ALTER ROLE xmail_staging_reader LOGIN; COMMIT;\n\\echo OWNED_ROLES_UNFENCED\n"


def reader_refresh_sql(m, password, expiry):
    require(re.fullmatch(r'[0-9T:+.\-]+', expiry) and isinstance(password, str) and password)
    return ("BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL statement_timeout='5s'; "
        "ALTER ROLE xmail_staging_reader LOGIN PASSWORD '"+m.postgres_scram(password)+"' VALID UNTIL '"+expiry+"'; COMMIT;\n\\echo OWNED_READER_REFRESHED\n")


def credential_state(m, pilot, image, old_url, new_url):
    old = probe_credentials(m, pilot, image, old_url); new = probe_credentials(m, pilot, image, new_url)
    if old == ACCEPTED and new == REJECTED: return 'old'
    if old == REJECTED and new == ACCEPTED: return 'new'
    raise Refused('credentials-ambiguous')


def cleanup_stale(m):
    # A cancelled deploy can leave its isolated preview (same image as the
    # candidate, hence counted as a writer) and its internal network behind.
    target = m.inspect(m.TARGET)['Id']
    for label in STALE_LABELS:
        for cid in m.call(['docker', 'ps', '-aq', '--no-trunc', '--filter', 'label='+label]).decode().split():
            need(re.fullmatch(r'[a-f0-9]{64}', cid), 'stale-container-id')
            need(m.inspect(cid)['Name'].startswith(('/xmail-maintenance-preview-', '/xmail-owned-preview')), 'stale-container-unknown')
            m.call(['docker', 'rm', '-f', cid])
        for nid in m.call(['docker', 'network', 'ls', '-q', '--no-trunc', '--filter', 'label='+label]).decode().split():
            net = json.loads(m.call(['docker', 'network', 'inspect', nid]))[0]
            need(net.get('Internal') is True and net['Name'].startswith(('xmail-maintenance-preview-', 'xmail-owned-preview')), 'stale-network-unknown')
            if target in (net.get('Containers') or {}): m.call(['docker', 'network', 'disconnect', '-f', nid, m.TARGET])
            m.call(['docker', 'network', 'rm', nid])


def stale_runtime_names(m, old_id, remove):
    for cid in m.call(['docker', 'ps', '-aq', '--no-trunc', '--filter', 'name=^/xmail$']).decode().split():
        if cid == old_id: continue
        live = m.inspect(cid)
        need(remove and live['Name'] == '/xmail' and live['State']['Running'] is False
            and (live['Config'].get('Labels') or {}).get('com.skale.xmail.runtime') == 'owned-full', 'duplicate-xmail')
        m.call(['docker', 'rm', cid])


def check_old(m, policy, old_id, previous, committed_possible):
    old = m.inspect(old_id); env = policy['container_env'](old)
    names = ['/xmail'] + (['/xmail-frozen-'+old_id[:12]] if committed_possible else [])
    need(old['Id'] == old_id and old['Name'] in names and old['State']['Running'] is False
        and (old['Config'].get('Labels') or {}).get('com.skale.xmail.runtime') == 'owned-full'
        and old['Image'] == previous['XMAIL_OWNED_APPROVED_IMAGE_ID'] and all(env.get(k) == v for k, v in previous.items()), 'old-container')
    return old


def start_old(m, policy, old, image_id):
    m.ensure_no_other_writers(policy, old, image_id)
    m.call(['docker', 'update', '--restart=unless-stopped', old['Id']])
    m.call(['docker', 'start', old['Id']], timeout=30)
    ready = "fetch('http://127.0.0.1:9001/health/ready',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    for _ in range(60):
        time.sleep(3)
        live = m.inspect(old['Id'])
        need(live['State']['Running'] is True, 'old-restart-exited')
        try: m.call(['docker', 'exec', old['Id'], 'node', '-e', ready], timeout=15)
        except Exception: continue
        if live['State'].get('Health', {}).get('Status') == 'healthy': return
    raise Refused('old-restart-unhealthy')


def restore_old(m, pilot, policy, args, ctx):
    phase, bundle, old, previous, roles = ctx['phase'], ctx['bundle'], ctx['old'], ctx['previous'], ctx['roles']
    need(old['Name'] == '/xmail', 'old-container-renamed')
    at('unfence')
    if roles == 'fenced':
        need(m.psql(unfence_sql(m, pilot)) == b'OWNED_ROLES_UNFENCED\n', 'unfence-failed')
    at('unfenced-guard'); m.read_only(pilot.owned_guard_sql(m))
    at('state-preserved')
    frozen_raw = optional(policy, bundle/'owned-frozen.json', 4194304)
    if frozen_raw is not None:
        frozen = policy['json_file'](frozen_raw); validate_snapshot(frozen, pilot)
        current = m.json_result(m.read_only(snapshot_sql(m, pilot))); validate_snapshot(current, pilot)
        need(preserved(frozen, current), 'state-diverged')
    at('old-password')
    need(probe_credentials(m, pilot, args.approved_image_id, previous['DATABASE_URL']) == ACCEPTED, 'old-password-rejected')
    at('stale-runtime'); stale_runtime_names(m, old['Id'], False)
    action = ('unfence-' if roles == 'fenced' else '')+'start-old'
    emit(phase, action)
    at('start-old'); start_old(m, policy, old, args.approved_image_id)
    at('restored-verify')
    live, _env, profile, *_ = current_owned(m, policy, old['Id'])
    anchor = policy['json_file'](authority_anchor(m, policy, live, profile))
    # The abandoned bundle never published: point the attempt journal back at the
    # still-authoritative anchor so a later deploy is not refused as "previous
    # attempt unresolved". The abandoned bundle stays on disk, untouched.
    m.durable_file(ctx['attempt_file'], m.encoded({'commitBundle': anchor['commitBundle'], 'oldContainerId': old['Id'], 'automaticRetryAllowed': False, 'recovered': bundle.name}), replace=True)
    m.durable_file(bundle/'recovery-restored-old.json', m.encoded({'phase': phase, 'action': action}), replace=True)
    emit(phase, 'old-runtime-restored')
    return {'ownedRecovered': True, 'oldRuntimeRestored': True, 'phase': phase, 'applicationStarted': True, 'sourceAuthRequests': False}


def republish(m, pilot, policy, args, ctx):
    phase, bundle, old, previous = ctx['phase'], ctx['bundle'], ctx['old'], ctx['previous']
    emit(phase, 'republish-receipts-continue-deploy')
    at('committed-load')
    frozen = policy['json_file'](policy['secure_read'](bundle/'owned-frozen.json', 4194304)); validate_snapshot(frozen, pilot)
    pending = policy['env_file'](policy['secure_read'](bundle/'pending-profile.env', 16384), policy['PROFILE_KEYS'])
    pending_reader = policy['env_file'](policy['secure_read'](bundle/'pending-reader.env', 16384), policy['READER_KEYS'])
    prior_raw = policy['secure_read'](bundle/'previous-receipt.json'); anchor_raw = policy['secure_read'](bundle/'previous-authority.json')
    prior_profile_raw = policy['secure_read'](bundle/'previous-profile.env', 16384)
    backup_sha = policy['secure_read'](bundle/'owned-before.sha256').decode().strip()
    need(re.fullmatch(r'[a-f0-9]{64}', backup_sha) and optional(policy, bundle/'preview-ready.json') is not None, 'bundle-incomplete')
    for key in ['DATABASE_URL', 'DIRECT_URL']: policy['database_url'](pending[key], 'xmail_runtime')
    policy['database_url'](pending_reader['XMAIL_STAGING_DATABASE_URL'], 'xmail_staging_reader')
    need(pending['DATABASE_URL'] == pending['DIRECT_URL'] and all(pending[k] == v for k, v in previous.items() if k not in CHANGING_PROFILE_KEYS), 'pending-profile-mismatch')
    old_env = policy['container_env'](old)
    base_raw = policy['secure_read'](m.OPS/'production-base.env', 32768); base = policy['env_file'](base_raw, policy['BASE_KEYS'], False)
    google_file = Path('/opt/xmail/google-identity-ops/google-auth.env'); policy['secure_directory'](google_file.parent, True)
    google = policy['env_file'](policy['secure_read'](google_file, 16384), GOOGLE_KEYS)
    need({k: v for k, v in old_env.items() if k in policy['BASE_KEYS']} == base and all(old_env.get(k) == v for k, v in google.items())
        and google['XMAIL_GOOGLE_AUTH_ENABLED'] == 'true' and google['XMAIL_GOOGLE_AUTH_ADC_MODE'] == 'external_account'
        and google['XMAIL_GOOGLE_AUTH_ORIGIN'] == 'https://mail.skale.club', 'environment-changed')
    at('committed-snapshot')
    m.read_only(pilot.owned_guard_sql(m))
    after = m.json_result(m.read_only(snapshot_sql(m, pilot))); validate_snapshot(after, pilot)
    need(preserved(frozen, after), 'committed-state-diverged')
    ack_path, after_path = bundle/'maintenance-commit-acknowledged.json', bundle/'owned-after-maintenance.json'
    ack = optional(policy, ack_path)
    if ack is None: m.durable_file(ack_path, m.encoded({'acknowledged': True}))
    else: need(policy['json_file'](ack) == {'acknowledged': True}, 'ack-invalid')
    written = optional(policy, after_path, 4194304)
    if written is None: m.durable_file(after_path, m.encoded(after))
    else:
        written = policy['json_file'](written); validate_snapshot(written, pilot); need(preserved(frozen, written), 'after-snapshot-invalid')
    at('reader-refresh')
    frozen_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0); expiry = frozen_at+dt.timedelta(minutes=15)
    reader_password = unquote(urlsplit(pending_reader['XMAIL_STAGING_DATABASE_URL']).password or '')
    need(m.psql(reader_refresh_sql(m, reader_password, expiry.isoformat())) == b'OWNED_READER_REFRESHED\n', 'reader-refresh-failed')
    at('committed-probes')
    need(probe_credentials(m, pilot, args.approved_image_id, previous['DATABASE_URL']) == REJECTED, 'old-password-accepted')
    need(probe_credentials(m, pilot, args.approved_image_id, pending['DATABASE_URL']) == ACCEPTED, 'new-password-rejected')
    need(probe_credentials(m, pilot, args.approved_image_id, pending_reader['XMAIL_STAGING_DATABASE_URL']) == ACCEPTED, 'reader-password-rejected')
    at('candidate-image'); check_candidate_image(m, args.approved_image_id, args.approved_source_sha)
    at('maintenance-state'); policy['verify_maintenance_state']({'applicationImage': args.approved_image_id}, google)
    at('stale-runtime'); stale_runtime_names(m, old['Id'], True)
    # The credentials are bound to the database, not to an image: publish the
    # profile for the image this deploy was asked to run (previewed by the consumer).
    next_profile = {**pending, 'XMAIL_OWNED_APPROVED_IMAGE_ID': args.approved_image_id, 'XMAIL_OWNED_APPROVED_SOURCE_SHA': args.approved_source_sha,
        'XMAIL_OWNED_RECEIPT_SHA256': '0'*64}
    at('publish')
    publish(m, policy, bundle, old, args.approved_image_id, args.approved_source_sha, prior_raw, prior_profile_raw, anchor_raw, base_raw,
        frozen, frozen_at, expiry, next_profile, pending_reader, backup_sha)
    m.durable_file(bundle/'maintenance-profile-ready.json', m.encoded({'ownedMaintenanceReady': True, 'businessFingerprintsPreserved': 70, 'allIdentityTablesPreserved': True, 'sourceAuthRequests': False}), replace=True)
    emit(phase, 'receipts-republished')
    return {'ownedMaintenanceReady': True, 'recovered': True, 'oldRuntimeRestored': False, 'applicationStarted': False, 'sourceAuthRequests': False}


def recover_locked(m, pilot, policy, args):
    at('no-running-xmail')
    need(not m.call(['docker', 'ps', '-q', '--no-trunc', '--filter', 'name=^/xmail$']).decode().split(), 'xmail-running')
    at('attempt')
    attempt_file = m.OPS/'maintenance-attempt.json'
    raw = optional(policy, attempt_file); need(raw is not None, 'no-attempt')
    attempt = policy['json_file'](raw)
    need(set(attempt) - {'recovered'} == {'commitBundle', 'oldContainerId', 'automaticRetryAllowed'} and attempt['automaticRetryAllowed'] is False
        and re.fullmatch(MAINTENANCE_BUNDLE, str(attempt['commitBundle'])) and re.fullmatch(r'[a-f0-9]{64}', str(attempt['oldContainerId'])), 'attempt-invalid')
    bundle = BACKUPS/attempt['commitBundle']; policy['secure_directory'](bundle, True)
    anchor = policy['json_file'](policy['secure_read'](m.OPS/'owned-authority-current.json'))
    need(anchor.get('commitBundle') != attempt['commitBundle'], 'already-published')
    marks = {name: optional(policy, bundle/name, 4194304) is not None for name in UNSAFE_MARKERS}
    committed_possible = marks['maintenance-commit-attempt.json'] or marks['maintenance-commit-acknowledged.json'] or marks['maintenance-profile-ready.json']
    phase = ('profile-ready' if marks['maintenance-profile-ready.json'] else 'commit-acknowledged' if marks['maintenance-commit-acknowledged.json']
        else 'commit-attempted' if marks['maintenance-commit-attempt.json'] else 'fenced-no-commit' if marks['fence-attempt.json'] else 'stopped-no-fence')
    RECOVERY['phase'] = phase
    at('previous-profile')
    prior = optional(policy, bundle/'previous-profile.env', 16384)
    if prior is None:
        # Written before any stop/fence/commit marker, so the live profile is still the previous one.
        need(not marks['fence-attempt.json'] and not committed_possible, 'previous-profile-missing')
        prior = policy['secure_read'](m.OPS/'owned-runtime.env', 16384)
    previous = policy['env_file'](prior, policy['PROFILE_KEYS'])
    need(previous['XMAIL_OWNED_AUTH_PHASE'] == 'identity' and previous['XMAIL_BROWSER_AUTH_AUTHORITY'] == previous['XMAIL_USER_ADMIN_AUTHORITY'] == 'owned', 'previous-profile-invalid')
    policy['database_url'](previous['DATABASE_URL'], 'xmail_runtime')
    at('old-container'); old = check_old(m, policy, attempt['oldContainerId'], previous, committed_possible)
    at('stale-cleanup'); cleanup_stale(m)
    at('other-writers'); m.ensure_no_other_writers(policy, old, args.approved_image_id)
    at('sql-sessions'); sql_sessions_quiet(m)
    at('role-state'); roles = role_state(m)
    committed = False
    if committed_possible and roles == 'login':
        # The rotation is one transaction ending with LOGIN: with LOGIN back on
        # the roles prove nothing, so the SCRAM passwords decide who is right.
        at('credential-probes')
        pending = policy['env_file'](policy['secure_read'](bundle/'pending-profile.env', 16384), policy['PROFILE_KEYS'])
        committed = credential_state(m, pilot, args.approved_image_id, previous['DATABASE_URL'], pending['DATABASE_URL']) == 'new'
    need(committed or not (marks['maintenance-commit-acknowledged.json'] or marks['maintenance-profile-ready.json']), 'acknowledged-without-new-credentials')
    ctx = {'phase': phase, 'bundle': bundle, 'old': old, 'previous': previous, 'roles': roles, 'attempt_file': attempt_file}
    if committed:
        phase = ctx['phase'] = ctx['phase'] if ctx['phase'] in ('commit-acknowledged', 'profile-ready') else 'committed-unacknowledged'
        return republish(m, pilot, policy, args, ctx)
    return restore_old(m, pilot, policy, args, ctx)


def recover(args):
    RECOVERY['active'] = True; at('preconditions')
    require(sys.platform.startswith('linux') and os.geteuid() == 0 and args.parent_lock and not args.old_container_id
        and re.fullmatch(r'sha256:[a-f0-9]{64}', args.approved_image_id or '') and re.fullmatch(r'[a-f0-9]{40}', args.approved_source_sha or '')
        and re.fullmatch(r'[a-f0-9]{64}', args.policy_sha256 or '') and os.environ.get('GITHUB_SOURCE_SHA') == args.approved_source_sha)
    at('libraries'); pilot, m = libraries(); policy, _ = m.load_public_sources(Path(__file__).parent, args.policy_sha256)
    at('ops-directory'); policy['secure_directory'](m.OPS, True)
    at('deploy-lock'); fd = deploy_lock(m, args, policy)
    try: return recover_locked(m, pilot, policy, args)
    finally: os.close(fd)


def reanchor(m, policy, old, profile):
    # The anchor is only a durable observation of the healthy owned runtime. When it
    # is stale but the running runtime, profile, receipt and acknowledged bundle all
    # agree, rebuild it from that real state (same shape as the consumer readback).
    # The runtime is never stopped here and nothing is written unless all of it holds.
    at('reanchor')
    raw = optional(policy, m.OPS/'maintenance-attempt.json'); need(raw is not None, 'reanchor-no-attempt')
    attempt = policy['json_file'](raw)
    need(re.fullmatch(MAINTENANCE_BUNDLE, str(attempt.get('commitBundle'))), 'reanchor-attempt-invalid')
    bundle = BACKUPS/attempt['commitBundle']; policy['secure_directory'](bundle, True)
    ack = policy['secure_read'](bundle/'maintenance-commit-acknowledged.json')
    need(policy['json_file'](ack) == {'acknowledged': True}, 'reanchor-ack-invalid')
    ready = policy['json_file'](policy['secure_read'](bundle/'maintenance-profile-ready.json'))
    need(ready.get('ownedMaintenanceReady') is True, 'reanchor-not-ready')
    receipt_raw = policy['secure_read'](m.OPS/'cutover-receipt.json'); receipt = policy['json_file'](receipt_raw)
    need(m.sha(receipt_raw) == profile['XMAIL_OWNED_RECEIPT_SHA256'] and receipt.get('version') == 2 and receipt.get('intent') == 'owned-maintenance'
        and receipt.get('applicationImage') == old['Image'] and receipt.get('sourceSha') == profile['XMAIL_OWNED_APPROVED_SOURCE_SHA'], 'reanchor-receipt-mismatch')
    pointer = receipt['proofs']['maintenance']
    proof_raw = policy['secure_read'](m.OPS/policy['PROOF_FILES']['maintenance'])
    need(pointer['file'] == policy['PROOF_FILES']['maintenance'] and pointer['sha256'] == m.sha(proof_raw), 'reanchor-proof-mismatch')
    facts = policy['json_file'](proof_raw)['facts']
    need(facts['commitBundle'] == bundle.name and facts['commitAckSha256'] == m.sha(ack), 'reanchor-bundle-mismatch')
    value = {'version': 1, 'app': 'xmail', 'authPhase': 'identity', 'runtimeId': old['Id'], 'applicationImage': old['Image'],
        'sourceSha': profile['XMAIL_OWNED_APPROVED_SOURCE_SHA'], 'receiptSha256': profile['XMAIL_OWNED_RECEIPT_SHA256'],
        'profileSha256': m.sha(policy['secure_read'](m.OPS/'owned-runtime.env')), 'commitBundle': bundle.name,
        'commitAckFile': 'maintenance-commit-acknowledged.json', 'commitAckSha256': m.sha(ack)}
    m.durable_file(m.OPS/'owned-authority-current.json', m.encoded(value), replace=True)
    print(json.dumps({'maintenanceStep': 'authority-reanchored', 'action': 'rebuilt-from-healthy-runtime'}, separators=(',', ':')), flush=True)
    return authority_anchor(m, policy, old, profile)


def run(args):
    import fcntl
    RECOVERY['phase'] = 'normal-run'; at('preconditions')
    require(sys.platform.startswith('linux') and os.geteuid() == 0
        and re.fullmatch(r'[a-f0-9]{64}', args.old_container_id or '') and re.fullmatch(r'[a-f0-9]{64}', args.policy_sha256 or ''))
    at('libraries'); pilot, m = libraries(); policy, _ = m.load_public_sources(Path(__file__).parent, args.policy_sha256)
    at('host-capacity'); m.capacity(); at('ops-directory'); policy['secure_directory'](m.OPS, True)
    at('deploy-lock'); fd = deploy_lock(m, args, policy)
    try:
        at('current-runtime')
        old, old_env, profile, reader, base_raw, google_raw, google, prior_raw = current_owned(m, policy, args.old_container_id)
        at('authority-anchor')
        try: anchor = authority_anchor(m, policy, old, profile, args.prior_authority_bundle)
        except Exception:
            if args.prior_authority_bundle or args.capture_authority: raise
            anchor = reanchor(m, policy, old, profile)
        at('sql-snapshot'); m.read_only(pilot.owned_guard_sql(m)); before = m.json_result(m.read_only(snapshot_sql(m, pilot))); validate_snapshot(before, pilot)
        if args.capture_authority:
            path = m.OPS/'owned-authority-current.json'
            if path.exists(): require(policy['secure_read'](path) == anchor)
            else: m.durable_file(path, anchor)
            return {'ownedAuthorityAnchorCaptured': True, 'applicationUnchanged': True, 'sourceAuthRequests': False}
        require(args.apply and re.fullmatch(r'sha256:[a-f0-9]{64}', args.approved_image_id or '')
            and re.fullmatch(r'[a-f0-9]{40}', args.approved_source_sha or '') and os.environ.get('GITHUB_SOURCE_SHA') == args.approved_source_sha)
        at('candidate-image'); check_candidate_image(m, args.approved_image_id, args.approved_source_sha)
        at('other-writers'); m.ensure_no_other_writers(policy, old, args.approved_image_id)
        at('negative-password-probe')
        bad_url = 'postgres://xmail_runtime:'+secrets.token_urlsafe(48)+'@'+m.TARGET+':5432/xmail'
        require(probe_credentials(m, pilot, args.approved_image_id, bad_url) == {'allowed': False, 'passwordRejected': True})
        at('attempt-journal')
        nonce = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4)
        parent = Path('/opt/xmail/backups'); policy['secure_directory'](parent, True)
        bundle = parent/('owned-maintenance-'+nonce); bundle.mkdir(mode=0o700); m.fsync_directory(parent)
        attempt_file = m.OPS/'maintenance-attempt.json'
        if attempt_file.exists():
            previous = policy['json_file'](policy['secure_read'](attempt_file))
            require(policy['json_file'](anchor)['commitBundle'] == previous['commitBundle'] or retry_is_safe(policy, previous))
        m.durable_file(attempt_file, m.encoded({'commitBundle': bundle.name, 'oldContainerId': old['Id'], 'automaticRetryAllowed': False}), replace=attempt_file.exists())
        for name, raw in [('previous-profile.env', policy['secure_read'](m.OPS/'owned-runtime.env')), ('previous-reader.env', policy['secure_read'](m.OPS/'reader.env')),
            ('previous-receipt.json', prior_raw), ('previous-authority.json', anchor), ('production-base.env', base_raw), ('google.env', google_raw), ('before-manifest.json', m.encoded(before))]:
            m.durable_file(bundle/name, raw)
        # Preview uses only the existing2-connection reader. Refreshing its
        # expired credential never starts a second full writer or touches users.
        at('preview-reader'); preview_password = secrets.token_urlsafe(48); preview_expiry = (dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=15)).isoformat()
        require(re.fullmatch(r'[0-9T:+.\-]+', preview_expiry))
        preview_reader = {**reader, 'XMAIL_STAGING_DATABASE_URL': 'postgres://xmail_staging_reader:'+preview_password+'@'+m.TARGET+':5432/xmail'}
        m.durable_file(bundle/'preview-reader.env', m.env_bytes(preview_reader))
        require(m.psql("BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL statement_timeout='5s'; DO $$ BEGIN IF EXISTS(SELECT FROM pg_stat_activity WHERE usename='xmail_staging_reader') THEN RAISE EXCEPTION 'Reader is occupied'; END IF; END $$; ALTER ROLE xmail_staging_reader LOGIN PASSWORD '"+m.postgres_scram(preview_password)+"' VALID UNTIL '"+preview_expiry+"'; COMMIT;\n\\echo MAINTENANCE_READER_READY\n") == b'MAINTENANCE_READER_READY\n')
        at('preview'); proof = preview(m, policy, args.approved_image_id, bundle/'preview-reader.env', nonce)
        m.durable_file(bundle/'preview-ready.json', m.encoded(proof))
        m.ensure_no_other_writers(policy, old, args.approved_image_id)
        at('maintenance-state-before-stop'); policy['verify_maintenance_state']({'applicationImage': args.approved_image_id}, google)
        at('running-backup'); m.archive_command(['docker', 'exec', m.TARGET, 'pg_dump', '-U', 'xmail_owner', '-d', 'xmail', '--format=custom', '--compress=6', '--no-owner', '--no-acl'], bundle/'running-before.dump')
        runtime_password, reader_password = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
        next_profile = {**profile, 'DATABASE_URL': 'postgres://xmail_runtime:'+runtime_password+'@'+m.TARGET+':5432/xmail',
            'DIRECT_URL': 'postgres://xmail_runtime:'+runtime_password+'@'+m.TARGET+':5432/xmail',
            'XMAIL_OWNED_APPROVED_IMAGE_ID': args.approved_image_id, 'XMAIL_OWNED_APPROVED_SOURCE_SHA': args.approved_source_sha, 'XMAIL_OWNED_RECEIPT_SHA256': '0'*64}
        next_reader = {**reader, 'XMAIL_STAGING_DATABASE_URL': 'postgres://xmail_staging_reader:'+reader_password+'@'+m.TARGET+':5432/xmail'}
        for name, value in [('pending-profile.env', next_profile), ('pending-reader.env', next_reader)]: m.durable_file(bundle/name, m.env_bytes(value))
        at('before-stop'); require(current_owned(m, policy, old['Id'])[0]['Id'] == old['Id'])
        at('stop-old'); m.call(['docker', 'update', '--restart=no', old['Id']]); m.call(['docker', 'stop', '--time=20', old['Id']], timeout=30)
        stopped = m.inspect(old['Id']); require(not stopped['State']['Running'] and stopped['State'].get('Pid', 0) == 0 and stopped['State'].get('ExitCode') == 0 and stopped['State'].get('OOMKilled') is False)
        m.ensure_no_other_writers(policy, old, args.approved_image_id)
        at('fence'); m.durable_file(bundle/'fence-attempt.json', m.encoded({'attempted': True, 'acknowledged': False}))
        require(m.psql(pilot.role_fence_sql(m)) == b'OWNED_ROLES_FENCED\n')
        at('frozen-snapshot'); frozen_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0); expiry = frozen_at+dt.timedelta(minutes=15)
        frozen = m.json_result(m.read_only(snapshot_sql(m, pilot))); validate_snapshot(frozen, pilot); require(frozen['schema'] == before['schema'])
        m.durable_file(bundle/'owned-frozen.json', m.encoded(frozen))
        backup_sha = m.archive_command(['docker', 'exec', m.TARGET, 'pg_dump', '-U', 'xmail_owner', '-d', 'xmail', '--format=custom', '--compress=6', '--no-owner', '--no-acl'], bundle/'owned-before.dump')
        m.durable_file(bundle/'owned-before.sha256', (backup_sha+'\n').encode())
        at('commit'); m.durable_file(bundle/'maintenance-commit-attempt.json', m.encoded({'attempted': True, 'acknowledged': False}))
        require(m.psql(rotation_sql(m, pilot, frozen, runtime_password, reader_password, expiry.isoformat(), policy['maintenance_state_sql']())) == b'OWNED_MAINTENANCE_COMMITTED\n')
        m.durable_file(bundle/'maintenance-commit-acknowledged.json', m.encoded({'acknowledged': True}))
        at('after-snapshot'); after = m.json_result(m.read_only(snapshot_sql(m, pilot))); validate_snapshot(after, pilot); require(preserved(frozen, after))
        m.durable_file(bundle/'owned-after-maintenance.json', m.encoded(after))
        at('credential-probes')
        require(probe_credentials(m, pilot, args.approved_image_id, profile['DATABASE_URL']) == {'allowed': False, 'passwordRejected': True})
        require(probe_credentials(m, pilot, args.approved_image_id, next_profile['DATABASE_URL']) == {'allowed': True, 'passwordRejected': False})
        require(probe_credentials(m, pilot, args.approved_image_id, next_reader['XMAIL_STAGING_DATABASE_URL']) == {'allowed': True, 'passwordRejected': False})
        policy['verify_maintenance_state']({'applicationImage': args.approved_image_id}, google)
        at('publish'); previous_profile_raw = policy['secure_read'](bundle/'previous-profile.env')
        publish(m, policy, bundle, old, args.approved_image_id, args.approved_source_sha, prior_raw, previous_profile_raw, anchor, base_raw,
            frozen, frozen_at, expiry, next_profile, next_reader, backup_sha)
        m.durable_file(bundle/'maintenance-profile-ready.json', m.encoded({'ownedMaintenanceReady': True, 'businessFingerprintsPreserved': 70, 'allIdentityTablesPreserved': True, 'sourceAuthRequests': False}))
        return {'ownedMaintenanceReady': True, 'previewReadyBeforeStop': True, 'businessFingerprintsPreserved': 70,
            'allIdentityTablesPreserved': True, 'sourceAuthRequests': False, 'personalFactorRequired': False, 'applicationStarted': False}
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(); group.add_argument('--plan', action='store_true'); group.add_argument('--capture-authority', action='store_true'); group.add_argument('--apply', action='store_true')
    group.add_argument('--recover-interrupted', action='store_true')
    parser.add_argument('--parent-lock', action='store_true')
    for key in ['approved-image-id', 'approved-source-sha', 'policy-sha256', 'old-container-id', 'prior-authority-bundle']: parser.add_argument('--'+key)
    args = parser.parse_args()
    if args.recover_interrupted:
        result = recover(args); print(json.dumps(result))
        if result.get('oldRuntimeRestored') is True: sys.exit(RESTORED_OLD_EXIT)
        return
    if not args.apply and not args.capture_authority:
        print('PLAN ONLY: owned maintenance; no Source Auth, factors, files, Docker, SQL, flags or application changes.'); return
    print(json.dumps(run(args)))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # Fixed labels only: the failed verification and detected phase, never values.
        check = error.check if isinstance(error, Refused) else RECOVERY['step']
        print(json.dumps({'recoveryPhase': RECOVERY['phase'], 'action': 'refused', 'check': check}, separators=(',', ':')), file=sys.stderr)
        print('Owned maintenance refused/uncertain; private diagnostics suppressed. No automatic restart, retry or import.', file=sys.stderr); sys.exit(1)
