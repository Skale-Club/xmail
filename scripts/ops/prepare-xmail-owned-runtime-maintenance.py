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


def run(args):
    import fcntl
    require(sys.platform.startswith('linux') and os.geteuid() == 0
        and re.fullmatch(r'[a-f0-9]{64}', args.old_container_id or '') and re.fullmatch(r'[a-f0-9]{64}', args.policy_sha256 or ''))
    pilot, m = libraries(); policy, _ = m.load_public_sources(Path(__file__).parent, args.policy_sha256)
    m.capacity(); policy['secure_directory'](m.OPS, True)
    fd = os.dup(9) if args.parent_lock else os.open(m.OPS/'deploy.lock', os.O_WRONLY | os.O_NOFOLLOW)
    info = os.fstat(fd); require(info.st_uid == info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and info.st_size == 0)
    expected = (m.OPS/'deploy.lock').lstat(); require((info.st_dev, info.st_ino) == (expected.st_dev, expected.st_ino))
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        old, old_env, profile, reader, base_raw, google_raw, google, prior_raw = current_owned(m, policy, args.old_container_id)
        anchor = authority_anchor(m, policy, old, profile, args.prior_authority_bundle)
        m.read_only(pilot.owned_guard_sql(m)); before = m.json_result(m.read_only(snapshot_sql(m, pilot))); validate_snapshot(before, pilot)
        if args.capture_authority:
            path = m.OPS/'owned-authority-current.json'
            if path.exists(): require(policy['secure_read'](path) == anchor)
            else: m.durable_file(path, anchor)
            return {'ownedAuthorityAnchorCaptured': True, 'applicationUnchanged': True, 'sourceAuthRequests': False}
        require(args.apply and re.fullmatch(r'sha256:[a-f0-9]{64}', args.approved_image_id or '')
            and re.fullmatch(r'[a-f0-9]{40}', args.approved_source_sha or '') and os.environ.get('GITHUB_SOURCE_SHA') == args.approved_source_sha)
        next_image = m.inspect(args.approved_image_id)
        require(next_image['Id'] == args.approved_image_id and (next_image['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') == args.approved_source_sha)
        contract = "const fs=require('node:fs');const {browserAuthAuthority}=require('./dist/server/lib/identity/browser-auth-authority.js');if(process.getuid()!==0||process.getgid()!==0||!['dist/server/index.js','dist/server/staging-http.js','dist/server/lib/identity/runtime.js'].every(p=>fs.statSync(p).isFile())||browserAuthAuthority({XMAIL_BROWSER_AUTH_AUTHORITY:'owned',XMAIL_USER_ADMIN_AUTHORITY:'owned',XMAIL_GOOGLE_AUTH_ENABLED:'true'})!=='owned')process.exit(1);"
        m.call(['docker', 'run', '--rm', '--pull=never', '--network', 'none', '--log-driver=none', '--read-only', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', args.approved_image_id, '-e', contract], timeout=8)
        m.ensure_no_other_writers(policy, old, args.approved_image_id)
        bad_url = 'postgres://xmail_runtime:'+secrets.token_urlsafe(48)+'@'+m.TARGET+':5432/xmail'
        require(probe_credentials(m, pilot, args.approved_image_id, bad_url) == {'allowed': False, 'passwordRejected': True})
        nonce = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4)
        parent = Path('/opt/xmail/backups'); policy['secure_directory'](parent, True)
        bundle = parent/('owned-maintenance-'+nonce); bundle.mkdir(mode=0o700); m.fsync_directory(parent)
        attempt_file = m.OPS/'maintenance-attempt.json'
        if attempt_file.exists():
            previous = policy['json_file'](policy['secure_read'](attempt_file))
            require(policy['json_file'](anchor)['commitBundle'] == previous['commitBundle'])
        m.durable_file(attempt_file, m.encoded({'commitBundle': bundle.name, 'oldContainerId': old['Id'], 'automaticRetryAllowed': False}), replace=attempt_file.exists())
        for name, raw in [('previous-profile.env', policy['secure_read'](m.OPS/'owned-runtime.env')), ('previous-reader.env', policy['secure_read'](m.OPS/'reader.env')),
            ('previous-receipt.json', prior_raw), ('previous-authority.json', anchor), ('production-base.env', base_raw), ('google.env', google_raw), ('before-manifest.json', m.encoded(before))]:
            m.durable_file(bundle/name, raw)
        # Preview uses only the existing2-connection reader. Refreshing its
        # expired credential never starts a second full writer or touches users.
        preview_password = secrets.token_urlsafe(48); preview_expiry = (dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=15)).isoformat()
        require(re.fullmatch(r'[0-9T:+.\-]+', preview_expiry))
        preview_reader = {**reader, 'XMAIL_STAGING_DATABASE_URL': 'postgres://xmail_staging_reader:'+preview_password+'@'+m.TARGET+':5432/xmail'}
        m.durable_file(bundle/'preview-reader.env', m.env_bytes(preview_reader))
        require(m.psql("BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL statement_timeout='5s'; DO $$ BEGIN IF EXISTS(SELECT FROM pg_stat_activity WHERE usename='xmail_staging_reader') THEN RAISE EXCEPTION 'Reader is occupied'; END IF; END $$; ALTER ROLE xmail_staging_reader LOGIN PASSWORD '"+m.postgres_scram(preview_password)+"' VALID UNTIL '"+preview_expiry+"'; COMMIT;\n\\echo MAINTENANCE_READER_READY\n") == b'MAINTENANCE_READER_READY\n')
        proof = preview(m, policy, args.approved_image_id, bundle/'preview-reader.env', nonce)
        m.durable_file(bundle/'preview-ready.json', m.encoded(proof))
        m.ensure_no_other_writers(policy, old, args.approved_image_id)
        policy['verify_maintenance_state']({'applicationImage': args.approved_image_id}, google)
        m.archive_command(['docker', 'exec', m.TARGET, 'pg_dump', '-U', 'xmail_owner', '-d', 'xmail', '--format=custom', '--compress=6', '--no-owner', '--no-acl'], bundle/'running-before.dump')
        runtime_password, reader_password = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
        next_profile = {**profile, 'DATABASE_URL': 'postgres://xmail_runtime:'+runtime_password+'@'+m.TARGET+':5432/xmail',
            'DIRECT_URL': 'postgres://xmail_runtime:'+runtime_password+'@'+m.TARGET+':5432/xmail',
            'XMAIL_OWNED_APPROVED_IMAGE_ID': args.approved_image_id, 'XMAIL_OWNED_APPROVED_SOURCE_SHA': args.approved_source_sha, 'XMAIL_OWNED_RECEIPT_SHA256': '0'*64}
        next_reader = {**reader, 'XMAIL_STAGING_DATABASE_URL': 'postgres://xmail_staging_reader:'+reader_password+'@'+m.TARGET+':5432/xmail'}
        for name, value in [('pending-profile.env', next_profile), ('pending-reader.env', next_reader)]: m.durable_file(bundle/name, m.env_bytes(value))
        require(current_owned(m, policy, old['Id'])[0]['Id'] == old['Id'])
        m.call(['docker', 'update', '--restart=no', old['Id']]); m.call(['docker', 'stop', '--time=20', old['Id']], timeout=30)
        stopped = m.inspect(old['Id']); require(not stopped['State']['Running'] and stopped['State'].get('Pid', 0) == 0 and stopped['State'].get('ExitCode') == 0 and stopped['State'].get('OOMKilled') is False)
        m.ensure_no_other_writers(policy, old, args.approved_image_id)
        m.durable_file(bundle/'fence-attempt.json', m.encoded({'attempted': True, 'acknowledged': False}))
        require(m.psql(pilot.role_fence_sql(m)) == b'OWNED_ROLES_FENCED\n')
        frozen_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0); expiry = frozen_at+dt.timedelta(minutes=15)
        frozen = m.json_result(m.read_only(snapshot_sql(m, pilot))); validate_snapshot(frozen, pilot); require(frozen['schema'] == before['schema'])
        m.durable_file(bundle/'owned-frozen.json', m.encoded(frozen))
        backup_sha = m.archive_command(['docker', 'exec', m.TARGET, 'pg_dump', '-U', 'xmail_owner', '-d', 'xmail', '--format=custom', '--compress=6', '--no-owner', '--no-acl'], bundle/'owned-before.dump')
        m.durable_file(bundle/'owned-before.sha256', (backup_sha+'\n').encode())
        m.durable_file(bundle/'maintenance-commit-attempt.json', m.encoded({'attempted': True, 'acknowledged': False}))
        require(m.psql(rotation_sql(m, pilot, frozen, runtime_password, reader_password, expiry.isoformat(), policy['maintenance_state_sql']())) == b'OWNED_MAINTENANCE_COMMITTED\n')
        m.durable_file(bundle/'maintenance-commit-acknowledged.json', m.encoded({'acknowledged': True}))
        after = m.json_result(m.read_only(snapshot_sql(m, pilot))); validate_snapshot(after, pilot); require(preserved(frozen, after))
        m.durable_file(bundle/'owned-after-maintenance.json', m.encoded(after))
        require(probe_credentials(m, pilot, args.approved_image_id, profile['DATABASE_URL']) == {'allowed': False, 'passwordRejected': True})
        require(probe_credentials(m, pilot, args.approved_image_id, next_profile['DATABASE_URL']) == {'allowed': True, 'passwordRejected': False})
        require(probe_credentials(m, pilot, args.approved_image_id, next_reader['XMAIL_STAGING_DATABASE_URL']) == {'allowed': True, 'passwordRejected': False})
        policy['verify_maintenance_state']({'applicationImage': args.approved_image_id}, google)
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0); require(now < expiry)
        stamp = lambda value: value.strftime('%Y-%m-%dT%H:%M:%SZ')
        common = {'version': 2, 'intent': 'owned-maintenance', 'app': 'xmail', 'target': m.TARGET, 'database': 'xmail', 'role': 'xmail_runtime',
            'postgresImage': m.PG_IMAGE, 'applicationImage': args.approved_image_id, 'sourceSha': args.approved_source_sha, 'authPhase': 'identity',
            'sourceKind': 'owned', 'oldContainerId': old['Id'], 'createdAt': stamp(now), 'expiresAt': stamp(expiry)}
        maintenance = {'authorityAlreadyOwned': True, 'currentSqlControlsPreserved': True, 'fullIdentityStatePreserved': True,
            'providerStatusReviewed': True, 'previewReadyBeforeStop': True, 'noSourceAuthRequests': True,
            'previousReceiptSha256': m.sha(prior_raw), 'previousProfileSha256': m.sha(policy['secure_read'](m.OPS/'owned-runtime.env')),
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
        for name, raw in [('maintenance-prior-receipt.json', prior_raw), ('maintenance-prior-profile.env', policy['secure_read'](m.OPS/'owned-runtime.env')),
            ('maintenance-prior-authority.json', anchor)]: m.durable_file(m.OPS/name, raw, replace=True)
        for path, value in [(m.OPS/'owned-runtime.env', next_profile), (m.OPS/'reader.env', next_reader)]: m.durable_file(path, m.env_bytes(value), replace=True)
        _, _, profile_digest, *_ = policy['profiles'](m.OPS)
        receipt = {**common, 'oldImageId': old['Image'], 'profileDigest': profile_digest, 'baseEnvironmentSha256': m.sha(base_raw), 'proofs': pointers}
        raw = m.encoded(receipt); m.durable_file(m.OPS/'cutover-receipt.json', raw, replace=True)
        next_profile['XMAIL_OWNED_RECEIPT_SHA256'] = m.sha(raw); m.durable_file(m.OPS/'owned-runtime.env', m.env_bytes(next_profile), replace=True)
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink): policy['execute']('inspect')
        m.durable_file(bundle/'maintenance-profile-ready.json', m.encoded({'ownedMaintenanceReady': True, 'businessFingerprintsPreserved': 70, 'allIdentityTablesPreserved': True, 'sourceAuthRequests': False}))
        return {'ownedMaintenanceReady': True, 'previewReadyBeforeStop': True, 'businessFingerprintsPreserved': 70,
            'allIdentityTablesPreserved': True, 'sourceAuthRequests': False, 'personalFactorRequired': False, 'applicationStarted': False}
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(); group.add_argument('--plan', action='store_true'); group.add_argument('--capture-authority', action='store_true'); group.add_argument('--apply', action='store_true')
    parser.add_argument('--parent-lock', action='store_true')
    for key in ['approved-image-id', 'approved-source-sha', 'policy-sha256', 'old-container-id', 'prior-authority-bundle']: parser.add_argument('--'+key)
    args = parser.parse_args()
    if not args.apply and not args.capture_authority:
        print('PLAN ONLY: owned maintenance; no Source Auth, factors, files, Docker, SQL, flags or application changes.'); return
    print(json.dumps(run(args)))


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Owned maintenance refused/uncertain; private diagnostics suppressed. No automatic restart, retry or import.', file=sys.stderr); sys.exit(1)
