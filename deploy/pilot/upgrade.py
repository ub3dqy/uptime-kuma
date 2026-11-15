#!/usr/bin/env python3
"""Stage, apply and compensate one immutable release of this exact owned pilot."""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid


def pilot_module(root):
    spec = importlib.util.spec_from_file_location("owned_pilot", root / "pilot.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ordinary(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
        raise ValueError("Expected a private ordinary release file")
    return path


def retained_state(data):
    """Fingerprint project-owned credentials/history without exporting their contents."""
    result = {}
    for key, name in [
        ("keysSHA256", "project-secrets/keys.json"),
        ("workerConfigSHA256", "ai-worker/config.json"),
        ("witnessConfigSHA256", "witness/config.json"),
    ]:
        with ordinary(data / name).open("rb") as stream:
            result[key] = hashlib.file_digest(stream, "sha256").hexdigest()
    with contextlib.closing(
        sqlite3.connect(f"file:{data / 'kuma.db'}?mode=ro", uri=True)
    ) as db:
        for key, table in [
            ("aiRowsSHA256", "project_ai"),
            ("aiJobsSHA256", "project_ai_job"),
            ("notificationsSHA256", "notification"),
        ]:
            digest = hashlib.sha256()
            # Table names are fixed above, never read from a manifest or browser.
            for row in db.execute(f'SELECT * FROM "{table}" ORDER BY rowid'):
                digest.update(json.dumps(row, separators=(",", ":"), ensure_ascii=True).encode())
                digest.update(b"\n")
            result[key] = digest.hexdigest()
        result["grantCount"] = db.execute(
            "SELECT COUNT(*) FROM project_ai WHERE secret_cipher IS NOT NULL"
        ).fetchone()[0]
        result["recoveryHistoryCount"] = db.execute("SELECT COUNT(*) FROM project_recovery").fetchone()[0]
        result["enabledAutomationCount"] = db.execute(
            "SELECT COUNT(*) FROM project_ai_automation WHERE enabled = 1"
        ).fetchone()[0]
    return result


class Upgrade:
    def __init__(self, root, release):
        self.root = root.resolve()
        if (
            self.root != Path("/srv/uptime-kuma-pilot")
            or root.is_symlink()
            or os.geteuid() != 0
        ):
            raise ValueError("Only the exact owned Linux installation is supported")
        self.module = pilot_module(self.root)
        self.pilot = self.module.Pilot(self.root)
        self.pilot.check_installation()
        self.release = release.resolve()
        if (
            release.is_symlink()
            or self.release.parent != self.root / "releases"
            or not re.fullmatch(r"[a-f0-9]{12,40}", self.release.name)
        ):
            raise ValueError("Release must be a direct owned release directory")
        self.config = json.loads(ordinary(self.release / "release.json").read_text())
        if (
            self.config.get("version") != 1
            or not re.fullmatch(
                r"ub3dqy/uptime-kuma:pilot-[a-f0-9]{7,40}", self.config.get("image", "")
            )
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", self.config.get("imageID", ""))
        ):
            raise ValueError("An immutable owned image is required")
        if (
            self.config.get("sourceCommit") != self.release.name
            or self.config.get("nodeVersion") != "24.22.2"
            or not re.fullmatch(
                r"sha256:[a-f0-9]{64}", self.config.get("expectedOldImageID", "")
            )
        ):
            raise ValueError("Release identity mismatch")
        if self.pilot.cfg["imageID"] not in (
            self.config["imageID"],
            self.config["expectedOldImageID"],
        ):
            raise ValueError(
                "This first product migration does not match the installed image"
            )
        for filename in ["image.tar.gz", "verify-product-data.cjs"]:
            if self.module.sha256(ordinary(self.release / filename)) != self.config.get(
                "files", {}
            ).get(filename):
                raise ValueError("Release checksum mismatch")

    def image(self):
        inspected = json.loads(
            self.module.run(["docker", "image", "inspect", self.config["image"]])
        )[0]
        if (
            inspected["Id"] != self.config["imageID"]
            or inspected["Os"] != "linux"
            or inspected["Architecture"] != "amd64"
        ):
            raise ValueError("Loaded image differs from the qualified release")

    def no_active_jobs(self):
        with contextlib.closing(
            sqlite3.connect(f"file:{self.root / 'data/kuma.db'}?mode=ro", uri=True)
        ) as db:
            tables = {
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            if (
                "project_ai_job" in tables
                and db.execute(
                    "SELECT COUNT(*) FROM project_ai_job WHERE status IN ('queued','running')"
                ).fetchone()[0]
            ):
                raise ValueError("Wait for active AI work before upgrade")
            if (
                "project_recovery" in tables
                and db.execute(
                    "SELECT COUNT(*) FROM project_recovery WHERE status IN ('queued','preparing','applying','verifying','reverting','verifying_rollback','recovering')"
                ).fetchone()[0]
            ):
                raise ValueError("Wait for active recovery before upgrade")
            if "notification_delivery" in tables and db.execute(
                "SELECT COUNT(*) FROM notification_delivery WHERE status IN ('queued','sending')"
            ).fetchone()[0]:
                raise ValueError("Wait for active delivery before upgrade")

    def first_product_migration(self):
        if self.pilot.cfg["imageID"] != self.config["expectedOldImageID"]:
            raise ValueError(
                "This release does not match the pinned source installation"
            )
        expected = self.config.get("retainedState")
        if expected is not None:
            actual = retained_state(self.root / "data")
            if (
                expected != actual
                or actual["enabledAutomationCount"] != 0
                or actual["recoveryHistoryCount"] != 0
            ):
                raise ValueError("Retained project state changed or is not quiesced")
            return
        with contextlib.closing(
            sqlite3.connect(f"file:{self.root / 'data/kuma.db'}?mode=ro", uri=True)
        ) as db:
            tables = {
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            if (
                "project_ai" in tables
                and db.execute(
                    "SELECT COUNT(*) FROM project_ai WHERE secret_cipher IS NOT NULL"
                ).fetchone()[0]
            ):
                raise ValueError(
                    "Configured AI needs a separate quiesced migration; this first-release tool cannot adopt it"
                )
            if (
                "project_recovery" in tables
                and db.execute("SELECT COUNT(*) FROM project_recovery").fetchone()[0]
            ):
                raise ValueError(
                    "An existing recovery history needs a separate quiesced migration"
                )

    def other_containers(self):
        identifiers = self.module.run(["docker", "ps", "-aq"]).split()
        if not identifiers:
            return {}
        result = {}
        for container in json.loads(
            self.module.run(["docker", "inspect", *identifiers])
        ):
            labels = container["Config"].get("Labels") or {}
            if (
                labels.get("com.docker.compose.project") == self.pilot.project
                or labels.get("com.ub3dqy.release-stage") == self.release.name
            ):
                continue
            result[container["Id"]] = {
                "running": container["State"]["Running"],
                "startedAt": container["State"]["StartedAt"],
                "image": container["Image"],
            }
        return result

    def owned_stop(self):
        allowed_images = {
            self.pilot.cfg["imageID"],
            self.config["imageID"],
            self.config["expectedOldImageID"],
        }
        for service in ("kuma", "canary"):
            ids = self.module.run(
                [
                    "docker",
                    "ps",
                    "-aq",
                    "--filter",
                    f"label=com.docker.compose.project={self.pilot.project}",
                    "--filter",
                    f"label=com.docker.compose.service={service}",
                ]
            ).split()
            if len(ids) != 1:
                raise ValueError("Owned service identity mismatch")
            item = json.loads(self.module.run(["docker", "inspect", ids[0]]))[0]
            if (
                item["Config"].get("Labels", {}).get("com.ub3dqy.pilot")
                != "uptime-kuma"
                or item["Image"] not in allowed_images
            ):
                raise ValueError("Refuse to stop an unrelated service")
            self.module.run(["docker", "stop", "--time", "60", ids[0]], timeout=90)

    def restore_directory(self, archive, destination):
        if destination.exists() or destination.parent.resolve() not in (
            self.root,
            self.release,
        ):
            raise ValueError("Restore requires a new owned directory")
        destination.mkdir(mode=0o700)
        self.module.extract_backup(archive, destination)
        for path in [destination, *destination.rglob("*")]:
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise ValueError("Unexpected restored file")
            os.chown(path, 1000, 1000)

    def stage(self):
        self.first_product_migration()
        self.no_active_jobs()
        before = self.other_containers()
        self.module.run(
            ["docker", "load", "-i", str(self.release / "image.tar.gz")], timeout=240
        )
        self.image()
        backup = self.pilot.backup()
        self.pilot.verify_backup(backup)
        destination = self.release / ("stage-data-" + uuid.uuid4().hex[:12])
        self.restore_directory(backup, destination)
        with contextlib.closing(sqlite3.connect(destination / "kuma.db")) as db:
            db.execute("UPDATE monitor SET active=0")
            tables = {
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            if "project_ai_job" in tables:
                db.execute(
                    "UPDATE project_ai_job SET status='cancelled' WHERE status IN ('queued','running')"
                )
            db.commit()
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        for path in destination.glob("kuma.db*"):
            if path.is_file() and not path.is_symlink():
                os.chown(path, 1000, 1000)
        name = "kuma-product-stage-" + uuid.uuid4().hex[:12]
        identifier = self.module.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                name,
                "--network",
                "none",
                "--read-only",
                "--user",
                "1000:1000",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--cpus",
                "0.25",
                "--memory",
                "384m",
                "--pids-limit",
                "128",
                "--tmpfs",
                "/tmp:size=67108864,mode=1777",
                "--label",
                "com.ub3dqy.release-stage=" + self.release.name,
                "-e",
                "NODE_ENV=production",
                "-e",
                "UPTIME_KUMA_DB_TYPE=sqlite",
                "-e",
                "UPTIME_KUMA_ENABLE_EMBEDDED_MARIADB=0",
                "-v",
                str(destination) + ":/app/data",
                self.config["image"],
            ]
        )
        try:
            end = time.monotonic() + 150
            while True:
                try:
                    self.module.run(
                        [
                            "docker",
                            "exec",
                            identifier,
                            "node",
                            "extra/pilot-healthcheck.cjs",
                        ],
                        timeout=10,
                    )
                    break
                except RuntimeError:
                    if time.monotonic() >= end:
                        raise
                    time.sleep(2)
            self.module.run(["docker", "stop", "--time", "60", identifier], timeout=90)
            # A portable, stopped clone must not need writable WAL shared-memory
            # files when opened by the following strictly read-only verifier.
            with contextlib.closing(sqlite3.connect(destination / "kuma.db")) as db:
                checkpoint = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                if checkpoint[0] != 0:
                    raise ValueError("Stopped clone checkpoint is busy")
                if db.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
                    raise ValueError("Stopped clone is not portable")
            verified = json.loads(
                self.module.run(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--network",
                        "none",
                        "--read-only",
                        "--user",
                        "1000:1000",
                        "--cap-drop",
                        "ALL",
                        "--security-opt",
                        "no-new-privileges",
                        "--cpus",
                        "0.25",
                        "--memory",
                        "256m",
                        "--pids-limit",
                        "32",
                        "-v",
                        str(destination) + ":/app/data:ro",
                        self.config["image"],
                        "node",
                        "extra/verify-product-data.cjs",
                    ],
                    timeout=45,
                )
            )
            if self.config.get("retainedState") is not None:
                if retained_state(destination) != self.config["retainedState"]:
                    raise ValueError("Staging changed retained credentials or project history")
                if verified["decryptedAIGrants"] != self.config["retainedState"]["grantCount"]:
                    raise ValueError("Staged AI credentials cannot be restored")
            if before != self.other_containers():
                raise ValueError("Other container state changed during staging")
            self.module.write_json(
                self.release / "stage-qualified.json",
                {
                    "at": self.module.utc(),
                    "imageID": self.config["imageID"],
                    "oldImageID": self.pilot.cfg["imageID"],
                    "backup": backup.name,
                    "network": "none",
                    "ports": [],
                    "verification": verified,
                    "otherContainersUnchanged": True,
                },
            )
        except Exception:
            try:
                self.module.write_json(
                    self.release / ("stage-runtime-" + uuid.uuid4().hex + ".json"),
                    {
                        "at": self.module.utc(),
                        "log": self.module.run(["docker", "logs", identifier]),
                    },
                )
            except Exception:
                pass  # Preserve the original failure even if its private log cannot be retained.
            raise
        finally:
            item = json.loads(self.module.run(["docker", "inspect", identifier]))[0]
            if (
                item["Config"].get("Labels", {}).get("com.ub3dqy.release-stage")
                != self.release.name
                or item["Image"] != self.config["imageID"]
            ):
                raise ValueError("Stage cleanup identity mismatch")
            self.module.run(["docker", "rm", "-f", identifier], timeout=90)

    def compensate(self, record):
        self.owned_stop()
        data = self.root / "data"
        if data.is_symlink() or data.resolve().parent != self.root:
            raise ValueError("Unexpected live data location")
        retained = self.root / ("retained-before-return-" + uuid.uuid4().hex)
        data.rename(retained)
        self.restore_directory(self.root / "backups" / record["backup"], data)
        self.module.write_json(self.root / "pilot.json", record["previousConfig"])
        self.pilot = self.module.Pilot(self.root)
        self.pilot.compose(
            "up",
            "-d",
            "--no-deps",
            "--wait",
            "--wait-timeout",
            "180",
            "kuma",
            "canary",
            timeout=240,
        )
        self.pilot.check_installation()
        self.pilot.container()
        self.module.write_json(
            self.release / "returned.json",
            {
                "at": self.module.utc(),
                "imageID": self.pilot.cfg["imageID"],
                "retainedData": retained.name,
                "backup": record["backup"],
                "expiresAt": None,
            },
        )

    def apply(self):
        self.first_product_migration()
        qualified = json.loads(
            ordinary(self.release / "stage-qualified.json").read_text()
        )
        if (
            qualified["imageID"] != self.config["imageID"]
            or qualified["oldImageID"] != self.pilot.cfg["imageID"]
        ):
            raise ValueError("Stage no longer matches the live installation")
        self.image()
        self.no_active_jobs()
        before = self.other_containers()
        backup = self.pilot.backup()
        self.pilot.verify_backup(backup)
        record = {
            "at": self.module.utc(),
            "backup": backup.name,
            "previousConfig": self.pilot.cfg,
            "imageID": self.config["imageID"],
            "expiresAt": None,
        }
        self.module.write_json(self.release / "return-point.json", record)
        self.owned_stop()
        try:
            self.module.write_json(
                self.root / "pilot.json",
                {
                    **self.pilot.cfg,
                    "image": self.config["image"],
                    "imageID": self.config["imageID"],
                    "applicationSource": self.release.name,
                },
            )
            next_pilot = self.module.Pilot(self.root)
            next_pilot.compose(
                "up",
                "-d",
                "--no-deps",
                "--wait",
                "--wait-timeout",
                "180",
                "kuma",
                "canary",
                timeout=240,
            )
            next_pilot.check_installation()
            next_pilot.container()
            next_pilot.container("canary")
            self.module.run(
                [
                    "docker",
                    "exec",
                    next_pilot.container()["Id"],
                    "node",
                    "extra/pilot-healthcheck.cjs",
                ],
                timeout=10,
            )
            if self.config.get("retainedState") is not None:
                if retained_state(self.root / "data") != self.config["retainedState"]:
                    raise ValueError("Release changed retained project state")
            if before != self.other_containers():
                raise ValueError("Other container state differs")
            self.module.write_json(
                self.release / "applied.json",
                {
                    "at": self.module.utc(),
                    "imageID": self.config["imageID"],
                    "previousImageID": self.pilot.cfg["imageID"],
                    "returnBackup": backup.name,
                    "otherContainersUnchanged": True,
                    "backupExpiry": None,
                },
            )
        except Exception:
            self.compensate(record)
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["stage", "apply", "rollback"])
    parser.add_argument("release", type=Path)
    parser.add_argument("--root", type=Path, default=Path("/srv/uptime-kuma-pilot"))
    args = parser.parse_args()
    upgrade = Upgrade(args.root, args.release)
    with upgrade.pilot.lock():
        if args.action == "stage":
            upgrade.stage()
        elif args.action == "apply":
            upgrade.apply()
        else:
            record = json.loads(
                ordinary(upgrade.release / "return-point.json").read_text()
            )
            if upgrade.pilot.cfg["imageID"] != upgrade.config["imageID"]:
                raise ValueError("Only the currently applied release can be returned")
            upgrade.no_active_jobs()
            upgrade.compensate(record)
    print(
        json.dumps(
            {
                "action": args.action,
                "release": upgrade.release.name,
                "result": "complete",
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit(
            "Owned release operation failed; inspect retained private reports. No unrelated service was selected."
        )
