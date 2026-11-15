"""Owner-operated work windows. This grants no right to change a monitored site."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import time

_spec = importlib.util.spec_from_file_location("_kuma_control_source", Path(__file__).with_name("source.py"))
_source = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_source)
adapters = _source.sibling("adapters")


@contextmanager
def owned_lock(directory, name):
    adapters.metadata(directory, directory=True, private=True)
    path = directory / (name + ".lock")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise ValueError("Unsafe announcement lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def profile_for(config, source_id):
    matches = [profile for profile in config["profiles"] if profile["id"] == source_id]
    if len(matches) != 1:
        raise ValueError("This site is not registered on this server")
    return matches[0]


def begin(config, source_id, kind, minutes, now_ms):
    profile = profile_for(config, source_id)
    if kind not in adapters.KINDS or type(minutes) is not int or not 5 <= minutes <= profile["minutes"]:
        raise ValueError("Invalid work declaration")
    directory = Path(config["announcements"])
    file = directory / (source_id + ".json")
    with owned_lock(directory, source_id):
        if file.exists() or file.is_symlink():
            raise ValueError("Existing work must be inspected and explicitly ended; its deadline cannot be refreshed")
        work = {"kind": kind, "phase": "applying", "startedAt": now_ms,
                "deadline": now_ms + minutes * 60000,
                "runID": hashlib.sha256(secrets.token_bytes(32)).hexdigest()}
        value = {"version": 1, "sourceID": source_id, "work": adapters.validate_work(work, now_ms)}
        _source.atomic_write(file, value)
        return value


def change(config, source_id, run_id, now_ms, phase=None, finish=False, result=None):
    profile_for(config, source_id)
    directory = Path(config["announcements"])
    file = directory / (source_id + ".json")
    with owned_lock(directory, source_id):
        value = adapters.read_json(file, private=True)
        if not isinstance(value, dict) or value.get("version") != 1:
            raise ValueError("Invalid work declaration")
        work = adapters.validate_work(value.get("work"), now_ms)
        if value.get("sourceID") != source_id or work["runID"] != run_id:
            raise ValueError("A different work window cannot be changed")
        if finish:
            history = directory / "history"
            history.mkdir(mode=0o700, exist_ok=True)
            adapters.metadata(history, directory=True, private=True)
            receipt = {**value, "endedAt": now_ms, "result": result}
            target = history / (source_id + "-" + run_id + ".json")
            if target.exists() or target.is_symlink():
                raise ValueError("Work completion already exists; inspect the receipt")
            _source.atomic_write(target, receipt)
            file.unlink()
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            return receipt
        if phase not in adapters.PHASES:
            raise ValueError("Invalid work phase")
        value["work"] = {**work, "phase": phase}
        _source.atomic_write(file, value)
        return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("/etc/uptime-kuma/site-work-sources.json"))
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ["begin", "phase", "end", "run"]:
        command = commands.add_parser(action)
        command.add_argument("source")
        if action in ["begin", "run"]:
            command.add_argument("--kind", choices=sorted(adapters.KINDS), default="update")
            command.add_argument("--minutes", type=int, default=30)
        if action in ["phase", "end"]:
            command.add_argument("run_id")
        if action == "phase":
            command.add_argument("phase", choices=sorted(adapters.PHASES))
        if action == "run":
            command.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PermissionError("Only the server owner may declare planned work")
    config = adapters.load_config(args.config)
    def now():
        return time.time_ns() // 1000000
    if args.action in ["begin", "run"]:
        if args.action == "run":
            arguments = args.command[1:] if args.command and args.command[0] == "--" else args.command
            if not arguments:
                raise ValueError("A work command is required")
        value = begin(config, args.source, args.kind, args.minutes, now())
        if args.action == "run":
            code = 1
            try:
                code = subprocess.run(arguments, check=False).returncode
            finally:
                change(config, args.source, value["work"]["runID"], now(), finish=True, result=code)
            raise SystemExit(code)
    elif args.action == "phase":
        value = change(config, args.source, args.run_id, now(), phase=args.phase)
    else:
        value = change(config, args.source, args.run_id, now(), finish=True)
    print(json.dumps(value, separators=(",", ":")))


if __name__ == "__main__":
    main()
