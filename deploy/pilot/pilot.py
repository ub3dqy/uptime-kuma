#!/usr/bin/env python3
"""Operate one pinned, private Uptime Kuma pilot without touching other services."""
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import ipaddress
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import uuid
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
OWNER_LABEL = "uptime-kuma"


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def run(args, *, timeout=120, env=None):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env)
    if result.returncode:
        # Deliberately omit command output: app/container output can contain secrets.
        raise RuntimeError(f"Command failed: {args[0]} (exit {result.returncode})")
    return result.stdout.strip()


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_json(path, value):
    temp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with temp.open("x", encoding="utf-8") as output:
        os.chmod(temp, 0o600)
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp, path)


def safe_directory(root, name):
    target = root / name
    if target.is_symlink() or target.resolve().parent != root.resolve():
        raise ValueError("Directory must stay inside this installation")
    target.mkdir(mode=0o700, exist_ok=True)
    return target


def load_config(root):
    path = root / "pilot.json"
    if path.is_symlink():
        raise ValueError("Config cannot be a link")
    cfg = json.loads(path.read_text(encoding="utf-8-sig"))
    if not re.fullmatch(r"(?:uptime-kuma-pilot|kuma-pilot-test-[a-f0-9]{8})", cfg.get("project", "")):
        raise ValueError("Unexpected project name")
    if not re.fullmatch(r"ub3dqy/uptime-kuma:pilot-[a-f0-9]{7,40}", cfg.get("image", "")):
        raise ValueError("Unexpected image tag")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", cfg.get("imageID", "")):
        raise ValueError("Expected immutable image ID is required")
    if type(cfg.get("port")) is not int or not 1024 <= cfg["port"] <= 65535:
        raise ValueError("Invalid loopback port")
    if cfg.get("days", 7) != 7:
        raise ValueError("This qualification plan is seven days")
    if "telegramControl" in cfg and type(cfg["telegramControl"]) is not bool:
        raise ValueError("Telegram control must be explicitly enabled by the installer")
    if cfg.get("notificationProxy"):
        proxy = urlsplit(cfg["notificationProxy"])
        if (
            proxy.scheme != "socks5h"
            or proxy.username
            or proxy.password
            or proxy.port != 19080
            or proxy.path
            or proxy.query
            or proxy.fragment
            or ipaddress.ip_address(proxy.hostname)
            not in ipaddress.ip_network("172.16.0.0/12")
        ):
            raise ValueError("Notification relay must use the private Docker bridge")
    return cfg


class Pilot:
    def __init__(self, root=ROOT):
        self.root = root.resolve()
        self.cfg = load_config(self.root)
        self.project = self.cfg["project"]
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("COMPOSE_")}
        self.env.update(
            KUMA_IMAGE=self.cfg["image"],
            KUMA_PORT=str(self.cfg["port"]),
            KUMA_NOTIFICATION_PROXY=self.cfg.get("notificationProxy") or "",
            KUMA_TELEGRAM_CONTROL_CONFIG="/app/data/telegram-control/config.json" if self.cfg.get("telegramControl") else "",
        )
        self.compose_args = ["docker", "compose", "--project-directory", str(self.root), "-p", self.project, "-f", str(self.root / "compose.yaml")]

    def compose(self, *args, timeout=180):
        return run([*self.compose_args, *args], env=self.env, timeout=timeout)

    def engine(self):
        return run(["docker", "info", "--format", "{{.ID}}"])

    def check_pin(self):
        image = json.loads(run(["docker", "image", "inspect", self.cfg["image"]]))[0]
        if image["Id"] != self.cfg["imageID"] or image["Architecture"] != "amd64" or image["Os"] != "linux":
            raise ValueError("Image identity or platform differs from the qualified build")

    def container(self, service="kuma"):
        ids = run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={self.project}", "--filter", f"label=com.docker.compose.service={service}"]).split()
        if len(ids) != 1:
            raise ValueError("Expected exactly one owned container")
        item = json.loads(run(["docker", "inspect", ids[0]]))[0]
        labels = item["Config"].get("Labels", {})
        if labels.get("com.ub3dqy.pilot") != OWNER_LABEL or item["Image"] != self.cfg["imageID"]:
            raise ValueError("Container ownership or image mismatch")
        if service == "kuma":
            mounts = [entry for entry in item["Mounts"] if entry["Destination"] == "/app/data"]
            if len(mounts) != 1 or Path(mounts[0]["Source"]).resolve() != (self.root / "data").resolve():
                raise ValueError("Unexpected data mount")
        return item

    def check_installation(self):
        state = json.loads((self.root / "installation.json").read_text(encoding="utf-8"))
        if state["engineID"] != self.engine() or state["project"] != self.project or state["root"] != str(self.root):
            raise ValueError("Installation belongs to another engine or directory")
        self.check_pin()
        safe_directory(self.root, "data")

    @contextlib.contextmanager
    def lock(self):
        # Production runs on Linux; an advisory file lock also survives process crashes.
        import fcntl
        path = self.root / ".operation.lock"
        if path.is_symlink():
            raise ValueError("Lock cannot be a link")
        with path.open("a") as stream:
            os.chmod(path, 0o600)
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def initialize(self):
        if os.name != "posix" or os.geteuid() != 0:
            raise ValueError("Initialize this dedicated installation as root on Linux")
        self.check_pin()
        state_path = self.root / "installation.json"
        if state_path.exists() or (self.root / "data").exists():
            raise ValueError("Installation already exists; initialization never adopts data")
        if run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={self.project}"]):
            raise ValueError("Project name is already used")
        if shutil.disk_usage(self.root).free < 4 * 1024 ** 3:
            raise ValueError("At least 4 GiB free is required before starting")
        data = safe_directory(self.root, "data")
        os.chown(data, 1000, 1000)
        safe_directory(self.root, "backups")
        safe_directory(self.root, "reports")
        write_json(state_path, {"root": str(self.root), "engineID": self.engine(), "project": self.project, "initializedAt": utc()})

    def start(self):
        self.check_installation()
        self.compose("up", "-d", "--pull", "never", "--wait", "--wait-timeout", "180", timeout=240)
        self.container()
        self.container("canary")

    def sample(self):
        self.check_installation()
        item = self.container()
        state = item["State"]
        row = {"time": utc(), "status": state["Status"], "health": state.get("Health", {}).get("Status", "missing"),
               "running": state["Running"], "oomKilled": state["OOMKilled"], "restartCount": item["RestartCount"],
               "startedAt": state["StartedAt"], "freeBytes": shutil.disk_usage(self.root).free,
               "dataBytes": sum(p.stat().st_size for p in (self.root / "data").rglob("*") if p.is_file() and not p.is_symlink())}
        if state["Running"]:
            row["stats"] = json.loads(run(["docker", "stats", "--no-stream", "--format", "{{json .}}", item["Id"]]))
        directory = safe_directory(self.root, "reports")
        path = directory / (dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d") + ".jsonl")
        if path.is_symlink():
            raise ValueError("Report cannot be a link")
        with path.open("a", encoding="utf-8") as output:
            os.chmod(path, 0o600)
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
        return row

    def backup(self):
        self.check_installation()
        item = self.container()
        data = self.root / "data"
        size = sum(path.stat().st_size for path in data.rglob("*") if path.is_file() and not path.is_symlink())
        if shutil.disk_usage(self.root).free < max(1024 ** 3, size * 3):
            raise ValueError("Insufficient free space; app was not stopped")
        backup_dir = safe_directory(self.root, "backups")
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
        destination = backup_dir / (stamp + ".tar.gz")
        temporary = destination.with_suffix(".partial")
        was_running = item["State"]["Running"]
        metadata = {"startedAt": utc(), "imageID": self.cfg["imageID"], "plannedStop": was_running}
        try:
            if was_running:
                self.compose("stop", "--timeout", "60", "kuma")
            stopped = self.container()
            if stopped["State"]["Running"] or stopped["State"]["ExitCode"] != 0:
                raise ValueError("Clean app shutdown is required for a coherent full backup")
            with temporary.open("xb") as stream:
                os.chmod(temporary, 0o600)
                with tarfile.open(fileobj=stream, mode="w:gz") as archive:
                    for path in sorted(data.rglob("*")):
                        if path.is_symlink() or not (path.is_dir() or path.is_file()):
                            raise ValueError("Unexpected special file in app data")
                        archive.add(path, arcname=str(path.relative_to(data)), recursive=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            metadata.update(archive=destination.name, sha256=sha256(destination), bytes=destination.stat().st_size, completedAt=utc())
            write_json(destination.with_suffix(".json"), metadata)
        finally:
            # Restart only the previously running, positively identified pilot app.
            if was_running:
                self.container()
                self.compose("start", "--wait", "--wait-timeout", "180", "kuma", timeout=240)
                metadata["restartCompletedAt"] = utc()
                if "archive" in metadata:
                    write_json(destination.with_suffix(".json"), metadata)
        return destination

    def verify_backup(self, archive_path):
        self.check_installation()
        archive_path = archive_path.resolve()
        backup_dir = safe_directory(self.root, "backups").resolve()
        if archive_path.parent != backup_dir or not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\.tar\.gz", archive_path.name):
            raise ValueError("Restore accepts only this installation's backups")
        metadata = json.loads(archive_path.with_suffix(".json").read_text(encoding="utf-8"))
        if metadata["sha256"] != sha256(archive_path) or metadata["imageID"] != self.cfg["imageID"]:
            raise ValueError("Backup checksum or image identity mismatch")
        restore_root = safe_directory(self.root, ".restore")
        work = Path(tempfile.mkdtemp(prefix="drill-", dir=restore_root))
        try:
            extract_backup(archive_path, work)
            cfg = json.loads((work / "db-config.json").read_text(encoding="utf-8"))
            if cfg.get("type") != "sqlite":
                raise ValueError("This restore procedure is for SQLite only")
            db = sqlite3.connect(str(work / "kuma.db"))
            try:
                if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("Restored database failed integrity check")
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not {"monitor", "heartbeat", "client_group", "client_group_monitor"}.issubset(tables):
                    raise ValueError("Required fork tables are missing")
                counts = {name: db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] for name in ["monitor", "heartbeat", "client_group", "client_group_monitor"]}
            finally:
                db.close()
            result = {"time": utc(), "archive": archive_path.name, "sha256": metadata["sha256"], "integrity": "ok", "tables": counts, "liveDataUntouched": True}
            write_json(archive_path.with_suffix(".verified.json"), result)
            return result
        finally:
            # This directory was freshly created above and is never a live data path.
            if work.resolve().parent != restore_root.resolve() or work.is_symlink():
                raise ValueError("Refuse cleanup outside the private restore area")
            shutil.rmtree(work)

    def arm(self):
        self.check_installation()
        item = self.container()
        if item["State"].get("Health", {}).get("Status") != "healthy":
            raise ValueError("Healthy app required before arming the seven-day trial")
        with contextlib.closing(sqlite3.connect(f"file:{self.root / 'data/kuma.db'}?mode=ro", uri=True)) as db:
            if db.execute('SELECT COUNT(*) FROM "user" WHERE active = 1').fetchone()[0] < 1:
                raise ValueError("Create the owner account before arming")
        if (self.root / "trial.json").exists():
            raise ValueError("Trial is already armed; start time will not be reset")
        now = dt.datetime.now(dt.timezone.utc)
        write_json(self.root / "trial.json", {"startedAt": now.isoformat(), "endsAt": (now + dt.timedelta(days=7)).isoformat(), "imageID": self.cfg["imageID"], "durationDays": 7})

    def period_evidence(self, start, end, filename):
        start = dt.datetime.fromisoformat(start.replace("Z", "+00:00")).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        end = dt.datetime.fromisoformat(end.replace("Z", "+00:00")).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        evidence = json.loads(run(["docker", "exec", self.container()["Id"], "node", "extra/pilot-daily-report.cjs", start, end]))
        write_json(safe_directory(self.root, "reports") / filename, evidence)
        return end

    def tick(self):
        self.check_installation()
        trial = json.loads((self.root / "trial.json").read_text(encoding="utf-8"))
        now = dt.datetime.now(dt.timezone.utc)
        sample = self.sample()
        state_path = self.root / "daily-backup.json"
        previous = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
        if now >= dt.datetime.fromisoformat(trial["endsAt"]) and not (self.root / "trial-result.json").exists():
            evidence_status = "complete"
            try:
                self.period_evidence(previous.get("windowEnd", trial["startedAt"]), trial["endsAt"], "final-checks.json")
            except Exception:
                # Keep the observed service result honest even if the app cannot export.
                evidence_status = "failed-requires-owner-review"
            start = dt.datetime.fromisoformat(trial["startedAt"])
            expected = 7 * 24 * 12
            slots = {}
            for path in sorted((self.root / "reports").glob("*.jsonl")):
                for line in path.read_text(encoding="utf-8").splitlines():
                    row = json.loads(line)
                    slot = int((dt.datetime.fromisoformat(row["time"].replace("Z", "+00:00")) - start).total_seconds() // 300)
                    if 0 <= slot < expected:
                        healthy = row["health"] == "healthy" and row["running"] and not row["oomKilled"]
                        slots[slot] = slots.get(slot, True) and healthy
            write_json(self.root / "trial-result.json", {"finishedAt": utc(), "state": "awaiting-owner-review", "expectedSlots": expected,
                "observedSlots": len(slots), "healthySlots": sum(slots.values()), "unhealthySlots": len(slots) - sum(slots.values()),
                "missingSlots": expected - len(slots), "missingSlotsNeverCountAsHealthy": True, "finalPeriodEvidence": evidence_status})
        if sample["health"] != "healthy" or not sample["running"] or sample["oomKilled"]:
            raise RuntimeError("Pilot health failed; see the recorded sample")
        # One attempt per Moscow backup day; failure cannot cause repeated pauses every 5 minutes.
        # Export before Kuma's 03:14 raw-history cleanup, then take the full backup.
        backup_day = (now.astimezone(ZoneInfo("Europe/Moscow")) - dt.timedelta(hours=3, minutes=10)).date().isoformat()
        if previous.get("backupDay") != backup_day:
            cursor = {"windowEnd": previous.get("windowEnd", trial["startedAt"])}
            write_json(state_path, {**cursor, "backupDay": backup_day, "attemptedAt": utc(), "status": "started"})
            report_status = "complete"
            try:
                window_end = self.period_evidence(cursor["windowEnd"], now.isoformat(), backup_day + "-checks.json")
                cursor["windowEnd"] = window_end
            except Exception:
                # Export failures must never disable scheduled recovery copies.
                report_status = "failed"
            try:
                archive = self.backup()
                result = self.verify_backup(archive)
                write_json(state_path, {**cursor, "backupDay": backup_day, "completedAt": utc(), "status": "verified", "archive": result["archive"], "reportStatus": report_status})
            except Exception:
                write_json(state_path, {**cursor, "backupDay": backup_day, "failedAt": utc(), "status": "failed", "reportStatus": report_status})
                raise
            if report_status == "failed":
                raise RuntimeError("Daily report failed; the full backup was verified")


def extract_backup(path, destination):
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            target = destination / member.name
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()) or target.resolve() == destination.resolve() or not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError("Unsafe backup member")
        # Python's data filter intentionally drops directory modes. Keep every
        # newly created restore directory private, including retained key rings.
        previous_mask = os.umask(0o077)
        try:
            archive.extractall(destination, members=members, filter="data")
        finally:
            os.umask(previous_mask)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["init", "start", "sample", "backup", "verify-backup", "arm", "tick"])
    parser.add_argument("archive", nargs="?")
    args = parser.parse_args()
    pilot = Pilot()
    with pilot.lock():
        if args.action == "init": pilot.initialize()
        elif args.action == "start": pilot.start()
        elif args.action == "sample":
            sample = pilot.sample()
            print(json.dumps(sample))
            if sample["health"] != "healthy" or not sample["running"] or sample["oomKilled"]: raise RuntimeError("Pilot health failed")
        elif args.action == "backup": print(str(pilot.backup()))
        elif args.action == "verify-backup": print(json.dumps(pilot.verify_backup(Path(args.archive))))
        elif args.action == "arm": pilot.arm()
        elif args.action == "tick": pilot.tick()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error))
