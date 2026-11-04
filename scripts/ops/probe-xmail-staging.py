#!/usr/bin/env python3
"""One bounded private probe; no production application/environment mutation."""
import base64
import glob
import hashlib
import hmac
import json
import os
import secrets
import signal
import shutil
import subprocess
import sys
import tempfile
import time

TARGET = 'e12scyfsrp822dag7m9wwd4x'
PG_IMAGE = 'sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'
APP_IMAGE = 'sha256:93c4f3284e452b518dfd7f7363152976cd1d1e3d1a28f76814b8a0ea9797b58d'
LABEL = 'com.skale.xmail-stage-probe'
FILES = {'package.json', 'server/index.js', 'server/runtime-entry.js', 'server/staging-config.js', 'server/staging-http.js'}


def run(args, body=None, timeout=15):
    result = subprocess.run(args, input=body, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('bounded_subprocess_failed')
    return result.stdout.strip()


def database(sql):
    # Never expose SQL diagnostics: the credential operation contains a verifier.
    return run(['docker', 'exec', '-i', TARGET, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'xmail_owner', '-d', 'xmail'], sql)


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def assert_runtime():
    target = inspect(TARGET)
    app = inspect('xmail')
    assert target['Image'] == PG_IMAGE and target['State']['Running'] and target['State']['Health']['Status'] == 'healthy'
    assert not any(target['NetworkSettings']['Ports'].values())
    assert any(m['Type'] == 'volume' and m['Destination'] == '/var/lib/postgresql/data' and m['RW'] for m in target['Mounts'])
    assert app['Image'] == APP_IMAGE and app['State']['Running'] and app['State']['Health']['Status'] == 'healthy'


def execute(payload):
    assert os.geteuid() == 0
    assert set(payload) == {'headSha', 'artifactDigest', 'files'}
    assert len(payload['headSha']) == 40 and all(c in '0123456789abcdef' for c in payload['headSha'])
    assert payload['artifactDigest'].startswith('sha256:') and len(payload['artifactDigest']) == 71
    assert set(payload['files']) == FILES
    decoded = {n: base64.b64decode(v, validate=True) for n, v in payload['files'].items()}
    assert sum(map(len, decoded.values())) < 262144
    assert json.loads(decoded['package.json']) == {'type': 'commonjs'}
    assert_runtime()
    memory = dict(line.split(':', 1) for line in open('/proc/meminfo'))
    assert int(memory['MemAvailable'].split()[0]) >= 786432
    assert int(memory['SwapTotal'].split()[0]) - int(memory['SwapFree'].split()[0]) <= 524288
    assert not run(['docker', 'ps', '-aq', '--filter', 'label='+LABEL])
    initial = database("SELECT count(*) FROM pg_authid WHERE rolname='xmail_staging_reader' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND rolbypassrls AND rolpassword IS NULL")
    assert initial == '1'
    receipts = []
    for name in glob.glob('/opt/xmail/backups/candidate-*/restore-proof.json'):
        if not os.path.islink(name):
            data = json.load(open(name))
            if data.get('status') == 'candidate_committed_and_reconciled' and data.get('candidate') == TARGET:
                receipts.append(data)
    assert len(receipts) == 1
    expected = receipts[0]
    expected_summary = {'users': expected['users'], 'organization_users': expected['memberships'], 'native_password_hashes': expected['nativePasswordHashes'], 'platform_admins': expected['platformAdmins']}
    parent = '/opt/xmail'
    assert os.path.isdir(parent) and not os.path.islink(parent) and os.stat(parent).st_uid == 0
    def interrupted(_number, _frame):
        raise RuntimeError('private_probe_interrupted')
    signals = [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]
    folder = None
    nonce = secrets.token_hex(8)
    resource = 'xmail-stage-proof-'+nonce
    network_attempted = False
    role_attempted = False
    outcome = None
    cleanup_errors = []
    previous = {number: signal.signal(number, interrupted) for number in signals}
    try:
        folder = tempfile.mkdtemp(prefix='staging-proof.', dir=parent)
        os.chmod(folder, 0o700)
        code = folder+'/code'
        os.mkdir(code, 0o700)
        os.mkdir(code+'/server', 0o700)
        for name, body in decoded.items():
            path = code+'/'+name
            with open(path, 'xb') as handle:
                handle.write(body)
            os.chmod(path, 0o600)
        password = secrets.token_urlsafe(48)
        salt = secrets.token_bytes(16)
        salted = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 4096)
        stored = hashlib.sha256(hmac.digest(salted, b'Client Key', 'sha256')).digest()
        server = hmac.digest(salted, b'Server Key', 'sha256')
        b64 = lambda data: base64.b64encode(data).decode()
        verifier = 'SCRAM-SHA-256$4096:'+b64(salt)+'$'+b64(stored)+':'+b64(server)
        envfile = folder+'/reader.env'
        descriptor = os.open(envfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as handle:
            handle.write('NODE_ENV=production\nXMAIL_STAGING_HTTP_ONLY=true\nXMAIL_STAGING_ORIGIN=http://127.0.0.1:9001\nXMAIL_GOOGLE_AUTH_ENABLED=false\nGOOGLE_AUTH_ENABLED=false\n')
            handle.write('XMAIL_STAGING_DATABASE_URL=postgres://xmail_staging_reader:'+password+'@'+TARGET+':5432/xmail\n')
        role_attempted = True
        expires = time.strftime('%Y-%m-%d %H:%M:%S+00', time.gmtime(time.time()+180))
        database("BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL transaction_timeout='10s'; ALTER ROLE xmail_staging_reader LOGIN PASSWORD '"+verifier+"' VALID UNTIL '"+expires+"'; COMMIT;")
        network_attempted = True
        run(['docker', 'network', 'create', '--internal', '--label', LABEL+'='+nonce, resource])
        run(['docker', 'network', 'connect', '--alias', TARGET, resource, TARGET])
        run(['docker', 'run', '--detach', '--name', resource, '--label', LABEL+'='+nonce,
             '--network', resource, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
             '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25', '--pids-limit', '64',
             '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--env-file', envfile,
             '--env', 'NODE_PATH=/app/node_modules', '--mount', 'type=bind,src='+code+',dst=/stage,readonly',
             '--no-healthcheck', '--entrypoint', 'node', APP_IMAGE, '/stage/server/index.js'])
        node = r"""
const fs=require('node:fs');const http=require('node:http');const postgres=require('postgres');
(async()=>{
 const get=(path,options={})=>new Promise((resolve,reject)=>{const req=http.request('http://127.0.0.1:9001'+path,options,res=>{let body='';res.on('data',chunk=>{body+=chunk;if(body.length>8192)req.destroy(Error('body'))});res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(body)})}catch(e){reject(e)}})});req.setTimeout(3000,()=>req.destroy(Error('timeout')));req.on('error',reject);req.end()});
 let health;for(let n=0;n<20;n++){try{health=await get('/health');break}catch{await new Promise(r=>setTimeout(r,500))}}
 if(health?.status!==200||health.body.mode!=='staging-http-only'||health.body.sideEffectsEnabled!==false)throw Error('health');
 const summary=await get('/api/staging/summary'),ready=await get('/health/ready');
 if(summary.status!==200||ready.status!==200||JSON.stringify(summary.body.summary)!==JSON.stringify(ready.body.summary))throw Error('summary');
 for(const path of ['/api/auth/login','/api/auth/identity/config','/t/open','/o/u/token'])if((await get(path)).status!==403)throw Error('route');
 for(const method of ['POST','PUT','PATCH','DELETE'])if((await get('/api/messages',{method})).status!==405)throw Error('mutation');
 if((await get('/health',{headers:{host:'foreign.invalid'}})).status!==403)throw Error('host');
 const sockets=new Set(fs.readdirSync('/proc/1/fd').map(fd=>{try{return /^socket:\[(\d+)\]$/.exec(fs.readlinkSync('/proc/1/fd/'+fd))?.[1]}catch{return undefined}}).filter(Boolean));
 const ports=['/proc/net/tcp','/proc/net/tcp6'].flatMap(p=>fs.readFileSync(p,'utf8').trim().split('\n').slice(1).map(l=>l.trim().split(/\s+/)).filter(c=>c[3]==='0A'&&sockets.has(c[9])).map(c=>parseInt(c[1].split(':')[1],16)));
 if(ports.length!==1||ports[0]!==9001)throw Error('listeners');
 const wrong=new URL(process.env.XMAIL_STAGING_DATABASE_URL);wrong.password=require('node:crypto').randomBytes(48).toString('base64url');
 const client=postgres(wrong.href,{max:1,prepare:false,connect_timeout:3,onnotice:()=>{}});let denied=false;
 try{await client`SELECT 1`}catch(e){denied=e.code==='28P01'}finally{await client.end({timeout:1})}
 if(!denied)throw Error('password');
 console.log(JSON.stringify({summary:summary.body.summary,health:true,ready:true,mutationsDenied:true,legacyRoutesDenied:true,wrongHostDenied:true,wrongPasswordDenied:true,listeningPorts:ports}));
})().catch(()=>{console.error('Private staging probe failed.');process.exitCode=1});
"""
        result = json.loads(run(['docker', 'exec', resource, 'node', '-e', node], timeout=40))
        assert result['summary'] == expected_summary
        state = inspect(resource)
        assert state['Image'] == APP_IMAGE and not any(state['NetworkSettings']['Ports'].values())
        assert state['HostConfig']['ReadonlyRootfs'] and state['HostConfig']['Memory'] == 134217728
        net = json.loads(run(['docker', 'network', 'inspect', resource]))[0]
        assert net['Internal'] and net['Labels'].get(LABEL) == nonce
        outcome = dict(result, candidate=TARGET, headSha=payload['headSha'], artifactDigest=payload['artifactDigest'], internalNetwork=True, publishedPorts=False, applicationCutover=False)
    finally:
        # First signal enters this block. Further termination signals must not
        # interrupt the bounded credential/resource cleanup halfway through.
        for number in signals:
            signal.signal(number, signal.SIG_IGN)
        # Remove only our exact labeled resources and our confined temporary dir.
        try:
            candidate = inspect(resource)
            assert candidate['Config']['Labels'].get(LABEL) == nonce
            run(['docker', 'rm', '-f', resource])
        except Exception:
            try:
                if run(['docker', 'ps', '-aq', '--filter', 'name=^/'+resource+'$']): cleanup_errors.append('container')
            except Exception: cleanup_errors.append('container')
        if network_attempted:
            try:
                net = json.loads(run(['docker', 'network', 'inspect', resource]))[0]
                assert net['Labels'].get(LABEL) == nonce
                if TARGET in [v.get('Name') for v in net['Containers'].values()]:
                    run(['docker', 'network', 'disconnect', resource, TARGET])
                run(['docker', 'network', 'rm', resource])
            except Exception:
                try:
                    if run(['docker', 'network', 'ls', '-q', '--filter', 'name=^'+resource+'$']): cleanup_errors.append('network')
                except Exception: cleanup_errors.append('network')
        if role_attempted:
            try:
                database("BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL transaction_timeout='10s'; ALTER ROLE xmail_staging_reader NOLOGIN PASSWORD NULL VALID UNTIL '1970-01-01 00:00:00+00'; COMMIT;")
                assert database("SELECT count(*) FROM pg_authid WHERE rolname='xmail_staging_reader' AND NOT rolcanlogin AND rolpassword IS NULL") == '1'
            except Exception: cleanup_errors.append('reader')
        try:
            if folder is not None:
                assert os.path.realpath(folder).startswith('/opt/xmail/staging-proof.') and not os.path.islink(folder)
                shutil.rmtree(folder)
        except Exception: cleanup_errors.append('private_files')
        # A timed-out CLI can leave the daemon completing an operation. Sweep
        # only this operation's label/name again, without ever reporting success
        # for the original failed/ambiguous probe.
        if cleanup_errors or outcome is None:
            for _attempt in range(3):
                time.sleep(1)
                try:
                    ids = run(['docker', 'ps', '-aq', '--filter', 'label='+LABEL+'='+nonce]).splitlines()
                    for identifier in ids:
                        late = inspect(identifier)
                        assert late['Name'] == '/'+resource and late['Config']['Labels'].get(LABEL) == nonce
                        run(['docker', 'rm', '-f', identifier])
                    nets = run(['docker', 'network', 'ls', '-q', '--filter', 'label='+LABEL+'='+nonce]).splitlines()
                    for identifier in nets:
                        late = json.loads(run(['docker', 'network', 'inspect', identifier]))[0]
                        assert late['Name'] == resource and late['Labels'].get(LABEL) == nonce
                        if TARGET in [v.get('Name') for v in late['Containers'].values()]:
                            run(['docker', 'network', 'disconnect', identifier, TARGET])
                        run(['docker', 'network', 'rm', identifier])
                except Exception:
                    pass
        assert not cleanup_errors, 'private_probe_cleanup_failed'
        assert_runtime()
        for number, handler in previous.items():
            signal.signal(number, handler)
    assert outcome is not None
    outcome['temporaryResourcesRemoved'] = True
    outcome['readerLoginDisabled'] = True
    return outcome


if __name__ == '__main__':
    if len(sys.argv) == 1 or sys.argv[1:] == ['--plan']:
        print('PLAN ONLY: no files, Docker, credentials or database operations. Probe CI-built HTTP-only code on the private Xmail candidate; ephemeral reader login/internal network; always clean up; no source/app cutover.')
    elif sys.argv[1:] == ['--execute-reviewed-probe']:
        try:
            raw = sys.stdin.buffer.read(524289)
            assert len(raw) <= 524288
            print(json.dumps(execute(json.loads(raw))))
        except Exception:
            print('{"stagingProbe":"failed","successWithheld":true}', file=sys.stderr)
            sys.exit(1)
    else:
        sys.exit(2)
