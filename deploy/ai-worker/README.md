# Private AI execution service

The monitoring instance owns projects, roles, individual encrypted ChatGPT/API
credentials, evidence consent, budgets and recovery approvals. The separate
service performs only the fixed OpenAI HTTPS operations. It cannot execute
commands, operate recovery recipes, or call the monitoring API. No account
credentials or evidence are retained on its disk. Its SQLite ledger retains
only request identities, timestamps and outcomes, without an expiry policy.
The supplied container disables core dumps and memory swapping. Do not enable
application request logging or an external crash collector containing memory.

For a two-server installation, use a separately qualified immutable image
under `/srv/uptime-kuma-ai-worker` on your worker host. Run only this Compose
project (`uptime-kuma-ai-worker`). Port 3047 is published on host loopback only.
The configuration is an ordinary, single-link, mode-0600 file owned by UID 1000:
`{"version":1,"workerID":"<opaque stable installation ID>","secret":"<32 random bytes as base64url>"}`.
The data directory must be UID 1000 and mode 0700. Never put either file in Git.

Copy the SSH templates to your own configuration directory and replace
`__PEER_IPV4__` with the worker address, `__PRIMARY_IPV4__` with the
primary server address and `__DOCKER_GATEWAY_IPV4__` with the gateway of
your Kuma Docker network. In documentation, `192.0.2.10` and
`198.51.100.20` are example addresses for the primary and worker servers.

Generate a new dedicated SSH key on the primary host under
`/var/lib/uptime-kuma-ai-tunnel`. Do not reuse an owner's key or broaden the
Telegram account. Install the peer account and its source-address-limited
authorized key with `restrict,port-forwarding,permitopen="127.0.0.1:3047"`.
Validate `sshd -t` and compare every existing account's effective SSH policy
before reloading SSH. The supplied Match block permits only that destination,
with no sessions, commands, reverse forwarding or agent forwarding.

Pin the already verified peer host key. Install the tunnel service and client
configuration. Permit incoming port 19087 only from the owned Docker bridge,
on that bridge's actual interface, source subnet and gateway. Never open either
AI port to the Internet. Confirm the bridge identity before installation.

On the primary, create `data/ai-worker/config.json` (parent 0700, file 0600,
UID 1000), using `http://__DOCKER_GATEWAY_IPV4__:19087` as the endpoint
after substituting your gateway. Use a label such as `AI worker`. An absent configuration
preserves local installations; an invalid explicit configuration fails closed.
Requests and replies are encrypted with AES-256-GCM, separately signed with
HMAC-SHA256 and bound to a fresh nonce, timestamp and request identity. Redirects
are refused and HTTPS certificate verification remains enabled. Started
requests survive restart as uncertain and are never automatically replayed.

The connection badge is a signed health check to this service, not an inference
or proof of account access. Each project administrator must complete their own
official ChatGPT sign-in or enter their API key, select an account-specific
model, then explicitly test it. A partial stream is never a completed result.
Automatic diagnosis and owner-approved recovery keep their existing gates.

Before changing a release, retain the previous image, both operator
configurations, tunnel identity and a consistent SQLite backup with protected
permissions. Keep these backups indefinitely. Back up the peer ledger using
SQLite's backup API, not a live copy of only the main database file. The primary
backup includes its AI route configuration and encrypted individual grants.
Rollback to a qualified image retaining this transport preserves the AI link;
an older image cannot use the new route. Monitoring continues independently
of AI service availability.

OpenAI's [self-hosted VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
and [models and inference protocol](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
remain authoritative for the per-account login and completed Responses flow.
