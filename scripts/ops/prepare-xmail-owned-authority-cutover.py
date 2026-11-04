#!/usr/bin/env python3
"""Prepare the final owned browser authority. Offline default; no factor simulation."""
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

ENTRY_MAX_AGE_SECONDS = 90
FINAL_MAX_AGE_SECONDS = 300

PILOT_SHA = 'f7305667a88d79150ad6df8f0a9cd4c21977d407f62f23952fd7958e52a1cee7'
FACT_KEYS = ['adminUserId','bindingId','sessionHash','legacyAnchorBindingId','legacyAnchorSessionHash']
CHECK_KEYS = ['independentLegacyProof','freshGoogleProof','ownedSessionAccepted','applicationAdminVerified']
GOOGLE_KEYS = set('XMAIL_GOOGLE_AUTH_ENABLED XMAIL_GOOGLE_AUTH_PROJECT_ID XMAIL_GOOGLE_AUTH_PROJECT_NUMBER XMAIL_GOOGLE_AUTH_WEB_API_KEY XMAIL_GOOGLE_AUTH_ADC_MODE XMAIL_GOOGLE_AUTH_ADC_FILE XMAIL_GOOGLE_AUTH_ADC_AUDIENCE XMAIL_GOOGLE_AUTH_ADC_SERVICE_ACCOUNT XMAIL_GOOGLE_AUTH_ORIGIN'.split())

# Runs only in an ephemeral pinned application image with the certificate directory
# read-only. No application environment, DB URL, app startup, SDK session or ports.
PROVIDER_REVIEW_JS = r'''
const fs=require('node:fs'),hard=setTimeout(()=>process.exit(124),9000);hard.unref();
(async()=>{
 const x=JSON.parse(fs.readFileSync(0,'utf8'));
 if(!x||x.subject===x.anchorSubject||[x.subject,x.anchorSubject].some(s=>typeof s!=='string'||!s.length||s.length>128)||[x.authenticatedAt,x.anchorAuthenticatedAt].some(t=>!Number.isSafeInteger(t)||t<=0))throw Error();
 if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||Object.keys(x.env).some(k=>!k.startsWith('XMAIL_GOOGLE_AUTH_')))throw Error();
 Object.assign(process.env,x.env,{NODE_ENV:'production'});
 const {resolveIdentityConfig}=require('./dist/server/lib/identity/config.js');
 const {createKeylessAccessTokenSupplier}=require('./dist/server/lib/identity/runtime.js');
 const config=resolveIdentityConfig(process.env);if(!config||config.projectId!=='skaleclub'||config.projectNumber!=='937861185231'||config.origin!=='https://mail.skale.club'||config.adcMode!=='external_account')throw Error();
 const signal=AbortSignal.timeout(8000),supplier=await createKeylessAccessTokenSupplier(config),token=await supplier(signal);
 async function account(subject,authTime){
  const r=await fetch('https://identitytoolkit.googleapis.com/v1/projects/skaleclub/accounts:lookup',{method:'POST',redirect:'error',signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({localId:[subject]})});
  if(!r.ok||r.redirected)throw Error();const reader=r.body?.getReader();if(!reader)throw Error();let n=0,chunks=[];
  try{for(;;){const p=await reader.read();if(p.done)break;n+=p.value.byteLength;if(n>65536)throw Error();chunks.push(Buffer.from(p.value))}}finally{void reader.cancel().catch(()=>{})}
  const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(b.users)||b.users.length!==1)throw Error();const u=b.users[0];
  if(!u||u.localId!==subject||u.tenantId!==undefined||u.disabled!==undefined&&typeof u.disabled!=='boolean'||u.disabled===true||u.validSince!==undefined&&(typeof u.validSince!=='string'||!/^\d+$/.test(u.validSince)))throw Error();
  const since=Number(u.validSince??'0');if(!Number.isSafeInteger(since)||since<0||authTime<since||!Array.isArray(u.providerUserInfo))throw Error();
  return u;
 }
 const [child,anchor]=await Promise.all([account(x.subject,x.authenticatedAt),account(x.anchorSubject,x.anchorAuthenticatedAt)]);
 // Distinct subjects and unambiguous current capabilities are required. This
 // intentionally refuses a same-UID merged account or a mixed-provider child.
 const phone=/^\+[1-9]\d{7,14}$/.test(child.phoneNumber??'')&&child.providerUserInfo.length>0&&child.providerUserInfo.every(p=>p&&p.providerId==='phone');
 const google=anchor.providerUserInfo.some(p=>p&&p.providerId==='google.com')&&anchor.phoneNumber===undefined;
 if(!phone||!google)throw Error();
 process.stdout.write(JSON.stringify({currentProviderActive:true,anchorProviderActive:true,distinctGoogleAndPhone:true}));
})().then(()=>clearTimeout(hard)).catch(()=>{clearTimeout(hard);process.exitCode=1});
'''


def require(value):
    if not value: raise ValueError('Owned authority cutover refused')


def libraries():
    path = Path(__file__).with_name('prepare-xmail-owned-pilot-rollout.py')
    require(hashlib.sha256(path.read_bytes().replace(b'\r\n',b'\n')).hexdigest() == PILOT_SHA)
    spec = importlib.util.spec_from_file_location('reviewed_owned_pilot',path)
    pilot = importlib.util.module_from_spec(spec);spec.loader.exec_module(pilot)
    return pilot,pilot.library()


def select_acceptance(rows, now=None, max_age=ENTRY_MAX_AGE_SECONDS):
    """Only real queried API rows; refuse missing factors, ambiguous ancestry or users."""
    now = now or dt.datetime.now(dt.timezone.utc)
    require(isinstance(rows,list) and 0 < len(rows) < 101)
    keys = set(FACT_KEYS+['subject','anchorSubject','authenticatedAt','anchorAuthenticatedAt','sessionCreatedAt'])
    for row in rows:
        require(isinstance(row,dict) and set(row) == keys)
        for k in ['adminUserId','bindingId','legacyAnchorBindingId']:
            require(isinstance(row[k],str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',row[k]))
        for k in ['sessionHash','legacyAnchorSessionHash']:require(isinstance(row[k],str) and re.fullmatch(r'[a-f0-9]{64}',row[k]))
        require(all(isinstance(row[k],str) and 0 < len(row[k]) <= 128 for k in ['subject','anchorSubject']))
        require(type(row['authenticatedAt']) is int and 0 <= now.timestamp()-row['authenticatedAt'] <= 300)
        # Historical ownership is fresh AT the original phone binding (SQL).
        # Current local cutoffs and Google validSince still apply to that proof.
        require(type(row['anchorAuthenticatedAt']) is int and 0 < row['anchorAuthenticatedAt'] <= now.timestamp())
        moment = dt.datetime.fromisoformat(row['sessionCreatedAt'].replace('Z','+00:00'))
        require(moment.tzinfo is not None and 0 <= (now-moment).total_seconds() <= 300)
    require(len({r['adminUserId'] for r in rows}) == 1)
    eligible = [r for r in rows if r['bindingId'] != r['legacyAnchorBindingId'] and r['subject'] != r['anchorSubject'] and r['sessionHash'] != r['legacyAnchorSessionHash']]
    require(eligible)
    eligible.sort(key=lambda r:(r['sessionCreatedAt'],r['sessionHash']),reverse=True)
    current = eligible[0]
    require(sum(r['sessionHash'] == current['sessionHash'] for r in eligible) == 1)
    # Entry admits only <=90s. Subsequent checks retain the <=300s contract.
    require(now.timestamp()-current['authenticatedAt'] <= max_age)
    return current


def acceptance_facts(row):
    return {**{k:row[k] for k in FACT_KEYS},**{k:True for k in CHECK_KEYS}}


def verified_acceptance(rows, verify_local, verify_provider, expected=None, max_age=ENTRY_MAX_AGE_SECONDS, now=None):
    row=select_acceptance(rows,now=now,max_age=max_age)
    if expected is not None:
        require(all(row[k]==expected[k] for k in FACT_KEYS+['subject','anchorSubject','authenticatedAt','anchorAuthenticatedAt']))
    facts=acceptance_facts(row)
    verify_local(facts)
    require(verify_provider(row)=={'currentProviderActive':True,'anchorProviderActive':True,'distinctGoogleAndPhone':True})
    return row,facts


def run(args):
    import fcntl
    require(sys.platform.startswith('linux') and os.geteuid() == 0
        and re.fullmatch(r'sha256:[a-f0-9]{64}',args.approved_image_id or '')
        and re.fullmatch(r'[a-f0-9]{40}',args.approved_source_sha or '')
        and re.fullmatch(r'[a-f0-9]{64}',args.policy_sha256 or '')
        and re.fullmatch(r'[a-f0-9]{64}',args.old_container_id or ''))
    pilot,m = libraries();policy,_ = m.load_public_sources(Path(__file__).parent,args.policy_sha256)
    m.capacity();policy['secure_directory'](m.OPS,True)
    fd = os.open(m.OPS/'deploy.lock',os.O_WRONLY|os.O_NOFOLLOW);lock = os.fstat(fd)
    require(lock.st_uid == lock.st_gid == 0 and stat.S_IMODE(lock.st_mode) == 0o600 and lock.st_nlink == 1 and lock.st_size == 0)
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    nonce = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4);resources=[]
    def node(program,data,phase,certificates=False):
        name='xmail-authority-'+phase+'-'+nonce;resources.append(name)
        command=['docker','run','--rm','--pull=never','-i','--name',name,'--label','com.skale.xmail-authority-cutover='+nonce,
            '--log-driver=none','--network','coolify','--read-only','--memory','128m','--memory-swap','128m','--cpus','0.5',
            '--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges']
        if certificates:command += ['--mount','type=bind,src=/opt/xmail/google-identity-runtime,dst=/run/secrets/xmail-google-identity,readonly']
        command += ['--entrypoint','node',args.approved_image_id,'-e',program]
        return m.json_result(m.call(command,m.encoded(data),timeout=65 if not certificates else 12))
    try:
        old=m.inspect(args.old_container_id);old_env=policy['container_env'](old)
        profile,reader,*_=policy['profiles'](m.OPS)
        require(old['Id']==args.old_container_id and old['Name']=='/xmail' and old['State']['Running'] is True
            and old['State'].get('Health',{}).get('Status')=='healthy' and old['Image']==args.approved_image_id
            and (old['Config'].get('Labels') or {}).get('com.skale.xmail.runtime')=='owned-full'
            and profile['XMAIL_OWNED_APPROVED_IMAGE_ID']==args.approved_image_id and profile['XMAIL_OWNED_APPROVED_SOURCE_SHA']==args.approved_source_sha
            and profile['XMAIL_OWNED_AUTH_PHASE']=='data' and profile['XMAIL_BROWSER_AUTH_AUTHORITY']==profile['XMAIL_USER_ADMIN_AUTHORITY']=='legacy'
            and all(old_env.get(k)==v for k,v in profile.items()))
        image=m.inspect(args.approved_image_id)
        require(image['Id']==args.approved_image_id and (image['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')==args.approved_source_sha)
        base_raw=policy['secure_read'](m.OPS/'production-base.env');base=policy['env_file'](base_raw,policy['BASE_KEYS'],False)
        require({k:v for k,v in old_env.items() if k in policy['BASE_KEYS']}==base)
        google_path=Path('/opt/xmail/google-identity-ops/google-auth.env');policy['secure_directory'](google_path.parent,True)
        google_raw=policy['secure_read'](google_path,16384);google=policy['env_file'](google_raw,GOOGLE_KEYS)
        require(google['XMAIL_GOOGLE_AUTH_ENABLED']=='true' and google['XMAIL_GOOGLE_AUTH_ADC_MODE']=='external_account'
            and google['XMAIL_GOOGLE_AUTH_ORIGIN']=='https://mail.skale.club' and all(old_env.get(k)==v for k,v in google.items()))
        pg=m.inspect(m.TARGET);mounts=[v for v in pg['Mounts'] if v.get('Destination')=='/var/lib/postgresql/data']
        require(pg['Image']==m.PG_IMAGE and pg['State']['Running'] is True and pg['State'].get('Health',{}).get('Status')=='healthy'
            and len(mounts)==1 and mounts[0].get('Type')=='volume' and mounts[0].get('Name')=='postgres-data-'+m.TARGET and mounts[0].get('RW') is True
            and not any((pg['NetworkSettings'].get('Ports') or {}).values()) and pg['HostConfig']['Memory']==pg['HostConfig']['MemorySwap']==536870912 and pg['HostConfig']['NanoCpus']==750000000)
        m.read_only(pilot.owned_guard_sql(m));m.ensure_no_other_writers(policy,old,args.approved_image_id)
        def capture(expected=None,max_age=ENTRY_MAX_AGE_SECONDS):
            return verified_acceptance(m.json_result(m.read_only(policy['admin_acceptance_candidates_sql']())),
                lambda facts:policy['verify_linked_admin']({'_acceptedAdmin':facts}),
                lambda row:node(PROVIDER_REVIEW_JS,{**row,'env':google},'provider',True),expected,max_age)
        row,facts=capture()
        if args.capture:
            # Private facts derived from SQL/provider, never public/raw output.
            m.durable_file(m.OPS/'admin-acceptance-capture.json',m.encoded({'capturedAt':dt.datetime.now(dt.timezone.utc).isoformat(),
                'oldContainerId':old['Id'],'applicationImage':args.approved_image_id,'sourceSha':args.approved_source_sha,'facts':facts}),replace=True)
            return {'realAdminChainAccepted':True,'distinctGoogleAndPhone':True,'applicationUnchanged':True}
        before=m.json_result(m.read_only(pilot.snapshot_sql(m)));pilot.validate_snapshot(before)
        from urllib.parse import urlsplit,urlunsplit
        u=urlsplit(profile['DATABASE_URL']);wrong=urlunsplit((u.scheme,'xmail_runtime:'+secrets.token_urlsafe(48)+'@'+m.TARGET+':5432',u.path,'',''))
        require(node(pilot.AUTH_PROBE_JS,{'url':wrong},'deny-before')=={'allowed':False,'passwordRejected':True})
        auth={'origin':old_env.get('SUPABASE_URL','').rstrip('/'),'key':old_env.get('SUPABASE_SERVICE_ROLE_KEY',''),'ids':before['ids']}
        initial_review=node(pilot.AUTH_REVIEW_JS,auth,'auth-before');pilot.validate_review(initial_review,before['ids'])
        parent=Path('/opt/xmail/backups');policy['secure_directory'](parent,True)
        bundle=parent/('owned-authority-'+nonce);bundle.mkdir(mode=0o700);m.fsync_directory(parent)
        for name,raw in [('previous-profile.env',policy['secure_read'](m.OPS/'owned-runtime.env')),('previous-reader.env',policy['secure_read'](m.OPS/'reader.env')),
            ('previous-google.env',google_raw),('production-base.env',base_raw),('before-manifest.json',m.encoded(before)),('before-auth-review.json',m.encoded(initial_review))]:m.durable_file(bundle/name,raw)
        for name in ['cutover-receipt.json',*policy['PROOF_FILES'].values()]:
            path=m.OPS/name
            if path.exists():m.durable_file(bundle/('previous-'+name),policy['secure_read'](path))
        backup_sha=m.archive_command(['docker','exec',m.TARGET,'pg_dump','-U','xmail_owner','-d','xmail','--format=custom','--compress=6','--no-owner','--no-acl'],bundle/'owned-before.dump')
        m.durable_file(bundle/'owned-before.sha256',(backup_sha+'\n').encode())
        runtime_password,reader_password=secrets.token_urlsafe(48),secrets.token_urlsafe(48)
        next_profile={**profile,'DATABASE_URL':'postgres://xmail_runtime:'+runtime_password+'@'+m.TARGET+':5432/xmail',
            'DIRECT_URL':'postgres://xmail_runtime:'+runtime_password+'@'+m.TARGET+':5432/xmail','XMAIL_OWNED_AUTH_PHASE':'identity',
            'XMAIL_BROWSER_AUTH_AUTHORITY':'owned','XMAIL_USER_ADMIN_AUTHORITY':'owned','XMAIL_OWNED_RECEIPT_SHA256':'0'*64}
        next_reader={**reader,'XMAIL_STAGING_DATABASE_URL':'postgres://xmail_staging_reader:'+reader_password+'@'+m.TARGET+':5432/xmail'}
        for name,value in [('pending-profile.env',next_profile),('pending-reader.env',next_reader)]:m.durable_file(bundle/name,m.env_bytes(value))
        row,facts=capture(row,max_age=FINAL_MAX_AGE_SECONDS) # Recheck the same admitted chain after slow work, still <=300s.
        m.durable_file(bundle/'admin-before-stop.json',m.encoded(facts))
        m.call(['docker','update','--restart=no',old['Id']]);m.call(['docker','stop','--time=20',old['Id']],timeout=30)
        stopped=m.inspect(old['Id']);require(not stopped['State']['Running'] and stopped['State'].get('Pid',0)==0 and stopped['State'].get('ExitCode')==0 and stopped['State'].get('OOMKilled') is False)
        m.ensure_no_other_writers(policy,old,args.approved_image_id)
        m.durable_file(bundle/'fence-attempt.json',m.encoded({'attempted':True,'acknowledged':False}))
        require(m.psql(pilot.role_fence_sql(m))==b'OWNED_ROLES_FENCED\n');m.read_only(pilot.owned_guard_sql(m,True))
        frozen_at=dt.datetime.now(dt.timezone.utc).replace(microsecond=0);expiry=frozen_at+dt.timedelta(minutes=15)
        frozen=m.json_result(m.read_only(pilot.snapshot_sql(m)));pilot.validate_snapshot(frozen);require(frozen['schema']==before['schema'])
        m.durable_file(bundle/'owned-frozen.json',m.encoded(frozen))
        review=node(pilot.AUTH_REVIEW_JS,{**auth,'ids':frozen['ids']},'auth-frozen');pilot.validate_review(review,frozen['ids'])
        m.durable_file(bundle/'owned-auth-review.json',m.encoded(review))
        # A newly banned admin refuses BEFORE password/control COMMIT.
        require(next(x for x in review['users'] if x['id']==row['adminUserId'])['disabled'] is False)
        policy['verify_linked_admin']({'_acceptedAdmin':facts})
        m.durable_file(bundle/'controls-commit-attempt.json',m.encoded({'attempted':True,'acknowledged':False}))
        require(m.psql(pilot.controls_sql(m,review,frozen,runtime_password,reader_password,expiry.isoformat()))==b'OWNED_CONTROLS_COMMITTED\n')
        m.durable_file(bundle/'controls-commit-acknowledged.json',m.encoded({'acknowledged':True}))
        after=m.json_result(m.read_only(pilot.snapshot_sql(m)));pilot.validate_snapshot(after)
        require(all(after[k]==frozen[k] for k in ['schema','fingerprints','ids','bindingDigest','challengeDigest','sessionCount']))
        pilot.verify_controls(frozen,after,review);m.durable_file(bundle/'owned-after-controls.json',m.encoded(after))
        require(node(pilot.AUTH_PROBE_JS,{'url':profile['DATABASE_URL']},'deny-old')=={'allowed':False,'passwordRejected':True})
        require(node(pilot.AUTH_PROBE_JS,{'url':next_profile['DATABASE_URL']},'allow-new')=={'allowed':True,'passwordRejected':False})
        require(node(pilot.AUTH_PROBE_JS,{'url':next_reader['XMAIL_STAGING_DATABASE_URL']},'allow-reader')=={'allowed':True,'passwordRejected':False})
        row,facts=capture(row,max_age=FINAL_MAX_AGE_SECONDS)
        now=dt.datetime.now(dt.timezone.utc).replace(microsecond=0);require(now<expiry)
        stamp=lambda x:x.strftime('%Y-%m-%dT%H:%M:%SZ')
        common={'version':1,'app':'xmail','target':m.TARGET,'database':'xmail','role':'xmail_runtime','postgresImage':m.PG_IMAGE,
            'applicationImage':args.approved_image_id,'sourceSha':args.approved_source_sha,'authPhase':'identity','sourceKind':'owned','oldContainerId':old['Id'],'createdAt':stamp(now),'expiresAt':stamp(expiry)}
        pointers={};proof_facts={'freeze':{'allSourceWritersStopped':True,'oldContainerStopped':True,'oldOwnedCredentialsRejected':True},
            'snapshot':{'sourceReadOnlySnapshotComplete':True,'snapshotDigest':m.sha(m.encoded(frozen)),'businessTables':70},
            'controls':{'snapshotReceiptSha256':'','exactUuidControlsReviewed':True,'disabledStatePreserved':True,'noContactAutoLinks':True,'runtimeGrantsReviewed':True},'admin-acceptance':facts}
        for kind in ['freeze','snapshot','controls','admin-acceptance']:
            if kind=='controls':proof_facts[kind]['snapshotReceiptSha256']=pointers['snapshot']['sha256']
            raw=m.encoded({**common,'kind':kind,'facts':proof_facts[kind],'createdAt':stamp(frozen_at if kind=='freeze' else now)})
            name=policy['PROOF_FILES'][kind];m.durable_file(m.OPS/name,raw,replace=True);pointers[kind]={'file':name,'sha256':m.sha(raw)}
        for path,value in [(m.OPS/'owned-runtime.env',next_profile),(m.OPS/'reader.env',next_reader)]:m.durable_file(path,m.env_bytes(value),replace=True)
        _,_,digest,*_=policy['profiles'](m.OPS)
        receipt={**common,'oldImageId':old['Image'],'profileDigest':digest,'baseEnvironmentSha256':m.sha(base_raw),'proofs':pointers}
        raw=m.encoded(receipt);m.durable_file(m.OPS/'cutover-receipt.json',raw,replace=True)
        next_profile['XMAIL_OWNED_RECEIPT_SHA256']=m.sha(raw);m.durable_file(m.OPS/'owned-runtime.env',m.env_bytes(next_profile),replace=True)
        with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink):policy['execute']('inspect')
        m.durable_file(bundle/'authority-profile-ready.json',m.encoded({'ownedAuthorityProfileReady':True,'realAdminChainAccepted':True,'applicationStarted':False}))
        return {'ownedAuthorityProfileReady':True,'realAdminChainAccepted':True,'distinctGoogleAndPhone':True,'businessFingerprintsPreserved':70,'ownedUuidControlsReviewed':len(frozen['ids']),'supabaseBusinessImport':False,'applicationStarted':False}
    finally:
        failed=False
        for name in resources:
            try:
                for cid in m.call(['docker','ps','-aq','--filter','name=^/'+name+'$']).decode().split():
                    state=m.inspect(cid);require((state['Config'].get('Labels') or {}).get('com.skale.xmail-authority-cutover')==nonce);m.call(['docker','rm','-f',cid])
            except Exception:failed=True
        os.close(fd);require(not failed)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    group=parser.add_mutually_exclusive_group();group.add_argument('--plan',action='store_true');group.add_argument('--capture',action='store_true');group.add_argument('--apply',action='store_true')
    for name in ['approved-image-id','approved-source-sha','policy-sha256','old-container-id']:parser.add_argument('--'+name)
    args=parser.parse_args()
    if not(args.capture or args.apply):
        print('PLAN ONLY: real independently linked admin, distinct Google/phone chain and fresh provider statuses required; no I/O, credentials, flags or application changes.');return
    print(json.dumps(run(args)))


if __name__=='__main__':
    try:main()
    except Exception:
        print('Owned authority preparation refused/failed. Missing real factor acceptance requires the personal pilot flow. No automatic restart, import or rollback.',file=sys.stderr);sys.exit(1)
