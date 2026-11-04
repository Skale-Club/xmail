#!/usr/bin/env python3
"""Prepare an owned-to-owned pilot rollout. Offline default; never imports Supabase data."""
import argparse
import base64
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

LIBRARY_SHA = '6e9a7a4b211410f6a0e7c073a91169584c3b4593ebf8209c372a4ba0d8c623e7'
UUID = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'

AUTH_REVIEW_JS = r'''
const fs=require('node:fs');const hard=setTimeout(()=>process.exit(124),55000);hard.unref();
(async()=>{
 if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error();
 const x=JSON.parse(fs.readFileSync(0,'utf8')),ref='zzbudkfkcmqkavgwselc';
 if(x.origin!=='https://'+ref+'.supabase.co'||!Array.isArray(x.ids)||!x.ids.length||x.ids.length>1000||new Set(x.ids).size!==x.ids.length||x.ids.some(v=>!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)))throw Error();
 if(typeof x.key!=='string'||x.key.length>16384||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(x.key))throw Error();
 const claims=JSON.parse(Buffer.from(x.key.split('.')[1],'base64url').toString('utf8'));if(claims.ref!==ref||claims.role!=='service_role')throw Error();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),50000),rows=[];let next=0;
 async function one(id){
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
  const r=await fetch(x.origin+'/auth/v1/admin/users/'+id,{method:'GET',headers:{apikey:x.key,Authorization:'Bearer '+x.key},redirect:'error',cache:'no-store',signal});
  const declared=Number(r.headers.get('content-length')||0);if(!r.ok||r.redirected||!Number.isFinite(declared)||declared<0||declared>65536)throw Error();
  const reader=r.body?.getReader();if(!reader)throw Error();const chunks=[];let length=0;
  try{for(;;){const p=await reader.read();if(p.done)break;length+=p.value.byteLength;if(length>65536)throw Error();chunks.push(Buffer.from(p.value))}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
  const raw=JSON.parse(Buffer.concat(chunks).toString('utf8')),u=raw.user??raw;if(!u||u.id!==id||u.app_metadata!=null&&(typeof u.app_metadata!=='object'||Array.isArray(u.app_metadata)))throw Error();
  const disabled=u.app_metadata?.xmail_disabled;if(disabled!=null&&typeof disabled!=='boolean')throw Error();
  const banned=u.banned_until;if(banned!=null&&(typeof banned!=='string'||!Number.isFinite(Date.parse(banned))))throw Error();
  const deleted=u.deleted_at;if(deleted!=null&&(typeof deleted!=='string'||!Number.isFinite(Date.parse(deleted))))throw Error();
  rows.push({id,disabled:disabled===true||deleted!=null||(banned!=null&&Date.parse(banned)>Date.now())});
 }
 try{await Promise.all(Array.from({length:Math.min(4,x.ids.length)},async()=>{for(;;){const index=next++;if(index>=x.ids.length)return;controller.signal.throwIfAborted();await one(x.ids[index])}}))}
 finally{clearTimeout(timer);controller.abort()}
 rows.sort((a,b)=>a.id.localeCompare(b.id));process.stdout.write(JSON.stringify({capturedAt:new Date().toISOString(),users:rows,origin:x.origin}));
})().then(()=>clearTimeout(hard)).catch(()=>{clearTimeout(hard);process.exitCode=1});
'''

AUTH_PROBE_JS = r'''
const fs=require('node:fs'),postgres=require('postgres'),hard=setTimeout(()=>process.exit(124),8000);hard.unref();
(async()=>{const x=JSON.parse(fs.readFileSync(0,'utf8')),u=new URL(x.url);if(u.hostname!=='e12scyfsrp822dag7m9wwd4x'||u.port!=='5432'||u.pathname!=='/xmail'||!['xmail_runtime','xmail_staging_reader'].includes(u.username)||!u.password||u.search||u.hash)throw Error();
 const sql=postgres(u.href,{max:1,prepare:false,connect_timeout:4,idle_timeout:1,onnotice(){}});let result;
 try{const [r]=await sql`SELECT current_user AS role,current_database() AS db`;result={allowed:r.role===u.username&&r.db==='xmail',passwordRejected:false}}
 catch(e){result={allowed:false,passwordRejected:e?.code==='28P01'}}finally{await sql.end({timeout:1})}
 process.stdout.write(JSON.stringify(result));
})().then(()=>clearTimeout(hard)).catch(()=>{clearTimeout(hard);process.exitCode=1});
'''


def require(value):
    if not value: raise ValueError('Owned pilot rollout refused')


def library():
    path = Path(__file__).with_name('prepare-xmail-final-data-cutover.py')
    raw = path.read_bytes().replace(b'\r\n', b'\n')
    require(hashlib.sha256(raw).hexdigest() == LIBRARY_SHA)
    spec = importlib.util.spec_from_file_location('reviewed_owned_rollout_primitives', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def snapshot_sql(m):
    return "SELECT jsonb_build_object('schema',(SELECT schema FROM ("+m.business_schema_sql()+") q)," \
        "'fingerprints',("+m.fingerprints_sql()+"),'ids',(SELECT jsonb_agg(id::text ORDER BY id) FROM public.users)," \
        "'controls',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.user_id),'[]') FROM public.xmail_identity_user_controls c)," \
        "'bindingDigest',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id)::text,'[]'),'UTF8')),'hex') FROM public.xmail_identity_bindings b)," \
        "'challengeDigest',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.challenge_hash)::text,'[]'),'UTF8')),'hex') FROM public.xmail_identity_browser_challenges c)," \
        "'sessionCount',(SELECT count(*) FROM public.xmail_identity_owned_sessions)," \
        "'unsafeDispatches',("+m.dispatch_admission_sql()+"),'capturedAt',to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))"


def owned_guard_sql(m, fenced=False):
    # Preserve every reviewed schema/grant restriction; relax only first-import
    # emptiness, and select LOGIN state appropriate to this rollout phase.
    value = m.CANDIDATE_GUARD
    start = value.index(' OR EXISTS(SELECT FROM public.xmail_identity_bindings)')
    end = value.index(' OR EXISTS(SELECT FROM pg_trigger', start)
    value = value[:start]+value[end:]
    value = value.replace('AND NOT rolcanlogin', 'AND '+('NOT rolcanlogin' if fenced else 'rolcanlogin'))
    if not fenced:
        value = value.replace("OR EXISTS(SELECT FROM pg_stat_activity WHERE datname='xmail' AND pid<>pg_backend_pid())",
            "OR EXISTS(SELECT FROM pg_stat_activity WHERE datname='xmail' AND pid<>pg_backend_pid() AND usename<>'xmail_runtime')")
    return value


def role_fence_sql(m):
    sql = "BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL statement_timeout='10s';"+owned_guard_sql(m)
    return sql+"DO $$ BEGIN IF EXISTS(SELECT FROM pg_stat_activity WHERE datname='xmail' AND pid<>pg_backend_pid()) THEN RAISE EXCEPTION 'Other owned connections remain'; END IF; END $$; ALTER ROLE xmail_runtime NOLOGIN; ALTER ROLE xmail_staging_reader NOLOGIN; COMMIT;\n\\echo OWNED_ROLES_FENCED\n"


def validate_snapshot(value):
    require(isinstance(value, dict) and set(value) == {'schema', 'fingerprints', 'ids', 'controls', 'bindingDigest', 'challengeDigest', 'sessionCount', 'unsafeDispatches', 'capturedAt'})
    ids = value['ids']
    require(isinstance(ids, list) and 0 < len(ids) <= 1000 and len(set(ids)) == len(ids)
        and all(re.fullmatch(UUID, x) for x in ids))
    require(len(value['schema']['tables']) == 70 and set(value['schema']['tables']) == set(value['fingerprints'])
        and value['fingerprints']['users']['count'] == len(ids) and type(value['unsafeDispatches']) is int and value['unsafeDispatches'] == 0)
    require(all(type(x['count']) is int and x['count'] >= 0 and re.fullmatch(r'[a-f0-9]{64}', x['sha256']) for x in value['fingerprints'].values()))
    require(isinstance(value['controls'], list) and all(x['user_id'] in ids for x in value['controls']))
    require(all(re.fullmatch(r'[a-f0-9]{64}',value[x]) for x in ['bindingDigest','challengeDigest'])
        and type(value['sessionCount']) is int and value['sessionCount'] >= 0)


def verify_controls(before, after, review):
    def moment(value):
        parsed = dt.datetime.fromisoformat(value.replace('Z','+00:00'));require(parsed.tzinfo is not None);return parsed
    old = {x['user_id']:x for x in before['controls']};new = {x['user_id']:x for x in after['controls']}
    flags = {x['id']:x['disabled'] for x in review['users']};captured = moment(review['capturedAt'])
    require(set(new) == set(flags) == set(after['ids']) == set(before['ids']))
    for uid,current in new.items():
        previous = old.get(uid)
        require((current['disabled_at'] is not None) == (flags[uid] or previous is not None and previous['disabled_at'] is not None))
        if previous:
            require(moment(current['sessions_valid_after']) >= moment(previous['sessions_valid_after']))
            if previous['disabled_at'] is not None:require(moment(current['disabled_at']) == moment(previous['disabled_at']))
            if not flags[uid] or previous['disabled_at'] is not None:require(current == previous)
            else:require(moment(current['disabled_at']) == captured and moment(current['sessions_valid_after']) >= captured)
        else:
            require(moment(current['sessions_valid_after']) == captured)
            if flags[uid]:require(moment(current['disabled_at']) == captured)


def validate_review(review, ids, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    require(set(review) == {'capturedAt', 'users', 'origin'} and review['origin'] == 'https://zzbudkfkcmqkavgwselc.supabase.co')
    captured = dt.datetime.fromisoformat(review['capturedAt'].replace('Z', '+00:00'))
    require(-5 <= (now-captured).total_seconds() <= 60 and len(review['users']) == len(ids)
        and {x['id'] for x in review['users']} == set(ids))
    require(all(set(x) == {'id', 'disabled'} and re.fullmatch(UUID, x['id']) and type(x['disabled']) is bool for x in review['users']))


def controls_sql(m, review, frozen, runtime_password, reader_password, expiry):
    validate_review(review, frozen['ids'])
    payload = base64.b64encode(m.encoded(review['users'])).decode()
    ref = 'owned-auth-review:'+m.sha(m.encoded(review))
    captured = dt.datetime.fromisoformat(review['capturedAt'].replace('Z', '+00:00')).isoformat()
    expiry_time = dt.datetime.fromisoformat(expiry.replace('Z','+00:00'))
    require(expiry_time.tzinfo is not None and 0 < (expiry_time-dt.datetime.now(dt.timezone.utc)).total_seconds() <= 900)
    expiry = expiry_time.isoformat()
    require(re.fullmatch(r'[0-9T:+.\-]+', captured) and re.fullmatch(r'[0-9T:+.\-]+', expiry))
    sql = "BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='2s';\n"
    sql += 'LOCK TABLE public.users,public.organization_users IN SHARE MODE; LOCK TABLE public.xmail_identity_user_controls IN SHARE ROW EXCLUSIVE MODE; '
    sql += 'LOCK TABLE public.xmail_identity_bindings,public.xmail_identity_owned_sessions,public.xmail_identity_browser_challenges IN SHARE MODE;\n'+owned_guard_sql(m, True)
    sql += "CREATE TEMP TABLE expected_status ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset(convert_from(decode('"+payload+"','base64'),'UTF8')::jsonb) AS r(id uuid,disabled boolean);\n"
    sql += "DO $$ BEGIN IF (SELECT count(*) FROM public.users)<>(SELECT count(*) FROM expected_status) OR EXISTS(SELECT FROM public.users u LEFT JOIN expected_status e ON e.id=u.id WHERE e.id IS NULL) "
    sql += "THEN RAISE EXCEPTION 'Owned UUID status set changed'; END IF; END $$;\n"
    sql += "INSERT INTO public.xmail_identity_user_controls(user_id,disabled_at,sessions_valid_after,review_source,reviewed_at) SELECT e.id,CASE WHEN e.disabled THEN '"+captured+"'::timestamptz ELSE NULL END,'"+captured+"','"+ref+"','"+captured+"' FROM expected_status e ON CONFLICT(user_id) DO NOTHING;\n"
    # Existing active cutoffs stay unchanged, so refreshing controls cannot
    # revoke an independently authenticated admin merely by moving the clock.
    sql += "UPDATE public.xmail_identity_user_controls c SET disabled_at='"+captured+"',sessions_valid_after=greatest(c.sessions_valid_after,'"+captured+"'::timestamptz),review_source='"+ref+"',reviewed_at='"+captured+"' FROM expected_status e WHERE c.user_id=e.id AND e.disabled AND c.disabled_at IS NULL;\n"
    sql += "UPDATE public.xmail_identity_owned_sessions s SET revoked_at=coalesce(s.revoked_at,'"+captured+"'::timestamptz) FROM public.xmail_identity_bindings b JOIN public.xmail_identity_user_controls c ON c.user_id=b.user_id WHERE s.binding_id=b.id AND c.disabled_at IS NOT NULL;\n"
    sql += "DO $$ BEGIN IF (SELECT count(*) FROM public.xmail_identity_user_controls)<>(SELECT count(*) FROM public.users) OR EXISTS(SELECT FROM expected_status e JOIN public.xmail_identity_user_controls c ON c.user_id=e.id WHERE e.disabled AND c.disabled_at IS NULL) THEN RAISE EXCEPTION 'Owned control reconciliation refused'; END IF; END $$;\n"
    sql += "ALTER ROLE xmail_runtime LOGIN PASSWORD '"+m.postgres_scram(runtime_password)+"' VALID UNTIL 'infinity';\n"
    sql += "ALTER ROLE xmail_staging_reader LOGIN PASSWORD '"+m.postgres_scram(reader_password)+"' VALID UNTIL '"+expiry+"';\n"
    return sql+"COMMIT;\n\\echo OWNED_CONTROLS_COMMITTED\n"


def apply(args):
    import fcntl
    require(sys.platform.startswith('linux') and os.geteuid() == 0 and args.enable_pilot
        and re.fullmatch(r'sha256:[a-f0-9]{64}', args.approved_image_id or '')
        and re.fullmatch(r'[a-f0-9]{40}', args.approved_source_sha or '')
        and re.fullmatch(r'[a-f0-9]{64}', args.policy_sha256 or '') and re.fullmatch(r'[a-f0-9]{64}', args.old_container_id or ''))
    m = library(); policy, _ = m.load_public_sources(Path(__file__).parent, args.policy_sha256)
    m.capacity(); policy['secure_directory'](m.OPS, True)
    fd = os.open(m.OPS/'deploy.lock', os.O_WRONLY | os.O_NOFOLLOW)
    lock = os.fstat(fd); require(lock.st_uid == lock.st_gid == 0 and stat.S_IMODE(lock.st_mode) == 0o600 and lock.st_nlink == 1 and lock.st_size == 0)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    resources = []; nonce = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4)
    def node(program, data, phase):
        name = 'xmail-owned-'+phase+'-'+nonce; resources.append(name)
        command = ['docker','run','--rm','--pull=never','-i','--name',name,'--label','com.skale.xmail-owned-rollout='+nonce,
            '--log-driver=none','--network','coolify','--read-only','--memory','128m','--memory-swap','128m','--cpus','0.5',
            '--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','node',args.approved_image_id,'-e',program]
        return m.json_result(m.call(command, m.encoded(data), timeout=65))
    try:
        old = m.inspect(args.old_container_id); old_env = policy['container_env'](old)
        require(old['Id'] == args.old_container_id and old['Name'] == '/xmail' and old['State']['Running'] is True and old['State'].get('Health',{}).get('Status') == 'healthy'
            and (old['Config'].get('Labels') or {}).get('com.skale.xmail.runtime') == 'owned-full')
        profile, reader, *_ = policy['profiles'](m.OPS)
        require(profile['XMAIL_OWNED_AUTH_PHASE'] == 'data' and profile['XMAIL_BROWSER_AUTH_AUTHORITY'] == profile['XMAIL_USER_ADMIN_AUTHORITY'] == 'legacy')
        require(all(old_env.get(k) == v for k,v in profile.items()) and old['Image'] == profile['XMAIL_OWNED_APPROVED_IMAGE_ID'])
        base_raw = policy['secure_read'](m.OPS/'production-base.env'); base = policy['env_file'](base_raw, policy['BASE_KEYS'], False)
        require({k:v for k,v in old_env.items() if k in policy['BASE_KEYS']} == base)
        google_path = Path('/opt/xmail/google-identity-ops/google-auth.env')
        policy['secure_directory'](google_path.parent, True)
        google_raw = policy['secure_read'](google_path, 16384)
        google = policy['env_file'](google_raw, set('XMAIL_GOOGLE_AUTH_ENABLED XMAIL_GOOGLE_AUTH_PROJECT_ID XMAIL_GOOGLE_AUTH_PROJECT_NUMBER XMAIL_GOOGLE_AUTH_WEB_API_KEY XMAIL_GOOGLE_AUTH_ADC_MODE XMAIL_GOOGLE_AUTH_ADC_FILE XMAIL_GOOGLE_AUTH_ADC_AUDIENCE XMAIL_GOOGLE_AUTH_ADC_SERVICE_ACCOUNT XMAIL_GOOGLE_AUTH_ORIGIN'.split()))
        require(all(old_env.get(k) == v for k,v in google.items()) and google['XMAIL_GOOGLE_AUTH_ENABLED'] in ['false','true']
            and google['XMAIL_GOOGLE_AUTH_ADC_MODE'] == 'external_account' and google['XMAIL_GOOGLE_AUTH_ORIGIN'] == 'https://mail.skale.club')
        image = m.inspect(args.approved_image_id)
        require(image['Id'] == args.approved_image_id and (image['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') == args.approved_source_sha)
        files = node("const fs=require('node:fs');console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),files:['dist/server/index.js','dist/server/staging-http.js','dist/server/lib/identity/legacy-account-proof.js'].every(p=>fs.statSync(p).isFile())}))", {}, 'image')
        require(files == {'uid':0,'gid':0,'files':True})
        pg = m.inspect(m.TARGET); mounts = [x for x in pg['Mounts'] if x.get('Destination') == '/var/lib/postgresql/data']
        require(pg['Image'] == m.PG_IMAGE and pg['State']['Running'] is True and pg['State'].get('Health',{}).get('Status') == 'healthy' and len(mounts) == 1
            and mounts[0].get('Type') == 'volume' and mounts[0].get('Name') == 'postgres-data-'+m.TARGET and mounts[0].get('RW') is True
            and not any((pg['NetworkSettings'].get('Ports') or {}).values()) and pg['HostConfig']['Memory'] == pg['HostConfig']['MemorySwap'] == 536870912 and pg['HostConfig']['NanoCpus'] == 750000000)
        m.read_only(owned_guard_sql(m)); before = m.json_result(m.read_only(snapshot_sql(m))); validate_snapshot(before)
        m.ensure_no_other_writers(policy, old, args.approved_image_id)
        from urllib.parse import urlsplit, urlunsplit
        u = urlsplit(profile['DATABASE_URL']); wrong = urlunsplit((u.scheme,'xmail_runtime:'+secrets.token_urlsafe(48)+'@'+m.TARGET+':5432',u.path,'',''))
        require(node(AUTH_PROBE_JS, {'url':wrong}, 'deny-before') == {'allowed':False,'passwordRejected':True})
        auth = {'origin':old_env.get('SUPABASE_URL','').rstrip('/'),'key':old_env.get('SUPABASE_SERVICE_ROLE_KEY',''),'ids':before['ids']}
        initial_review = node(AUTH_REVIEW_JS, auth, 'auth-before'); validate_review(initial_review, before['ids'])
        parent = Path('/opt/xmail/backups'); policy['secure_directory'](parent, True)
        bundle = parent/('owned-pilot-'+nonce); bundle.mkdir(mode=0o700); m.fsync_directory(parent)
        for name,raw in [('previous-profile.env',policy['secure_read'](m.OPS/'owned-runtime.env')),('previous-reader.env',policy['secure_read'](m.OPS/'reader.env')),
            ('previous-google.env',google_raw),('production-base.env',base_raw),('before-manifest.json',m.encoded(before)),('before-auth-review.json',m.encoded(initial_review))]: m.durable_file(bundle/name,raw)
        for name in ['cutover-receipt.json',*policy['PROOF_FILES'].values()]:
            path = m.OPS/name
            if path.exists(): m.durable_file(bundle/('previous-'+name),policy['secure_read'](path))
        backup_sha = m.archive_command(['docker','exec',m.TARGET,'pg_dump','-U','xmail_owner','-d','xmail','--format=custom','--compress=6','--no-owner','--no-acl'],bundle/'owned-before.dump')
        m.durable_file(bundle/'owned-before.sha256',(backup_sha+'\n').encode())
        runtime_password,reader_password = secrets.token_urlsafe(48),secrets.token_urlsafe(48)
        next_profile = {**profile,'DATABASE_URL':'postgres://xmail_runtime:'+runtime_password+'@'+m.TARGET+':5432/xmail',
            'DIRECT_URL':'postgres://xmail_runtime:'+runtime_password+'@'+m.TARGET+':5432/xmail','XMAIL_OWNED_APPROVED_IMAGE_ID':args.approved_image_id,
            'XMAIL_OWNED_APPROVED_SOURCE_SHA':args.approved_source_sha,'XMAIL_OWNED_RECEIPT_SHA256':'0'*64}
        next_reader = {**reader,'XMAIL_STAGING_DATABASE_URL':'postgres://xmail_staging_reader:'+reader_password+'@'+m.TARGET+':5432/xmail'}
        next_google = {**google,'XMAIL_GOOGLE_AUTH_ENABLED':'true'}
        for name,value in [('pending-profile.env',next_profile),('pending-reader.env',next_reader),('pending-google.env',next_google)]: m.durable_file(bundle/name,m.env_bytes(value))
        # Every mutable credential and a complete fresh backup exist before OLD
        # stops. No rollback re-enables the previous writer or its credentials.
        m.call(['docker','update','--restart=no',old['Id']]);m.call(['docker','stop','--time=20',old['Id']],timeout=30)
        stopped = m.inspect(old['Id']);require(not stopped['State']['Running'] and stopped['State'].get('Pid',0) == 0
            and stopped['State'].get('ExitCode') == 0 and stopped['State'].get('OOMKilled') is False)
        m.ensure_no_other_writers(policy, old, args.approved_image_id)
        m.durable_file(bundle/'fence-attempt.json',m.encoded({'attempted':True,'acknowledged':False}))
        require(m.psql(role_fence_sql(m)) == b'OWNED_ROLES_FENCED\n');m.read_only(owned_guard_sql(m,True))
        frozen_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0);expiry = frozen_at+dt.timedelta(minutes=15)
        frozen = m.json_result(m.read_only(snapshot_sql(m)));validate_snapshot(frozen);require(frozen['schema'] == before['schema'])
        m.durable_file(bundle/'owned-frozen.json',m.encoded(frozen))
        review = node(AUTH_REVIEW_JS,{**auth,'ids':frozen['ids']},'auth-frozen');validate_review(review,frozen['ids'])
        m.durable_file(bundle/'owned-auth-review.json',m.encoded(review))
        m.durable_file(bundle/'controls-commit-attempt.json',m.encoded({'attempted':True,'acknowledged':False}))
        require(m.psql(controls_sql(m,review,frozen,runtime_password,reader_password,expiry.isoformat())) == b'OWNED_CONTROLS_COMMITTED\n')
        m.durable_file(bundle/'controls-commit-acknowledged.json',m.encoded({'acknowledged':True}))
        after = m.json_result(m.read_only(snapshot_sql(m)));validate_snapshot(after)
        require(all(after[key] == frozen[key] for key in ['schema','fingerprints','ids','bindingDigest','challengeDigest','sessionCount']))
        verify_controls(frozen,after,review);m.durable_file(bundle/'owned-after-controls.json',m.encoded(after))
        require(node(AUTH_PROBE_JS,{'url':profile['DATABASE_URL']},'deny-old') == {'allowed':False,'passwordRejected':True})
        require(node(AUTH_PROBE_JS,{'url':next_profile['DATABASE_URL']},'allow-new') == {'allowed':True,'passwordRejected':False})
        require(node(AUTH_PROBE_JS,{'url':next_reader['XMAIL_STAGING_DATABASE_URL']},'allow-reader') == {'allowed':True,'passwordRejected':False})
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0);require(now < expiry)
        stamp = lambda x:x.strftime('%Y-%m-%dT%H:%M:%SZ')
        common = {'version':1,'app':'xmail','target':m.TARGET,'database':'xmail','role':'xmail_runtime','postgresImage':m.PG_IMAGE,
            'applicationImage':args.approved_image_id,'sourceSha':args.approved_source_sha,'authPhase':'data','sourceKind':'owned','oldContainerId':old['Id'],
            'createdAt':stamp(now),'expiresAt':stamp(expiry)}
        pointers = {}
        facts = {'freeze':{'allSourceWritersStopped':True,'oldContainerStopped':True,'oldOwnedCredentialsRejected':True},
            'snapshot':{'sourceReadOnlySnapshotComplete':True,'snapshotDigest':m.sha(m.encoded(frozen)),'businessTables':70},
            'controls':{'snapshotReceiptSha256':'','exactUuidControlsReviewed':True,'disabledStatePreserved':True,'noContactAutoLinks':True,'runtimeGrantsReviewed':True}}
        for kind in ['freeze','snapshot','controls']:
            if kind == 'controls':facts[kind]['snapshotReceiptSha256'] = pointers['snapshot']['sha256']
            value = {**common,'kind':kind,'facts':facts[kind],'createdAt':stamp(frozen_at if kind == 'freeze' else now)}
            raw = m.encoded(value);name = policy['PROOF_FILES'][kind];m.durable_file(m.OPS/name,raw,replace=True);pointers[kind] = {'file':name,'sha256':m.sha(raw)}
        for path,value in [(m.OPS/'owned-runtime.env',next_profile),(m.OPS/'reader.env',next_reader),(google_path,next_google)]: m.durable_file(path,m.env_bytes(value),replace=True)
        _,_,digest,*_ = policy['profiles'](m.OPS)
        receipt = {**common,'oldImageId':old['Image'],'profileDigest':digest,'baseEnvironmentSha256':m.sha(base_raw),'proofs':pointers}
        raw = m.encoded(receipt);m.durable_file(m.OPS/'cutover-receipt.json',raw,replace=True)
        next_profile['XMAIL_OWNED_RECEIPT_SHA256'] = m.sha(raw);m.durable_file(m.OPS/'owned-runtime.env',m.env_bytes(next_profile),replace=True)
        import contextlib
        with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink): policy['execute']('inspect')
        m.durable_file(bundle/'pilot-profile-ready.json',m.encoded({'ownedToOwned':True,'businessImport':False,'browserAuthority':'legacy','googlePilotEnabled':True,'applicationStarted':False}))
        result = {'ownedPilotProfileReady':True,'ownedUuidControlsReviewed':len(frozen['ids']),'businessFingerprintsPreserved':70,
            'oldOwnedCredentialsRejected':True,'supabaseBusinessImport':False,'browserAuthority':'legacy','googlePilotEnabled':True,'applicationStarted':False}
    finally:
        failed = False
        for name in resources:
            try:
                for cid in m.call(['docker','ps','-aq','--filter','name=^/'+name+'$']).decode().split():
                    state = m.inspect(cid);require((state['Config'].get('Labels') or {}).get('com.skale.xmail-owned-rollout') == nonce);m.call(['docker','rm','-f',cid])
            except Exception:failed = True
        os.close(fd);require(not failed)
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan',action='store_true');parser.add_argument('--apply',action='store_true');parser.add_argument('--enable-pilot',action='store_true')
    for name in ['approved-image-id','approved-source-sha','policy-sha256','old-container-id']:parser.add_argument('--'+name)
    args = parser.parse_args();require(not(args.plan and args.apply))
    if not args.apply:
        print('PLAN ONLY: owned-to-owned pilot; no files, Docker, network, SQL, credentials, flags or application changes.');return
    apply(args)


if __name__ == '__main__':
    try:main()
    except Exception:
        print('Owned pilot rollout refused/failed; private diagnostics suppressed. No automatic restart or import.',file=sys.stderr);sys.exit(1)
