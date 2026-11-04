"""Offline fixtures only: never connect to source/target or read repository .env."""
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock

SOURCE = Path(__file__).with_name("prepare-xmail-identity-controls.py")
spec = importlib.util.spec_from_file_location("controls_ops", SOURCE)
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
NOW = dt.datetime(2026, 11, 4, 4, 0, tzinfo=dt.timezone.utc)


def review():
    return {"version": 1, "app": "xmail", "sourceProjectRef": ops.SOURCE_PROJECT,
            "capturedAt": "2026-11-04T04:00:00.000Z", "usersDigest": "a" * 64,
            "membershipsDigest": "b" * 64, "readOnlySnapshot": True,
            "users": [{"id": "11111111-1111-4111-8111-111111111111", "disabled": False},
                      {"id": "22222222-2222-4222-8222-222222222222", "disabled": True}]}


class ControlPolicyTests(unittest.TestCase):
    def test_default_plan_never_reads_files_runtime_or_environment(self):
        with mock.patch.object(ops, "run", side_effect=AssertionError("Offline")), \
                mock.patch.object(Path, "open", side_effect=AssertionError("No file reads")), \
                mock.patch.object(ops.subprocess, "run", side_effect=AssertionError("No subprocess")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(ops.main([]), 0)
        plan = json.loads(output.getvalue())
        self.assertTrue(plan["planOnly"])
        self.assertFalse(plan["inputRead"])
        self.assertFalse(plan["loginEnabled"])

    def test_accepts_complete_uuid_status_review_without_contacts_or_bindings(self):
        value = review()
        self.assertEqual(ops.validate_review(value, NOW), value)
        self.assertEqual(sum(row["disabled"] for row in value["users"]), 1)

    def test_rejects_wrong_project_app_schema_or_unproven_snapshot(self):
        for key, bad in (("sourceProjectRef", "otherproject0000000000"), ("app", "xmartmenu"),
                         ("version", True), ("readOnlySnapshot", False), ("usersDigest", None)):
            value = {**review(), key: bad}
            with self.subTest(key=key), self.assertRaises(ValueError):
                ops.validate_review(value, NOW)

    def test_rejects_stale_future_and_noncanonical_timestamps(self):
        for timestamp in ("2026-11-04T03:29:59.000Z", "2026-11-04T04:00:06.000Z",
                          "2026-11-04T04:00:00.500Z", "infinity", "2026-11-04"):
            with self.subTest(timestamp=timestamp), self.assertRaises(ValueError):
                ops.validate_review({**review(), "capturedAt": timestamp}, NOW)

    def test_rejects_contacts_roles_tokens_and_unknown_review_fields(self):
        for key in ("email", "phone", "providerSubject", "role", "password_hash", "accessToken"):
            value = review()
            value["users"][0][key] = "fixture-not-a-credential"
            with self.subTest(key=key), self.assertRaises(ValueError):
                ops.validate_review(value, NOW)
        with self.assertRaises(ValueError):
            ops.validate_review({**review(), "createBindings": True}, NOW)

    def test_rejects_duplicate_invalid_missing_uuid_and_ambiguous_disable_state(self):
        variants = [[], [review()["users"][0]] * 2,
                    [{"id": "another-user@example.invalid", "disabled": False}],
                    [{"id": review()["users"][0]["id"], "disabled": "false"}],
                    [{"id": review()["users"][0]["id"], "disabled": None}]]
        for users in variants:
            with self.subTest(users=users), self.assertRaises(ValueError):
                ops.validate_review({**review(), "users": users}, NOW)

    def test_sql_transport_is_one_transaction_and_never_uses_argv_values(self):
        with mock.patch.object(ops, "validate_review", side_effect=lambda value: value):
            text = ops.import_sql(review(), "-- approved fixed SQL").decode()
        self.assertTrue(text.startswith("BEGIN; DO $review$"))
        self.assertIn("PERFORM set_config('xmail.identity_status_review'", text)
        self.assertNotIn("SELECT set_config", text)
        self.assertTrue(text.endswith("COMMIT;\n"))
        # The function cannot transport a quoting payload past validation.
        bad = review()
        bad["capturedAt"] = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        bad["users"][0]["id"] = "'; DROP TABLE users; --"
        with self.assertRaises(ValueError):
            ops.import_sql(bad, "-- approved fixed SQL")

    def test_readback_is_separate_read_only_transaction_without_private_projection(self):
        with mock.patch.object(ops, "validate_review", side_effect=lambda value: value):
            sql = ops.readback_sql(review()).decode()
        self.assertTrue(sql.startswith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"))
        self.assertTrue(sql.endswith("ROLLBACK;\n"))
        self.assertIn("'controlsMatch'", sql)
        self.assertIn("'userDigestMatched'", sql)
        self.assertNotIn("INSERT INTO", sql)

    def test_reviewed_sql_hash_matches_exact_bundled_file(self):
        data = SOURCE.with_name("xmail-identity-controls.sql").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), ops.SQL_SHA256)

    def test_source_program_parses_without_running_or_loading_env(self):
        result = subprocess.run(["node", "--check"], input=ops.SOURCE_PROGRAM.encode(), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0)

    def test_candidate_container_rejects_wrong_image_exposed_port_budget_or_mount(self):
        fixture = {"image": ops.PG_IMAGE, "running": True, "health": "healthy", "ports": None,
                   "memory": 536870912, "swap": 536870912, "cpu": 750000000,
                   "mounts": [{"Destination": "/var/lib/postgresql/data", "Type": "volume", "RW": True}]}
        for change in ({"image": ops.APP_IMAGE}, {"ports": {"5432/tcp": []}}, {"memory": 268435456},
                       {"swap": 1073741824}, {"cpu": 1000000000}, {"mounts": []}, {"health": "starting"}):
            with self.subTest(change=change), self.assertRaises(ValueError), \
                    mock.patch.object(ops, "check_directory", side_effect=AssertionError("Must reject before receipt")):
                ops.candidate_guard(lambda *_: json.dumps({**fixture, **change}).encode())

    def test_application_snapshot_is_exact_healthy_image(self):
        state = {"image": ops.APP_IMAGE, "running": True, "health": "healthy", "id": "fixture"}
        self.assertEqual(ops.app_snapshot(lambda *_: json.dumps(state).encode()), state)
        with self.assertRaises(ValueError):
            ops.app_snapshot(lambda *_: json.dumps({**state, "image": ops.PG_IMAGE}).encode())

    def test_subprocess_suppresses_diagnostics_and_bounds_output(self):
        with mock.patch.object(ops.subprocess, "run") as command:
            command.return_value.returncode = 0
            command.return_value.stdout = b"safe"
            self.assertEqual(ops.command(["fixed"], b"private-fixture", 3), b"safe")
            self.assertEqual(command.call_args.kwargs["input"], b"private-fixture")
            self.assertEqual(command.call_args.kwargs["stderr"], subprocess.DEVNULL)
            self.assertEqual(command.call_args.kwargs["timeout"], 3)
            command.return_value.returncode = 1
            with self.assertRaisesRegex(ValueError, "operation refused"):
                ops.command(["fixed"])

    def test_invalid_cli_never_echoes_supplied_value(self):
        with contextlib.redirect_stderr(io.StringIO()) as output, self.assertRaises(ValueError):
            ops.main(["--url", "fixture-private-value"])
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
