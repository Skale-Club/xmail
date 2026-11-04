#!/usr/bin/env python3
"""Current owned SQL backup: offline default; dedicated host-only encrypted transport."""
import argparse
import ast
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import time

SOURCE='49.13.197.250';TARGET='188.245.112.3'
PG='e12scyfsrp822dag7m9wwd4x'
PG_IMAGE='sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'
RECIPIENT_SHA='2efbf3fc906a50317413cb6994842229b81062897a3d3849dd3f835abbdfa0cb'
LIB_SHA='6e9a7a4b211410f6a0e7c073a91169584c3b4593ebf8209c372a4ba0d8c623e7'
CRYPTO_SHA='1ebdd1f376989da5010d8b78ba78c7d0c91fae58a992a8a4ba1394a513765cff'
OPS=Path('/opt/xmail/owned-backup-ops')
ARCHIVES=Path('/opt/xmail/offsite-backups/owned-v1')
RECIPIENT=Path('/opt/xmail/offsite-backups/v1/recipient')
MAX=256*1024*1024;KEEP=7
IDENTITY={'xmail_identity_bindings','xmail_identity_owned_sessions','xmail_identity_user_controls','xmail_identity_browser_challenges'}


def need(value):
    if not value:raise ValueError('Owned backup refused')


def sha(raw):return hashlib.sha256(raw).hexdigest()


def libraries():
    root=Path(__file__).parent;path=root/'prepare-xmail-final-data-cutover.py'
    need(sha(path.read_bytes().replace(b'\r\n',b'\n'))==LIB_SHA)
    spec=importlib.util.spec_from_file_location('owned_backup_primitives',path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    raw=(root/'xmail-offsite-backup.mjs').read_bytes().replace(b'\r\n',b'\n');need(sha(raw)==CRYPTO_SHA)
    body=raw.decode().split('const REMOTE = String.raw`\n',1)[1].split('\n`;\n',1)[0]
    # Reuse the reviewed root/file/recipient/CMS guards, without running the old
    # controller's fixed snapshot dispatch, timers or file-size resource limits.
    tree=ast.parse(body);declarations=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef,ast.ClassDef))]
    crypto={'ACTIVE':set(),'MAX':MAX+1048576,'BASE':RECIPIENT.parent}
    exec(compile(ast.Module(body=declarations,type_ignores=[]),'reviewed-offsite-primitives','exec'),crypto)
    return m,crypto


def private_dir(c,path,create=False):
    c['parents'](path)
    c['private_dir'](path,create)


def manifest_sql(m):
    excluded=' AND c.relname NOT IN ('+','.join("'"+x+"'" for x in m.IDENTITY)+' )'
    schema=m.business_schema_sql();fingerprints=m.fingerprints_sql()
    need(schema.count(excluded)==fingerprints.count(excluded)==1)
    schema=schema.replace(excluded,'');fingerprints=fingerprints.replace(excluded,'')
    return "SELECT jsonb_build_object('schema',(SELECT schema FROM ("+schema+") q),'fingerprints',("+fingerprints+")," \
        "'ledger',(SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(jsonb_agg(to_jsonb(t) ORDER BY version)::text,'UTF8')),'hex')) FROM supabase_migrations.schema_migrations t)," \
        "'policyRoles',(SELECT coalesce(jsonb_agg(DISTINCT r.rolname ORDER BY r.rolname),'[]') FROM pg_policy p JOIN pg_class t ON t.oid=p.polrelid JOIN pg_namespace n ON n.oid=t.relnamespace CROSS JOIN LATERAL unnest(p.polroles) v JOIN pg_roles r ON r.oid=v WHERE n.nspname='public'))"


def validate_manifest(value):
    need(isinstance(value,dict) and set(value)=={'schema','fingerprints','ledger','policyRoles'})
    need(len(value['schema']['tables'])==len(value['fingerprints'])==74 and set(value['schema']['tables'])==set(value['fingerprints'])
        and IDENTITY<=set(value['schema']['tables']) and value['ledger']['count']==80 and re.fullmatch(r'[a-f0-9]{64}',value['ledger']['sha256']))
    need(set(value['policyRoles'])<=set(['anon','authenticated','service_role','xmail_owner','xmail_runtime','xmail_staging_reader']))
    need(all(type(x['count']) is int and x['count']>=0 and re.fullmatch(r'[a-f0-9]{64}',x['sha256']) for x in value['fingerprints'].values()))


def packet(value):
    need(isinstance(value,dict) and set(value)=={'version','app','operation','archiveSha256','archiveBytes','cipherSha256','cipherBytes','recipientDerSha256','createdAt'})
    need(type(value['version']) is int and value['version']==2 and value['app']=='xmail' and value['recipientDerSha256']==RECIPIENT_SHA
        and re.fullmatch(r'owned-\d{8}T\d{6}Z-[a-f0-9]{16}',value['operation']))
    for key in ['archiveSha256','cipherSha256']:need(isinstance(value[key],str) and re.fullmatch(r'[a-f0-9]{64}',value[key]))
    need(type(value['archiveBytes']) is int and type(value['cipherBytes']) is int and 0<value['archiveBytes']<value['cipherBytes']<=MAX)
    now=dt.datetime.now(dt.timezone.utc);created=dt.datetime.fromisoformat(value['createdAt'].replace('Z','+00:00'))
    need(created.tzinfo is not None and -5<=(now-created).total_seconds()<=900)
    return value


def fingerprint(c,path):return c['digest'](path)


def retention(c,root):
    candidates=[]
    for path in root.iterdir():
        if not re.fullmatch(r'owned-\d{8}T\d{6}Z-[a-f0-9]{16}',path.name):continue
        c['guard'](path,True,0o700)
        need({p.name for p in path.iterdir()}=={'snapshot.tar.cms','receipt.json'})
        receipt=c['read_json'](path/'receipt.json')
        need(receipt.get('version')==2 and receipt.get('app')=='xmail' and receipt.get('operation')==path.name
            and receipt.get('restoreEquivalent') is True and receipt.get('aeadVerified') is True
            and receipt.get('recipientDerSha256')==RECIPIENT_SHA)
        need(fingerprint(c,path/'snapshot.tar.cms')==(receipt['cipherSha256'],receipt['cipherBytes']))
        candidates.append(path)
    candidates.sort(key=lambda p:p.name,reverse=True)
    for path in candidates[KEEP:]:
        (path/'snapshot.tar.cms').unlink();(path/'receipt.json').unlink();path.rmdir()
    c['syncdir'](root)
    return min(len(candidates),KEEP)


def restore(m,c,stage,expected,operation):
    need(shutil.disk_usage('/opt').free>=1024**3)
    mem={k:int(v.split()[0]) for k,v in (line.split(':',1) for line in open('/proc/meminfo'))}
    need(mem['MemAvailable']>=1536*1024)
    image=m.inspect(PG_IMAGE);need(image['Id']==PG_IMAGE and set(image['Config'].get('Volumes') or {})=={'/var/lib/postgresql/data'})
    name='xmail-dr-'+operation
    need(not m.call(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip())
    started=False
    try:
        m.call(['docker','run','-d','--pull=never','--name',name,'--label','com.skale.xmail-dr='+operation,'--network','none',
            '--read-only','--tmpfs','/var/lib/postgresql/data:rw,size=268435456','--tmpfs','/var/run/postgresql:rw,size=8388608',
            '--tmpfs','/tmp:rw,size=16777216','--memory','384m','--memory-swap','384m','--cpus','0.5','--pids-limit','96',
            '--log-driver','none','--security-opt','no-new-privileges','--env','POSTGRES_HOST_AUTH_METHOD=trust',PG_IMAGE,
            '-c','shared_buffers=32MB','-c','work_mem=2MB','-c','max_connections=5'],timeout=15);started=True
        for _ in range(60):
            ready=subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3)
            if ready.returncode==0:break
            time.sleep(.5)
        need(ready.returncode==0)
        state=m.inspect(name)
        need(state['Image']==PG_IMAGE and state['NetworkSettings'].get('Networks')=={'none':state['NetworkSettings']['Networks'].get('none')}
            and not any((state['NetworkSettings'].get('Ports') or {}).values())
            and not any(x.get('Type') in ['volume','bind'] for x in state.get('Mounts',[]))
            and state['HostConfig']['Tmpfs'].get('/var/lib/postgresql/data')=='rw,size=268435456')
        roles=expected['policyRoles']
        sql=''.join('CREATE ROLE "'+r+'" NOLOGIN;' for r in roles)+'CREATE DATABASE xmail_dr;'
        m.call(['docker','exec','-i',name,'psql','-XwqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],sql.encode())
        with (stage/'snapshot.dump').open('rb') as data:
            p=subprocess.run(['docker','exec','-i',name,'pg_restore','-U','postgres','-d','xmail_dr','--exit-on-error','--single-transaction','--no-owner','--no-acl'],stdin=data,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=180)
        need(p.returncode==0)
        query="BEGIN READ ONLY; SET LOCAL statement_timeout='60s'; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL search_path=public,pg_catalog; "+manifest_sql(m)+';ROLLBACK;'
        actual=m.json_result(m.call(['docker','exec','-i',name,'psql','-XwqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','xmail_dr'],query.encode(),timeout=75))
        validate_manifest(actual);need(actual==expected)
    finally:
        if started:
            state=m.inspect(name);need((state['Config'].get('Labels') or {}).get('com.skale.xmail-dr')==operation and state['Image']==PG_IMAGE)
            m.call(['docker','rm','-f','-v',name])
        need(not m.call(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip())


def extract_archive(archive,stage):
    names=set()
    with tarfile.open(archive,'r|') as tar:
        for entry in tar:
            need(entry.name in {'snapshot.dump','manifest.json'} and entry.name not in names and len(names)<2
                and entry.isfile() and 0<entry.size<MAX and (entry.name!='manifest.json' or entry.size<=65536))
            names.add(entry.name)
            fd=os.open(stage/entry.name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as out,tar.extractfile(entry) as source:
                shutil.copyfileobj(source,out,65536);out.flush();os.fsync(out.fileno())
    need(names=={'snapshot.dump','manifest.json'})


def receive(m,c):
    need(os.environ.get('SSH_CONNECTION','').split()[0:1]==[SOURCE] and os.environ.get('SSH_CONNECTION','').split()[2:3]==[TARGET]
        and os.environ.get('SSH_ORIGINAL_COMMAND')=='xmail-owned-backup')
    raw=sys.stdin.buffer.readline(32769);need(len(raw)<=32768 and raw.endswith(b'\n'));value=packet(json.loads(raw))
    private_dir(c,OPS);private_dir(c,ARCHIVES,True)
    need(shutil.disk_usage(ARCHIVES).free>=max(1024**3,3*value['cipherBytes']+256*1024*1024))
    import fcntl
    lock=os.open(OPS/'receiver.lock',os.O_WRONLY|os.O_NOFOLLOW);info=os.fstat(lock)
    need(info.st_uid==info.st_gid==0 and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1 and info.st_size==0)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    public,fp=c['recipient']();need(fp==RECIPIENT_SHA)
    destination=ARCHIVES/value['operation'];need(not os.path.lexists(destination))
    stage=ARCHIVES/('staging-'+value['operation']);stage.mkdir(mode=0o700);c['syncdir'](ARCHIVES)
    try:
        encrypted=stage/'snapshot.tar.cms';h=hashlib.sha256();count=0
        fd=os.open(encrypted,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as out:
            for chunk in iter(lambda:sys.stdin.buffer.read(65536),b''):
                count+=len(chunk);need(count<=value['cipherBytes']);h.update(chunk);out.write(chunk)
            out.flush();os.fsync(out.fileno())
        need((h.hexdigest(),count)==(value['cipherSha256'],value['cipherBytes']));c['cms_algorithms'](encrypted)
        archive=stage/'plaintext.tar'
        fd=os.open(archive,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as out:
            c['command'](['openssl','cms','-decrypt','-binary','-inform','DER','-in',str(encrypted),'-recip',str(RECIPIENT/'recipient.crt'),'-inkey',str(RECIPIENT/'recipient.key')],stdout=out)
            out.flush();os.fsync(out.fileno())
        need(fingerprint(c,archive)==(value['archiveSha256'],value['archiveBytes']))
        extract_archive(archive,stage)
        expected=c['read_json'](stage/'manifest.json');validate_manifest(expected)
        restore(m,c,stage,expected,value['operation'])
        for name in ['plaintext.tar','snapshot.dump','manifest.json']:(stage/name).unlink()
        proof={**value,'aeadVerified':True,'restoreEquivalent':True,'schemaMatch':True,'rowsMatch':True,'publicTables':74,'migrationLedger':80,
            'createdAt':value['createdAt'],'verifiedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'applicationChanged':False,'sourceWriteFenceChanged':False}
        c['write_json'](stage/'receipt.json',proof);c['syncdir'](stage);c['rename_new'](stage,destination);c['syncdir'](ARCHIVES)
        retained=retention(c,ARCHIVES)
        return {**proof,'retainedVerifiedArchives':retained,'temporaryRestoreRemoved':True}
    finally:
        if stage.exists():
            c['guard'](stage,True,0o700)
            need({p.name for p in stage.iterdir()}<={'snapshot.tar.cms','plaintext.tar','snapshot.dump','manifest.json','receipt.json'})
            for p in stage.iterdir():c['guard'](p,False,0o600);p.unlink()
            stage.rmdir();c['syncdir'](ARCHIVES)
        os.close(lock)


def backup(m,c):
    import fcntl
    private_dir(c,OPS)
    lock=os.open(OPS/'backup.lock',os.O_WRONLY|os.O_NOFOLLOW);info=os.fstat(lock)
    need(info.st_uid==info.st_gid==0 and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1 and info.st_size==0)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    m.capacity()
    old=m.inspect('xmail');pg=m.inspect(PG)
    env=dict(x.split('=',1) for x in old['Config']['Env']);from urllib.parse import urlsplit
    need(old['State']['Running'] is True and old['State'].get('Health',{}).get('Status')=='healthy'
        and (old['Config'].get('Labels') or {}).get('com.skale.xmail.runtime')=='owned-full'
        and pg['Image']==PG_IMAGE and pg['State']['Running'] is True and pg['State'].get('Health',{}).get('Status')=='healthy')
    for key in ['DATABASE_URL','DIRECT_URL']:
        u=urlsplit(env[key]);need(u.hostname==PG and u.port==5432 and u.path=='/xmail' and u.username=='xmail_runtime')
    mounts=[v for v in pg.get('Mounts',[]) if v.get('Destination')=='/var/lib/postgresql/data']
    need(len(mounts)==1 and mounts[0].get('Name')=='postgres-data-'+PG and mounts[0].get('Type')=='volume' and mounts[0].get('RW') is True)
    for name in ['transport.key','known_hosts','recipient.crt']:c['guard'](OPS/name,False,0o600)
    public=(OPS/'recipient.crt').read_bytes();need(sha(c['command'](['openssl','x509','-outform','DER'],public))==RECIPIENT_SHA)
    operation='owned-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(8)
    root=OPS/'local-archives';private_dir(c,root,True);stage=root/('pending-'+operation);stage.mkdir(mode=0o700);c['syncdir'](root)
    holder=None
    try:
        holder=subprocess.Popen(['docker','exec','-i',PG,'psql','-XwqAt','-v','ON_ERROR_STOP=1','-U','xmail_owner','-d','xmail'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        holder.stdin.write(b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL idle_in_transaction_session_timeout='180s'; SELECT pg_export_snapshot();\n");holder.stdin.flush()
        import select
        need(select.select([holder.stdout],[],[],10)[0]);snapshot=holder.stdout.readline().decode().strip();need(re.fullmatch(r'[A-Fa-f0-9-]{8,80}',snapshot))
        m.archive_command(['docker','exec',PG,'pg_dump','-U','xmail_owner','-d','xmail','--snapshot='+snapshot,'--format=custom','--compress=6','--no-owner','--no-acl'],stage/'snapshot.dump')
        query="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '"+snapshot+"'; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL statement_timeout='60s'; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL search_path=public,pg_catalog; "+manifest_sql(m)+';ROLLBACK;'
        manifest=m.json_result(m.psql(query,timeout=75));validate_manifest(manifest);m.durable_file(stage/'manifest.json',m.encoded(manifest))
        holder.stdin.write(b'COMMIT;\n\\q\n');holder.stdin.close();need(holder.wait(timeout=5)==0);holder=None
        archive=stage/'plaintext.tar'
        fd=os.open(archive,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as out:
            with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as tar:
                for name in ['snapshot.dump','manifest.json']:tar.add(stage/name,arcname=name,recursive=False)
            out.flush();os.fsync(out.fileno())
        archive_sha,archive_bytes=fingerprint(c,archive);need(0<archive_bytes<MAX-1048576)
        encrypted=stage/'snapshot.tar.cms';fd=os.open(encrypted,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as out:
            c['command'](['openssl','cms','-encrypt','-binary','-stream','-outform','DER','-aes-256-gcm','-recip',str(OPS/'recipient.crt'),'-keyopt','rsa_padding_mode:oaep','-keyopt','rsa_oaep_md:sha256','-keyopt','rsa_mgf1_md:sha256','-in',str(archive)],stdout=out)
            out.flush();os.fsync(out.fileno())
        cipher_sha,cipher_bytes=fingerprint(c,encrypted)
        value=packet({'version':2,'app':'xmail','operation':operation,'archiveSha256':archive_sha,'archiveBytes':archive_bytes,'cipherSha256':cipher_sha,
            'cipherBytes':cipher_bytes,'recipientDerSha256':RECIPIENT_SHA,'createdAt':dt.datetime.now(dt.timezone.utc).isoformat()})
        command=['ssh','-T','-i',str(OPS/'transport.key'),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
            '-o','UserKnownHostsFile='+str(OPS/'known_hosts'),'-o','ForwardAgent=no','-o','ConnectTimeout=10','-o','ServerAliveInterval=15',
            '-o','ServerAliveCountMax=2','root@'+TARGET,'xmail-owned-backup']
        with encrypted.open('rb') as data:
            p=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            try:
                p.stdin.write(m.encoded(value)+b'\n');shutil.copyfileobj(data,p.stdin,65536);p.stdin.close()
                import select
                need(select.select([p.stdout],[],[],240)[0]);raw=p.stdout.read(65537);need(len(raw)<=65536 and p.wait(timeout=10)==0)
                proof=json.loads(raw)
            finally:
                if p.poll() is None:p.kill();p.wait(timeout=5)
        need(all(proof.get(k)==v for k,v in value.items()) and all(proof.get(k) is True for k in ['aeadVerified','restoreEquivalent','schemaMatch','rowsMatch','temporaryRestoreRemoved'])
            and proof.get('publicTables')==74 and proof.get('migrationLedger')==80 and 0<proof.get('retainedVerifiedArchives',0)<=KEEP)
        current=m.inspect(old['Id']);need(current['State']['Running'] is True and current['State'].get('Health',{}).get('Status')=='healthy' and current['State']['StartedAt']==old['State']['StartedAt'])
        m.durable_file(stage/'receipt.json',m.encoded(proof))
        # Remove local plaintext only after off-host authenticated recovery and
        # isolated PostgreSQL equivalence. Keep encrypted local fallback/proof.
        for name in ['snapshot.dump','manifest.json','plaintext.tar']:(stage/name).unlink()
        c['syncdir'](stage);c['rename_new'](stage,root/operation);c['syncdir'](root)
        retained_local=retention(c,root)
        return {'retainedLocalEncryptedArchives':retained_local,'ownedBackupVerified':True,'offsiteEncrypted':True,'restoreEquivalent':True,'temporaryRestoreRemoved':True,'publicTables':74,'migrationLedger':80,
            'retainedVerifiedArchives':proof['retainedVerifiedArchives'],'applicationUnchanged':True,'sourceWriteFenceChanged':False}
    finally:
        if holder is not None:
            try:holder.stdin.write(b'ROLLBACK;\n\\q\n');holder.stdin.close();holder.wait(timeout=5)
            except Exception:holder.kill();holder.wait(timeout=5)
        if stage.exists():
            c['guard'](stage,True,0o700)
            need({p.name for p in stage.iterdir()}<={'snapshot.dump','manifest.json','plaintext.tar','snapshot.tar.cms','receipt.json'})
            for path in stage.iterdir():c['guard'](path,False,0o600);path.unlink()
            stage.rmdir();c['syncdir'](root)
        os.close(lock)


def main():
    p=argparse.ArgumentParser(description=__doc__);g=p.add_mutually_exclusive_group();g.add_argument('--plan',action='store_true');g.add_argument('--backup',action='store_true');g.add_argument('--receive',action='store_true')
    args=p.parse_args()
    if not(args.backup or args.receive):print('PLAN ONLY: current owned SQL; existing CMS recipient; no I/O, backup, transport, schedule or application changes.');return
    need(sys.platform.startswith('linux') and os.geteuid()==0);os.umask(0o077)
    import signal
    def timeout(_signal,_frame):raise TimeoutError('Backup deadline')
    for interrupt in [signal.SIGALRM,signal.SIGTERM,signal.SIGHUP,signal.SIGINT]:signal.signal(interrupt,timeout)
    signal.alarm(600)
    m,c=libraries()
    try:print(json.dumps(receive(m,c) if args.receive else backup(m,c)))
    finally:signal.alarm(0)


if __name__=='__main__':
    try:main()
    except Exception:
        print('Owned backup failed/refused; raw diagnostics suppressed. Existing app, source fence and published backups preserved.',file=sys.stderr);sys.exit(1)
