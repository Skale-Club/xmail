"""Offline policy/transport tests only; no dotenv, Docker or network."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

PATH = Path(__file__).with_name('prepare-xmail-owned-pilot-rollout.py')
spec = importlib.util.spec_from_file_location('owned_pilot_operator',PATH)
operator = importlib.util.module_from_spec(spec);spec.loader.exec_module(operator)


class OwnedPilotPolicy(unittest.TestCase):
    def setUp(self):
        self.lib = operator.library()
        self.uid = '11111111-1111-4111-8111-111111111111'
        self.now = dt.datetime.now(dt.timezone.utc)
        self.review = {'origin':'https://zzbudkfkcmqkavgwselc.supabase.co','capturedAt':self.now.isoformat(),
            'users':[{'id':self.uid,'disabled':False}]}

    def test_default_plan_does_not_even_load_library_or_open_a_process(self):
        with patch('sys.argv',[str(PATH)]),patch.object(operator,'library',side_effect=AssertionError('No I/O')),contextlib.redirect_stdout(io.StringIO()) as out:
            operator.main()
        self.assertIn('PLAN ONLY',out.getvalue())

    def test_preserves_schema_and_grant_guards_but_allows_existing_bindings(self):
        before = operator.owned_guard_sql(self.lib)
        fenced = operator.owned_guard_sql(self.lib,True)
        self.assertNotIn('OR EXISTS(SELECT FROM public.xmail_identity_bindings)',before)
        self.assertIn('AND rolcanlogin',before);self.assertIn('AND NOT rolcanlogin',fenced)
        for guard in ["<>74","<>'080'",'rolconnlimit=CASE',"has_sequence_privilege",'has_function_privilege','NOT g.tgisinternal']:
            self.assertIn(guard,before);self.assertIn(guard,fenced)
        self.assertIn("AND usename<>'xmail_runtime'",before)
        self.assertNotIn("AND usename<>'xmail_runtime'",fenced)

    def test_auth_review_requires_every_owned_uuid_and_a_fresh_exact_source(self):
        operator.validate_review(self.review,[self.uid],self.now)
        for changed in [{'users':[]},{'users':self.review['users']*2},{'origin':'https://other.invalid'},
            {'capturedAt':(self.now-dt.timedelta(seconds=61)).isoformat()},
            {'users':[{'id':self.uid,'disabled':0}]}]:
            with self.assertRaises(ValueError):operator.validate_review({**self.review,**changed},[self.uid],self.now)

    def test_controls_never_import_business_data_or_loosen_active_existing_cutoffs(self):
        with patch.object(self.lib,'postgres_scram',return_value='synthetic-scram'):
            sql = operator.controls_sql(self.lib,self.review,{'ids':[self.uid]},'memory-one','memory-two',(self.now+dt.timedelta(minutes=15)).isoformat())
        self.assertLess(sql.index('LOCK TABLE'),sql.index('INSERT INTO'))
        self.assertIn('ON CONFLICT(user_id) DO NOTHING',sql)
        self.assertIn('WHERE c.user_id=e.id AND e.disabled AND c.disabled_at IS NULL',sql)
        self.assertIn('greatest(c.sessions_valid_after',sql)
        for forbidden in ['DROP SCHEMA','DROP TABLE public.','TRUNCATE ','COPY ','UPDATE public.users','UPDATE public.organization_users','CREATE ROLE','GRANT ','DISABLE TRIGGER']:
            self.assertNotIn(forbidden,sql)
        self.assertTrue(sql.endswith('COMMIT;\n\\echo OWNED_CONTROLS_COMMITTED\n'))

    def auth_fixture(self,changes=None,wrong_id=False):
        key = '.'.join(['offline',__import__('base64').urlsafe_b64encode(json.dumps({'ref':'zzbudkfkcmqkavgwselc','role':'service_role'}).encode()).decode().rstrip('='),'signature'])
        data = {'origin':'https://zzbudkfkcmqkavgwselc.supabase.co','key':key,'ids':[self.uid],**(changes or {})}
        fixture = "globalThis.fetch=async(url,init)=>{if(init.method!=='GET'||init.redirect!=='error'||url!=='https://zzbudkfkcmqkavgwselc.supabase.co/auth/v1/admin/users/11111111-1111-4111-8111-111111111111')throw Error('Wrong request scope');return new Response(JSON.stringify({id:'"+('22222222-2222-4222-8222-222222222222' if wrong_id else self.uid)+"',app_metadata:{xmail_disabled:true}}))};\n"
        return subprocess.run(['node','-e',fixture+operator.AUTH_REVIEW_JS],input=json.dumps(data).encode(),capture_output=True,timeout=3)

    def test_auth_transport_is_get_only_exact_owned_uid_and_emits_no_profile_or_key(self):
        result = self.auth_fixture()
        self.assertEqual(result.returncode,0)
        value = json.loads(result.stdout)
        self.assertEqual(value['users'],[{'id':self.uid,'disabled':True}])
        self.assertEqual(set(value),{'capturedAt','users','origin'})
        self.assertNotIn(b'signature',result.stdout)
        self.assertNotIn(b'app_metadata',result.stdout)

    def test_wrong_auth_uid_or_origin_never_admits_an_account(self):
        self.assertNotEqual(self.auth_fixture(wrong_id=True).returncode,0)
        self.assertNotEqual(self.auth_fixture({'origin':'https://other.invalid'}).returncode,0)

    def test_supported_opaque_admin_key_still_requires_exact_online_uuid_and_rejects_public_keys(self):
        suffix=__import__('uuid').uuid4().hex
        opaque='sb_secret_'+suffix
        self.assertEqual(self.auth_fixture({'key':opaque}).returncode,0)
        self.assertNotEqual(self.auth_fixture({'key':opaque},wrong_id=True).returncode,0)
        self.assertNotEqual(self.auth_fixture({'key':'sb_publishable_'+suffix}).returncode,0)

    def test_readback_rejects_ban_removal_cutoff_reset_or_missing_owned_uuid(self):
        prior = {'user_id':self.uid,'disabled_at':None,'sessions_valid_after':'2099-01-01T00:00:00+00:00','review_source':'local-review','reviewed_at':self.now.isoformat()}
        before = {'ids':[self.uid],'controls':[prior]}
        operator.verify_controls(before,before,self.review)
        for changed in [{'sessions_valid_after':self.now.isoformat()},{'disabled_at':self.now.isoformat()},{'review_source':'overwritten'}]:
            with self.assertRaises(ValueError):operator.verify_controls(before,{'ids':[self.uid],'controls':[{**prior,**changed}]},self.review)
        with self.assertRaises(ValueError):operator.verify_controls(before,{'ids':[self.uid],'controls':[]},self.review)

    def test_old_credential_rejection_is_not_fabricated_from_network_or_other_database_errors(self):
        for code,expected in [('28P01',{'allowed':False,'passwordRejected':True}),('08006',{'allowed':False,'passwordRejected':False}),
            (None,{'allowed':True,'passwordRejected':False})]:
            stub="const Module=require('node:module'),original=Module._load;Module._load=function(name,...args){if(name!=='postgres')return original.call(this,name,...args);return()=>{const sql=async()=>{"
            stub+=("throw Object.assign(Error('fixture'),{code:"+json.dumps(code)+"})" if code else "return[{role:'xmail_runtime',db:'xmail'}]")
            stub+="};sql.end=async()=>{};return sql}};\n"
            url='postgres://xmail_runtime:'+__import__('uuid').uuid4().hex+'@e12scyfsrp822dag7m9wwd4x:5432/xmail'
            r=subprocess.run(['node','-e',stub+operator.AUTH_PROBE_JS],input=json.dumps({'url':url}).encode(),capture_output=True,timeout=3)
            self.assertEqual(r.returncode,0)
            self.assertEqual(json.loads(r.stdout),expected)


if __name__=='__main__':unittest.main()
