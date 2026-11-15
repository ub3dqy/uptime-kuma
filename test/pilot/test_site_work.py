import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

MODULES = Path(__file__).resolve().parents[2] / "deploy" / "site-work"
sys.path.insert(0, str(MODULES))
import source
import poll


@unittest.skipUnless(os.name == "posix", "Linux owner, permissions and release markers")
class WorkSourceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.shared = self.root / "shared"
        self.shared.mkdir(mode=0o700)
        self.marker_dir = self.shared / "maintenance"
        self.marker_dir.mkdir(mode=0o755)
        self.marker = self.marker_dir / "enabled"
        self.proc = self.root / "proc"
        self.proc.mkdir(mode=0o700)
        self.now = 1793651400000
        self.commit = "a" * 40

    def start(self):
        self.marker.write_bytes(b"")
        self.marker.chmod(0o644)
        os.utime(self.marker, ns=((self.now - 60000) * 1_000_000,) * 2)

    def collect(self, now=None):
        return source.collect(self.root, self.now if now is None else now, 30, self.proc)

    def test_idle_requires_a_valid_explicit_parent(self):
        self.assertEqual(self.collect(), {"state": "idle", "observedAt": self.now})
        self.marker_dir.rmdir()
        with self.assertRaises(OSError): self.collect()

    def test_active_is_explicit_bounded_and_does_not_extend_on_poll(self):
        self.start()
        first = self.collect()
        second = self.collect(self.now + 120000)
        self.assertEqual(first["state"], "active")
        self.assertEqual(first["work"], second["work"])
        self.assertEqual(first["work"]["deadline"], self.now - 60000 + 1800000)
        self.assertEqual(first["work"]["phase"], "working")
        self.assertEqual(first["work"]["kind"], "maintenance")

    def test_observer_does_not_change_release_files(self):
        self.start()
        before = (self.marker.stat(), hashlib.sha256(self.marker.read_bytes()).hexdigest())
        self.collect()
        after = (self.marker.stat(), hashlib.sha256(self.marker.read_bytes()).hexdigest())
        self.assertEqual(before[0].st_mtime_ns, after[0].st_mtime_ns)
        self.assertEqual(before[1], after[1])
        self.assertEqual(list(self.marker_dir.iterdir()), [self.marker])

    def test_linked_or_writable_markers_never_prove_planned_work(self):
        self.start()
        self.marker.chmod(0o666)
        with self.assertRaises(ValueError): self.collect()
        self.marker.chmod(0o644)
        os.link(self.marker, self.marker_dir / "hard")
        with self.assertRaises(ValueError): self.collect()

    def test_symlink_cannot_be_reported_as_idle(self):
        self.marker.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError): self.collect()

    def test_deadline_limits_are_checked_and_never_refreshed(self):
        self.start()
        for duration in [True, 0, 4, 121, "30"]:
            with self.assertRaises(ValueError): source.collect(self.root, self.now, duration, self.proc)
        first = self.collect()
        late = self.collect(self.now + 86400000)
        self.assertEqual(first["work"]["deadline"], late["work"]["deadline"])

    def test_fixed_current_release_markers_determine_phase(self):
        self.start()
        release = self.shared / ("deploy-" + self.commit)
        release.mkdir(mode=0o700)
        for name, expected in [("activated", "verifying"), ("acceptance-passed", "opening")]:
            (release / name).touch(mode=0o600)
            self.assertEqual(self.collect()["work"]["phase"], expected)
        process = self.proc / "42"
        process.mkdir()
        (process / "comm").write_text("bash\n")
        command = ["/bin/bash", f"/opt/compliance-navigator/releases/{self.commit}/ops/deploy/remote-production.sh", "recover", self.commit]
        (process / "cmdline").write_bytes(b"\x00".join(word.encode() for word in command))
        self.assertEqual(self.collect()["work"]["phase"], "rolling_back")
        command[1] = "/tmp/remote-production.sh"
        (process / "cmdline").write_bytes(b"\x00".join(word.encode() for word in command))
        self.assertEqual(self.collect()["work"]["phase"], "opening")

    def test_a_completed_release_cannot_classify_unrelated_maintenance_as_an_update(self):
        self.start()
        release = self.shared / ("deploy-" + self.commit)
        release.mkdir(mode=0o700)
        (release / "activated").touch(mode=0o600)
        (release / "completed").touch(mode=0o600)
        value = self.collect()
        self.assertEqual(value["work"]["kind"], "maintenance")
        self.assertEqual(value["work"]["phase"], "working")

    def test_atomic_export_has_requested_private_mode(self):
        target = self.root / "state.json"
        source.atomic_write(target, self.collect(), 0o440)
        self.assertEqual(target.stat().st_mode & 0o777, 0o440)
        self.assertEqual(json.loads(target.read_text())["state"], "idle")
        target.unlink()
        target.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError): source.atomic_write(target, {})

    def test_poller_pins_destination_and_preserves_original_observation(self):
        config = {"host": "192.0.2.1", "hostKeyFile": str(self.root / "known_hosts"), "keyFile": str(self.root / "key"), "user": "kuma-site-peer", "monitorID": 9, "ownerID": 1, "siteHost": "example.test", "output": str(self.root / "site-work.json")}
        for key in ["hostKeyFile", "keyFile"]:
            Path(config[key]).touch(mode=0o600)
        self.start()
        value = self.collect()
        reply = types.SimpleNamespace(stdout=json.dumps(value).encode())
        with patch.object(poll.subprocess, "run", return_value=reply) as run:
            result = poll.poll(config, self.now)
        self.assertEqual(result["records"][0]["work"], value["work"])
        self.assertEqual(result["records"][0]["observedAt"], self.now)
        command = run.call_args.args[0]
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertIn("IdentitiesOnly=yes", command)
        self.assertEqual(command[-1], "kuma-site-peer@192.0.2.1")
        for value in [{"state": "idle", "observedAt": self.now - 45001}, {"state": "idle", "observedAt": self.now + 5001}, {"state": "pretend_success", "observedAt": self.now}]:
            with patch.object(poll.subprocess, "run", return_value=types.SimpleNamespace(stdout=json.dumps(value).encode())):
                with self.assertRaises(ValueError): poll.poll(config, self.now)
        with self.assertRaises(ValueError): poll.poll({**config, "host": "attacker.test; command"}, self.now)


if __name__ == "__main__":
    unittest.main()
