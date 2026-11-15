"""Read administrator-owned work declarations and existing release evidence."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat

MAXIMUM_DURATION = 7200000
KINDS = {"update", "backup", "maintenance", "rollback"}
PHASES = {"preparing", "applying", "verifying", "opening", "rolling_back", "working"}
IDENTIFIER = re.compile(r"[a-z][a-z0-9-]{0,39}\Z")


def metadata(path, directory=False, private=False, limit=65536):
    info = Path(path).lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_mode & 0o022 or info.st_uid != os.geteuid():
        raise ValueError("Unsafe work evidence")
    if private and info.st_mode & 0o077:
        raise ValueError("Work configuration must be private")
    if not directory and (info.st_nlink != 1 or info.st_size > limit):
        raise ValueError("Invalid work evidence size or links")
    return info


def read_json(path, private=False):
    metadata(path, private=private)
    return json.loads(Path(path).read_text(encoding="utf8"))


def validate_work(work, now_ms):
    if not isinstance(work, dict) or not isinstance(work.get("kind"), str) or not isinstance(work.get("phase"), str) or work["kind"] not in KINDS or work["phase"] not in PHASES:
        raise ValueError("Invalid work kind or phase")
    start, end = work.get("startedAt"), work.get("deadline")
    if type(start) is not int or type(end) is not int or not 0 < start < end <= start + MAXIMUM_DURATION or start > now_ms + 5000:
        raise ValueError("Invalid absolute work deadline")
    if not isinstance(work.get("runID"), str) or not re.fullmatch(r"[a-f0-9]{64}", work["runID"]):
        raise ValueError("Invalid work identity")
    return {key: work[key] for key in ["kind", "phase", "startedAt", "deadline", "runID"]}


def load_config(filename):
    config = read_json(filename, private=True)
    if not isinstance(config, dict) or set(config) != {"version", "announcements", "profiles"} or config["version"] != 1:
        raise ValueError("Invalid source configuration")
    directory = Path(config["announcements"])
    if not directory.is_absolute():
        raise ValueError("Absolute work directory required")
    metadata(directory, directory=True, private=True)
    profiles = config["profiles"]
    if not isinstance(profiles, list) or not 1 <= len(profiles) <= 20:
        raise ValueError("Invalid number of sources")
    names = []
    for profile in profiles:
        if not isinstance(profile, dict):
            raise ValueError("Invalid source profile")
        name = profile.get("id")
        if not isinstance(name, str) or not IDENTIFIER.fullmatch(name) or name in names:
            raise ValueError("Invalid or duplicate source")
        names.append(name)
        if type(profile.get("minutes")) is not int or not 5 <= profile["minutes"] <= 120:
            raise ValueError("Invalid source deadline")
        if profile.get("adapter") not in {"manual", "compliance", "directory", "lock", "receipt"}:
            raise ValueError("Unknown source adapter")
        if profile["adapter"] != "manual" and not Path(profile["path"]).is_absolute():
            raise ValueError("Absolute native evidence path required")
    return config


def generated_work(profile, identity, start, now_ms, phase="applying", kind="update"):
    return validate_work({"kind": kind, "phase": phase, "startedAt": start,
                          "deadline": start + profile["minutes"] * 60000,
                          "runID": hashlib.sha256((profile["id"] + ":" + identity).encode()).hexdigest()}, now_ms)


def lock_process(proc, process, info):
    if process.stat().st_uid != os.geteuid():
        raise ValueError("Untrusted maintenance lock owner")
    values = (process / "stat").read_text().rpartition(")")[2].split()
    ticks = int(values[19])
    boot = int(next(row.split()[1] for row in (proc / "stat").read_text().splitlines() if row.startswith("btime ")))
    return {"identity": f"{boot}:{process.name}:{ticks}:{info.st_ino}",
            "startedAt": boot * 1000 + ticks * 1000 // os.sysconf("SC_CLK_TCK"),
            "command": (process / "cmdline").read_bytes()[:8192].split(b"\x00")}


def inherited_holder(proc, info):
    # `flock -n 9` exits while its parent retains the shared descriptor. The
    # kernel keeps the exited child's PID, so inspect kernel fdinfo rather than
    # acquiring a site's lock or treating a missing PID as finished work.
    found = []
    for process in list(proc.iterdir())[:8192]:
        if not process.name.isdecimal():
            continue
        try:
            if process.stat().st_uid != os.geteuid():
                continue
            for descriptor in list((process / "fdinfo").iterdir())[:512]:
                try:
                    text = descriptor.read_text()[:4096]
                except OSError:
                    continue
                for line in text.splitlines():
                    if not line.startswith("lock:"):
                        continue
                    fields = line.split()[1:]
                    if len(fields) < 8 or fields[1] != "FLOCK" or fields[3] != "WRITE":
                        continue
                    major, minor, inode = fields[5].split(":")
                    if (int(major, 16), int(minor, 16), int(inode)) == (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino):
                        found.append(lock_process(proc, process, info))
                        break
        except (OSError, ValueError, IndexError, StopIteration):
            continue
    if not found:
        raise ValueError("Maintenance lock holder cannot be established")
    return min(found, key=lambda entry: (entry["startedAt"], entry["identity"]))


def held_lock(path, proc=Path("/proc")):
    file = Path(path)
    if not file.exists() and not file.is_symlink():
        info = file.parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise ValueError("Untrusted lock directory")
        return None
    info = metadata(file)
    for line in (proc / "locks").read_text().splitlines():
        fields = line.split()
        if len(fields) < 8 or fields[1] != "FLOCK" or fields[3] != "WRITE":
            continue
        major, minor, inode = fields[5].split(":")
        if (int(major, 16), int(minor, 16), int(inode)) != (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino):
            continue
        pid = int(fields[4])
        if pid > 0 and (proc / str(pid)).exists():
            return lock_process(proc, proc / str(pid), info)
        return inherited_holder(proc, info)
    return None


def native(profile, now_ms, compliance_reader, proc=Path("/proc")):
    adapter = profile["adapter"]
    if adapter == "manual":
        return None
    path = Path(profile["path"])
    if adapter == "compliance":
        result = compliance_reader(path, now_ms, profile["minutes"], proc)
        return result.get("work") if result["state"] == "active" else None
    if adapter != "lock" and not path.exists() and not path.is_symlink():
        metadata(path.parent, directory=True)
        return None
    if adapter == "directory":
        info = metadata(path, directory=True)
        start = info.st_mtime_ns // 1000000
        return generated_work(profile, f"{info.st_dev}:{info.st_ino}:{start}", start, now_ms)
    if adapter == "receipt":
        metadata(path, limit=8192)
        values = {}
        for line in path.read_text(encoding="ascii").splitlines():
            key, separator, value = line.partition("=")
            if not separator or key in values:
                raise ValueError("Malformed release receipt")
            values[key] = value
        state = values.get("state", "")
        if not re.fullmatch(r"[A-Z_]{1,40}", state) or values.get("receipt_end") != "v3":
            raise ValueError("Unrecognized release receipt")
        if not re.fullmatch(r"[0-9a-f]{40}", values.get("commit", "")):
            raise ValueError("Invalid release receipt identity")
        started = datetime.datetime.strptime(values["started_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
        phase = "rolling_back" if "ROLLBACK" in state else "verifying"
        return generated_work(profile, values["commit"] + ":" + values["release"], int(started.timestamp() * 1000), now_ms, phase)
    if adapter == "lock":
        lock = held_lock(path, proc)
        if lock is None:
            return None
        names = [Path(word.decode("utf8", errors="replace")).name for word in lock["command"]]
        kind = "update" if "github_deploy.py" in names else "maintenance"
        if "backup-run.sh" in names:
            kind = "backup"
        # Other lock adapters are dedicated activation locks, not general backup locks.
        if profile.get("dedicatedUpdate") is True:
            kind = "update"
        return generated_work(profile, lock["identity"], lock["startedAt"], now_ms, kind=kind)
    raise ValueError("Unsupported source")


def collect_many(config, now_ms, compliance_reader, proc=Path("/proc")):
    sources = {}
    for profile in config["profiles"]:
        try:
            flag = Path(config["announcements"]) / (profile["id"] + ".json")
            if flag.exists() or flag.is_symlink():
                value = read_json(flag, private=True)
                if not isinstance(value, dict) or value.get("sourceID") != profile["id"] or value.get("version") != 1:
                    raise ValueError("Mismatched work declaration")
                work = validate_work(value.get("work"), now_ms)
            else:
                work = native(profile, now_ms, compliance_reader, proc)
            sources[profile["id"]] = {"state": "active" if work else "idle", "observedAt": now_ms}
            if work:
                sources[profile["id"]]["work"] = work
        except (OSError, ValueError, KeyError, TypeError, StopIteration):
            sources[profile["id"]] = {"state": "unavailable", "observedAt": now_ms}
    return {"version": 1, "sources": sources}
