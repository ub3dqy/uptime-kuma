# Deployment status

This fork remains a development edition. Dependency remediation does not
establish the security of the complete application or a future deployment.

## Dependency review on 31 October 2026

| Check | Before this remediation | Current locked tree |
| --- | --- | --- |
| `npm audit --omit=dev` | 30 packages: 2 critical, 20 high, 6 moderate, 2 low | 13 packages: 0 critical, 0 high, 11 moderate, 2 low |
| Full `npm audit` | Not recorded on the original baseline | 40 packages: 0 critical, 0 high, 38 moderate, 2 low |

These are registry classifications and dependency propagation counts, not
counts of independently reproduced vulnerabilities. `--omit=dev` alone is
insufficient for this project: DOMPurify and Vue I18n are development
dependencies that are bundled into the production browser interface. Both
were included in remediation and the full audit.

Updated protobufjs, gRPC, Axios, LiquidJS, MySQL2, Nodemailer, qs, ws and tar;
updated DOMPurify, Vue I18n and the build/test dependencies. Axios remains on
its compatible 0.x branch. SQLite 15.1.6 and redbean-node 0.3.3 were retained;
their affected tar, Glob and Lodash dependencies were targeted separately.
Undici 5 consumers use an override to the tested 6.29.1 without replacing
unrelated 7.x consumers. The existing remote Playwright monitor protocol
version was retained; its development test runner was updated separately.

**Compatibility:** this edition now requires Node.js 22.20 or newer, including
for builds. The patched Vue I18n requires Node 22, and the build/lint tree and
existing optional Linux tools impose higher patch-level requirements. Use a currently
supported, security-patched runtime. Validation used Node.js 24.13.0 on
Windows; other runtime/OS combinations were not independently validated.
Vite 6 uses the legacy Sass API explicitly to preserve the existing styles.

## Reproduction and validation

The original notification template renderer stalled on `a<` and `text<!--`
with `strip_html`; bounded subprocesses were terminated after the timeout.
The patched renderer finishes and preserves the input, and ordinary HTML
still produces the expected plain text. The bounded tar fixture verifies
both ordinary extraction and rejection of excessive decompression. Protobuf
identifier and valid-message controls, a local authenticated HTTP proxy,
and local SMTP authentication, recipients, headers and templates are covered
by regression tests. Schema-related code execution was not independently
demonstrated through the application's gRPC monitor.

Focused backend tests, SQLite migrations, the production frontend build,
JavaScript lint and the strict backend type check were run. Compatibility
with the updated compiler required a Popper type-definition update and
synthetic default-import typing; CommonJS emit semantics were preserved.
The browser scenarios cover CSV, empty history,
range validation, Russian text, narrow screens and sanitized descriptions.
Local STARTTLS and SMTPS controls retain certificate validation and generate
DKIM signatures. Portable MariaDB 12.3.2 passed all 56 fresh-schema migrations,
production monitor queries, Unicode, password overrides/refusal, compressed
queries and the CSV size query. Its official archive checksum was verified.

The full Docker/container suite, source compilation of SQLite, physical
production infrastructure and an upgrade of a real customer database have
not been validated. Existing lint/build warnings remain. No production
deployment or GitHub Actions run was enabled.

## Remaining findings

The 13 production-tree classifications originate in the SQLite installation
toolchain and MQTT's command-line help dependency. The remaining full-tree
classifications also include local linting, archive/container tooling and
their old Glob/Minimatch dependencies. They remain open. The identified
installer and help code uses local paths/patterns; a route from ordinary
public web requests to those particular vulnerable operations was not found
in this focused review. This is not proof that every possible route is safe.
Only trusted installation sources, repository contents and local CLI inputs
should be used while this work remains open.

Do not force the latest Glob/Minimatch globally: the legacy installer and
lint consumers use callable/callback APIs removed by later major versions.
Replacing those consumers requires a separate compatibility change and real
source-build checks. The development servers are not deployment servers.

Primary references:

- [protobufjs schema code generation](https://github.com/advisories/GHSA-xq3m-2v4x-88gg)
- [tar decompression limits](https://github.com/advisories/GHSA-23hp-3jrh-7fpw)
- [LiquidJS infinite loop](https://github.com/advisories/GHSA-m7fp-h3p4-hr49)
- [DOMPurify update](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cg2g-xh64-v4q7)
- [Vue I18n engine requirement](https://github.com/intlify/vue-i18n/blob/v11.4.16/packages/vue-i18n/package.json)
- [Vite Sass compatibility](https://v6.vite.dev/guide/migration.html#sass-now-uses-modern-api-by-default)

The CSV endpoint checks authentication and monitor ownership, bounds the date
range, row count and output size, limits concurrent exports per account, and
neutralizes formula-like text. Those controls apply to this feature; they do
not establish the security of the entire application.
