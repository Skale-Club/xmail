"""Offline tests only. Never reads dotenv or invokes Docker/network/production SQL."""
import argparse
import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

PATH = Path(__file__).with_name('prepare-xmail-final-data-cutover.py')
spec = importlib.util.spec_from_file_location('final_data_operator', PATH)
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


class FinalDataPolicy(unittest.TestCase):
    def setUp(self):
        self.tables = ['users', 'organization_users']+['business_'+str(i).zfill(3) for i in range(68)]
        self.fks = [{'table': 'organization_users', 'tableSchema': 'public', 'name': 'membership_user',
            'definition': 'FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED',
            'validated': True, 'deferrable': True, 'deferred': True, 'referenceSchema': 'public'}]
        self.controls = [{'id': '11111111-1111-4111-8111-111111111111', 'present': True, 'valid': True, 'disabled': False}]
        self.copy = 'COPY public.users (id) FROM stdin;\n11111111-1111-4111-8111-111111111111\n\\.\n'
        self.cutoff = '2026-11-04T00:00:00Z'

    def plan(self, **changes):
        values = {'tables': self.tables, 'fks': self.fks, 'copy_sql': self.copy,
            'controls': self.controls, 'cutoff': self.cutoff}
        return operator.refresh_sql(**{**values, **changes})

    def test_default_plan_performs_no_process_file_or_network_operation(self):
        with (patch('sys.argv', [str(PATH)]), patch.object(operator, 'call', side_effect=AssertionError('Forbidden process')),
                patch.object(operator, 'apply', side_effect=AssertionError('Forbidden apply'))):
            with contextlib.redirect_stdout(io.StringIO()) as output: operator.main()
        self.assertIn('PLAN ONLY', output.getvalue())

    def test_transaction_locks_and_guards_precede_all_mutation_and_never_drop_schema_or_ledger(self):
        script = self.plan(expected_schema={'tables': {t: 'a'*64 for t in self.tables}})
        self.assertLess(script.index('LOCK TABLE'), script.index('Final data target/control authority refused'))
        self.assertLess(script.index('Business schema changed before refresh'), script.index('DROP CONSTRAINT'))
        for forbidden in ['DROP SCHEMA', 'DROP TABLE', 'TRUNCATE public.', ' CASCADE', 'COMMIT;', 'ALTER ROLE']:
            self.assertNotIn(forbidden, script)
        self.assertEqual(script.count('BEGIN; SET LOCAL'), 1)
        self.assertIn('REFRESH_READY', script)

    def test_exact_fk_definitions_and_modes_are_recreated_and_validated(self):
        script = self.plan()
        self.assertIn('ADD CONSTRAINT "membership_user" '+self.fks[0]['definition']+' NOT VALID;', script)
        self.assertIn('VALIDATE CONSTRAINT "membership_user";', script)
        for key, value in [('validated', False), ('referenceSchema', 'auth'), ('tableSchema', 'outside')]:
            with self.subTest(key=key):
                fk = {**self.fks[0], key: value}
                with self.assertRaises(ValueError): self.plan(fks=[fk])

    def test_copy_payload_remains_opaque_even_when_customer_text_mentions_sql(self):
        payload = self.copy+'-- customer data could contain CREATE TABLE or setval( text\n'
        self.assertIn(payload, self.plan(copy_sql=payload))
        self.assertLess(self.plan().index('DISABLE TRIGGER USER'), self.plan().index('TRUNCATE TABLE'))
        self.assertIn('SET LOCAL search_path=public,pg_catalog;', self.plan())

    def test_trigger_modes_are_restored_exactly_without_business_side_effects(self):
        triggers = [{'table': 'business_000', 'name': 'trigger_'+mode, 'mode': mode} for mode in ['O', 'D', 'R', 'A']]
        script = self.plan(triggers=triggers)
        for command in ['ENABLE TRIGGER "trigger_O"', 'DISABLE TRIGGER "trigger_D"',
                'ENABLE REPLICA TRIGGER "trigger_R"', 'ENABLE ALWAYS TRIGGER "trigger_A"']:
            self.assertIn(command, script)
        self.assertLess(script.index(self.copy), script.index('ENABLE ALWAYS TRIGGER'))

    def test_controls_preserve_existing_bans_and_future_cutoffs_and_refuse_incomplete_auth_proof(self):
        script = self.plan()
        self.assertIn('v.disabled OR p.disabled_at IS NOT NULL', script)
        self.assertIn("greatest(coalesce(p.sessions_valid_after,'epoch')", script)
        for change in [{'present': False}, {'valid': False}, {'disabled': 1}, {'id': 'not-a-uuid'}]:
            with self.assertRaises(ValueError): self.plan(controls=[{**self.controls[0], **change}])
        with self.assertRaises(ValueError): self.plan(controls=self.controls*2)

    def test_sequence_restart_preserves_next_value_and_never_uses_nontransactional_setval(self):
        sequence = {'name': 'fixture_seq', 'last': '10', 'increment': '3', 'minimum': '1', 'maximum': '100', 'called': True, 'cycle': False}
        self.assertEqual(operator.next_sequence_value(sequence), 13)
        script = self.plan(sequences=[sequence])
        self.assertIn('ALTER SEQUENCE public."fixture_seq" RESTART WITH 13;', script)
        self.assertNotIn('setval(', script)
        self.assertEqual(operator.next_sequence_value({**sequence, 'called': False}), 10)
        with self.assertRaises(ValueError): operator.next_sequence_value({**sequence, 'last': '100'})
        self.assertEqual(operator.next_sequence_value({**sequence, 'last': '100', 'cycle': True}), 1)

    def test_source_queries_cover_all_seventy_fingerprints_and_never_export_row_content(self):
        sql = operator.fingerprints_sql()
        self.assertIn('sha256(convert_to(to_jsonb(t)::text', sql)
        self.assertIn("'sha256'", sql)
        for table in operator.IDENTITY: self.assertIn("'"+table+"'", sql)
        self.assertNotIn('jsonb_agg(to_jsonb(t))', sql)

    def test_public_protocol_mismatch_refuses_without_exec_or_docker(self):
        with patch.object(operator, 'call', side_effect=AssertionError('Forbidden process')):
            with self.assertRaises(ValueError): operator.load_public_sources(PATH.parent, '0'*64)

    def test_exact_reviewed_public_policy_and_v2_protocol_load_without_any_process_or_env_access(self):
        deploy = PATH.parents[2]/'.github/scripts/deploy-xmail.sh'
        digest = operator.sha(deploy.read_bytes().replace(b'\r\n', b'\n'))
        with patch.object(operator, 'call', side_effect=AssertionError('Forbidden process')):
            policy, programs = operator.load_public_sources(PATH.parent, digest)
        self.assertEqual(policy['TARGET'], operator.TARGET)
        self.assertEqual(set(programs), {'ca_program', 'holder_program'})
        self.assertIn('repeatable read read only', programs['holder_program'])


if __name__ == '__main__': unittest.main()
