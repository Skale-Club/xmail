#!/usr/bin/env python3
"""CI-only disposable reproduction using the actual backup restore protocol."""
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time


def check(ok):
    if not ok: raise ValueError('Disposable restore rehearsal refused')


def main():
    mode=os.environ.get('XMAIL_OWNED_BACKUP_REHEARSAL')
    check(sys.platform.startswith('linux') and os.environ.get('CI')=='true'
        and mode in ['disposable-lock-budget','disposable-data-capacity'])
    pressure=mode=='disposable-data-capacity'
    path=Path(__file__).with_name('xmail-owned-backup.py')
    spec=importlib.util.spec_from_file_location('backup_fixture',path)
    backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
    m,c=backup.libraries()
    operation='owned-20261105T000000Z-'+secrets.token_hex(8)
    source='xmail-dr-fixture-source-'+secrets.token_hex(8)
    results=[];last_state=[None]
    original_call=m.call
    def call(args,payload=None,timeout=15):
        if 'psql' not in args: return original_call(args,payload,timeout)
        args=args+['-v','VERBOSITY=sqlstate']
        r=subprocess.run(args,input=payload,capture_output=True,timeout=timeout)
        if r.returncode:
            matches=re.findall(rb'ERROR:\s+([A-Z0-9]{5})(?:\s|$)',r.stderr)
            last_state[0]=matches[-1].decode() if matches else None
            raise ValueError('Disposable SQL failed; raw diagnostics suppressed')
        check(len(r.stdout)<=4*1024*1024);return r.stdout
    m.call=call
    started=False
    try:
        args=backup.restore_arguments(source,operation)
        args[args.index('max_connections=5')]='max_connections=32'
        m.call(args);started=True
        for _ in range(60):
            if subprocess.run(['docker','exec',source,'pg_isready','-h','127.0.0.1','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3).returncode==0:break
            time.sleep(.5)
        else: raise ValueError('Disposable source unavailable')
        tables=sorted(backup.IDENTITY)+['business_'+str(i).zfill(3) for i in range(70)]
        sql="CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text);INSERT INTO supabase_migrations.schema_migrations SELECT lpad(n::text,3,'0') FROM generate_series(1,80)n;"
        for name in tables: sql+='CREATE TABLE '+name+"(id int PRIMARY KEY,payload text);INSERT INTO "+name+" VALUES(1,'disposable-row');"
        if pressure: sql+="INSERT INTO business_000 SELECT n,'disposable-row' FROM generate_series(2,100000)n;"
        for n in range(235): sql+='CREATE INDEX fixture_idx_'+str(n)+' ON '+tables[n%74]+'(payload);'
        sql+='CREATE SEQUENCE fixture_sequence_one;CREATE SEQUENCE fixture_sequence_two;'
        m.call(['docker','exec','-i',source,'psql','-XwqAt','-v','ON_ERROR_STOP=1','-U','postgres'],sql.encode(),timeout=45)
        query="BEGIN READ ONLY;SET LOCAL timezone='UTC';SET LOCAL datestyle='ISO,YMD';SET LOCAL extra_float_digits=3;SET LOCAL bytea_output='hex';SET LOCAL search_path=public,pg_catalog;"+backup.manifest_sql(m)+';ROLLBACK;'
        expected=m.json_result(m.call(['docker','exec','-i',source,'psql','-XwqAt','-v','ON_ERROR_STOP=1','-U','postgres'],query.encode(),timeout=75));backup.validate_manifest(expected)
        counts=m.call(['docker','exec',source,'psql','-XwqAt','-U','postgres','-c',"SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public')||','||(SELECT count(*) FROM pg_indexes WHERE schemaname='public')||','||(SELECT count(*) FROM pg_sequences WHERE schemaname='public')"]).strip()
        check(counts==b'74,309,2')
        with tempfile.TemporaryDirectory(prefix='xmail-dr-locks-') as temporary:
            stage=Path(temporary);stage.chmod(0o700)
            dump=stage/'snapshot.dump'
            with dump.open('xb') as out:
                dump.chmod(0o600)
                r=subprocess.run(['docker','exec',source,'pg_dump','-U','postgres','--format=custom','--no-owner','--no-acl','postgres'],stdout=out,stderr=subprocess.DEVNULL,timeout=60)
                check(r.returncode==0)
            original_arguments=backup.restore_arguments
            original_manifest=backup.restored_manifest
            reserve_kib=[None]
            def pressure_manifest(module,name,query):
                # Fixture-only reserved bytes model the measured near-full
                # PGDATA. Identical reserve is used under256 and512 MiB; the
                # real fingerprint query must spill beyond the old free space.
                free=int(m.call(['docker','exec',name,'df','-Pk','/var/lib/postgresql/data']).decode().splitlines()[-1].split()[3])
                if reserve_kib[0] is None: reserve_kib[0]=free-1024
                check(0<reserve_kib[0]<256*1024)
                m.call(['docker','exec',name,'dd','if=/dev/zero','of=/var/lib/postgresql/data/xmail-fixture-capacity','bs=1024','count='+str(reserve_kib[0])],timeout=30)
                return original_manifest(module,name,query)
            if pressure: backup.restored_manifest=pressure_manifest
            settings=[(64,256,384),(64,512,768)] if pressure else [(64,512,768),(256,512,768)]
            for locks,data_mib,memory_mib in settings:
                backup.RESTORE_DATA_BYTES=data_mib*1024*1024;backup.RESTORE_MEMORY_MIB=memory_mib
                backup.restore_arguments=lambda name,op:original_arguments(name,op)+['-c','max_locks_per_transaction='+str(locks)]
                last_state[0]=None
                passed=False
                try: backup.restore(m,c,stage,expected,operation);passed=True
                except backup.RestoreQueryFailure as error:last_state[0]=error.sqlState
                except Exception: pass
                results.append({'lockBudget':locks,'dataMiB':data_mib,'memoryMiB':memory_mib,'restoreEquivalent':passed,'sqlstate':last_state[0]})
        print(json.dumps({'tables':74,'indexes':309,'sequences':2,'actualRestoreProtocol':True,'dataPressure':pressure,'results':results}))
        check(results[0]['restoreEquivalent'] is (not pressure) and results[0]['sqlstate']==('53100' if pressure else None))
        check(results[1]['restoreEquivalent'] is True and results[1]['sqlstate'] is None)
    finally:
        if started:
            state=m.inspect(source);check((state['Config'].get('Labels') or {}).get('com.skale.xmail-dr')==operation)
            m.call(['docker','rm','-f','-v',source])
        check(not m.call(['docker','ps','-aq','--filter','name=^/xmail-dr-'+operation+'$']).strip())


if __name__=='__main__':
    try:main()
    except Exception:
        print('Disposable restore budget hypothesis not confirmed; no live operation performed.',file=sys.stderr);sys.exit(1)
