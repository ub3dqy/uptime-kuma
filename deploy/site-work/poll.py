"""Pull a forced-command, pinned SSH source. Never accept site-supplied URLs."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import time
_spec = importlib.util.spec_from_file_location("_kuma_site_work_source", Path(__file__).with_name("source.py"))
_source = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_source)
atomic_write, trusted = _source.atomic_write, _source.trusted


def fetch_remote(config, limit=8192):
    # These are installation settings, not input from the monitored application.
    import ipaddress
    ipaddress.ip_address(config["host"])
    if config["user"] != "kuma-site-peer":
        raise ValueError("Unexpected source account")
    for key in ["hostKeyFile", "keyFile"]:
        trusted(Path(config[key]))
    command = ["/usr/bin/ssh", "-T", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=2", "-o", "ServerAliveCountMax=1", "-o", "UpdateHostKeys=no", "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UserKnownHostsFile=" + config["hostKeyFile"], "-i", config["keyFile"], config["user"] + "@" + config["host"]]
    result = subprocess.run(command, capture_output=True, timeout=9, check=True)
    if len(result.stdout) > limit:
        raise ValueError("Oversized source observation")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("Invalid source envelope")
    return value


def poll(config, now_ms):
    if set(config) != {"host", "hostKeyFile", "keyFile", "user", "monitorID", "ownerID", "siteHost", "output"}:
        raise ValueError("Unexpected observer configuration")
    if any(type(config[key]) is not int or config[key] < 1 for key in ["monitorID", "ownerID"]):
        raise ValueError("Invalid check identity")
    if not isinstance(config["siteHost"], str) or len(config["siteHost"]) > 253:
        raise ValueError("Invalid site host")
    value = fetch_remote(config, 4096)
    if value.get("state") not in {"active", "idle", "unavailable"}:
        raise ValueError("Invalid source observation")
    observed = value.get("observedAt")
    if type(observed) is not int or observed > now_ms + 5000 or now_ms - observed > 45000:
        raise ValueError("Stale source observation")
    record = {"monitorID": config["monitorID"], "ownerID": config["ownerID"], "host": config["siteHost"], "state": value["state"], "observedAt": observed}
    if value["state"] == "active":
        work = value.get("work")
        if not isinstance(work, dict) or len(json.dumps(work)) > 1024:
            raise ValueError("Invalid work observation")
        record["work"] = work
    return {"version": 1, "records": [record]}


def poll_many(config, now_ms):
    if not isinstance(config, dict) or set(config) != {"version", "localConfig", "remote", "bindings", "output"} or config["version"] != 2:
        raise ValueError("Invalid multi-site configuration")
    bindings = config["bindings"]
    if not isinstance(bindings, list) or not 1 <= len(bindings) <= 200:
        raise ValueError("Invalid monitored source count")
    identifiers = set()
    adapters = _source.sibling("adapters")
    for binding in bindings:
        if not isinstance(binding, dict) or set(binding) != {"origin", "sourceID", "monitorID", "ownerID", "siteHost"}:
            raise ValueError("Invalid source binding")
        if binding["origin"] not in {"local", "remote"} or not isinstance(binding["sourceID"], str) or not adapters.IDENTIFIER.fullmatch(binding["sourceID"]):
            raise ValueError("Invalid source origin")
        if any(type(binding[key]) is not int or binding[key] < 1 for key in ["monitorID", "ownerID"]):
            raise ValueError("Invalid check identity")
        if binding["monitorID"] in identifiers or not isinstance(binding["siteHost"], str) or not 1 <= len(binding["siteHost"]) <= 253:
            raise ValueError("Duplicate or invalid check binding")
        identifiers.add(binding["monitorID"])
    evidence = {"local": {}, "remote": {}}
    try:
        local_config = adapters.load_config(Path(config["localConfig"]))
        evidence["local"] = adapters.collect_many(local_config, now_ms, _source.collect)["sources"]
    except (OSError, ValueError, KeyError, TypeError):
        pass  # A local source failure never invalidates a healthy remote source.
    remote = config["remote"]
    if remote is not None:
        if not isinstance(remote, dict) or set(remote) != {"host", "hostKeyFile", "keyFile", "user"}:
            raise ValueError("Invalid remote source connection")
        try:
            value = fetch_remote(remote)
            if value.get("version") == 1 and isinstance(value.get("sources"), dict):
                evidence["remote"] = value["sources"]
            elif value.get("state") in {"active", "idle", "unavailable"}:
                evidence["remote"] = {"compliance": value}
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            pass  # Missing remote evidence does not pause local checks.
    records = []
    for binding in bindings:
        row = {"monitorID": binding["monitorID"], "ownerID": binding["ownerID"], "host": binding["siteHost"], "state": "unavailable", "observedAt": now_ms}
        value = evidence[binding["origin"]].get(binding["sourceID"])
        try:
            if not isinstance(value, dict) or value.get("state") not in {"active", "idle"}:
                raise ValueError("No trusted source observation")
            observed = value.get("observedAt")
            if type(observed) is not int or observed > now_ms + 5000 or now_ms - observed > 45000:
                raise ValueError("Stale source observation")
            row.update({"state": value["state"], "observedAt": observed})
            if value["state"] == "active":
                row["work"] = adapters.validate_work(value.get("work"), now_ms)
        except (ValueError, KeyError, TypeError):
            row.update({"state": "unavailable", "observedAt": now_ms})
            row.pop("work", None)
        records.append(row)
    return {"version": 1, "records": records}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    info = trusted(args.config)
    if info.st_mode & 0o077:
        raise ValueError("Observer config must be private")
    config = json.loads(args.config.read_text(encoding="utf8"))
    try:
        handler = poll_many if config.get("version") == 2 else poll
        value = handler(config, time.time_ns() // 1_000_000)
    except (OSError, ValueError, subprocess.SubprocessError):
        # Replace old evidence with an explicit unavailable signal. Never refresh
        # an earlier active record or move its original absolute deadline.
        value = {"version": 1, "records": []}
    atomic_write(Path(config["output"]), value, 0o600, owner=1000, group=1000)


if __name__ == "__main__":
    main()
