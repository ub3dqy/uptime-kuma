"""Export only explicit release markers. Never probe, restart or modify a site."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time


def sibling(name):
    if name not in {"adapters", "control"}:
        raise ValueError("Unknown observer module")
    spec = importlib.util.spec_from_file_location("_kuma_work_" + name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trusted(path, directory=False, owners=None):
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or info.st_mode & 0o022:
        raise ValueError("Untrusted release marker")
    if hasattr(os, "geteuid") and info.st_uid not in (owners if owners is not None else {os.geteuid()}):
        raise ValueError("Unexpected marker owner")
    if not directory and (info.st_nlink != 1 or info.st_size > 4096):
        raise ValueError("Invalid release marker")
    return info


def active_phase(proc, commit):
    phases = {"prepare": "preparing", "activate": "applying", "accept": "verifying", "open": "opening", "recover": "rolling_back"}
    for entry in list(proc.iterdir())[:8192]:
        if not entry.name.isdecimal():
            continue
        try:
            if entry.stat().st_uid != os.geteuid() or (entry / "comm").read_text().strip() != "bash":
                continue
            words = (entry / "cmdline").read_bytes()[:8192].split(b"\x00")
            command = [word.decode("ascii") for word in words[:5]]
            if len(command) >= 4 and command[0] in {"/bin/bash", "/usr/bin/bash", "bash"} and command[1] == f"/opt/compliance-navigator/releases/{commit}/ops/deploy/remote-production.sh" and command[3] == commit:
                return phases.get(command[2])
        except (OSError, UnicodeError):
            continue
    return None


def collect(root, now_ms, duration_minutes=30, proc=Path("/proc")):
    if not isinstance(duration_minutes, int) or not 5 <= duration_minutes <= 120:
        raise ValueError("Invalid work deadline")
    trusted(root, directory=True)
    shared = root / "shared"
    trusted(shared, directory=True)
    marker_dir = shared / "maintenance"
    trusted(marker_dir, directory=True)
    marker = marker_dir / "enabled"
    if not marker.exists() and not marker.is_symlink():
        return {"state": "idle", "observedAt": now_ms}
    info = trusted(marker)
    started = info.st_mtime_ns // 1_000_000
    if started > now_ms + 5000:
        raise ValueError("Future release marker")
    candidates = list(shared.glob("deploy-*"))
    if len(candidates) > 1000:
        raise ValueError("Too many release records")
    selected = []
    for candidate in candidates:
        if not re.fullmatch(r"deploy-[0-9a-f]{40}", candidate.name):
            continue
        metadata = trusted(candidate, directory=True)
        ended = False
        for name in ["completed", "rolled-back"]:
            completion = candidate / name
            if completion.exists() or completion.is_symlink():
                trusted(completion)
                ended = True
        if ended:
            continue
        if metadata.st_mtime_ns // 1_000_000 >= started - 60000:
            selected.append(candidate)
    phase = "working"
    if selected:
        phase = "preparing"
        latest = max(selected, key=lambda item: item.stat().st_mtime_ns)
        for name, value in [("activated", "verifying"), ("acceptance-passed", "opening"), ("opening", "opening")]:
            target = latest / name
            if target.exists() or target.is_symlink():
                trusted(target)
                phase = value
        phase = active_phase(proc, latest.name[7:]) or phase
    run_id = hashlib.sha256(f"{info.st_dev}:{info.st_ino}:{info.st_mtime_ns}".encode("ascii")).hexdigest()
    return {"state": "active", "observedAt": now_ms, "work": {"kind": "update" if selected else "maintenance", "phase": phase, "startedAt": started, "deadline": started + duration_minutes * 60000, "runID": run_id}}


def atomic_write(destination, value, mode=0o600, owner=None, group=None):
    parent = destination.parent
    trusted(parent, directory=True, owners={os.geteuid(), owner} if owner is not None else None)
    if destination.exists() or destination.is_symlink():
        info = destination.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("Unsafe observer destination")
    handle, name = tempfile.mkstemp(prefix=".site-work-", dir=parent)
    try:
        with os.fdopen(handle, "w", encoding="utf8") as stream:
            os.fchmod(stream.fileno(), mode)
            if owner is not None or group is not None:
                os.fchown(stream.fileno(), -1 if owner is None else owner, -1 if group is None else group)
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, destination)
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser()
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--root", type=Path)
    selection.add_argument("--config", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--read-group", required=True)
    parser.add_argument("--deadline-minutes", type=int, default=30)
    args = parser.parse_args()
    import grp
    try:
        if args.config:
            adapters = sibling("adapters")
            config = adapters.load_config(args.config)
            value = adapters.collect_many(config, time.time_ns() // 1_000_000, collect)
            # Preserve the original endpoint while an older main-node poller is
            # still running during the rolling observer update.
            if "compliance" in value["sources"]:
                value.update(value["sources"]["compliance"])
        else:
            value = collect(args.root, time.time_ns() // 1_000_000, args.deadline_minutes)
    except (OSError, ValueError):
        # A source error can never be turned into an 'idle' / completed claim.
        value = {"state": "unavailable", "observedAt": time.time_ns() // 1_000_000}
    atomic_write(args.output, value, 0o440, group=grp.getgrnam(args.read_group).gr_gid)


if __name__ == "__main__":
    main()
