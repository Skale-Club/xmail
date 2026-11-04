"""Backup guard/retention/installer fixtures; no SSH, Docker, dotenv or customer data."""
import base64
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import tarfile
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


if __name__=='__main__':unittest.main()
