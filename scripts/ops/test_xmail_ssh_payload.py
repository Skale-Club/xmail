"""Public payload fixtures; no SSH, Docker, dotenv or live credentials."""
import base64
import contextlib
import errno
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('payload_guard',Path(__file__).with_name('check-xmail-ssh-payload.py'))
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
TEXT=(ROOT/'.github/workflows/build-deploy.yml').read_text(encoding='utf-8')


def public_bundle():
    names=['.github/scripts/deploy-xmail.sh','scripts/ops/prepare-xmail-owned-runtime-maintenance.py','scripts/ops/prepare-xmail-owned-pilot-rollout.py','scripts/ops/prepare-xmail-final-data-cutover.py','scripts/ops/xmail-database-rehearsal.sh']
    bundle=io.BytesIO()
    with tarfile.open(fileobj=bundle,mode='w') as archive:
        for name in names:
            raw=(ROOT/name).read_bytes().replace(b'\r\n',b'\n');info=tarfile.TarInfo(name);info.size=len(raw);info.mode=0o600;archive.addfile(info,io.BytesIO(raw))
    data=gzip.compress(bundle.getvalue(),mtime=0)
    return {'XMAIL_MAINTENANCE_CODE_B64':base64.b64encode(data).decode(),
        'XMAIL_MAINTENANCE_CODE_SHA256':hashlib.sha256(data).hexdigest(),
        'XMAIL_DEPLOY_CODE_SHA256':hashlib.sha256((ROOT/names[0]).read_bytes().replace(b'\r\n',b'\n')).hexdigest()}


class PayloadTests(unittest.TestCase):
    def test_one_public_bundle_avoids_duplicate_code_and_fits_with_room_for_real_config(self):
        env=public_bundle();command=guard.command(TEXT,env)
        self.assertNotIn('XMAIL_DEPLOY_CODE_B64',TEXT)
        self.assertLess(len(command.encode()),100000)
        self.assertIn("assert hashlib.sha256(data)",command)
        self.assertLess(command.index('assert hashlib.sha256(data)'),command.index('sys.stdout.buffer.write(data)'))

    def test_actual_environment_budget_fails_before_connection_without_printing_values(self):
        canary='private-value-sentinel';env=public_bundle();env['JWT_SECRET']=canary*12000
        with patch.object(guard.os,'environ',env),patch.object(os,'sysconf',return_value=4096,create=True),contextlib.redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(ValueError):guard.main()
        self.assertEqual(out.getvalue(),'')
        env['JWT_SECRET']='small-offline'
        with patch.object(guard.os,'environ',env),patch.object(os,'sysconf',return_value=4096,create=True),contextlib.redirect_stdout(io.StringIO()) as out:
            guard.main()
        result=json.loads(out.getvalue());self.assertTrue(result['sshPayloadFits']);self.assertNotIn('small-offline',out.getvalue())

    @unittest.skipUnless(sys.platform=='linux','Linux execve argument limit reproduction')
    def test_actual_public_old_command_hits_e2big_and_single_bundle_command_executes(self):
        env=public_bundle();raw=base64.b64encode((ROOT/'.github/scripts/deploy-xmail.sh').read_bytes()).decode()
        old="export XMAIL_DEPLOY_CODE_B64='"+raw+"'\nexport XMAIL_MAINTENANCE_CODE_B64='"+env['XMAIL_MAINTENANCE_CODE_B64']+"'\n:"
        with self.assertRaises(OSError) as stopped:subprocess.run(['/bin/bash','-c',old],env={},capture_output=True,timeout=5)
        self.assertEqual(stopped.exception.errno,errno.E2BIG)
        canary="offline ' $() `literal`\nsecond-line";env['JWT_SECRET']=canary
        full=guard.command(TEXT,env);exports=full[:-len(guard.wrapper(TEXT))]
        noop=exports+'test "$JWT_SECRET" = '+shlex.quote(canary)+" && printf 'bounded-transfer-ok\\n'"
        result=subprocess.run(['/bin/bash','-c',noop],env={},capture_output=True,timeout=5)
        self.assertEqual(result.returncode,0);self.assertEqual(result.stdout,b'bounded-transfer-ok\n')
        self.assertNotIn(canary.encode(),result.stderr)


if __name__=='__main__':unittest.main()
