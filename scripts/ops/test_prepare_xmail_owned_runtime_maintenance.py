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


if __name__=='__main__':unittest.main()
