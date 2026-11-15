import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

MODULES = Path(__file__).resolve().parents[2] / "deploy" / "site-work"
sys.path.insert(0, str(MODULES))
import source
import poll


@unittest.skipUnless(os.name == "posix", "Linux source ownership and kernel lock evidence")
class MultiSiteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.flags = self.root / "announcements"
        self.flags.mkdir(mode=0o700)
        self.native_root = self.root / "native"
        self.native_root.mkdir(mode=0o700)
        self.adapters = source.sibling("adapters")
        self.control = source.sibling("control")
        self.now = time.time_ns() // 1000000
        self.config = {"version": 1, "announcements": str(self.flags), "profiles": [
            {"id": "demo-shop", "adapter": "manual", "minutes": 30},
            {"id": "demo-family", "adapter": "manual", "minutes": 30},
            {"id": "demo-catalog", "adapter": "directory", "minutes": 30, "path": str(self.native_root / "pending")},
            {"id": "demo-portal", "adapter": "lock", "minutes": 30, "path": str(self.native_root / "activation.lock"), "dedicatedUpdate": True},
        ]}
        self.config_path = self.root / "sources.json"
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(0o600)
        self.bindings = [{"origin": "local", "sourceID": name, "monitorID": monitor_id, "ownerID": 1, "siteHost": host}
                         for monitor_id, name, host in [(4, "demo-shop", "demo-shop.test"), (12, "demo-shop", "demo-shop.test"), (6, "demo-catalog", "demo-catalog.test"), (8, "demo-portal", "demo-portal.test")]]
        self.bindings += [{"origin": "remote", "sourceID": "compliance", "monitorID": 9, "ownerID": 1, "siteHost": "demo-backend.test"},
                          {"origin": "remote", "sourceID": "demo-family", "monitorID": 10, "ownerID": 1, "siteHost": "demo-family.test"}]
        self.remote = {"host": "192.0.2.1", "hostKeyFile": str(self.root / "known_hosts"), "keyFile": str(self.root / "key"), "user": "kuma-site-peer"}
        for key in ["hostKeyFile", "keyFile"]:
            Path(self.remote[key]).touch(mode=0o600)
        self.poll_config = {"version": 2, "localConfig": str(self.config_path), "remote": self.remote, "bindings": self.bindings, "output": str(self.root / "result.json")}

    def collect(self, now=None):
        return self.adapters.collect_many(self.config, self.now if now is None else now, source.collect)

    def remote_value(self, sources=None):
        return {"version": 1, "sources": sources or {"compliance": {"state": "idle", "observedAt": self.now}, "demo-family": {"state": "idle", "observedAt": self.now}}}

    def poll(self, value=None, error=None):
        options = {"side_effect": error} if error else {"return_value": types.SimpleNamespace(stdout=json.dumps(value if value is not None else self.remote_value()).encode())}
        with patch.object(poll.subprocess, "run", **options):
            return poll.poll_many(self.poll_config, self.now)

    def test_all_bindings_are_fresh_idle_without_declared_work(self):
        result = self.poll()
        self.assertEqual(len(result["records"]), 6)
        self.assertTrue(all(record["state"] == "idle" for record in result["records"]))
        self.assertEqual({record["monitorID"] for record in result["records"]}, {4, 6, 8, 9, 10, 12})

    def test_declared_site_only_affects_its_two_intentionally_shared_checks(self):
        begun = self.control.begin(self.config, "demo-shop", "update", 30, self.now)
        records = self.poll()["records"]
        active = [record for record in records if record["state"] == "active"]
        self.assertEqual({record["monitorID"] for record in active}, {4, 12})
        self.assertTrue(all(record["work"]["runID"] == begun["work"]["runID"] for record in active))
        self.assertTrue(all(record["ownerID"] == 1 and record["host"] == "demo-shop.test" for record in active))

    def test_polling_and_phase_changes_never_extend_the_original_deadline(self):
        begun = self.control.begin(self.config, "demo-family", "update", 30, self.now)
        changed = self.control.change(self.config, "demo-family", begun["work"]["runID"], self.now + 10000, phase="verifying")
        self.assertEqual(begun["work"]["deadline"], changed["work"]["deadline"])
        late = self.collect(self.now + 7200000)["sources"]["demo-family"]["work"]
        self.assertEqual(late["deadline"], begun["work"]["deadline"])
        with self.assertRaises(ValueError): self.control.begin(self.config, "demo-family", "update", 30, self.now + 7200000)

    def test_finish_requires_the_same_source_and_window_then_keeps_history(self):
        begun = self.control.begin(self.config, "demo-family", "update", 30, self.now)
        with self.assertRaises(ValueError): self.control.change(self.config, "demo-family", "f" * 64, self.now, finish=True)
        self.assertEqual(self.collect()["sources"]["demo-family"]["state"], "active")
        self.control.change(self.config, "demo-family", begun["work"]["runID"], self.now + 1000, finish=True, result=1)
        self.assertEqual(self.collect()["sources"]["demo-family"]["state"], "idle")
        saved = json.loads(next((self.flags / "history").iterdir()).read_text())
        self.assertEqual(saved["result"], 1)
        self.assertEqual(saved["work"]["runID"], begun["work"]["runID"])

    def test_unknown_source_or_excessive_window_cannot_create_maintenance(self):
        for name, minutes in [("other", 30), ("demo-shop", 31), ("demo-shop", 0), ("demo-shop", True)]:
            with self.assertRaises(ValueError): self.control.begin(self.config, name, "update", minutes, self.now)
        self.assertEqual(list(self.flags.iterdir()), [])

    def test_corrupt_or_linked_declaration_fails_only_that_source(self):
        self.control.begin(self.config, "demo-family", "update", 30, self.now)
        bad = self.flags / "demo-shop.json"
        bad.write_text('{"broken":true}')
        bad.chmod(0o600)
        sources = self.collect()["sources"]
        self.assertEqual(sources["demo-shop"]["state"], "unavailable")
        self.assertEqual(sources["demo-family"]["state"], "active")
        bad.unlink()
        bad.symlink_to(self.flags / "demo-family.json")
        self.assertEqual(self.collect()["sources"]["demo-shop"]["state"], "unavailable")

    def test_explicit_native_transaction_directory_and_its_removal(self):
        pending = self.native_root / "pending"
        pending.mkdir(mode=0o700)
        value = self.collect(self.now + 1000)["sources"]["demo-catalog"]
        self.assertEqual(value["state"], "active")
        self.assertEqual(value["work"]["kind"], "update")
        pending.rmdir()
        self.assertEqual(self.collect()["sources"]["demo-catalog"]["state"], "idle")

    def test_non_object_declaration_cannot_interrupt_other_sources(self):
        self.control.begin(self.config, "demo-family", "update", 30, self.now)
        bad = self.flags / "demo-shop.json"
        for value in [[], None, "invalid", 42]:
            bad.write_text(json.dumps(value))
            bad.chmod(0o600)
            sources = self.collect()["sources"]
            self.assertEqual(sources["demo-shop"]["state"], "unavailable")
            self.assertEqual(sources["demo-family"]["state"], "active")
            self.assertEqual(sources["demo-portal"]["state"], "idle")

    def test_a_lock_file_alone_is_not_planned_work_and_reading_never_acquires_it(self):
        lock = self.native_root / "activation.lock"
        descriptor = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            self.assertEqual(self.collect()["sources"]["demo-portal"]["state"], "idle")
            # Real shell deployers use a short-lived flock child. Its inherited
            # lock must still be associated with the live root parent.
            subprocess.run(["flock", "-n", str(descriptor)], pass_fds=(descriptor,), check=True)
            result = self.adapters.held_lock(lock)
            self.assertIsNotNone(result)
            self.assertEqual(result["command"][0], Path("/proc/self/cmdline").read_bytes().split(b"\x00")[0])
            self.assertEqual(self.collect(time.time_ns() // 1000000)["sources"]["demo-portal"]["state"], "active")
        finally:
            os.close(descriptor)
        self.assertEqual(self.collect()["sources"]["demo-portal"]["state"], "idle")

    def test_remote_outage_or_bad_json_preserves_local_evidence(self):
        self.control.begin(self.config, "demo-shop", "update", 30, self.now)
        for value, error in [(None, subprocess.TimeoutExpired("owned-source", 9)), ([], None), ({"version": 1, "sources": {}}, None)]:
            result = self.poll(value, error)
            self.assertEqual([record for record in result["records"] if record["monitorID"] == 4][0]["state"], "active")
            self.assertTrue(all(record["state"] == "unavailable" for record in result["records"] if record["monitorID"] in {9, 10}))

    def test_local_failure_does_not_invalidate_remote_source(self):
        self.config_path.chmod(0o666)
        records = self.poll()["records"]
        self.assertTrue(all(record["state"] == "idle" for record in records if record["monitorID"] in {9, 10}))
        self.assertTrue(all(record["state"] == "unavailable" for record in records if record["monitorID"] not in {9, 10}))

    def test_remote_cannot_choose_check_owner_or_hostname(self):
        forged = {"state": "idle", "observedAt": self.now, "monitorID": 4, "ownerID": 77, "host": "attacker.test"}
        records = self.poll(self.remote_value({"compliance": forged, "demo-family": forged}))["records"]
        remote = [row for row in records if row["monitorID"] in {9, 10}]
        self.assertTrue(all(row["ownerID"] == 1 and row["host"] in {"demo-backend.test", "demo-family.test"} for row in remote))

    def test_stale_or_future_remote_evidence_does_not_suppress_local_monitoring(self):
        for timestamp in [self.now - 45001, self.now + 5001, "now"]:
            records = self.poll(self.remote_value({"compliance": {"state": "active", "observedAt": timestamp}}))["records"]
            self.assertEqual(next(row for row in records if row["monitorID"] == 9)["state"], "unavailable")
            self.assertEqual(next(row for row in records if row["monitorID"] == 6)["state"], "idle")

    def test_duplicate_binding_is_rejected_before_fetching_any_source(self):
        self.poll_config["bindings"].append(dict(self.bindings[0]))
        with patch.object(poll.subprocess, "run") as run:
            with self.assertRaises(ValueError): poll.poll_many(self.poll_config, self.now)
        run.assert_not_called()

    def test_rollout_can_read_the_original_compliance_only_endpoint(self):
        records = self.poll({"state": "idle", "observedAt": self.now})["records"]
        self.assertEqual(next(row for row in records if row["monitorID"] == 9)["state"], "idle")
        self.assertEqual(next(row for row in records if row["monitorID"] == 10)["state"], "unavailable")

    def test_signed_release_receipt_uses_its_saved_start_not_poll_time(self):
        file = self.native_root / "receipt"
        file.write_text("state=PENDING_ACCEPTANCE\ncommit=" + "a" * 40 + "\nrelease=approved-release\nstarted_at=2026-01-01T00:00:00Z\nreceipt_end=v3\n")
        file.chmod(0o600)
        profile = {"id": "mastika", "adapter": "receipt", "minutes": 30, "path": str(file)}
        old = self.adapters.native(profile, self.now, source.collect)
        later = self.adapters.native(profile, self.now + 60000, source.collect)
        self.assertEqual(old["deadline"], later["deadline"])
        self.assertLess(old["deadline"], self.now)
        self.assertEqual(old["kind"], "update")

    def test_command_wrapper_ends_failed_work_and_preserves_the_failure(self):
        command = [sys.executable, "-I", str(MODULES / "control.py"), "--config", str(self.config_path), "run", "demo-shop", "--", sys.executable, "-c", "raise SystemExit(7)"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(self.collect()["sources"]["demo-shop"]["state"], "idle")
        receipt = json.loads(next((self.flags / "history").iterdir()).read_text())
        self.assertEqual(receipt["result"], 7)

    def test_empty_command_does_not_open_an_orphan_work_window(self):
        command = [sys.executable, "-I", str(MODULES / "control.py"), "--config", str(self.config_path), "run", "demo-shop", "--"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.flags.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
