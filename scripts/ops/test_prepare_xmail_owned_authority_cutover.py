"""Offline acceptance and real transport seam tests; never uses dotenv or Docker."""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

PATH=Path(__file__).with_name('prepare-xmail-owned-authority-cutover.py')
spec=importlib.util.spec_from_file_location('owned_authority_operator',PATH)
operator=importlib.util.module_from_spec(spec);spec.loader.exec_module(operator)


class AuthorityAcceptance(unittest.TestCase):
    def setUp(self):
        self.now=dt.datetime.now(dt.timezone.utc)
        self.row={'adminUserId':'11111111-1111-4111-8111-111111111111',
            'bindingId':'22222222-2222-4222-8222-222222222222','sessionHash':'a'*64,
            'legacyAnchorBindingId':'33333333-3333-4333-8333-333333333333','legacyAnchorSessionHash':'b'*64,
            'subject':'offline-phone','anchorSubject':'offline-google',
            'authenticatedAt':int(self.now.timestamp())-10,'anchorAuthenticatedAt':int(self.now.timestamp())-30,
            'sessionCreatedAt':(self.now-dt.timedelta(seconds=9)).isoformat()}

    def test_default_plan_cannot_load_libraries_or_spawn_processes(self):
        with patch('sys.argv',[str(PATH)]),patch.object(operator,'libraries',side_effect=AssertionError('No I/O')),patch.object(operator,'run',side_effect=AssertionError('No I/O')),contextlib.redirect_stdout(io.StringIO()) as out:
            operator.main()
        self.assertIn('PLAN ONLY',out.getvalue())

    def test_reuses_exact_reviewed_primitives_without_altering_pilot(self):
        pilot,lib=operator.libraries()
        self.assertEqual(lib.TARGET,'e12scyfsrp822dag7m9wwd4x')
        self.assertEqual(pilot.LIBRARY_SHA,operator.libraries()[0].LIBRARY_SHA)

    def test_selects_only_a_real_unambiguous_distinct_subject_chain(self):
        self.assertEqual(operator.select_acceptance([self.row],self.now),self.row)
        for values in [[],[self.row]*101,[self.row,self.row],
            [{**self.row,'subject':self.row['anchorSubject']}],
            [{**self.row,'bindingId':self.row['legacyAnchorBindingId']}],
            [{**self.row,'sessionHash':self.row['legacyAnchorSessionHash']}],
            [{**self.row,'authenticatedAt':0}],
            [{**self.row,'authenticatedAt':int(self.now.timestamp())+1}],
            [{**self.row,'sessionCreatedAt':(self.now+dt.timedelta(seconds=1)).isoformat()}],
            [{**self.row,'authenticatedAt':True}],
            [{**self.row,'sessionHash':"'; SELECT 1; --"}],
            [{**self.row,'anchorAuthenticatedAt':int(self.now.timestamp())+1}],
            [self.row,{**self.row,'adminUserId':'44444444-4444-4444-8444-444444444444'}],
            [{**self.row,'pretendFactorConfirmed':True}]]:
            with self.subTest(values=len(values)),self.assertRaises(ValueError):operator.select_acceptance(values,self.now)

    def test_publication_reuses_original_active_session_without_changing_its_auth_time(self):
        older={**self.row,'authenticatedAt':int(self.now.timestamp())-7200,'anchorAuthenticatedAt':int(self.now.timestamp())-86400,
            'sessionCreatedAt':(self.now-dt.timedelta(seconds=7199)).isoformat()}
        self.assertEqual(operator.select_acceptance([older],self.now),older)
        self.assertEqual(older['authenticatedAt'],int(self.now.timestamp())-7200)

    def test_historical_ancestor_does_not_expire_again_after_its_original_binding(self):
        value={**self.row,'anchorAuthenticatedAt':int(self.now.timestamp())-86400}
        self.assertEqual(operator.select_acceptance([value],self.now),value)
        # The SQL consumer verifies its original 300s window and current cutoff;
        # the provider callback still verifies current disabled/validSince state.
        denied=lambda _value:(_ for _ in ()).throw(ValueError('revoked'))
        with self.assertRaises(ValueError):operator.verified_acceptance([value],denied,lambda _:None,now=self.now)

    def test_rechecks_same_original_session_and_both_live_guards_after_slow_work(self):
        checks={'currentProviderActive':True,'anchorProviderActive':True,'distinctGoogleAndPhone':True}
        local=[];providers=[]
        def provider(row):providers.append(row);return checks
        entry,facts=operator.verified_acceptance([self.row],local.append,provider,now=self.now)
        later=self.now+dt.timedelta(seconds=100)
        result,_=operator.verified_acceptance([self.row],local.append,provider,expected=entry,now=later)
        self.assertEqual(result,entry);self.assertEqual(len(local),2);self.assertEqual(len(providers),2)
        for key,value in [('sessionHash','c'*64),('subject','other-subject'),('authenticatedAt',self.row['authenticatedAt']-1)]:
            with self.assertRaises(ValueError):operator.verified_acceptance([{**self.row,key:value}],local.append,provider,expected=entry,now=later)
        with self.assertRaises(ValueError):operator.verified_acceptance([self.row],local.append,lambda _: {**checks,'anchorProviderActive':False},expected=entry,now=later)
        denied=lambda _:(_ for _ in ()).throw(ValueError('Original session revoked or expired'))
        with self.assertRaises(ValueError):operator.verified_acceptance([self.row],denied,provider,expected=entry,now=later)

    def test_receipt_facts_are_only_selected_exact_values_and_checks(self):
        facts=operator.acceptance_facts(self.row)
        self.assertEqual(set(facts),set(operator.FACT_KEYS+operator.CHECK_KEYS))
        self.assertEqual(facts['sessionHash'],self.row['sessionHash'])
        self.assertNotIn('subject',facts)

    def provider(self,change=None,status=200):
        now=int(self.now.timestamp())
        accounts={self.row['subject']:{'localId':self.row['subject'],'phoneNumber':'+12025550123','providerUserInfo':[{'providerId':'phone'}]},
            self.row['anchorSubject']:{'localId':self.row['anchorSubject'],'providerUserInfo':[{'providerId':'google.com'}]}}
        if change:change(accounts)
        fixture=r'''
const Module=require('node:module'),original=Module._load;
Module._load=function(name,...rest){
 if(name.endsWith('/config.js'))return {resolveIdentityConfig:()=>({projectId:'skaleclub',projectNumber:'937861185231',origin:'https://mail.skale.club',adcMode:'external_account'})};
 if(name.endsWith('/runtime.js'))return {createKeylessAccessTokenSupplier:async()=>async()=> 'offline-ephemeral-credential'};
 return original.call(this,name,...rest);
};
globalThis.fetch=async(url,init)=>{
 if(url!=='https://identitytoolkit.googleapis.com/v1/projects/skaleclub/accounts:lookup'||init.method!=='POST'||init.redirect!=='error'||init.headers.Authorization!=='Bearer offline-ephemeral-credential'||!init.signal)throw Error('scope');
 const b=JSON.parse(init.body);if(Object.keys(b).join()!=='localId'||b.localId.length!==1||!Object.hasOwn(ACCOUNTS,b.localId[0]))throw Error('scope');
 return new Response(JSON.stringify({users:[ACCOUNTS[b.localId[0]]]}),{status:STATUS});
};
'''.replace('ACCOUNTS',json.dumps(accounts)).replace('STATUS',str(status))
        return subprocess.run(['node','-e',fixture+operator.PROVIDER_REVIEW_JS],
            input=json.dumps({**self.row,'env':{'XMAIL_GOOGLE_AUTH_ENABLED':'true'}}).encode(),capture_output=True,timeout=12)

    def test_provider_only_reads_exact_subjects_fixed_origin_and_outputs_booleans(self):
        result=self.provider();self.assertEqual(result.returncode,0,result.stderr.decode())
        self.assertEqual(json.loads(result.stdout),{'currentProviderActive':True,'anchorProviderActive':True,'distinctGoogleAndPhone':True})
        self.assertNotIn(b'offline-',result.stdout);self.assertEqual(result.stderr,b'')

    def test_historical_provider_still_requires_current_validsince_not_after_original_authentication(self):
        self.row['anchorAuthenticatedAt']=int(self.now.timestamp())-86400
        self.assertEqual(self.provider().returncode,0)
        result=self.provider(lambda a:a[self.row['anchorSubject']].update(validSince=str(int(self.now.timestamp())-3600)))
        self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,b'')

    def test_active_older_phone_session_still_requires_current_provider_validsince(self):
        self.row['authenticatedAt']=int(self.now.timestamp())-7200
        self.assertEqual(self.provider().returncode,0)
        result=self.provider(lambda a:a[self.row['subject']].update(validSince=str(int(self.now.timestamp())-3600)))
        self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,b'')

    def test_provider_refuses_disabled_revoked_wrong_uid_or_ambiguous_capabilities(self):
        changes=[lambda a:a[self.row['subject']].update(disabled=True),
            lambda a:a[self.row['anchorSubject']].update(disabled=True),
            lambda a:a[self.row['subject']].update(validSince=str(int(self.now.timestamp()))),
            lambda a:a[self.row['subject']].update(localId='wrong-subject'),
            lambda a:a[self.row['subject']].update(providerUserInfo=[{'providerId':'phone'},{'providerId':'google.com'}]),
            lambda a:a[self.row['subject']].pop('phoneNumber'),
            lambda a:a[self.row['anchorSubject']].update(phoneNumber='+12025550123')]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                result=self.provider(change);self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,b'');self.assertEqual(result.stderr,b'')
        self.assertNotEqual(self.provider(status=403).returncode,0)


if __name__=='__main__':unittest.main()
