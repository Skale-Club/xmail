"""Backup guard/retention/installer fixtures; no SSH, Docker, dotenv or customer data."""
import base64
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import runpy
from pathlib import Path
import stat
import sys
import tempfile
import tarfile
from types import SimpleNamespace
import types
import unittest
from unittest.mock import patch


def load(name):
    path=Path(__file__).with_name(name+'.py');spec=importlib.util.spec_from_file_location(name,path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


backup=load('xmail-owned-backup');installer=load('install-xmail-owned-backup')


class OwnedBackupGuards(unittest.TestCase):
    def setUp(self):
        if sys.platform=='win32':
            flag=patch.object(backup.os,'O_NOFOLLOW',0,create=True);flag.start();self.addCleanup(flag.stop)

    def test_both_defaults_are_offline_without_library_or_process_access(self):
        for m in [backup,installer]:
            with patch('sys.argv',['offline']),patch.object(m,'run' if m is installer else 'libraries',side_effect=AssertionError('No I/O')),contextlib.redirect_stdout(io.StringIO()) as out:m.main()
            self.assertIn('PLAN ONLY',out.getvalue())

    def test_failure_coordinates_never_include_exception_or_frame_values(self):
        private_value='customer-and-credential-sentinel'
        try:backup.need(False)
        except Exception as error:
            error.args=(private_value,)
            rows=backup.failure_location(error)
        self.assertTrue(rows)
        self.assertEqual(set(rows[0]),{'component','function','line'})
        self.assertNotIn(private_value,json.dumps(rows))
        self.assertTrue(all(row['component']=='xmail-owned-backup.py' for row in rows))

    def test_receiver_diagnostics_accept_only_bounded_public_code_coordinates(self):
        row={'component':'xmail-owned-backup.py','function':'restore','line':140}
        valid=json.dumps({'ownedBackupFailed':True,'location':[row]})
        self.assertEqual(backup.receiver_failure(valid).location,[row])
        for raw in ['raw credential sentinel',json.dumps({'ownedBackupFailed':True,'location':[dict(row,message='private')]}),
                    json.dumps({'ownedBackupFailed':True,'location':[dict(row,component='/private/key')]}),
                    json.dumps({'ownedBackupFailed':True,'location':[dict(row,line=True)]}),
                    json.dumps({'ownedBackupFailed':True,'location':[row]*9})]:
            self.assertEqual(backup.receiver_failure(raw).location,[])

    def test_actual_cli_failure_coordinates_survive_the_receiver_parser(self):
        with patch.object(sys,'platform','win32'),patch.object(sys,'argv',['backup','--receive']),contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as stopped:runpy.run_path(str(backup.__file__),run_name='__main__')
        self.assertEqual(stopped.exception.code,1)
        value=json.loads(errors.getvalue())
        self.assertTrue(any(row['function']=='<module>' for row in value['location']))
        self.assertEqual(backup.receiver_failure(errors.getvalue()).location,value['location'])

    def libraries(self):
        # Windows lacks resource; importing declarations must not invoke it.
        with patch.dict(sys.modules,{'resource':types.ModuleType('resource')}),patch.object(backup.subprocess,'Popen',side_effect=AssertionError('No process')):
            return backup.libraries()

    def test_reuses_pinned_crypto_declarations_without_old_dispatch_or_key_generation(self):
        m,c=self.libraries()
        self.assertEqual(m.TARGET,backup.PG)
        for name in ['guard','recipient','cms_algorithms','rename_new','digest']:self.assertTrue(callable(c[name]))
        self.assertNotIn('action',c);self.assertNotIn('packet',c)

    def test_manifest_uses_all_74_tables_full_row_fingerprints_and_80_ledger(self):
        m,_=self.libraries();sql=backup.manifest_sql(m)
        self.assertNotIn('relname NOT IN',sql)
        self.assertIn('to_jsonb(t)',sql);self.assertIn('supabase_migrations.schema_migrations',sql)
        names=list(backup.IDENTITY)+[str(i) for i in range(70)]
        values={'schema':{'tables':{n:'a'*64 for n in names}},
            'fingerprints':{n:{'count':0,'sha256':'b'*64} for n in names},'ledger':{'count':80,'sha256':'c'*64},'policyRoles':['authenticated']}
        backup.validate_manifest(values)
        for change in [{'ledger':{'count':79,'sha256':'c'*64}},{'policyRoles':['unreviewed_role']},{'fingerprints':{}}]:
            with self.assertRaises(ValueError):backup.validate_manifest({**values,**change})

    def test_manifest_mismatch_reports_only_bounded_component_counts_and_booleans(self):
        from copy import deepcopy
        private='private-table-or-credential-sentinel'
        before={'schema':{'tables':{private:'a'*64},'functions':'b'*64,'types':[]},
            'fingerprints':{private:{'count':2,'sha256':'c'*64}},'ledger':{'count':80,'sha256':'d'*64},'policyRoles':[]}
        after=deepcopy(before);after['fingerprints'][private]['sha256']='e'*64
        comparison=backup.manifest_comparison(before,after)
        self.assertTrue(backup.valid_comparison(comparison));self.assertEqual(comparison['fingerprintHashDifferenceCount'],1)
        self.assertEqual(comparison['fingerprintCountDifferenceCount'],0);self.assertEqual(comparison['schemaTableDifferenceCount'],0)
        payload=backup.failure_payload(backup.RestoreManifestMismatch(comparison))
        self.assertNotIn(private,json.dumps(payload));self.assertNotIn('c'*64,json.dumps(payload))
        self.assertEqual(backup.receiver_failure(json.dumps(payload)).comparison,comparison)
        for bad in [{**comparison,'sql':'private'},{**comparison,'schemaTableDifferenceCount':True},{**comparison,'fingerprintHashDifferenceCount':257}]:
            self.assertIsNone(backup.receiver_failure(json.dumps({'ownedBackupFailed':True,'location':[],'comparison':bad})).comparison)
        for field in ['functions','types']:
            changed=deepcopy(before);changed['schema'][field]='different'
            self.assertFalse(backup.manifest_comparison(before,changed)['schema'+field.title()+'Equal'])

    def test_isolated_restore_keeps_existing_resource_and_network_limits(self):
        args=backup.restore_arguments('offline-container','offline-operation')
        for value in ['max_connections=5','shared_buffers=32MB','work_mem=2MB']:
            self.assertIn(value,args)
        self.assertFalse(any('max_locks_per_transaction' in value for value in args))
        self.assertEqual(args[args.index('--memory')+1],'768m')
        self.assertEqual(args[args.index('--memory-swap')+1],'768m')
        self.assertEqual(args[args.index('--cpus')+1],'0.5')
        self.assertEqual(args[args.index('--network')+1],'none')
        self.assertIn('/var/lib/postgresql/data:rw,size=536870912',args)
        self.assertIn('--read-only',args)
        self.assertNotIn('--volume',args);self.assertNotIn('--mount',args);self.assertNotIn('-p',args)

    def test_restore_refuses_less_than_two_gib_available_before_any_container_access(self):
        fake=SimpleNamespace(inspect=lambda *_:self.fail('No container access before memory admission'))
        with patch.object(backup.shutil,'disk_usage',return_value=SimpleNamespace(free=2*1024**3)),patch('builtins.open',return_value=io.StringIO('MemAvailable: 2097151 kB\n')):
            with self.assertRaises(ValueError):backup.restore(fake,{},Path('/unused'),{},'offline')

    def test_restore_query_reports_only_valid_sqlstate_and_propagates_it(self):
        fake=SimpleNamespace(json_result=lambda value:json.loads(value))
        for stderr,expected in [(b'ERROR:  42501\n','42501'),(b'FATAL:  53200\n','53200'),
            (b'password credential-sentinel\n',None),(b'ERROR:  NOT_A_CODE\n',None)]:
            result=SimpleNamespace(returncode=1,stdout=b'private-row-sentinel',stderr=stderr)
            with patch.object(backup.subprocess,'run',return_value=result) as run:
                with self.assertRaises(backup.RestoreQueryFailure) as stopped:backup.restored_manifest(fake,'fixture','private-query-sentinel')
            args=run.call_args.args[0];self.assertIn('VERBOSITY=sqlstate',args)
            self.assertNotIn('private-query-sentinel',' '.join(args))
            payload=backup.failure_payload(stopped.exception)
            self.assertEqual(payload.get('sqlState'),expected)
            public=json.dumps(payload);self.assertNotIn('sentinel',public)
            forwarded=backup.receiver_failure(public)
            self.assertEqual(forwarded.sqlState,expected)
        for code in ['secret-value','53200\nprivate',True,None,12345]:
            self.assertEqual(backup.receiver_failure(json.dumps({'ownedBackupFailed':True,'location':[],'sqlState':code})).location,[])
            self.assertIsNone(backup.receiver_failure(json.dumps({'ownedBackupFailed':True,'location':[],'sqlState':code})).sqlState)

    def test_packet_refuses_wrong_app_path_hash_limits_replay_and_nonboolean_numeric_types(self):
        now=dt.datetime.now(dt.timezone.utc)
        value={'version':2,'app':'xmail','operation':'owned-20261104T200000Z-'+'a'*16,'archiveSha256':'a'*64,'archiveBytes':1024,
            'cipherSha256':'b'*64,'cipherBytes':2048,'recipientDerSha256':backup.RECIPIENT_SHA,'createdAt':now.isoformat()}
        self.assertEqual(backup.packet(value),value)
        for change in [{'app':'xkedule'},{'operation':'../../outside'},{'version':True},{'archiveBytes':True},{'cipherBytes':backup.MAX+1},
            {'archiveSha256':"';DROP"},{'recipientDerSha256':'0'*64},{'createdAt':(now-dt.timedelta(seconds=901)).isoformat()}, {'extra':'not-allowed'}]:
            with self.assertRaises(ValueError):backup.packet({**value,**change})

    def test_retention_keeps_seven_verified_archives_and_preserves_historical_source(self):
        _,c=self.libraries()
        # Root ownership is the injected filesystem boundary; exercise the real
        # hashing, receipt parsing and deletion logic on non-root CI temp files.
        def guard(path,directory=False,mode=None):
            s=path.lstat()
            if path.is_symlink() or (not path.is_dir() if directory else not path.is_file()):raise ValueError('Fixture refused')
            if sys.platform!='win32' and mode is not None and stat.S_IMODE(s.st_mode)!=mode:raise ValueError('Fixture mode refused')
            return s
        c['guard']=guard
        if sys.platform=='win32':c['syncdir']=lambda _path:None
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);historical=root/'candidate-original';historical.mkdir();(historical/'keep').write_text('historical')
            for i in range(9):
                name='owned-2026110'+str(i+1)+'T200000Z-'+'a'*16;path=root/name;path.mkdir(mode=0o700)
                data=b'offline encrypted fixture';(path/'snapshot.tar.cms').write_bytes(data);(path/'snapshot.tar.cms').chmod(0o600)
                receipt={'version':2,'app':'xmail','operation':name,'restoreEquivalent':True,'aeadVerified':True,'recipientDerSha256':backup.RECIPIENT_SHA,
                    'cipherSha256':hashlib.sha256(data).hexdigest(),'cipherBytes':len(data)}
                (path/'receipt.json').write_text(json.dumps(receipt));(path/'receipt.json').chmod(0o600)
            self.assertEqual(backup.retention(c,root),7)
            self.assertEqual(len(list(root.glob('owned-*'))),7)
            self.assertEqual((historical/'keep').read_text(),'historical')
            latest=sorted(root.glob('owned-*'))[-1];(latest/'unexpected').write_text('preserve')
            with self.assertRaises(ValueError):backup.retention(c,root)
            self.assertTrue((latest/'unexpected').exists())

    def test_transport_is_forced_and_source_scoped_and_never_contains_a_private_key(self):
        raw=b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20'+b'a'*32
        key='ssh-ed25519 '+base64.b64encode(raw).decode()
        line=installer.authorized_line(key)
        self.assertTrue(line.startswith('from="49.13.197.250",restrict,command="/usr/bin/python3 -B '))
        self.assertIn('xmail-owned-backup.py --receive"',line)
        self.assertNotIn('PRIVATE',line)
        for invalid in [key+'\nother',key+' arbitrary-comment','ssh-rsa abc','../../key']:
            with self.assertRaises(ValueError):installer.authorized_line(invalid)
        host='188.245.112.3 '+key
        with patch.object(installer,'HOST_SHA',hashlib.sha256(raw).hexdigest()):self.assertEqual(installer.host_line(host),host+'\n')
        with self.assertRaises(ValueError):installer.host_line(host)

    def test_archive_extraction_refuses_links_traversal_duplicates_and_extra_members(self):
        for entries in [['snapshot.dump','manifest.json'],['../outside','manifest.json'],['snapshot.dump','snapshot.dump'],['snapshot.dump','manifest.json','extra'],['snapshot.dump','link']]:
            with tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);archive=root/'input.tar';stage=root/'out';stage.mkdir()
                with tarfile.open(archive,'w',format=tarfile.USTAR_FORMAT) as out:
                    for name in entries:
                        info=tarfile.TarInfo(name)
                        if name=='link':info.type=tarfile.SYMTYPE;info.linkname='outside';out.addfile(info)
                        else:info.size=3;out.addfile(info,io.BytesIO(b'abc'))
                if entries==['snapshot.dump','manifest.json']:
                    backup.extract_archive(archive,stage);self.assertEqual((stage/'snapshot.dump').read_bytes(),b'abc')
                else:
                    with self.assertRaises(ValueError):backup.extract_archive(archive,stage)
                self.assertFalse((root/'outside').exists())

    def test_daily_unit_has_no_secret_arguments_or_app_restart_or_key_export(self):
        self.assertIn('03:15:00 UTC',installer.TIMER);self.assertIn('Persistent=true',installer.TIMER)
        self.assertIn('xmail-owned-backup.py --backup',installer.SERVICE)
        for forbidden in ['DATABASE_URL','PRIVATE KEY','docker restart','docker stop','ssh-agent','Environment=']:
            self.assertNotIn(forbidden,installer.SERVICE+installer.TIMER)

    def test_restore_waits_for_final_tcp_server_and_removes_exact_tmpfs_container(self):
        operation='owned-20261104T200000Z-'+'a'*16
        names=list(backup.IDENTITY)+[str(i) for i in range(70)]
        expected={'schema':{'tables':{n:'a'*64 for n in names}},
            'fingerprints':{n:{'count':0,'sha256':'b'*64} for n in names},
            'ledger':{'count':80,'sha256':'c'*64},'policyRoles':[]}
        calls=[];state={'tcpAttempts':0,'finalServer':False,'removed':False}
        container={'Image':backup.PG_IMAGE,'Config':{'Labels':{'com.skale.xmail-dr':operation}},
            'NetworkSettings':{'Networks':{'none':{}},'Ports':{}},'Mounts':[],
            'HostConfig':{'Tmpfs':{'/var/lib/postgresql/data':'rw,size=536870912'},'Memory':768*1024*1024,
                'MemorySwap':768*1024*1024,'NanoCpus':500000000,'PidsLimit':96}}
        def inspect(identifier):
            return {'Id':backup.PG_IMAGE,'Config':{'Volumes':{'/var/lib/postgresql/data':{}}}} if identifier==backup.PG_IMAGE else container
        def call(args,payload=None,timeout=None):
            calls.append(args)
            if args[:2]==['docker','ps']:return b''
            if args[:2]==['docker','rm']:
                self.assertEqual(args[2:4],['-f','-v']);state['removed']=True;return b''
            if payload and payload.startswith(b'BEGIN READ ONLY'):return json.dumps(expected).encode()
            return b''
        def run(args,**_kwargs):
            if 'psql' in args:
                self.assertTrue(state['finalServer']);self.assertIn('VERBOSITY=sqlstate',args)
                return SimpleNamespace(returncode=0,stdout=json.dumps(expected).encode(),stderr=b'')
            if 'pg_isready' in args:
                if '-h' in args and args[args.index('-h')+1]=='127.0.0.1':
                    state['tcpAttempts']+=1;state['finalServer']=state['tcpAttempts']>1
                    return SimpleNamespace(returncode=0 if state['finalServer'] else 1)
                return SimpleNamespace(returncode=0) # The unsafe initdb socket is already ready.
            self.assertIn('pg_restore',args);self.assertTrue(state['finalServer'])
            return SimpleNamespace(returncode=0)
        real,_=self.libraries()
        m=SimpleNamespace(IDENTITY=real.IDENTITY,business_schema_sql=real.business_schema_sql,
            fingerprints_sql=real.fingerprints_sql,inspect=inspect,call=call,json_result=lambda x:json.loads(x))
        real_open=open
        def opened(path,*args,**kwargs):
            if str(path)=='/proc/meminfo':return io.StringIO('MemAvailable: 2097152 kB\n')
            return real_open(path,*args,**kwargs)
        with tempfile.TemporaryDirectory() as tmp:
            stage=Path(tmp);(stage/'snapshot.dump').write_bytes(b'offline fixture')
            with patch.object(backup.shutil,'disk_usage',return_value=SimpleNamespace(free=2*1024**3)),patch('builtins.open',side_effect=opened),patch.object(backup.subprocess,'run',side_effect=run),patch.object(backup.time,'sleep'):
                backup.restore(m,{},stage,expected,operation)
        self.assertEqual(state['tcpAttempts'],2);self.assertTrue(state['removed'])
        create=next(x for x in calls if x[:2]==['docker','run'])
        self.assertIn('/var/lib/postgresql/data:rw,size=536870912',create)
        self.assertNotIn('/var/lib/postgresql:rw,size=268435456',create)


if __name__=='__main__':unittest.main()
