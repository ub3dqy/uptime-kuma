#!/usr/bin/env python3
"""Independent, outbound-only witness. No shell, incoming port or site credentials."""
import argparse
import base64
import contextlib
import datetime as dt
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import signal
import smtplib
import ssl
import stat
import sys
import time
from email.message import EmailMessage
from urllib.parse import urlencode, urlsplit


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def read_private(path, maximum=32768, *, systemd_credential=False):
    """Reject links, oversized files and ambiguous persisted objects."""
    path = Path(path)
    info = path.lstat()
    permission_mask = 0o077
    if systemd_credential:
        directory = path.parent
        parent = directory.lstat()
        # systemd represents a DynamicUser credential ACL with mode 0440.
        # Accept this only in its root-owned, private, read-only runtime mount;
        # ordinary configuration and state files keep the strict 0600 policy.
        if (
            os.name != "posix"
            or directory.parent != Path("/run/credentials")
            or directory.resolve() != directory
            or not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != 0
            or parent.st_gid != 0
            or stat.S_IMODE(parent.st_mode) not in (0o500, 0o550)
            or info.st_uid != 0
            or info.st_gid != 0
            or stat.S_IMODE(info.st_mode) not in (0o400, 0o440)
        ):
            raise ValueError("Invalid systemd credential")
        permission_mask = 0o037
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_size > maximum
        or (os.name == "posix" and info.st_mode & permission_mask)
    ):
        raise ValueError("Invalid private file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as source:
        opened = os.fstat(source.fileno())
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("Private file changed")
        if systemd_credential and not os.fstatvfs(source.fileno()).f_flag & os.ST_RDONLY:
            raise ValueError("Credential mount must be read-only")
        return json.loads(source.read(maximum + 1))


def write_state(path, value):
    """Durable no-follow write before any message is sent."""
    path = Path(path)
    if path.exists() and (path.is_symlink() or path.stat().st_nlink != 1):
        raise ValueError("Invalid state file")
    temporary = path.with_name(".state-" + secrets.token_hex(16))
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump(value, target, ensure_ascii=False, separators=(",", ":"))
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        if hasattr(os, "O_DIRECTORY"):
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def save_state(path, value):
    write_state(path, value)
    event = value.get("lastEvent")
    if event:
        if not isinstance(event.get("id"), str) or not re.fullmatch(
            r"[a-f0-9]{32}", event["id"]
        ):
            raise ValueError("Invalid event identity")
        directory = Path(path).parent / "events"
        if directory.is_symlink():
            raise ValueError("Invalid event directory")
        directory.mkdir(mode=0o700, exist_ok=True)
        write_state(directory / (event["id"] + ".json"), event)


def configuration(value):
    expected = {
        "version",
        "nodeID",
        "secret",
        "origin",
        "intervalSeconds",
        "timeoutSeconds",
        "failureThreshold",
        "recoveryThreshold",
        "channels",
    }
    if not isinstance(value, dict) or set(value) != expected or value["version"] != 1:
        raise ValueError("Invalid configuration")
    if not isinstance(value["nodeID"], str) or not re.fullmatch(
        r"[a-zA-Z0-9_-]{8,48}", value["nodeID"]
    ):
        raise ValueError("Invalid identity")
    if not isinstance(value["secret"], str) or not re.fullmatch(
        r"[a-zA-Z0-9_-]{43}", value["secret"]
    ):
        raise ValueError("Invalid authentication")
    origin = urlsplit(value["origin"])
    if (
        origin.scheme != "https"
        or not origin.hostname
        or origin.username
        or origin.password
        or origin.path not in ("", "/")
        or origin.query
        or origin.fragment
    ):
        raise ValueError("A fixed HTTPS origin is required")
    for field, minimum, maximum in [
        ("intervalSeconds", 20, 300),
        ("timeoutSeconds", 3, 15),
        ("failureThreshold", 2, 10),
        ("recoveryThreshold", 2, 10),
    ]:
        if type(value[field]) is not int or not minimum <= value[field] <= maximum:
            raise ValueError("Invalid observation limits")
    channels = value["channels"]
    if not isinstance(channels, list) or len(channels) > 2:
        raise ValueError("Invalid notification channels")
    seen = set()
    for channel in channels:
        if not isinstance(channel, dict) or channel.get("type") in seen:
            raise ValueError("Invalid notification channel")
        kind = channel.get("type")
        seen.add(kind)
        if kind == "email":
            if set(channel) != {
                "type",
                "host",
                "port",
                "security",
                "username",
                "password",
                "from",
                "to",
            }:
                raise ValueError("Invalid mail configuration")
            if (
                not isinstance(channel["host"], str)
                or not re.fullmatch(r"[a-zA-Z0-9.-]{1,253}", channel["host"])
                or type(channel["port"]) is not int
                or not 1 <= channel["port"] <= 65535
            ):
                raise ValueError("Invalid mail host")
            if channel["security"] not in ("tls", "starttls"):
                raise ValueError("Mail transport must use verified TLS")
            for field in ("from", "to"):
                if (
                    not isinstance(channel[field], str)
                    or not re.fullmatch(
                        r"[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+", channel[field]
                    )
                    or len(channel[field]) > 254
                ):
                    raise ValueError("One explicit mail address is required")
            for field in ("username", "password"):
                if (
                    not isinstance(channel[field], str)
                    or not 1 <= len(channel[field]) <= 4096
                    or "\x00" in channel[field]
                ):
                    raise ValueError("Invalid mail authentication")
        elif kind == "telegram":
            if (
                set(channel) != {"type", "botToken", "chatID"}
                or not isinstance(channel["botToken"], str)
                or not re.fullmatch(
                    r"[0-9]{5,20}:[a-zA-Z0-9_-]{20,100}", channel["botToken"]
                )
            ):
                raise ValueError("Invalid Telegram authentication")
            if not isinstance(channel["chatID"], str) or not re.fullmatch(
                r"-?[0-9]{1,24}|@[a-zA-Z0-9_]{5,64}", channel["chatID"]
            ):
                raise ValueError("Invalid Telegram recipient")
        else:
            raise ValueError("Unsupported notification channel")
    return value


def request_text(value):
    return "\n".join(
        [
            "uptime-kuma-witness/request/v1",
            value["nodeID"],
            str(value["timestamp"]),
            value["nonce"],
            ",".join(value["channels"]),
        ]
    )


def sign(config, text):
    key = base64.urlsafe_b64decode(config["secret"] + "=")
    return hmac.new(key, text.encode("utf-8"), hashlib.sha256).hexdigest()


@contextlib.contextmanager
def deadline(seconds):
    """Production Linux gets a total deadline, including slow response bodies."""
    supported = hasattr(signal, "setitimer")
    previous = None
    if supported:

        def timed_out(_number, _frame):
            raise TimeoutError("Operation deadline")

        previous = signal.signal(signal.SIGALRM, timed_out)
        signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        if supported:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)


def probe(config):
    origin = urlsplit(config["origin"])
    value = {
        "nodeID": config["nodeID"],
        "timestamp": int(time.time() * 1000),
        "nonce": secrets.token_urlsafe(32),
        "channels": sorted(channel["type"] for channel in config["channels"]),
    }
    value["signature"] = sign(config, request_text(value))
    connection = http.client.HTTPSConnection(
        origin.hostname,
        origin.port or 443,
        timeout=config["timeoutSeconds"],
        context=ssl.create_default_context(),
    )
    try:
        with deadline(config["timeoutSeconds"] + 2):
            connection.request(
                "POST",
                "/api/independent-witness/probe",
                json.dumps(value).encode("utf-8"),
                {"Content-Type": "application/json", "Cache-Control": "no-store"},
            )
            response = connection.getresponse()
            body = response.read(4097)
            if response.status != 200 or len(body) > 4096:
                return False
            answer = json.loads(body)
            if not isinstance(answer, dict) or set(answer) != {
                "version",
                "nodeID",
                "nonce",
                "timestamp",
                "ready",
                "signature",
            }:
                return False
            if (
                answer["version"] != 1
                or answer["ready"] is not True
                or answer["nodeID"] != value["nodeID"]
                or answer["nonce"] != value["nonce"]
                or type(answer["timestamp"]) is not int
                or abs(time.time() * 1000 - answer["timestamp"]) > 120000
                or not isinstance(answer["signature"], str)
            ):
                return False
            expected = sign(
                config,
                "\n".join(
                    [
                        "uptime-kuma-witness/response/v1",
                        request_text(value),
                        str(answer["timestamp"]),
                        "ready=1",
                    ]
                ),
            )
            return hmac.compare_digest(expected, answer["signature"])
    except Exception:
        return False
    finally:
        connection.close()


def advance(state, healthy, config):
    """A single failed probe or missing measurement never becomes a completed outage."""
    state["lastProbeAt"] = utc()
    state["failures"] = (
        0 if healthy else min(state.get("failures", 0) + 1, config["failureThreshold"])
    )
    state["successes"] = (
        min(state.get("successes", 0) + 1, config["recoveryThreshold"])
        if healthy
        else 0
    )
    event = None
    if (
        not healthy
        and state["failures"] >= config["failureThreshold"]
        and state.get("state") != "down"
    ):
        state["state"] = "down"
        event = "outage"
    elif healthy and state["successes"] >= config["recoveryThreshold"]:
        if state.get("state") == "down":
            event = "recovery"
        state["state"] = "up"
    if event:
        state["lastEvent"] = {
            "id": secrets.token_hex(16),
            "kind": event,
            "at": utc(),
            "channels": {},
        }
    return state


def notify(channel, event, config):
    subject = (
        "Мониторинг недоступен"
        if event["kind"] == "outage"
        else "Мониторинг снова доступен"
    )
    message = (
        f"{subject}\n{config['origin']}\nНезависимый узел: {config['nodeID']}\nВремя: {event['at']}\nСобытие: {event['id']}\n"
        + (
            "Причина пока не установлена. Основная установка не прошла несколько проверок доступности."
            if event["kind"] == "outage"
            else "Получены две последовательные успешные проверки основной установки."
        )
    )
    with deadline(20):
        if channel["type"] == "email":
            body = EmailMessage()
            body["From"], body["To"], body["Subject"] = (
                channel["from"],
                channel["to"],
                subject,
            )
            body["Message-ID"] = f"<{event['id']}@uptime-kuma-witness.local>"
            body.set_content(message)
            context = ssl.create_default_context()
            if channel["security"] == "tls":
                client = smtplib.SMTP_SSL(
                    channel["host"], channel["port"], timeout=12, context=context
                )
            else:
                client = smtplib.SMTP(channel["host"], channel["port"], timeout=12)
            with client:
                if channel["security"] == "starttls":
                    client.starttls(context=context)
                client.login(channel["username"], channel["password"])
                if client.send_message(body):
                    raise RuntimeError("Mail not accepted")
        else:
            connection = http.client.HTTPSConnection(
                "api.telegram.org", timeout=12, context=ssl.create_default_context()
            )
            try:
                body = urlencode({"chat_id": channel["chatID"], "text": message})
                connection.request(
                    "POST",
                    "/bot" + channel["botToken"] + "/sendMessage",
                    body,
                    {"Content-Type": "application/x-www-form-urlencoded"},
                )
                response = connection.getresponse()
                result = response.read(16385)
                if (
                    response.status != 200
                    or len(result) > 16384
                    or json.loads(result).get("ok") is not True
                ):
                    raise RuntimeError("Telegram not accepted")
            finally:
                connection.close()


def deliver(state, config, save, sender=notify):
    event = state.get("lastEvent")
    if not event:
        return
    for channel in config["channels"]:
        kind = channel["type"]
        if kind in event["channels"]:
            continue  # An interrupted/uncertain send is never silently repeated.
        event["channels"][kind] = {"status": "attempting", "at": utc()}
        save(state)
        try:
            sender(channel, event, config)
            status = "accepted"  # Provider acceptance is not recipient confirmation.
        except Exception:
            status = "uncertain"
        event["channels"][kind] = {"status": status, "at": utc()}
        save(state)


@contextlib.contextmanager
def exclusive(directory):
    """One sender per persisted state; duplicate service launches fail closed."""
    import fcntl

    descriptor = os.open(
        directory / ".witness.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("Invalid witness lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path)
    parser.add_argument(
        "--state", type=Path, default=Path("/var/lib/uptime-kuma-witness/state.json")
    )
    parser.add_argument("--once", action="store_true")
    arguments = parser.parse_args()
    try:
        config_path = (
            arguments.config
            or Path(os.environ["CREDENTIALS_DIRECTORY"]) / "witness-config"
        )
        config = configuration(
            read_private(config_path, systemd_credential=arguments.config is None)
        )
        arguments.state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    except Exception:
        print(
            json.dumps({"time": utc(), "error": "private_configuration_invalid"}),
            flush=True,
        )
        return 2
    with exclusive(arguments.state.parent):
        return run(config, arguments)


def run(config, arguments):
    state = (
        read_private(arguments.state)
        if arguments.state.exists()
        else {"version": 1, "state": "unknown", "failures": 0, "successes": 0}
    )
    if state.get("version") != 1 or state.get("state") not in ("unknown", "up", "down"):
        raise ValueError("Invalid state")
    stopping = False

    def stop(_number, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopping:
        began = time.monotonic()
        state = advance(state, probe(config), config)
        save = lambda value: save_state(arguments.state, value)
        save(state)
        deliver(state, config, save)
        print(
            json.dumps(
                {
                    "time": utc(),
                    "state": state["state"],
                    "failures": state["failures"],
                    "channelsConfigured": [
                        channel["type"] for channel in config["channels"]
                    ],
                    "lastEvent": {
                        kind: record["status"]
                        for kind, record in state.get("lastEvent", {})
                        .get("channels", {})
                        .items()
                    },
                }
            ),
            flush=True,
        )
        if arguments.once:
            break
        while not stopping and time.monotonic() - began < config["intervalSeconds"]:
            time.sleep(
                min(1, max(0, config["intervalSeconds"] - (time.monotonic() - began)))
            )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(
            json.dumps({"time": utc(), "error": "witness_state_unavailable"}),
            flush=True,
        )
        sys.exit(1)
