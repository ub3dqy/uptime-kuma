import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "deploy/pilot/pilot.py"
spec = importlib.util.spec_from_file_location("pilot", SOURCE)
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class FixturePilot(pilot.Pilot):
    def __init__(self, root):
        self.root = root
        self.cfg = {"imageID": "sha256:" + "a" * 64, "port": 3041}
        self.project = "kuma-pilot-test-01234567"
        self.running = True
        self.commands = []

    def check_installation(self):
        pass

    def container(self, service="kuma"):
        return {"Id": "owned-id", "State": {"Running": self.running, "ExitCode": 0}}

    def compose(self, *args, **kwargs):
        self.commands.append(args)
        if args[0] == "stop": self.running = False
        if args[0] == "start": self.running = True


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_notification_route_is_explicit_and_confined_to_the_private_bridge(self):
        config = {
            "project": "kuma-pilot-test-01234567",
            "image": "ub3dqy/uptime-kuma:pilot-01234567",
            "imageID": "sha256:" + "a" * 64,
            "port": 3041,
            "days": 7,
        }
        file = self.root / "pilot.json"
        file.write_text(json.dumps(config))
        with patch.dict(os.environ, {"KUMA_NOTIFICATION_PROXY": "http://unrelated.example"}):
            self.assertEqual(pilot.Pilot(self.root).env["KUMA_NOTIFICATION_PROXY"], "")
        for address in [
            "http://203.0.113.1:19080",
            "socks5h://127.0.0.1:19080",
            "socks5h://172.32.0.1:19080",
            "socks5h://user:password@203.0.113.1:19080",
            "socks5h://203.0.113.1:443",
        ]:
            file.write_text(json.dumps({**config, "notificationProxy": address}))
            with self.assertRaises(ValueError):
                pilot.Pilot(self.root)
        file.write_text(json.dumps({**config, "notificationProxy": "socks5h://172.31.250.1:19080"}))
        self.assertEqual(
            pilot.Pilot(self.root).env["KUMA_NOTIFICATION_PROXY"],
            "socks5h://172.31.250.1:19080",
        )

    def test_telegram_control_is_opt_in_and_uses_a_fixed_private_file(self):
        config = {
            "project": "kuma-pilot-test-01234567",
            "image": "ub3dqy/uptime-kuma:pilot-01234567",
            "imageID": "sha256:" + "a" * 64,
            "port": 3041,
        }
        file = self.root / "pilot.json"
        file.write_text(json.dumps(config))
        with patch.dict(os.environ, {"KUMA_TELEGRAM_CONTROL_CONFIG": "/other/config.json"}):
            self.assertEqual(pilot.Pilot(self.root).env["KUMA_TELEGRAM_CONTROL_CONFIG"], "")
        file.write_text(json.dumps({**config, "telegramControl": "true"}))
        with self.assertRaises(ValueError):
            pilot.Pilot(self.root)
        file.write_text(json.dumps({**config, "telegramControl": True}))
        self.assertEqual(
            pilot.Pilot(self.root).env["KUMA_TELEGRAM_CONTROL_CONFIG"], "/app/data/telegram-control/config.json"
        )

    def data(self):
        data = self.root / "data"
        data.mkdir()
        (data / "db-config.json").write_text('{"type":"sqlite"}')
        (data / "asset.txt").write_text("Unique recovery asset")
        with closing(sqlite3.connect(data / "kuma.db")) as db:
            for table in ["monitor", "heartbeat", "client_group", "client_group_monitor"]:
                db.execute(f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY)')
                db.execute(f'INSERT INTO "{table}" VALUES (1)')
            db.commit()
        return data

    def test_complete_backup_restores_all_files_and_preserves_live_data(self):
        data = self.data()
        original = pilot.sha256(data / "kuma.db")
        instance = FixturePilot(self.root)
        archive = instance.backup()
        self.assertTrue(instance.running)
        self.assertEqual([row[0] for row in instance.commands], ["stop", "start"])
        result = instance.verify_backup(archive)
        self.assertEqual(result["integrity"], "ok")
        self.assertEqual(result["tables"]["heartbeat"], 1)
        self.assertEqual(pilot.sha256(data / "kuma.db"), original)
        with tarfile.open(archive) as source:
            self.assertEqual(source.extractfile("asset.txt").read(), b"Unique recovery asset")
        self.assertEqual(list((self.root / ".restore").iterdir()), [])

    @unittest.skipUnless(os.name == "posix", "Linux directory permissions")
    def test_restored_key_directory_retains_private_access(self):
        data = self.data()
        keys = data / "project-secrets"
        keys.mkdir(mode=0o700)
        (keys / "keys.json").write_text('{"synthetic":"private-key-fixture"}')
        (keys / "keys.json").chmod(0o600)
        instance = FixturePilot(self.root)
        archive = instance.backup()
        restored = self.root / "independent-restore"
        restored.mkdir(mode=0o700)
        previous_mask = os.umask(0o022)
        try:
            pilot.extract_backup(archive, restored)
            self.assertEqual(os.umask(0o022), 0o022)
        finally:
            os.umask(previous_mask)
        self.assertEqual((restored / "project-secrets").stat().st_mode & 0o777, 0o700)
        self.assertEqual((restored / "project-secrets/keys.json").stat().st_mode & 0o777, 0o600)

    def test_archive_failure_restarts_only_a_previously_running_app(self):
        self.data()
        instance = FixturePilot(self.root)
        with patch.object(tarfile.TarFile, "add", side_effect=OSError("Disk fixture")):
            with self.assertRaises(OSError): instance.backup()
        self.assertTrue(instance.running)
        self.assertEqual([row[0] for row in instance.commands], ["stop", "start"])
        instance.running = False
        instance.commands.clear()
        instance.backup()
        self.assertFalse(instance.running)
        self.assertEqual(instance.commands, [])

    def test_low_disk_space_does_not_stop_the_app(self):
        self.data()
        instance = FixturePilot(self.root)
        with patch.object(pilot.shutil, "disk_usage", return_value=type("Disk", (), {"free": 0})()):
            with self.assertRaises(ValueError): instance.backup()
        self.assertEqual(instance.commands, [])

    def test_unsafe_archive_members_are_refused_before_extracting(self):
        for name, kind in [("../outside", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("hard", tarfile.LNKTYPE), ("device", tarfile.CHRTYPE)]:
            with self.subTest(name=name):
                archive = self.root / "attack.tar.gz"
                with tarfile.open(archive, "w:gz") as target:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = "/outside"
                    target.addfile(member, io.BytesIO())
                destination = self.root / "extracted"
                destination.mkdir(exist_ok=True)
                with self.assertRaises(ValueError): pilot.extract_backup(archive, destination)
                self.assertEqual(list(destination.iterdir()), [])

    def test_tampered_backup_never_modifies_live_data(self):
        data = self.data()
        instance = FixturePilot(self.root)
        archive = instance.backup()
        with archive.open("ab") as target: target.write(b"tampered")
        original = pilot.sha256(data / "kuma.db")
        with self.assertRaises(ValueError): instance.verify_backup(archive)
        self.assertEqual(pilot.sha256(data / "kuma.db"), original)

    def test_data_symlinks_are_not_adopted(self):
        outside = self.root / "other"
        outside.mkdir()
        try: (self.root / "data").symlink_to(outside, target_is_directory=True)
        except OSError: self.skipTest("Symlinks require local privileges")
        with self.assertRaises(ValueError): pilot.safe_directory(self.root, "data")

    def test_config_rejects_wrong_project_image_and_port(self):
        base = {"project": "uptime-kuma-pilot", "image": "ub3dqy/uptime-kuma:pilot-01234567", "imageID": "sha256:" + "a" * 64, "port": 3041, "days": 7}
        for field, value in [("project", "unrelated-app"), ("image", "example/arbitrary:latest"), ("imageID", "latest"), ("port", 80), ("port", "3041")]:
            (self.root / "pilot.json").write_text(json.dumps({**base, field: value}))
            with self.assertRaises(ValueError): pilot.load_config(self.root)

    def test_replaced_image_is_not_started(self):
        instance = FixturePilot(self.root)
        instance.cfg["image"] = "ub3dqy/uptime-kuma:pilot-01234567"
        with patch.object(pilot, "run", return_value=json.dumps([{"Id": "sha256:" + "b" * 64, "Architecture": "amd64", "Os": "linux"}])):
            with self.assertRaises(ValueError): instance.check_pin()

    def test_failed_daily_backup_is_not_repeated_every_five_minutes(self):
        import datetime as dt
        instance = FixturePilot(self.root)
        now = dt.datetime.now(dt.timezone.utc)
        pilot.write_json(self.root / "trial.json", {"startedAt": (now - dt.timedelta(hours=1)).isoformat(), "endsAt": (now + dt.timedelta(days=6)).isoformat()})
        (self.root / "reports").mkdir()
        good = {"health": "healthy", "running": True, "oomKilled": False}
        with patch.object(instance, "sample", return_value=good), patch.object(pilot, "run", return_value='{"synthetic":true}'), patch.object(instance, "backup", side_effect=ValueError("Backup fixture")) as backup:
            with self.assertRaises(ValueError): instance.tick()
            instance.tick()
            self.assertEqual(backup.call_count, 1)
            self.assertEqual(json.loads((self.root / "daily-backup.json").read_text())["status"], "failed")
            self.assertIn("windowEnd", json.loads((self.root / "daily-backup.json").read_text()))

    def test_final_trial_result_keeps_missing_slots_unknown(self):
        import datetime as dt
        instance = FixturePilot(self.root)
        now = dt.datetime.now(dt.timezone.utc)
        start = now - dt.timedelta(days=8)
        pilot.write_json(self.root / "trial.json", {"startedAt": start.isoformat(), "endsAt": (start + dt.timedelta(days=7)).isoformat()})
        (self.root / "reports").mkdir()
        row = {"time": start.isoformat(), "health": "healthy", "running": True, "oomKilled": False}
        (self.root / "reports" / "samples.jsonl").write_text(json.dumps(row) + "\n")
        backup_day = (now.astimezone(pilot.ZoneInfo("Europe/Moscow")) - dt.timedelta(hours=3, minutes=10)).date().isoformat()
        pilot.write_json(self.root / "daily-backup.json", {"backupDay": backup_day, "status": "verified"})
        with patch.object(instance, "sample", return_value=row), patch.object(instance, "period_evidence") as evidence:
            instance.tick()
            evidence.assert_called_once_with(start.isoformat(), (start + dt.timedelta(days=7)).isoformat(), "final-checks.json")
        result = json.loads((self.root / "trial-result.json").read_text())
        self.assertEqual(result["healthySlots"], 1)
        self.assertEqual(result["missingSlots"], 2015)
        self.assertEqual(result["state"], "awaiting-owner-review")
        self.assertEqual(result["finalPeriodEvidence"], "complete")

    def test_daily_backups_continue_after_the_trial_result_was_saved(self):
        import datetime as dt
        self.data()
        instance = FixturePilot(self.root)
        now = dt.datetime.now(dt.timezone.utc)
        pilot.write_json(self.root / "trial.json", {"startedAt": (now - dt.timedelta(days=8)).isoformat(), "endsAt": (now - dt.timedelta(days=1)).isoformat()})
        pilot.write_json(self.root / "trial-result.json", {"state": "awaiting-owner-review", "missingSlots": 5})
        result_hash = pilot.sha256(self.root / "trial-result.json")
        (self.root / "reports").mkdir()
        good = {"health": "healthy", "running": True, "oomKilled": False}
        with patch.object(instance, "sample", return_value=good) as sample, patch.object(instance, "period_evidence", return_value=now.isoformat()):
            instance.tick()
            instance.tick()
        self.assertEqual(sample.call_count, 2)
        self.assertEqual([row[0] for row in instance.commands], ["stop", "start"])
        state = json.loads((self.root / "daily-backup.json").read_text())
        self.assertEqual(state["status"], "verified")
        self.assertTrue((self.root / "backups" / state["archive"]).exists())
        self.assertEqual(result_hash, pilot.sha256(self.root / "trial-result.json"))

    def test_report_failure_does_not_prevent_a_verified_daily_backup(self):
        import datetime as dt
        self.data()
        instance = FixturePilot(self.root)
        now = dt.datetime.now(dt.timezone.utc)
        pilot.write_json(self.root / "trial.json", {"startedAt": (now - dt.timedelta(hours=1)).isoformat(), "endsAt": (now + dt.timedelta(days=6)).isoformat()})
        (self.root / "reports").mkdir()
        good = {"health": "healthy", "running": True, "oomKilled": False}
        with patch.object(instance, "sample", return_value=good), patch.object(instance, "period_evidence", side_effect=ValueError("Export fixture")):
            with self.assertRaisesRegex(RuntimeError, "full backup was verified"):
                instance.tick()
            instance.tick()
        state = json.loads((self.root / "daily-backup.json").read_text())
        self.assertEqual(state["status"], "verified")
        self.assertEqual(state["reportStatus"], "failed")
        self.assertEqual(state["windowEnd"], (now - dt.timedelta(hours=1)).isoformat())
        self.assertTrue((self.root / "backups" / state["archive"]).exists())
        self.assertEqual([row[0] for row in instance.commands], ["stop", "start"])


if __name__ == "__main__": unittest.main()
