import contextlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "deploy/pilot/upgrade.py"
spec = importlib.util.spec_from_file_location("owned_upgrade", SOURCE)
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class RetainedUpgradeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / "data"
        self.data.mkdir()
        for name in ["project-secrets/keys.json", "ai-worker/config.json", "witness/config.json"]:
            file = self.data / name
            file.parent.mkdir(mode=0o700)
            file.write_text('{"synthetic":"private-test-value"}')
            file.chmod(0o600)
        with contextlib.closing(sqlite3.connect(self.data / "kuma.db")) as db:
            db.executescript("""
                CREATE TABLE project_ai(id INTEGER PRIMARY KEY, secret_cipher TEXT);
                INSERT INTO project_ai VALUES(1,'synthetic-encrypted-grant');
                CREATE TABLE project_ai_job(id INTEGER PRIMARY KEY, status TEXT, result_json TEXT);
                INSERT INTO project_ai_job VALUES(1,'completed','synthetic-result');
                CREATE TABLE notification(id INTEGER PRIMARY KEY, config TEXT);
                INSERT INTO notification VALUES(1,'synthetic-encrypted-channel');
                CREATE TABLE project_recovery(id INTEGER PRIMARY KEY, status TEXT);
                CREATE TABLE project_ai_automation(project_id INTEGER PRIMARY KEY, enabled INTEGER);
                CREATE TABLE notification_delivery(id INTEGER PRIMARY KEY, status TEXT);
            """)
            db.commit()
        self.instance = upgrade.Upgrade.__new__(upgrade.Upgrade)
        self.instance.root = self.root
        self.instance.pilot = types.SimpleNamespace(cfg={"imageID": "pinned-source"})
        self.instance.config = {
            "expectedOldImageID": "pinned-source",
            "retainedState": upgrade.retained_state(self.data),
        }

    def change(self, sql):
        with contextlib.closing(sqlite3.connect(self.data / "kuma.db")) as db:
            db.execute(sql)
            db.commit()

    def test_quiescent_state_is_accepted_without_disclosing_credentials(self):
        self.instance.first_product_migration()
        self.instance.no_active_jobs()
        report = json.dumps(self.instance.config["retainedState"])
        self.assertNotIn("synthetic", report)
        self.assertEqual(self.instance.config["retainedState"]["grantCount"], 1)

    def test_credential_channel_history_and_operator_key_changes_are_rejected(self):
        changes = [
            "UPDATE project_ai SET secret_cipher='changed'",
            "UPDATE notification SET config='changed'",
            "UPDATE project_ai_job SET result_json='changed'",
        ]
        for sql in changes:
            with self.subTest(sql=sql):
                original = self.instance.config["retainedState"]
                self.change(sql)
                with self.assertRaises(ValueError):
                    self.instance.first_product_migration()
                self.instance.config["retainedState"] = upgrade.retained_state(self.data)
                self.assertNotEqual(original, self.instance.config["retainedState"])
        (self.data / "project-secrets/keys.json").write_text("changed-key")
        with self.assertRaises(ValueError):
            self.instance.first_product_migration()

    def test_active_automatic_policy_and_recovery_history_need_a_separate_update(self):
        self.change("INSERT INTO project_ai_automation VALUES(1,1)")
        self.instance.config["retainedState"] = upgrade.retained_state(self.data)
        with self.assertRaises(ValueError):
            self.instance.first_product_migration()
        self.change("UPDATE project_ai_automation SET enabled=0")
        self.change("INSERT INTO project_recovery VALUES(1,'completed')")
        self.instance.config["retainedState"] = upgrade.retained_state(self.data)
        with self.assertRaises(ValueError):
            self.instance.first_product_migration()

    def test_wrong_image_and_incomplete_fingerprint_are_rejected(self):
        self.instance.pilot.cfg["imageID"] = "different-source"
        with self.assertRaises(ValueError):
            self.instance.first_product_migration()
        self.instance.pilot.cfg["imageID"] = "pinned-source"
        self.instance.config["retainedState"] = {}
        with self.assertRaises(ValueError):
            self.instance.first_product_migration()

    def test_active_ai_recovery_and_delivery_block_the_update(self):
        for sql, undo in [
            ("UPDATE project_ai_job SET status='running'", "UPDATE project_ai_job SET status='completed'"),
            ("INSERT INTO project_recovery VALUES(1,'verifying')", "DELETE FROM project_recovery"),
            ("INSERT INTO notification_delivery VALUES(1,'sending')", "DELETE FROM notification_delivery"),
        ]:
            self.change(sql)
            with self.assertRaises(ValueError):
                self.instance.no_active_jobs()
            self.change(undo)
        self.instance.no_active_jobs()

    def test_legacy_first_migration_still_rejects_configured_grants(self):
        self.instance.config.pop("retainedState")
        with self.assertRaisesRegex(ValueError, "Configured AI"):
            self.instance.first_product_migration()


if __name__ == "__main__":
    unittest.main()
