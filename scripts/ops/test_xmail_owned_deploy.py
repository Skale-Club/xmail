"""Offline fixtures for the exact deploy heredoc; no Docker/network/dotenv access."""
import contextlib
import copy
import base64
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

WORKFLOW = Path(__file__).resolve().parents[2]/'.github/workflows/build-deploy.yml'
WORKFLOW_TEXT = WORKFLOW.read_text().replace('\r\n', '\n')
DEPLOY = WORKFLOW.parents[1]/'scripts/deploy-xmail.sh'
TEXT = DEPLOY.read_text().replace('\r\n', '\n')
START = TEXT.index('import datetime as dt\n', TEXT.index('# BEGIN XMAIL OWNED POLICY'))
END = TEXT.index('XMAIL_OWNED_POLICY_PY', START)
SOURCE = textwrap.dedent(TEXT[START:END])


class PolicyFixture(unittest.TestCase):
    def setUp(self):
        self.ns = {'__name__': 'offline_fixture'}
        exec(compile(SOURCE, str(WORKFLOW)+'::owned-policy', 'exec'), self.ns)
        self.root = Path('/offline/xmail/owned-runtime-ops')
        self.files = {}
        self.commands = []
        self.ns['secure_directory'] = lambda *_args: None
        uid_patch = patch.object(self.ns['os'], 'geteuid', return_value=0, create=True)
        uid_patch.start(); self.addCleanup(uid_patch.stop)
        self.ns['secure_read'] = lambda path, maximum=65536: self.fixture_read(path, maximum)
        self.p = {
            'DATABASE_URL': 'postgres://xmail_runtime:offline-password@'+self.ns['TARGET']+':5432/xmail',
            'DIRECT_URL': 'postgres://xmail_runtime:offline-password@'+self.ns['TARGET']+':5432/xmail',
            'XMAIL_BROWSER_AUTH_AUTHORITY': 'owned', 'XMAIL_USER_ADMIN_AUTHORITY': 'owned', 'XMAIL_OWNED_AUTH_PHASE': 'identity',
            'DB_POOL_MAX': '4', 'DB_JOB_POOL_MAX': '12', 'XMAIL_ADMIN_DB_POOL_MAX': '2',
            'XMAIL_DB_ROLE_CONNECTION_LIMIT': '20', 'XMAIL_DB_CONNECTION_RESERVE': '2', 'XMAIL_DB_PROCESS_COUNT': '1',
            'XMAIL_OWNED_DEPLOY_MODE': 'promote', 'XMAIL_OWNED_APPROVED_IMAGE_ID': 'sha256:'+'a'*64,
            'XMAIL_OWNED_APPROVED_SOURCE_SHA': 'c'*40, 'XMAIL_OWNED_RECEIPT_SHA256': '',
        }
        self.reader = {'NODE_ENV': 'production', 'XMAIL_STAGING_HTTP_ONLY': 'true',
            'XMAIL_STAGING_ORIGIN': 'http://127.0.0.1:9001', 'XMAIL_STAGING_DATABASE_URL':
            'postgres://xmail_staging_reader:offline-reader@'+self.ns['TARGET']+':5432/xmail',
            'XMAIL_GOOGLE_AUTH_ENABLED': 'false', 'GOOGLE_AUTH_ENABLED': 'false'}
        self.base = {'NODE_ENV': 'production', 'PORT': '9001', 'JWT_SECRET': 'offline-preserved-native-proof'}
        google_names = 'XMAIL_GOOGLE_AUTH_ENABLED XMAIL_GOOGLE_AUTH_PROJECT_ID XMAIL_GOOGLE_AUTH_PROJECT_NUMBER XMAIL_GOOGLE_AUTH_WEB_API_KEY XMAIL_GOOGLE_AUTH_ADC_MODE XMAIL_GOOGLE_AUTH_ADC_FILE XMAIL_GOOGLE_AUTH_ADC_AUDIENCE XMAIL_GOOGLE_AUTH_ADC_SERVICE_ACCOUNT XMAIL_GOOGLE_AUTH_ORIGIN'.split()
        self.google = {name: 'offline-fixture' for name in google_names}
        self.google['XMAIL_GOOGLE_AUTH_ENABLED'] = 'true'
        self.google['XMAIL_GOOGLE_AUTH_ADC_MODE'] = 'external_account'
        self.google['XMAIL_GOOGLE_AUTH_ORIGIN'] = 'https://mail.skale.club'
        self.files[Path('/opt/xmail/google-identity-ops/google-auth.env')] = self.env(self.google)
        self.old_id, self.pg_id, self.new_id = 'd'*64, 'e'*64, 'f'*64
        self.old_image = 'sha256:'+'b'*64
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)-dt.timedelta(seconds=2)
        self.created = now.strftime('%Y-%m-%dT%H:%M:%SZ')
        self.expiry = (now+dt.timedelta(minutes=10)).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.source_kind = 'owned'
        self.admin_accepted = True
        self.facts = {
            'freeze': {'allSourceWritersStopped': True, 'oldContainerStopped': True, 'oldOwnedCredentialsRejected': True},
            'snapshot': {'sourceReadOnlySnapshotComplete': True, 'snapshotDigest': '9'*64, 'businessTables': 70},
            'final-import': {'snapshotReceiptSha256': '', 'restoredAndReconciled': True, 'nativeHashesPreserved': True,
                'referenceMetadataPreserved': True, 'identityTables': 4, 'businessTables': 70},
            'controls': {'snapshotReceiptSha256': '', 'exactUuidControlsReviewed': True, 'disabledStatePreserved': True,
                'noContactAutoLinks': True, 'runtimeGrantsReviewed': True},
        }
        self.facts['admin-acceptance'] = {'adminUserId': '11111111-1111-4111-8111-111111111111',
            'bindingId': '22222222-2222-4222-8222-222222222222', 'sessionHash': '8'*64,
            'legacyAnchorBindingId': '22222222-2222-4222-8222-222222222222', 'legacyAnchorSessionHash': '8'*64,
            'independentLegacyProof': True, 'freshGoogleProof': True, 'ownedSessionAccepted': True, 'applicationAdminVerified': True}
        self.regenerate()
        ports = {'9001/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '9001'}]}
        self.states = {
            self.p['XMAIL_OWNED_APPROVED_IMAGE_ID']: {'Id': self.p['XMAIL_OWNED_APPROVED_IMAGE_ID'],
                'Config': {'Labels': {'org.opencontainers.image.revision': self.p['XMAIL_OWNED_APPROVED_SOURCE_SHA']}}},
            self.old_id: {'Id': self.old_id, 'Image': self.old_image, 'Name': '/xmail', 'State': {'Running': False, 'Pid': 0},
                'Config': {'Env': self.env_list({**self.base, 'DATABASE_URL': self.p['DATABASE_URL'], 'DIRECT_URL': self.p['DIRECT_URL']})}, 'HostConfig': {'PortBindings': ports}},
            self.pg_id: {'Id': self.pg_id, 'Image': self.ns['PG_IMAGE'], 'Name': '/'+self.ns['TARGET'],
                'State': {'Running': True, 'Health': {'Status': 'healthy'}}, 'Config': {'Env': []},
                'NetworkSettings': {'Ports': {'5432/tcp': None}},
                'Mounts': [{'Destination': '/var/lib/postgresql/data', 'Type': 'volume', 'RW': True,
                    'Name': 'postgres-data-e12scyfsrp822dag7m9wwd4x'}]},
        }
        self.states[self.ns['TARGET']] = self.states[self.pg_id]
        self.ns['inspect'] = lambda identifier: copy.deepcopy(self.states[identifier])
        self.running_ids = [self.pg_id]
        self.ns['docker'] = self.docker

    def fixture_read(self, path, maximum):
        value = self.files[path]
        if not 0 < len(value) <= maximum: raise ValueError('fixture size refused')
        return value

    def docker(self, arguments, payload=None):
        self.commands.append(arguments)
        if arguments[:2] == ['exec', '-i']:
            self.assertIn(b'BEGIN READ ONLY', payload)
            self.assertNotIn('8'*64, ' '.join(arguments))
            return b't\n' if self.admin_accepted else b'f\n'
        if arguments == ['ps', '-q']: return '\n'.join(self.running_ids).encode()
        raise AssertionError('Unexpected Docker command: fixture accepts read-only ps only')

    @staticmethod
    def env(value): return ''.join(k+'='+v+'\n' for k, v in value.items()).encode()

    @staticmethod
    def env_list(value): return [k+'='+v for k, v in value.items()]

    @staticmethod
    def encoded(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

    @staticmethod
    def sha(value): return hashlib.sha256(value).hexdigest()

    def regenerate(self):
        self.files[self.root/'reader.env'] = self.env(self.reader)
        self.files[self.root/'production-base.env'] = self.env(self.base)
        unsigned = {k: v for k, v in self.p.items() if k != 'XMAIL_OWNED_RECEIPT_SHA256'}
        common = {'version': 1, 'app': 'xmail', 'target': self.ns['TARGET'], 'database': 'xmail', 'role': 'xmail_runtime',
            'postgresImage': self.ns['PG_IMAGE'], 'applicationImage': self.p['XMAIL_OWNED_APPROVED_IMAGE_ID'],
            'sourceSha': self.p['XMAIL_OWNED_APPROVED_SOURCE_SHA'], 'oldContainerId': self.old_id,
            'authPhase': self.p['XMAIL_OWNED_AUTH_PHASE'], 'sourceKind': self.source_kind,
            'createdAt': self.created, 'expiresAt': self.expiry}
        self.proofs = {}
        pointers = {}
        for kind, filename in self.ns['PROOF_FILES'].items():
            if kind == 'maintenance': continue
            if kind == 'final-import' and self.source_kind != 'supabase': continue
            if kind == 'admin-acceptance' and self.p['XMAIL_OWNED_AUTH_PHASE'] != 'identity': continue
            if kind in ['final-import', 'controls']: self.facts[kind]['snapshotReceiptSha256'] = pointers['snapshot']['sha256']
            proof = {**common, 'kind': kind, 'facts': self.facts[kind]}
            raw = self.encoded(proof)
            self.files[self.root/filename] = raw
            self.proofs[kind] = proof
            pointers[kind] = {'file': filename, 'sha256': self.sha(raw)}
        self.r = {**common, 'oldImageId': self.old_image, 'profileDigest': self.sha(self.encoded(unsigned)),
            'baseEnvironmentSha256': self.sha(self.env(self.base)), 'proofs': pointers}
        raw = self.encoded(self.r)
        self.files[self.root/'cutover-receipt.json'] = raw
        self.p['XMAIL_OWNED_RECEIPT_SHA256'] = self.sha(raw) if self.p['XMAIL_OWNED_DEPLOY_MODE'] == 'promote' else ''
        self.files[self.root/'owned-runtime.env'] = self.env(self.p)

    def execute(self, action='inspect', admitted=None):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.ns['execute'](action, self.root, admitted)
        return output.getvalue()

    def test_valid_chain_accepts_only_read_only_docker_checks_and_never_emits_credentials(self):
        output = self.execute('assert-promote')
        self.assertIn('promote sha256:', output)
        self.assertNotIn('offline-password', output)
        self.assertNotIn('offline-preserved-native-proof', output)
        self.assertEqual(self.commands[0], ['ps', '-q'])
        self.assertEqual(self.commands[1][:2], ['exec', '-i'])

    def test_preview_needs_no_freeze_receipts_and_does_not_inspect_or_stop_old_writer(self):
        self.p['XMAIL_OWNED_DEPLOY_MODE'] = 'preview'; self.regenerate()
        self.files.pop(self.root/'cutover-receipt.json')
        self.states[self.old_id]['State']['Running'] = True
        self.assertTrue(self.execute().startswith('preview '))
        self.assertEqual(self.commands, [])

    def test_first_data_cutover_preserves_explicit_legacy_auth_with_google_disabled_and_no_binding(self):
        self.p['XMAIL_OWNED_AUTH_PHASE'] = 'data'
        self.p['XMAIL_BROWSER_AUTH_AUTHORITY'] = self.p['XMAIL_USER_ADMIN_AUTHORITY'] = 'legacy'
        self.source_kind = 'supabase'
        self.facts['freeze'].pop('oldOwnedCredentialsRejected')
        self.base['SUPABASE_URL'] = 'https://zzbudkfkcmqkavgwselc.supabase.co'
        source = 'postgres://postgres:offline-source@db.zzbudkfkcmqkavgwselc.supabase.co:5432/postgres'
        self.states[self.old_id]['Config']['Env'] = self.env_list({**self.base, 'DATABASE_URL': source, 'DIRECT_URL': source})
        self.google['XMAIL_GOOGLE_AUTH_ENABLED'] = 'false'
        self.files[Path('/opt/xmail/google-identity-ops/google-auth.env')] = self.env(self.google)
        self.regenerate(); self.admin_accepted = False
        with self.assertRaises(ValueError): self.execute()  # Docker stop alone cannot fence REST/RPC.
        self.facts['freeze']['sourceWriteFenceEnforced'] = True
        self.regenerate()
        self.assertTrue(self.execute().startswith('promote '))
        self.assertEqual(self.commands, [['ps', '-q']])

    def test_pilot_on_already_owned_sql_keeps_legacy_auth_and_does_not_reimport_supabase(self):
        self.p['XMAIL_OWNED_AUTH_PHASE'] = 'data'
        self.p['XMAIL_BROWSER_AUTH_AUTHORITY'] = self.p['XMAIL_USER_ADMIN_AUTHORITY'] = 'legacy'
        self.regenerate(); self.admin_accepted = False
        self.assertNotIn('final-import', self.r['proofs'])
        self.assertTrue(self.execute().startswith('promote '))

    def test_google_uses_actual_xmail_mode_and_origin_contract_and_rejects_extras(self):
        self.assertTrue(self.execute().startswith('promote '))
        for name, bad in [('XMAIL_GOOGLE_AUTH_ADC_MODE', 'ambient'), ('XMAIL_GOOGLE_AUTH_ORIGIN', 'https://other.invalid'),
                ('XMAIL_GOOGLE_AUTH_ADC_SUBJECT', 'unsupported')]:
            previous = self.google.get(name)
            self.google[name] = bad
            self.files[Path('/opt/xmail/google-identity-ops/google-auth.env')] = self.env(self.google)
            with self.assertRaises(ValueError): self.execute()
            if previous is None: del self.google[name]
            else: self.google[name] = previous

    def test_identity_authority_refuses_missing_current_independently_linked_admin(self):
        self.admin_accepted = False
        with self.assertRaises(ValueError): self.execute()

    def test_unsafe_targets_ambiguous_authority_and_overlap_budget_refused(self):
        for key, value in [('DIRECT_URL', 'postgres://xmail_runtime:offline@foreign.invalid:5432/xmail'),
                ('XMAIL_DB_PROCESS_COUNT', '2'), ('DB_POOL_MAX', '20'), ('DB_JOB_POOL_MAX', '11'),
                ('XMAIL_BROWSER_AUTH_AUTHORITY', 'legacy')]:
            with self.subTest(key=key):
                previous = self.p[key]; self.p[key] = value; self.regenerate()
                with self.assertRaises(ValueError): self.execute()
                self.p[key] = previous

    def test_reader_rejects_writer_url_and_any_extra_secret_key(self):
        self.reader['XMAIL_STAGING_DATABASE_URL'] = self.p['DATABASE_URL']; self.regenerate()
        with self.assertRaises(ValueError): self.execute()
        self.reader['XMAIL_STAGING_DATABASE_URL'] = 'postgres://xmail_staging_reader:offline@'+self.ns['TARGET']+':5432/xmail'
        self.reader['SUPABASE_SERVICE_ROLE_KEY'] = 'offline-never-load'; self.regenerate()
        with self.assertRaises(ValueError): self.execute()

    def test_any_receipt_tamper_or_missing_proof_refused(self):
        self.files[self.root/'freeze-receipt.json'] += b' '
        with self.assertRaises(ValueError): self.execute()
        self.regenerate(); self.files.pop(self.root/'controls-receipt.json')
        with self.assertRaises(KeyError): self.execute()

    def test_freshness_boolean_types_and_uncompleted_import_refused_even_with_correct_hashes(self):
        self.facts['freeze']['oldContainerStopped'] = 1; self.regenerate()
        with self.assertRaises(ValueError): self.execute()
        self.facts['freeze']['oldContainerStopped'] = True
        self.facts['controls']['runtimeGrantsReviewed'] = False; self.regenerate()
        with self.assertRaises(ValueError): self.execute()
        self.facts['controls']['runtimeGrantsReviewed'] = True
        self.created = (dt.datetime.now(dt.timezone.utc)-dt.timedelta(minutes=16)).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.regenerate()
        with self.assertRaises(ValueError): self.execute()

    def test_rejects_source_revision_mismatch_even_with_exact_image_id(self):
        self.states[self.p['XMAIL_OWNED_APPROVED_IMAGE_ID']]['Config']['Labels']['org.opencontainers.image.revision'] = '0'*40
        with self.assertRaises(ValueError): self.execute()

    def test_old_running_and_another_full_writer_fail_closed(self):
        self.states[self.old_id]['State']['Running'] = True
        with self.assertRaises(ValueError): self.execute()
        self.states[self.old_id]['State']['Running'] = False
        self.states['unrelated'] = {'Id': '1'*64, 'Name': '/unrelated-worker', 'Image': 'sha256:'+'2'*64,
            'Config': {'Env': ['DATABASE_URL='+self.p['DATABASE_URL']]}}
        self.running_ids.append('unrelated')
        with self.assertRaises(ValueError): self.execute()

    def test_substituted_or_duplicate_postgres_data_volume_is_refused(self):
        mount = self.states[self.pg_id]['Mounts'][0]
        mount['Name'] = 'substituted-volume'
        with self.assertRaises(ValueError): self.execute()
        mount['Name'] = 'postgres-data-e12scyfsrp822dag7m9wwd4x'
        self.states[self.pg_id]['Mounts'].append(copy.deepcopy(mount))
        with self.assertRaises(ValueError): self.execute()

    def test_baseline_change_and_google_disabled_never_start_a_writer(self):
        self.states[self.old_id]['Config']['Env'].append('R2_SECRET_ACCESS_KEY=offline-new-value')
        with self.assertRaises(ValueError): self.execute()
        self.states[self.old_id]['Config']['Env'] = self.env_list({**self.base, 'DATABASE_URL': self.p['DATABASE_URL'], 'DIRECT_URL': self.p['DIRECT_URL']})
        self.google['XMAIL_GOOGLE_AUTH_ENABLED'] = 'false'
        self.files[Path('/opt/xmail/google-identity-ops/google-auth.env')] = self.env(self.google)
        with self.assertRaises(ValueError): self.execute()

    def test_full_readback_requires_exact_env_image_ports_and_readonly_certificate_mount(self):
        self.states[self.new_id] = {'Id': self.new_id, 'Name': '/xmail', 'Image': self.p['XMAIL_OWNED_APPROVED_IMAGE_ID'],
            'State': {'Running': True, 'Health': {'Status': 'healthy'}}, 'HostConfig': copy.deepcopy(self.states[self.old_id]['HostConfig']),
            'Config': {'Env': self.env_list({**self.base, **self.p, **self.google}), 'Labels': {'com.skale.xmail.runtime': 'owned-full'}},
            'Mounts': [{'Destination': '/run/secrets/xmail-google-identity', 'Source': '/opt/xmail/google-identity-runtime', 'RW': False}]}
        self.running_ids.append(self.new_id)
        self.assertTrue(self.execute('readback', self.new_id).startswith('promote '))
        self.states[self.new_id]['Mounts'][0]['RW'] = True
        with self.assertRaises(ValueError): self.execute('readback', self.new_id)
        self.states[self.new_id]['Mounts'][0]['RW'] = False
        self.states[self.new_id]['HostConfig']['PortBindings'] = {}
        with self.assertRaises(ValueError): self.execute('readback', self.new_id)
        self.states[self.new_id]['HostConfig'] = copy.deepcopy(self.states[self.old_id]['HostConfig'])
        self.states[self.new_id]['Config']['Env'] = self.env_list({**self.base, **self.p, **self.google, 'DIRECT_URL': 'postgres://old.invalid'})
        with self.assertRaises(ValueError): self.execute('readback', self.new_id)

    def test_preview_readback_requires_reader_only_no_secrets_ports_or_certificate_mounts(self):
        stage = {'Id': self.new_id, 'Name': '/xmail-owned-preview', 'Image': self.p['XMAIL_OWNED_APPROVED_IMAGE_ID'],
            'State': {'Running': True}, 'Config': {'Env': self.env_list(self.reader), 'Entrypoint': ['node'],
                'Cmd': ['dist/server/index.js'], 'Labels': {'com.skale.xmail.runtime': 'isolated-preview'}},
            'HostConfig': {'ReadonlyRootfs': True}, 'Mounts': [], 'NetworkSettings': {'Ports': {},
                'Networks': {'xmail-owned-preview': {'NetworkID': 'offline-network'}}}}
        self.states[self.new_id] = stage
        original = self.ns['docker']
        self.ns['docker'] = lambda args, payload=None: self.encoded([{'Internal': True, 'Labels': {'com.skale.xmail.runtime': 'isolated-preview'},
            'Containers': {self.new_id: {}, self.pg_id: {}}}]) if args == ['network', 'inspect', 'offline-network'] else original(args, payload)
        self.assertEqual(self.execute('preview-readback', self.new_id), 'isolated-preview-readback-ok\n')
        stage['Config']['Env'].append('SUPABASE_SERVICE_ROLE_KEY=offline-forbidden')
        with self.assertRaises(ValueError): self.execute('preview-readback', self.new_id)
        stage['Config']['Env'] = self.env_list(self.reader)
        stage['Mounts'] = [{'Type': 'bind', 'Destination': '/run/secrets/xmail-google-identity'}]
        with self.assertRaises(ValueError): self.execute('preview-readback', self.new_id)


class SourcePolicy(unittest.TestCase):
    def test_workflow_checks_public_code_hash_before_execution_and_keeps_yaml_input_small(self):
        start = WORKFLOW_TEXT.index('          script: |\n')+len('          script: |\n')
        lines = []
        for line in WORKFLOW_TEXT[start:].splitlines():
            if line.strip() and not line.startswith('            '): break
            lines.append(line[12:] if line.startswith('            ') else '')
        wrapper = '\n'.join(lines)+'\n'
        self.assertLess(len(wrapper), 21000)
        self.assertLess(wrapper.index('[ "$actual" = "$XMAIL_DEPLOY_CODE_SHA256" ]'), wrapper.index('| bash -s'))
        bash = 'C:/Program Files/Git/bin/bash.exe' if sys.platform == 'win32' else shutil.which('bash')
        if not bash: self.skipTest('Bash unavailable; Linux CI provides Bash')
        program = b"printf 'public-code-executed\\n'\n"
        env = {**os.environ, 'XMAIL_DEPLOY_CODE_B64': base64.b64encode(program).decode(),
            'XMAIL_DEPLOY_CODE_SHA256': hashlib.sha256(program).hexdigest()}
        valid = subprocess.run([bash, '-c', wrapper], env=env, text=True, capture_output=True, check=False)
        self.assertEqual((valid.returncode, valid.stdout.strip()), (0, 'public-code-executed'))
        env['XMAIL_DEPLOY_CODE_SHA256'] = '0'*64
        invalid = subprocess.run([bash, '-c', wrapper], env=env, text=True, capture_output=True, check=False)
        self.assertEqual(invalid.returncode, 2); self.assertEqual(invalid.stdout, '')

    def test_actual_ssh_script_and_heredocs_have_valid_bash_syntax(self):
        shell = TEXT
        bash = 'C:/Program Files/Git/bin/bash.exe' if sys.platform == 'win32' else shutil.which('bash')
        if not bash: self.skipTest('Bash syntax checker unavailable; Linux CI provides Bash')
        result = subprocess.run([bash, '-n'], input=shell, text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux filesystem metadata fixture; never uses production paths')
    def test_real_file_reader_rejects_symlinks_modes_hardlinks_and_nonroot_ownership(self):
        ns = {'__name__': 'offline_filesystem_fixture'}
        exec(compile(SOURCE, str(WORKFLOW)+'::owned-policy', 'exec'), ns)
        original = Path.lstat
        owner = [0]
        class RootMetadata:
            def __init__(self, actual): self.actual = actual
            def __getattr__(self, name):
                if name in ['st_uid', 'st_gid']: return owner[0]
                return getattr(self.actual, name)
        with tempfile.TemporaryDirectory(prefix='xmail-owned-policy-') as temporary:
            root = Path(temporary)
            target = root/'offline.env'; target.write_bytes(b'fixture=offline\n'); target.chmod(0o600)
            with patch.object(Path, 'lstat', lambda value: RootMetadata(original(value))):
                self.assertEqual(ns['secure_read'](target), b'fixture=offline\n')
                target.chmod(0o644)
                with self.assertRaises(ValueError): ns['secure_read'](target)
                target.chmod(0o600); owner[0] = 1000
                with self.assertRaises(ValueError): ns['secure_read'](target)
                owner[0] = 0
                linked = root/'linked.env'; linked.symlink_to(target)
                with self.assertRaises(ValueError): ns['secure_read'](linked)
                os.link(target, root/'hardlink.env')
                with self.assertRaises(ValueError): ns['secure_read'](target)

    def test_owned_paths_use_env_files_not_source_eval_or_legacy_secret_arguments(self):
        start = TEXT.index('run_owned_preview() (')
        body = TEXT[start:TEXT.index('echo "::group::Deploy"', start)]
        self.assertNotIn('source ', body); self.assertNotIn('eval ', body)
        self.assertNotIn('-e DATABASE_URL=', body); self.assertNotIn('-e SMTP_PASS=', body)
        self.assertNotIn('rollback_to_previous', body)
        preview = body[:body.index('run_owned_deploy() {')]
        self.assertIn('--env-file "$OWNED_READER_ENV_FILE"', preview)
        self.assertNotIn('$GOOGLE_RUNTIME_ARGS', preview); self.assertNotIn('$OWNED_BASE_ENV_FILE', preview)
        self.assertNotIn('-p ', preview); self.assertIn('--network "$network_id" --read-only', preview)
        self.assertIn('response=$(owned_policy assert-promote)', body)
        self.assertLess(body.rindex('response=$(owned_policy assert-promote)'), body.index('new_id=$(docker run'))
        self.assertIn('owned_policy readback "$new_id"', body)
        self.assertIn('flock -n 9', body)


if __name__ == '__main__': unittest.main()
