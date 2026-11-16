import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / "deploy/witness/witness.py"
spec = importlib.util.spec_from_file_location("witness", source)
witness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(witness)


def config():
    return {
        "version": 1,
        "nodeID": "synthetic-witness",
        "secret": base64.urlsafe_b64encode(bytes([42]) * 32).decode().rstrip("="),
        "origin": "https://monitor.example",
        "intervalSeconds": 30,
        "timeoutSeconds": 5,
        "failureThreshold": 3,
        "recoveryThreshold": 2,
        "channels": [],
    }


class WitnessTests(unittest.TestCase):
    def test_site_list_is_bounded_and_private_addresses_are_refused_at_connection(self):
        sites = [{"id": 7, "url": "https://example.com/"}]
        parsed = witness.configuration({**config(), "sites": sites})
        self.assertEqual(parsed["sites"], sites)
        for bad in ([*sites, sites[0]], [{"id": 7, "url": "https://me:secret@example.com/"}]):
            with self.assertRaises(ValueError):
                witness.configuration({**config(), "sites": bad})

        answers = [
            (witness.socket.AF_INET, witness.socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
            (witness.socket.AF_INET, witness.socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
        ]
        with patch.object(witness.socket, "getaddrinfo", return_value=answers):
            with patch.object(witness.socket, "create_connection", return_value="fixture-socket") as connect:
                self.assertEqual(witness.public_connection("example.com", 443, 2), "fixture-socket")
                connect.assert_called_once_with(("1.1.1.1", 443), 2)

    def test_site_values_are_bound_into_the_witness_signature(self):
        value = {
            "nodeID": "synthetic-witness", "timestamp": 1777777777000, "nonce": "a" * 43, "channels": [],
            "sites": [{"id": 7, "hash": "f" * 64, "checkedAt": 1777777776999, "httpStatus": 503, "responseMS": 12}],
        }
        signed = witness.request_text(value)
        self.assertTrue(signed.startswith("uptime-kuma-witness/request/v2\n"))
        self.assertTrue(signed.endswith("7:" + "f" * 64 + ":1777777776999:503:12"))
        changed = copy.deepcopy(value)
        changed["sites"][0]["httpStatus"] = 200
        self.assertNotEqual(witness.sign(config(), signed), witness.sign(config(), witness.request_text(changed)))

    @unittest.skipUnless(os.name == "posix", "Linux file permissions")
    def test_group_read_is_rejected_outside_a_systemd_credential_mount(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            path.write_text(json.dumps(config()))
            path.chmod(0o440)
            with self.assertRaises(ValueError):
                witness.read_private(path)
            with self.assertRaises(ValueError):
                witness.read_private(path, systemd_credential=True)

    def test_only_a_verified_response_for_this_nonce_proves_readiness(self):
        value = config()

        class Response:
            status = 200

            def __init__(self, body):
                self.body = body

            def read(self, _limit):
                return self.body

        class Connection:
            changed = False

            def __init__(self, *args, **kwargs):
                self.request_body = None

            def request(self, method, path, body, headers):
                self.assert_path = path
                self.request_body = json.loads(body)

            def getresponse(self):
                request = self.request_body
                stamp = int(time.time() * 1000)
                answer = {
                    "version": 1,
                    "nodeID": request["nodeID"],
                    "nonce": request["nonce"],
                    "timestamp": stamp,
                    "ready": True,
                }
                answer["signature"] = witness.sign(
                    value,
                    "\n".join(
                        [
                            "uptime-kuma-witness/response/v1",
                            witness.request_text(request),
                            str(stamp),
                            "ready=1",
                        ]
                    ),
                )
                if self.changed:
                    answer["nonce"] = "another-nonce"
                return Response(json.dumps(answer).encode())

            def close(self):
                pass

        with patch.object(witness.http.client, "HTTPSConnection", Connection):
            self.assertTrue(witness.probe(value))
            Connection.changed = True
            self.assertFalse(witness.probe(value))

        class Redirect(Connection):
            def getresponse(self):
                result = Response(b"not readiness")
                result.status = 302
                return result

        with patch.object(witness.http.client, "HTTPSConnection", Redirect):
            self.assertFalse(witness.probe(value))

    def test_configuration_requires_tls_and_explicit_closed_channels(self):
        value = config()
        self.assertEqual(witness.configuration(value), value)
        for changed in [
            {"origin": "http://monitor.example"},
            {"origin": "https://user:password@monitor.example"},
            {"origin": "https://monitor.example/path?secret=value"},
            {"intervalSeconds": 0},
            {"channels": [{"type": "shell"}]},
        ]:
            with self.assertRaises(ValueError):
                witness.configuration({**value, **changed})

    def test_three_failures_and_two_successes_preserve_outage_across_restart(self):
        value = config()
        state = {"version": 1, "state": "unknown", "failures": 0, "successes": 0}
        for _ in range(2):
            state = witness.advance(state, False, value)
            self.assertNotIn("lastEvent", state)
        state = witness.advance(state, False, value)
        self.assertEqual(state["state"], "down")
        event = state["lastEvent"]["id"]
        state = witness.advance(json.loads(json.dumps(state)), False, value)
        self.assertEqual(state["lastEvent"]["id"], event)
        state = witness.advance(state, True, value)
        self.assertEqual(state["state"], "down")
        state = witness.advance(state, True, value)
        self.assertEqual(state["state"], "up")
        self.assertEqual(state["lastEvent"]["kind"], "recovery")

    def test_message_acceptance_uncertainty_and_crash_never_cause_silent_replay(self):
        value = config()
        value["channels"] = [{"type": "email"}, {"type": "telegram"}]
        state = {
            "lastEvent": {
                "id": "synthetic",
                "kind": "outage",
                "at": witness.utc(),
                "channels": {},
            }
        }
        saved, sends = [], []

        def save(data):
            saved.append(copy.deepcopy(data))

        def send(channel, _event, _config):
            self.assertEqual(
                saved[-1]["lastEvent"]["channels"][channel["type"]]["status"],
                "attempting",
            )
            sends.append(channel["type"])
            if channel["type"] == "telegram":
                raise TimeoutError("Synthetic ambiguous provider response")

        witness.deliver(state, value, save, send)
        self.assertEqual(state["lastEvent"]["channels"]["email"]["status"], "accepted")
        self.assertEqual(
            state["lastEvent"]["channels"]["telegram"]["status"], "uncertain"
        )
        witness.deliver(json.loads(json.dumps(state)), value, save, send)
        self.assertEqual(sends, ["email", "telegram"])
        interrupted = {
            "lastEvent": {
                "id": "synthetic2",
                "kind": "outage",
                "at": witness.utc(),
                "channels": {},
            }
        }

        def crash(*_arguments):
            raise KeyboardInterrupt()

        with self.assertRaises(KeyboardInterrupt):
            witness.deliver(interrupted, value, save, crash)
        recovered = saved[-1]
        value["channels"] = [{"type": "email"}]
        witness.deliver(recovered, value, save, send)
        self.assertEqual(len(sends), 2)

    def test_atomic_state_round_trip_retains_unknown_delivery(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            value = {
                "version": 1,
                "state": "down",
                "lastEvent": {"channels": {"email": {"status": "attempting"}}},
            }
            witness.write_state(path, value)
            self.assertEqual(witness.read_private(path), value)
            self.assertEqual(len(list(Path(folder).iterdir())), 1)

    def test_events_remain_after_recovery_without_retention_expiry(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            first = {
                "version": 1,
                "lastEvent": {"id": "a" * 32, "kind": "outage", "channels": {}},
            }
            second = {
                "version": 1,
                "lastEvent": {"id": "b" * 32, "kind": "recovery", "channels": {}},
            }
            witness.save_state(path, first)
            witness.save_state(path, second)
            self.assertEqual(len(list((Path(folder) / "events").iterdir())), 2)
            self.assertEqual(
                witness.read_private(Path(folder) / "events" / ("a" * 32 + ".json")),
                first["lastEvent"],
            )


if __name__ == "__main__":
    unittest.main()
