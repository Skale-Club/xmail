"""Offline maintenance protocol fixtures; never reads dotenv or live hosts."""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_xmail_owned_deploy as consumer_fixture
TEXT, WORKFLOW_TEXT = consumer_fixture.TEXT, consumer_fixture.WORKFLOW_TEXT

PATH = Path(__file__).with_name('prepare-xmail-owned-runtime-maintenance.py')
spec = importlib.util.spec_from_file_location('maintenance_operator', PATH)
operator = importlib.util.module_from_spec(spec); spec.loader.exec_module(operator)


class MaintenanceProtocol(unittest.TestCase):
    def fixture(self):
        f = consumer_fixture.PolicyFixture('runTest'); f.setUp(); self.addCleanup(f.doCleanups)
        return f

    def test_default_is_offline_and_does_not_load_helpers(self):
        with patch.object(sys, 'argv', [str(PATH)]), patch.object(operator, 'libraries', side_effect=AssertionError('No I/O')), contextlib.redirect_stdout(io.StringIO()) as out:
            operator.main()
        self.assertIn('PLAN ONLY', out.getvalue())

    def test_rotation_only_changes_existing_role_credentials_inside_one_transaction(self):
        pilot, lib = operator.libraries(); f = self.fixture()
        with patch.object(lib, 'postgres_scram', return_value='SCRAM-SHA-256$offline-verifier'):
            sql = operator.rotation_sql(lib, pilot, {}, 'not-an-argument', 'also-private', (dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=14)).isoformat(), f.ns['maintenance_state_sql']())
        self.assertLess(sql.index('LOCK TABLE'), sql.index('ALTER ROLE'))
        self.assertIn('AND NOT rolcanlogin', sql)
        self.assertTrue(sql.endswith('COMMIT;\n\\echo OWNED_MAINTENANCE_COMMITTED\n'))
        for forbidden in ['not-an-argument', 'also-private', 'UPDATE public.', 'INSERT INTO', 'COPY ', 'TRUNCATE ', 'CREATE ROLE', 'GRANT ', 'DISABLE TRIGGER']:
            self.assertNotIn(forbidden, sql)

    def test_all_four_full_identity_tables_and_native_data_are_preserved(self):
        before = {k: {'fixture': 'unchanged'} for k in ['schema','fingerprints','ids','controls','identityDigests','bindingDigest','challengeDigest','sessionCount']}
        self.assertTrue(operator.preserved(before, copy.deepcopy(before)))
        for key in before:
            changed = copy.deepcopy(before); changed[key] = 'tampered'
            self.assertFalse(operator.preserved(before, changed), key)

    def test_current_controls_use_owned_uuids_without_source_inventory(self):
        f = self.fixture(); sql = f.ns['maintenance_state_sql']()
        self.assertIn('LEFT JOIN public.xmail_identity_user_controls', sql)
        self.assertIn('c.reviewed_at IS NULL', sql)
        self.assertNotIn('auth.users', sql)
        self.assertNotIn('authenticated_at', sql)
        self.assertNotIn('session', sql.replace('sessions_valid_after',''))
        source = PATH.read_text()
        for forbidden in ['AUTH_REVIEW_JS', 'validate_review(', 'controls_sql(', 'auth/v1/admin', 'SOURCE_CLOSED', 'INSERT INTO public.']:
            self.assertNotIn(forbidden, source)

    def test_actual_order_is_preview_backup_stop_fence_frozen_backup_commit(self):
        source = PATH.read_text(); body = source[source.index('def run('):]
        positions = [body.index(x) for x in ["proof = preview(", "bundle/'running-before.dump'", "'docker', 'stop'", 'pilot.role_fence_sql(m)', "bundle/'owned-before.dump'", 'm.psql(rotation_sql(']]
        self.assertEqual(positions, sorted(positions))
        self.assertLess(body.index('bad_url ='), body.index("'docker', 'stop'"))
        self.assertIn('automaticRetryAllowed\': False', body)

    def test_official_workflow_transports_only_public_pinned_code_and_holds_leases(self):
        self.assertIn('XMAIL_MAINTENANCE_CODE_SHA256', WORKFLOW_TEXT)
        self.assertIn("info=tarfile.TarInfo(name)", WORKFLOW_TEXT)
        stage = TEXT[TEXT.index('prepare_owned_maintenance_pipeline() {'):TEXT.index('# END XMAIL OWNED POLICY')]
        self.assertIn('archive.getmembers()', stage)
        self.assertIn('m.isfile()', stage)
        self.assertIn('GITHUB_SOURCE_SHA', stage)
        self.assertIn('org.opencontainers.image.revision', stage)
        self.assertIn('--apply --parent-lock', stage)
        self.assertIn('flock -n 9', stage); self.assertIn('flock -n 8', stage)
        self.assertNotRegex(stage, r'(?m)^\s*(source|eval) ')

    def version_two(self):
        f = self.fixture()
        prior_raw = f.files[f.root/'cutover-receipt.json']; prior_profile = f.files[f.root/'owned-runtime.env']
        anchor = {'runtimeId':f.old_id,'applicationImage':f.old_image,'receiptSha256':f.sha(prior_raw),'profileSha256':f.sha(prior_profile)}
        # Historical release is a real old commit reference, not a renewed lease.
        prior = json.loads(prior_raw); prior.update(applicationImage=f.old_image,createdAt='2020-01-01T00:00:00Z',expiresAt='2020-01-01T00:15:00Z')
        prior_raw=f.encoded(prior); old_profile=dict(f.p); old_profile['XMAIL_OWNED_RECEIPT_SHA256']=f.sha(prior_raw)
        prior_profile=f.env(old_profile);anchor.update(receiptSha256=f.sha(prior_raw),profileSha256=f.sha(prior_profile))
        for name,raw in [('maintenance-prior-receipt.json',prior_raw),('maintenance-prior-profile.env',prior_profile),('maintenance-prior-authority.json',f.encoded(anchor))]: f.files[f.root/name]=raw
        bundle=Path('/opt/xmail/backups/owned-maintenance-20261105T010203Z-aabbccdd')
        state={k:'full-state' for k in ['schema','fingerprints','ids','controls','bindingDigest','challengeDigest','sessionCount']}
        state['identityDigests']={'all-four':'9'*64}
        ack=f.encoded({'acknowledged':True})
        for name,raw in [('maintenance-commit-acknowledged.json',ack),('owned-frozen.json',f.encoded(state)),('owned-after-maintenance.json',f.encoded(state)),('owned-before.sha256',b'8'*64+b'\n')]:f.files[bundle/name]=raw
        facts={k:True for k in ['authorityAlreadyOwned','currentSqlControlsPreserved','fullIdentityStatePreserved','providerStatusReviewed','previewReadyBeforeStop','noSourceAuthRequests']}
        facts.update(previousReceiptSha256=f.sha(prior_raw),previousProfileSha256=f.sha(prior_profile),previousAuthoritySha256=f.sha(f.encoded(anchor)),commitBundle=bundle.name,commitAckSha256=f.sha(ack),identityStateDigest=f.sha(f.encoded(state['identityDigests'])),backupSha256='8'*64)
        common={k:v for k,v in f.r.items() if k not in ['oldImageId','profileDigest','baseEnvironmentSha256','proofs']}
        common.update(version=2,intent='owned-maintenance')
        proofs={}
        for kind in ['freeze','snapshot','controls','maintenance']:
            value=facts if kind=='maintenance' else dict(f.facts[kind])
            if kind=='controls':value['snapshotReceiptSha256']=proofs['snapshot']['sha256']
            raw=f.encoded({**common,'kind':kind,'facts':value}); name=f.ns['PROOF_FILES'][kind]
            f.files[f.root/name]=raw;proofs[kind]={'file':name,'sha256':f.sha(raw)}
        r={**f.r,**common,'proofs':proofs};raw=f.encoded(r)
        f.p['XMAIL_OWNED_RECEIPT_SHA256']=f.sha(raw);f.files[f.root/'cutover-receipt.json']=raw
        return f,r,facts,bundle

    def test_v2_accepts_historical_owned_commit_without_new_personal_factor(self):
        f,r,_,_=self.version_two()
        accepted,_=f.ns['receipt'](f.p,r['profileDigest'],f.root)
        self.assertEqual(accepted['_maintenance']['noSourceAuthRequests'],True)
        self.assertNotIn('_acceptedAdmin',accepted)

    def test_v2_rejects_mismatched_anchor_commit_missing_and_changed_identity(self):
        for path_suffix in ['maintenance-prior-authority.json','maintenance-commit-acknowledged.json','owned-after-maintenance.json']:
            f,r,_,bundle=self.version_two(); path=(f.root if path_suffix.startswith('maintenance-prior') else bundle)/path_suffix
            f.files[path]=b'{}'
            with self.assertRaises((ValueError,KeyError)):f.ns['receipt'](f.p,r['profileDigest'],f.root)

    def test_v2_lease_still_expires_and_cannot_replay_legacy_authority(self):
        f,r,_,_=self.version_two()
        with self.assertRaises(ValueError):f.ns['receipt'](f.p,r['profileDigest'],f.root,dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=1))
        f.p['XMAIL_BROWSER_AUTH_AUTHORITY']='legacy';f.files[f.root/'owned-runtime.env']=f.env(f.p)
        with self.assertRaises(ValueError):f.ns['profiles'](f.root)

    def provider(self, overrides=None):
        f=self.fixture()
        user={'localId':'offline-subject','providerUserInfo':[{'providerId':'phone'}],'validSince':'1000000000',**(overrides or {})}
        fixture="const Module=require('node:module'),original=Module._load;Module._load=function(name,...args){if(name.endsWith('/config.js'))return{resolveIdentityConfig:()=>({projectId:'skaleclub',projectNumber:'937861185231',origin:'https://mail.skale.club',adcMode:'external_account'})};if(name.endsWith('/runtime.js'))return{createKeylessAccessTokenSupplier:async()=>async()=>\"offline-token\"};return original.call(this,name,...args)};globalThis.fetch=async(url,init)=>{if(url!=='https://identitytoolkit.googleapis.com/v1/projects/skaleclub/accounts:lookup'||init.method!=='POST'||init.redirect!=='error'||JSON.parse(init.body).localId[0]!=='offline-subject')throw Error();return new Response(JSON.stringify({users:["+json.dumps(user)+"]}))};\n"
        return subprocess.run(['node','-e',fixture+f.ns['MAINTENANCE_PROVIDER_JS']],input=json.dumps({'subjects':['offline-subject'],'env':f.google}).encode(),capture_output=True,timeout=3)

    def test_provider_lookup_current_account_has_no_sms_or_deployment_age_requirement(self):
        result=self.provider();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),{'currentProviderAvailable':True,'administrativeBindingAvailable':True,'noProviderWrites':True})
        self.assertNotIn(b'offline-token',result.stdout)
        for change in [{'disabled':True},{'tenantId':'another'},{'localId':'different'},{'validSince':'999999999999'},{'providerUserInfo':[]}]:
            self.assertNotEqual(self.provider(change).returncode,0,change)


import hashlib
import tempfile
from types import SimpleNamespace

ACCEPTED, REJECTED = operator.ACCEPTED, operator.REJECTED
REAL_PUBLISH = operator.publish
ANCHOR_BUNDLE = 'owned-authority-20261104T235544Z-e82cc86e'
ATTEMPT_BUNDLE = 'owned-maintenance-20261105T020800Z-aabbccdd'


class Sim:
    """Offline stand-in for the reviewed Docker/PostgreSQL primitives."""
    TARGET = 'e12scyfsrp822dag7m9wwd4x'
    PG_IMAGE = 'sha256:'+'2'*64

    def __init__(self, ops, old_id, previous, roles):
        self.OPS, self.roles, self.sessions, self.old_id = ops, roles, 0, old_id
        self.log, self.psql_log, self.durable, self.stale = [], [], [], {}
        self.containers = {old_id: {'Id': old_id, 'Name': '/xmail', 'Image': previous['XMAIL_OWNED_APPROVED_IMAGE_ID'],
            'State': {'Running': False, 'Pid': 0}, 'Config': {'Labels': {'com.skale.xmail.runtime': 'owned-full'},
            'Env': [k+'='+v for k, v in previous.items()]}}}
        self.containers[self.TARGET] = {'Id': 'e'*64, 'Name': '/'+self.TARGET, 'State': {'Running': True}}
        self.snapshot = {k: 'same' for k in ['schema', 'fingerprints', 'ids', 'controls', 'identityDigests', 'bindingDigest', 'challengeDigest', 'sessionCount']}

    postgres_scram = staticmethod(lambda password: 'SCRAM-SHA-256$offline-verifier')
    encoded = staticmethod(lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode())
    sha = staticmethod(lambda raw: hashlib.sha256(raw).hexdigest())
    env_bytes = staticmethod(lambda values: ''.join(k+'='+v+'\n' for k, v in values.items()).encode())
    json_result = staticmethod(lambda raw: json.loads(raw))
    fsync_directory = staticmethod(lambda path: None)

    def inspect(self, identifier): return copy.deepcopy(self.containers[identifier])

    def ensure_no_other_writers(self, policy, old, approved): self.log.append('writers-checked')

    def durable_file(self, path, raw, replace=False):
        if not replace and path.exists(): raise ValueError('exists')
        path.write_bytes(raw); self.durable.append(path.name)

    def call(self, args, payload=None, timeout=15):
        self.log.append(args[1]+':'+(args[2] if len(args) > 2 else ''))
        if args[:2] == ['docker', 'ps']:
            flags = ' '.join(args)
            if 'label=' in flags: return '\n'.join(i for i, c in self.containers.items() if c.get('Labels2') == flags.split('label=')[1]).encode()
            ids = [i for i, c in self.containers.items() if c['Name'] == '/xmail' and ('-a' in args[2] or c['State']['Running'])]
            return '\n'.join(ids).encode()
        if args[:2] == ['docker', 'network']: return b''
        if args[:2] == ['docker', 'update']: self.containers[args[3]]['Restart'] = args[2]; return b''
        if args[:2] == ['docker', 'start']:
            self.containers[args[2]]['State'] = {'Running': True, 'Health': {'Status': 'healthy'}}; return b''
        if args[:2] == ['docker', 'exec']: return b''
        if args[:2] == ['docker', 'rm']: del self.containers[args[-1]]; return b''
        raise AssertionError('Unexpected Docker call')

    def psql(self, sql):
        self.psql_log.append(sql)
        if 'OWNED_ROLES_UNFENCED' in sql:
            assert self.roles == 'fenced' and 'GUARD-FENCED' in sql and 'ALTER ROLE xmail_runtime LOGIN; ALTER ROLE xmail_staging_reader LOGIN;' in sql
            self.roles = 'login'; return b'OWNED_ROLES_UNFENCED\n'
        if 'OWNED_READER_REFRESHED' in sql:
            assert 'xmail_staging_reader' in sql and 'xmail_runtime' not in sql
            return b'OWNED_READER_REFRESHED\n'
        raise AssertionError('Unexpected SQL write')

    def read_only(self, query):
        if query == 'SNAPSHOT-SQL': return json.dumps(self.snapshot).encode()
        if query.startswith('SELECT count(*)'): return str(self.sessions).encode()+b'\n'
        if 'string_agg' in query:
            flag = {'login': 'true', 'fenced': 'false', 'mixed': None}[self.roles]
            return ('xmail_runtime=true,xmail_staging_reader=false' if flag is None else 'xmail_runtime=%s,xmail_staging_reader=%s' % (flag, flag)).encode()+b'\n'
        if query.startswith('GUARD'): return b''
        raise AssertionError('Unexpected SQL read')


class InterruptedRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()); self.addCleanup(lambda: __import__('shutil').rmtree(self.tmp, ignore_errors=True))
        self.ops, self.backups = self.tmp/'ops', self.tmp/'backups'
        self.ops.mkdir(); self.backups.mkdir(); self.bundle = self.backups/ATTEMPT_BUNDLE; self.bundle.mkdir()
        f = consumer_fixture.PolicyFixture('runTest'); f.setUp(); self.addCleanup(f.doCleanups); self.f = f
        ns = f.ns; self.old_id = 'd'*64
        self.previous = dict(f.p); self.previous['XMAIL_OWNED_RECEIPT_SHA256'] = 'f'*64
        self.pending = {**self.previous, 'DATABASE_URL': 'postgres://xmail_runtime:NEW@'+ns['TARGET']+':5432/xmail',
            'DIRECT_URL': 'postgres://xmail_runtime:NEW@'+ns['TARGET']+':5432/xmail', 'XMAIL_OWNED_RECEIPT_SHA256': '0'*64}
        self.pending_reader = {**f.reader, 'XMAIL_STAGING_DATABASE_URL': 'postgres://xmail_staging_reader:NEWREADER@'+ns['TARGET']+':5432/xmail'}
        (self.ops/'owned-runtime.env').write_bytes(f.env(self.previous))
        (self.ops/'production-base.env').write_bytes(f.env(f.base))
        (self.ops/'owned-authority-current.json').write_bytes(f.encoded({'commitBundle': ANCHOR_BUNDLE}))
        self.attempt = {'commitBundle': ATTEMPT_BUNDLE, 'oldContainerId': self.old_id, 'automaticRetryAllowed': False}
        (self.ops/'maintenance-attempt.json').write_bytes(f.encoded(self.attempt))
        for name, raw in [('previous-profile.env', f.env(self.previous)), ('previous-receipt.json', b'{"r":1}'), ('previous-authority.json', b'{"a":1}'),
                          ('preview-ready.json', b'{}'), ('pending-profile.env', f.env(self.pending)), ('pending-reader.env', f.env(self.pending_reader)),
                          ('owned-before.sha256', b'8'*64+b'\n')]:
            (self.bundle/name).write_bytes(raw)
        self.sim = Sim(self.ops, self.old_id, self.previous, 'login')
        self.sim.containers[self.old_id]['Config']['Env'] += [k+'='+v for k, v in f.base.items()]
        self.states = {}
        self.published = []
        self.patches = [patch.object(operator, 'BACKUPS', self.backups), patch.object(operator, 'snapshot_sql', return_value='SNAPSHOT-SQL'),
            patch.object(operator, 'validate_snapshot'), patch.object(operator, 'probe_credentials', side_effect=self.probe),
            patch.object(operator, 'check_candidate_image'), patch.object(operator.time, 'sleep'),
            patch.object(operator, 'publish', side_effect=lambda *a, **k: self.published.append(a)),
            patch.object(operator, 'current_owned', side_effect=lambda m, policy, old: (m.inspect(old), {}, self.previous)),
            patch.object(operator, 'authority_anchor', return_value=f.encoded({'commitBundle': ANCHOR_BUNDLE}))]
        for p in self.patches: p.start(); self.addCleanup(p.stop)
        self.pilot = SimpleNamespace(owned_guard_sql=lambda m, fenced=False: 'GUARD-FENCED' if fenced else 'GUARD')
        self.google_dir = patch.object(operator, 'GOOGLE_KEYS', set(f.google))
        self.google_dir.start(); self.addCleanup(self.google_dir.stop)
        google = Path('/opt/xmail/google-identity-ops/google-auth.env')
        read = lambda path, maximum=65536: (f.files[path] if path in f.files else path.read_bytes())
        self.policy = {'secure_read': read, 'secure_directory': lambda path, private=False: (path in (google.parent,)) or path.is_dir() or (_ for _ in ()).throw(ValueError('dir')),
            'json_file': ns['json_file'], 'env_file': ns['env_file'], 'container_env': ns['container_env'], 'database_url': ns['database_url'],
            'PROFILE_KEYS': ns['PROFILE_KEYS'], 'READER_KEYS': ns['READER_KEYS'], 'BASE_KEYS': ns['BASE_KEYS'],
            'verify_maintenance_state': lambda *a: self.states.setdefault('verified', True)}
        self.sim.containers[self.old_id]['Config']['Env'] += [k+'='+v for k, v in f.google.items() if k not in self.previous]
        self.args = SimpleNamespace(approved_image_id='sha256:'+'a'*64, approved_source_sha='c'*40)
        operator.RECOVERY.update(active=False, phase='not-detected', step='start')
        self.mode = 'old'

    def probe(self, m, pilot, image, url):
        if url == self.previous['DATABASE_URL']: return {'old': ACCEPTED, 'new': REJECTED, 'both': ACCEPTED, 'none': REJECTED}[self.mode]
        return {'old': REJECTED, 'new': ACCEPTED, 'both': ACCEPTED, 'none': REJECTED}[self.mode]

    def mark(self, *names):
        for name in names: (self.bundle/name).write_bytes(b'{}')

    def freeze(self):
        (self.bundle/'owned-frozen.json').write_bytes(Sim.encoded(self.sim.snapshot))

    def go(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try: return operator.recover_locked(self.sim, self.pilot, self.policy, self.args), out.getvalue()
            except operator.Refused as error: error.stdout = out.getvalue(); raise

    def lines(self, text): return [json.loads(x) for x in text.splitlines() if x.startswith('{')]

    # Case 1: the old app was stopped, the roles were never fenced, no password changed.
    def test_stopped_without_fence_restarts_the_old_runtime_and_unsticks_the_journal(self):
        result, text = self.go()
        self.assertEqual(result['oldRuntimeRestored'], True)
        self.assertEqual(self.lines(text)[0], {'recoveryPhase': 'stopped-no-fence', 'action': 'start-old'})
        self.assertEqual(self.sim.containers[self.old_id]['Restart'], '--restart=unless-stopped')
        self.assertTrue(self.sim.containers[self.old_id]['State']['Running'])
        self.assertEqual(self.sim.psql_log, [])
        journal = json.loads((self.ops/'maintenance-attempt.json').read_bytes())
        self.assertEqual(journal['commitBundle'], ANCHOR_BUNDLE)  # run() compares this with the anchor
        self.assertEqual(journal['recovered'], ATTEMPT_BUNDLE); self.assertFalse(journal['automaticRetryAllowed'])
        self.assertEqual(self.published, [])

    # Case 2: fenced before the COMMIT intent. The exact inverse of role_fence_sql runs first.
    def test_fenced_without_commit_attempt_unfences_then_starts_old(self):
        self.mark('fence-attempt.json'); self.sim.roles = 'fenced'; self.freeze()
        result, text = self.go()
        self.assertEqual(self.lines(text)[0], {'recoveryPhase': 'fenced-no-commit', 'action': 'unfence-start-old'})
        self.assertEqual(self.sim.roles, 'login'); self.assertEqual(len(self.sim.psql_log), 1)
        self.assertLess(self.sim.log.index('start:'+self.old_id), len(self.sim.log))
        self.assertTrue(result['oldRuntimeRestored'])

    def test_fence_that_never_reached_the_database_needs_no_unfence(self):
        self.mark('fence-attempt.json'); result, text = self.go()
        self.assertEqual(self.lines(text)[0]['action'], 'start-old'); self.assertEqual(self.sim.psql_log, [])

    # Case 3 (not committed): NOLOGIN roles or the old password still working prove the COMMIT did not happen.
    def test_commit_intent_with_fenced_roles_did_not_commit(self):
        self.mark('fence-attempt.json', 'maintenance-commit-attempt.json'); self.sim.roles = 'fenced'; self.freeze()
        result, text = self.go()
        self.assertEqual(self.lines(text)[0], {'recoveryPhase': 'commit-attempted', 'action': 'unfence-start-old'})
        self.assertTrue(result['oldRuntimeRestored']); self.assertEqual(self.published, [])

    def test_commit_intent_with_old_password_accepted_did_not_commit(self):
        self.mark('fence-attempt.json', 'maintenance-commit-attempt.json'); self.mode = 'old'
        result, _ = self.go()
        self.assertTrue(result['oldRuntimeRestored']); self.assertEqual(self.published, []); self.assertEqual(self.sim.psql_log, [])

    # Case 3 (committed): the new password is the one the database accepts.
    def test_commit_with_new_password_republishes_fresh_receipts_and_does_not_start_old(self):
        self.mark('fence-attempt.json', 'maintenance-commit-attempt.json'); self.freeze(); self.mode = 'new'
        before = dt.datetime.now(dt.timezone.utc)
        result, text = self.go()
        self.assertEqual(result, {'ownedMaintenanceReady': True, 'recovered': True, 'oldRuntimeRestored': False, 'applicationStarted': False, 'sourceAuthRequests': False})
        self.assertEqual(self.lines(text)[0], {'recoveryPhase': 'committed-unacknowledged', 'action': 'republish-receipts-continue-deploy'})
        self.assertFalse(self.sim.containers[self.old_id]['State']['Running'])
        self.assertEqual(json.loads((self.bundle/'maintenance-commit-acknowledged.json').read_bytes()), {'acknowledged': True})
        self.assertTrue((self.bundle/'owned-after-maintenance.json').exists()); self.assertTrue((self.bundle/'maintenance-profile-ready.json').exists())
        self.assertEqual(len(self.sim.psql_log), 1)  # reader credential refresh only
        (m, policy, bundle, old, image, source, prior, prior_profile, anchor, base, frozen, frozen_at, expiry, next_profile, next_reader, backup), = self.published
        self.assertEqual((image, source), (self.args.approved_image_id, self.args.approved_source_sha))
        self.assertGreaterEqual(frozen_at, before.replace(microsecond=0)); self.assertEqual(expiry-frozen_at, dt.timedelta(minutes=15))
        self.assertEqual(next_profile['DATABASE_URL'], self.pending['DATABASE_URL'])
        self.assertEqual(next_profile['XMAIL_OWNED_APPROVED_IMAGE_ID'], self.args.approved_image_id)
        self.assertEqual(prior_profile, (self.bundle/'previous-profile.env').read_bytes()); self.assertEqual(backup, '8'*64)

    def test_profile_ready_but_consumer_unfinished_regenerates_receipts_without_extending_old_ones(self):
        self.mark('fence-attempt.json', 'maintenance-commit-attempt.json', 'maintenance-commit-acknowledged.json', 'maintenance-profile-ready.json')
        (self.bundle/'maintenance-commit-acknowledged.json').write_bytes(Sim.encoded({'acknowledged': True}))
        self.freeze(); (self.bundle/'owned-after-maintenance.json').write_bytes(Sim.encoded(self.sim.snapshot)); self.mode = 'new'
        stale = self.sim.containers['9'*64] = {'Id': '9'*64, 'Name': '/xmail', 'State': {'Running': False}, 'Config': {'Labels': {'com.skale.xmail.runtime': 'owned-full'}}}
        self.sim.containers[self.old_id]['Name'] = '/xmail-frozen-'+self.old_id[:12]
        result, text = self.go()
        self.assertEqual(self.lines(text)[0]['recoveryPhase'], 'profile-ready'); self.assertEqual(len(self.published), 1)
        self.assertNotIn('9'*64, self.sim.containers)  # the stopped half-started consumer container cannot collide on the name
        self.assertLessEqual(self.published[0][12]-self.published[0][11], dt.timedelta(minutes=15))
        self.assertGreaterEqual(self.published[0][11], dt.datetime.now(dt.timezone.utc).replace(microsecond=0)-dt.timedelta(seconds=30))

    # Ambiguous and unsafe states stop with a fixed label and change nothing.
    def refused(self, check, phase):
        with self.assertRaises(operator.Refused) as raised: self.go()
        self.assertEqual(raised.exception.check, check); self.assertEqual(operator.RECOVERY['phase'], phase)
        self.assertEqual(self.sim.psql_log, []); self.assertEqual(self.published, [])
        self.assertFalse(self.sim.containers[self.old_id]['State']['Running'])
        self.assertNotIn('start:'+self.old_id, self.sim.log)

    def test_both_or_neither_password_accepted_is_ambiguous(self):
        self.mark('fence-attempt.json', 'maintenance-commit-attempt.json')
        for mode in ['both', 'none']:
            self.mode = mode; self.refused('credentials-ambiguous', 'commit-attempted')

    def test_acknowledged_commit_with_old_password_or_fenced_roles_is_refused(self):
        self.mark('fence-attempt.json', 'maintenance-commit-attempt.json', 'maintenance-commit-acknowledged.json')
        self.mode = 'old'; self.refused('acknowledged-without-new-credentials', 'commit-acknowledged')
        self.sim.roles = 'fenced'; self.refused('acknowledged-without-new-credentials', 'commit-acknowledged')

    def test_mixed_role_state_lingering_sessions_and_diverged_data_are_refused(self):
        self.sim.roles = 'mixed'; self.refused('roles-unexpected-state', 'stopped-no-fence')
        self.sim.roles = 'login'; self.sim.sessions = 1; self.refused('sql-sessions-linger', 'stopped-no-fence')
        self.sim.sessions = 0; self.mark('fence-attempt.json'); self.freeze(); self.sim.snapshot = {**self.sim.snapshot, 'ids': 'changed'}
        self.refused('state-diverged', 'fenced-no-commit')

    def test_committed_data_that_diverged_from_the_frozen_snapshot_is_refused_before_any_write(self):
        self.mark('fence-attempt.json', 'maintenance-commit-attempt.json'); self.freeze(); self.mode = 'new'
        self.sim.snapshot = {**self.sim.snapshot, 'controls': 'changed'}
        with self.assertRaises(operator.Refused) as raised: self.go()
        self.assertEqual(raised.exception.check, 'committed-state-diverged'); self.assertEqual(self.sim.psql_log, []); self.assertEqual(self.published, [])

    def test_old_password_rejected_without_a_commit_marker_is_refused(self):
        self.mode = 'none'; self.refused('old-password-rejected', 'stopped-no-fence')

    def test_running_runtime_missing_attempt_and_published_attempt_are_not_recoveries(self):
        self.sim.containers[self.old_id]['State']['Running'] = True
        with self.assertRaises(operator.Refused) as raised: self.go()
        self.assertEqual(raised.exception.check, 'xmail-running'); self.assertEqual(self.sim.psql_log, [])
        self.sim.containers[self.old_id]['State']['Running'] = False
        (self.ops/'owned-authority-current.json').write_bytes(Sim.encoded({'commitBundle': ATTEMPT_BUNDLE})); self.refused('already-published', 'not-detected')
        (self.ops/'maintenance-attempt.json').unlink(); self.refused('no-attempt', 'not-detected')

    def test_leftover_previews_are_removed_so_they_cannot_count_as_a_second_writer(self):
        ghost = '7'*64; self.sim.containers[ghost] = {'Id': ghost, 'Name': '/xmail-maintenance-preview-20261105T020800Z-aabbccdd', 'State': {'Running': True}, 'Labels2': 'com.skale.xmail.maintenance'}
        self.go(); self.assertNotIn(ghost, self.sim.containers)
        stranger = '6'*64; self.sim.containers[stranger] = {'Id': stranger, 'Name': '/something-else', 'State': {'Running': True}, 'Labels2': 'com.skale.xmail.maintenance'}
        self.sim.containers[self.old_id]['State']['Running'] = False
        (self.ops/'maintenance-attempt.json').write_bytes(self.f.encoded(self.attempt))
        with self.assertRaises(operator.Refused) as raised: self.go()
        self.assertEqual(raised.exception.check, 'stale-container-unknown'); self.assertIn(stranger, self.sim.containers)

    def test_next_normal_attempt_is_not_blocked_by_an_abandoned_bundle_that_never_fenced(self):
        self.assertTrue(operator.retry_is_safe(self.policy, self.attempt))
        self.mark('fence-attempt.json'); self.assertFalse(operator.retry_is_safe(self.policy, self.attempt))
        self.assertFalse(operator.retry_is_safe(self.policy, {'commitBundle': '../x'}))
        source = PATH.read_text(); self.assertIn("or retry_is_safe(policy, previous))", source)

    def test_exit_code_tells_the_deploy_script_to_stop_after_restoring_the_old_runtime(self):
        for restored, code in [(True, 10), (False, None)]:
            with patch.object(sys, 'argv', [str(PATH), '--recover-interrupted']), patch.object(operator, 'recover', return_value={'oldRuntimeRestored': restored}), contextlib.redirect_stdout(io.StringIO()):
                if code is None: operator.main()
                else:
                    with self.assertRaises(SystemExit) as raised: operator.main()
                    self.assertEqual(raised.exception.code, code)

    def test_refusal_prints_only_fixed_phase_and_check_labels(self):
        operator.RECOVERY.update(active=True, phase='commit-attempted', step='credential-probes')
        self.addCleanup(operator.RECOVERY.update, active=False, phase='not-detected', step='start')
        namespace = {'__name__': '__main__'}
        source = PATH.read_text(); tail = source[source.index("if __name__ == '__main__':"):]
        errors = io.StringIO()
        with patch.object(sys, 'stderr', errors), self.assertRaises(SystemExit):
            exec(compile(tail.replace("main()", "(_ for _ in ()).throw(operator.Refused('credentials-ambiguous'))", 1), 'tail', 'exec'), {**vars(operator), 'operator': operator, '__name__': '__main__'})
        first = json.loads(errors.getvalue().splitlines()[0])
        self.assertEqual(first, {'recoveryPhase': 'commit-attempted', 'action': 'refused', 'check': 'credentials-ambiguous'})

    def test_publish_writes_fresh_receipts_from_the_bundle_copy_of_the_previous_profile(self):
        ops = self.tmp/'publish-ops'; ops.mkdir(); (ops/'owned-runtime.env').write_bytes(b'MUTATED=1\n')
        files = {}
        class M(Sim):
            OPS = ops
            def durable_file(self, path, raw, replace=False): files[path.name] = raw; path.write_bytes(raw)
        m = M(ops, self.old_id, self.previous, 'login')
        policy = {'PROOF_FILES': {'freeze': 'freeze-receipt.json', 'snapshot': 'snapshot-receipt.json', 'controls': 'controls-receipt.json', 'maintenance': 'maintenance-receipt.json'},
            'secure_read': lambda path, maximum=65536: path.read_bytes(), 'profiles': lambda root: (None, None, 'p'*64), 'execute': lambda action: None}
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        old = {'Id': self.old_id, 'Image': 'sha256:'+'b'*64}
        (self.bundle/'maintenance-commit-acknowledged.json').write_bytes(Sim.encoded({'acknowledged': True}))
        frozen = {'identityDigests': {'t': '1'*64}, 'x': 1}
        REAL_PUBLISH(m, policy, self.bundle, old, 'sha256:'+'a'*64, 'c'*40, b'{"r":1}', b'PRIOR-PROFILE\n', b'{"a":1}', b'BASE=1\n', frozen, now, now+dt.timedelta(minutes=15),
            dict(self.pending), dict(self.pending_reader), '8'*64)
        receipt = json.loads(files['cutover-receipt.json']); facts = json.loads(files['maintenance-receipt.json'])['facts']
        self.assertEqual(facts['previousProfileSha256'], hashlib.sha256(b'PRIOR-PROFILE\n').hexdigest())
        self.assertEqual(files['maintenance-prior-profile.env'], b'PRIOR-PROFILE\n')
        self.assertEqual(receipt['version'], 2); self.assertEqual(receipt['oldContainerId'], self.old_id)
        window = lambda doc: (dt.datetime.fromisoformat(doc['expiresAt'].replace('Z', '+00:00')) - dt.datetime.fromisoformat(doc['createdAt'].replace('Z', '+00:00')))
        self.assertLessEqual(window(receipt), dt.timedelta(minutes=15)); self.assertGreater(window(receipt), dt.timedelta(0))
        self.assertEqual(json.loads(files['freeze-receipt.json'])['createdAt'], now.strftime('%Y-%m-%dT%H:%M:%SZ'))
        self.assertIn(hashlib.sha256(files['cutover-receipt.json']).hexdigest().encode(), files['owned-runtime.env'])

    def test_deploy_script_recovers_only_without_a_running_runtime_and_names_the_failed_step(self):
        stage = TEXT[TEXT.index('prepare_owned_maintenance_pipeline() {'):TEXT.index('# END XMAIL OWNED POLICY')]
        self.assertIn("'identity' if ids else 'recover'", stage); self.assertIn('--recover-interrupted --parent-lock', stage)
        self.assertNotIn('details suppressed', stage); self.assertIn("step+'; values suppressed.'", stage)
        self.assertLess(stage.index('flock -n 9'), stage.index('--recover-interrupted'))
        self.assertIn('[ "$status" -eq 10 ]', stage)
        self.assertIn('OWNED_MODE" = recovered', TEXT); self.assertIn('exit 0', TEXT[TEXT.index('OWNED_MODE" = recovered'):][:200])
        for step in ['ops-directory', 'profile-file', 'source-sha', 'bundle-checksum', 'bundle-extract', 'deploy-code-hash', 'running-container', 'candidate-image']:
            self.assertIn("step='"+step+"'", stage)
        # The pinned five-file bundle is unchanged: recovery lives inside the existing maintenance operator.
        self.assertEqual(stage.count('prepare-xmail-owned-runtime-maintenance.py'), 3)

if __name__=='__main__':unittest.main()
