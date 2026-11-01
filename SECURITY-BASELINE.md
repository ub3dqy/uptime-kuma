# Dependency baseline — 31 October 2026

This independent fork remains a development edition. These checks do not establish
the security of the complete application or of a production deployment.

## Locked dependency tree

All 157 original direct dependencies were checked against the official npm registry.
115 declarations were updated, replaced or removed; 42 already matched the selected
release. The resulting manifest has 155 direct packages, including explicit parser
and compiler compatibility packages. The lockfile pins the complete resolved tree.
All nested package manifests were inspected too. The TypeScript push example now
runs directly on Node 24; its four old development dependencies are unnecessary
and were removed. The other nested manifests declare no additional packages.

| Check                     | Previously published fork | Updated locked tree |
| ------------------------- | ------------------------- | ------------------- |
| Production-only npm audit | 13: 11 moderate, 2 low    | 0 advisories        |
| Complete npm audit        | 40: 38 moderate, 2 low    | 0 advisories        |

These are registry classifications and dependency propagation counts, not counts
of independently reproduced exploits. Browser packages declared as development
dependencies were included: they become part of the deployed interface.

## Compatibility changes

- Use **Node.js 24.22.2 LTS, branch 24.x**. Runtime, build and development commands use
  the same supported branch. Node.js 26 was also exercised during investigation, but
  the current SSH library's optional native accelerator does not build there.
  The selected 24.22.2 release builds that accelerator successfully. Older system
  Node installations were not replaced as part of this work.
- Docker's main, push-helper and auxiliary stages use the selected Node runtime.
  The healthcheck is built from source with Go 1.27.3; the old Debian Buster/Node 18
  builder and prebuilt upstream healthcheck image are no longer required.
- The archived SQLite driver was replaced with current better-sqlite3 13.0.3.
  Queries run in workers so a busy database does not block monitoring timers.
  The Knex SQLite dialect and existing database format are preserved. The package
  bundles SQLite 3.53.4; this is not a claim that it bundles the newest SQLite engine.
- The old TLS-table migration now rebuilds the table through public SQL operations.
  It preserves rows, the identifier sequence and cascading ownership. SQLite's
  defensive mode remains enabled; direct writes to sqlite_master are unnecessary.
- Express 5 routes preserve optional badge durations and first-run setup. Axios,
  database/network clients, MQTT 5 and the remote-browser Playwright client were
  updated. Redis authentication failures now reject cleanly and close the socket;
  a failing connection previously caused an unhandled rejection. A remote Playwright server must use the same 1.64.1 protocol version.
- The sole OAuth client-credentials helper uses current Axios and preserves both
  secret authentication methods, scope, audience, expiry and a ten-second timeout.
  Redirects are refused and errors omit request credentials.
- Croner 11 preserves legacy question-mark placeholders and range steps through a
  compatibility helper. Stored expressions remain unchanged.
- The discontinued prom-client name aliases the maintained @prometheus-io/client.
  Application gauges and HTTP middleware share one registry.
- Vue 3 notification and editor prereleases were replaced with stable vue-sonner
  and prism-code-editor. Datepicker 14 options and styles were migrated. Notification
  timeout settings, read-only push examples and editable status-page CSS remain.
- Vite 8 uses its current configuration format and compression plugin. ESLint 10
  uses a flat configuration retaining the existing documentation/style policy.
  TypeScript 7.0.2 compiles the backend utility; Microsoft's TypeScript 6 API
  compatibility package supports the current lint parser.

## Version selection and limitations

The npm latest tag is not always the compatible stable release: vuedraggable's tag
points to Vue 2, so its Vue 3 release 4.1.0 is retained. Small packages with no newer
release also remain, including the application's ping fork and legacy password-hash
reader. Their age alone is not evidence of a vulnerability, and zero advisories is
not proof that they have no bugs. Dependencies of current packages still include
some deprecated helpers, notably core-js 2 through the image cropper, lodash.get,
event-to-promise and whatwg-encoding. They have no reported npm advisory in this
locked tree; they were not silently relabelled as maintained components.

Current Glob and Minimatch are selected only after their remaining consumers were
checked for the named/synchronous APIs they use. RedBean model loading, linting and
archive glob traversal were exercised. Removed legacy callable consumers are not
forced onto incompatible APIs merely to change the audit count.

## Validation

Local checks cover database parameters, Unicode/BLOB data, rollback, locking without
blocking timers, first-run SQLite upgrades, all 56 fresh SQLite migrations, and
reopening a synthetic database created by the previous SQLite 3.41.1 driver.
The retained records and integrity check survive that upgrade.

Portable MariaDB 12.3.2 passed all 56 fresh-schema migrations and production monitor
queries, Unicode, password overrides/refusal, compression and the CSV size query.
Isolated Redis 8 and PostgreSQL 18 containers passed production monitor queries
and authentication/error controls. Loopback peers exercise MQTT, gRPC, TCP, WebSocket, SSH/SFTP and SMTP. STARTTLS and
SMTPS retain certificate validation against an explicit test CA and produce DKIM
signatures. OAuth, shared metrics, token limiting, parser/decompression regressions,
CSV authorization and formula protection have focused controls.

Eight Chrome scenarios cover real CSV download, empty history, UTC validation,
Russian text, narrow screens, sanitized descriptions, charts/dropdowns, editable
status-page CSS/title, read-only push code, date pickers and authenticated metrics.
The production frontend build, strict utility type check and lint checks are included.
Existing warnings remain; checks were not weakened to hide runtime incompatibilities.

A clean Windows installation through `npm run setup` passed. The Linux/amd64 full
container base and release image built locally, including production dependencies.
The image reports Node 24.22.2 and SQLite 3.53.4, loads the native CPU/SSH modules,
and passes the same eight browser scenarios against a fresh isolated SQLite database.
The newly compiled healthcheck also passes. The TypeScript push example executes
on Node 24 without installing a compiler or making an external test request.

The complete Docker/container attempt on 31 October did not complete: its required
MariaDB/MySQL images did not start in that attempt. The portable MariaDB checks and the
Linux/amd64 release acceptance above are separate evidence. Other architectures,
macOS, real customer data and external notification
vendors or database services requiring separate infrastructure/accounts are not
qualified by local fixtures. No production deployment or Actions run was enabled.
Build this fork's container base locally before its main image; upstream prebuilt
images do not contain the updated runtime or this fork's additions.

## Follow-up validation — 1 November 2026

The complete Windows backend invocation now reports 227 passing tests, zero
failures and six skipped tests. Linux-only suites retain their platform guards.
Separate container runs cover 19 MQTT scenarios, four MySQL/MariaDB monitor
scenarios, two PostgreSQL scenarios, nine RabbitMQ scenarios, 17 SFTP scenarios
and three database migration scenarios. All have passing results in the focused
runs; this does not claim one successful complete Linux suite. The three schema
tests exercise SQLite, MariaDB 12.3.3 and MySQL 8.4 LTS, including all migrations.

Testcontainers 12 now receives explicit service images. MQTT fixtures wait for a
retained publication acknowledgement before starting the monitor; MariaDB fixtures
wait for the final database server after initialization. Teardown is awaited.
The test database uses Node's built-in file removal instead of an undeclared old
package. Ed25519 test keys are validated during generation, because ssh2 1.17 can
occasionally generate a malformed key; application key parsing is unchanged.

Domain-expiry tests use fixed RDAP network responses and keep their real parsing,
database and notification paths. They no longer depend on live registration dates
or use a retry helper that can hide failed assertions. This is fixture coverage,
not validation of external registries. The full npm audit still reports zero
advisories. Local owner reports are excluded from Git and Docker build contexts.
The platform, vendor and production-deployment limitations above still apply.

## Source review and hardening — 1 November 2026

The recovered source review targets immutable revision `dfea9c9a`. It covered
733 implementation, configuration, documentation and test files and assessed 82
data files. Five binary icons and upstream maintainer-only guidance were explicitly
excluded. Eleven distinct source-backed issues survived validation. The private
scan report retains their evidence and deployment assumptions. It is not a claim
that every deployment is exposed, or that a package advisory count describes the
application's complete security.

The subsequent patch separates RSS cache entries by every request-origin input,
bounds response-cache retention to 1,000 entries and 32 MiB of counted content,
key and header bytes (the JavaScript heap has additional overhead), limits each cached
response to 1 MiB and each cache key to 2 KiB, and avoids caching HTTP errors.
Oversized responses are still served completely without being retained. Cache
replacement, eviction and clearing also remove indexes and timers.

SFTP checks validate a mandatory, owner-confirmed SHA256 host-key fingerprint
before authentication and close failed connections without waiting for the peer.
The fingerprint is stored by a new migration and survives creation, editing and
reload. Existing SFTP monitors require operator action; no unsafe fallback or
trust-on-first-use mode is enabled.

RADIUS binds its UDP socket to the resolved peer, correlates identifiers and
verifies raw response-authenticator bytes before accepting a result. Requests
include Message-Authenticator and responses must include its valid counterpart.
Malformed or unauthenticated datagrams do not terminate the wait for a valid reply.

HTTP response buffering is bounded to 10 MiB after decompression, including NTLM.
OAuth and NTLM error paths preserve transport/size errors without dereferencing
a nonexistent response. HTTP password and API-key verification reserve rate-limit
capacity before asynchronous work. Successful HTTP attempts consume the same
20/60-per-minute instance-wide allowance.

SMSManager parameters are encoded as data and retain the configured recipient
and gateway. Aliyun SMS starts with HTTPS and refuses redirects. Provider controls
use local adapters; no real SMS, paid transaction or vendor account was exercised.

Release categorization passes PR text without a shell. Windows resolves a native
OpenCode executable or the Node entry in its npm installation instead of executing
a batch shim. This does not install OpenCode or invoke a model service during tests.
Apprise is pinned to Debian `2.1.0-1`, downloaded by APT from a signed Debian index
over HTTPS and checked against that index before installation; the previous
unsigned HTTP directory downloader was removed. The container retains the MIT
license and upstream attribution.

The old Kafka boolean migration now normalizes retained values before dropping
their original columns. Unknown nonempty TLS values remain enabled. A database
that already lost its earlier value needs operator comparison with a backup.

Peer dependency checks are enabled rather than ignored. Undici and Keyv are
placed at compatible versions for their respective consumers, including the
release HTTP client and cookie agents. This preserves the current direct package
versions without forcing incompatible consumers onto one nested version.

Status-page editing waits for both initial settings responses before enabling
inputs. A late public response no longer replaces authenticated editor settings,
and reconnecting does not discard unsaved values. The browser regression checks
the saved title and CSS after the page's actual reload.

Post-patch checks: the Windows backend suite has 249 passing tests, zero failures
and six platform skips. A separate service run has 22 passing cases: 19 SFTP
checks including OpenSSH and a peer that keeps a rejected connection half open,
plus fresh SQLite, MariaDB 12.3.3 and MySQL 8.4 LTS migrations. Nine Chrome
scenarios pass on Windows, including fingerprint creation/editing and title/CSS
persistence after a real reload. The same nine scenarios also pass against a
fresh Linux/amd64 release container built with `npm ci --omit=dev`. Its healthcheck,
native modules, saved fingerprint, retained title/CSS and SQLite integrity pass.
The application build, utility type check and dependency-tree validation pass;
the full npm audit has zero advisories. Lint has zero errors; existing warnings
were not suppressed. No permanent-server or external notification-vendor test
is implied by these local results.

## Primary references

- [Node release index](https://nodejs.org/dist/index.json)
- [Native TypeScript execution](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
- [Current Go releases](https://go.dev/dl/)
- [SQLite driver](https://github.com/WiseLibs/better-sqlite3)
- [Express 5 migration](https://expressjs.com/en/guide/migrating-5.html)
- [Croner migration](https://croner.56k.guru/migration/)
- [Maintained Prometheus client](https://github.com/prometheus/client_js)
- [TypeScript compiler/API compatibility](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [Vite migration](https://vite.dev/guide/migration)
- [Datepicker migration](https://vue3datepicker.com/migration/from-v11)

The audit is a dated baseline. Recheck the locked tree before deploying and before
subsequent updates; newly disclosed advisories can change the result.
