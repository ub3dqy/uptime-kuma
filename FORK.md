# Uptime Kuma — ub3dqy edition

**Development edition:** [deployment and dependency review](SECURITY-BASELINE.md)
is still required before production use.

This independently maintained fork starts from upstream **2.5.8**. Uptime Kuma
was created by Louis Lam and its contributors. The original MIT license and
attribution are retained. This edition is maintained by Dima Mak / ub3dqy.

## First addition: retained check history as CSV

Open a monitor, find **Export check history**, select a UTC time range and
choose **Download CSV**. The start is included and the end is excluded.
The default range covers the previous 24 hours up to the current minute.

The UTF-8 CSV includes the monitor ID and name, UTC timestamp, status, response
time in milliseconds, stored duration in seconds and check message. Null
values stay empty; zero response times are preserved. Monitor credentials,
push tokens, configuration and stored response bodies are not exported.
Messages can contain private information. Review files before sharing them.
Untrusted text that could be treated as a spreadsheet formula is prefixed
with an apostrophe. Import the comma-separated file as UTF-8 if your spreadsheet
application does not detect it automatically.

Exports require sign-in and access to the selected monitor. One export can run
per account at a time. A request is limited to 31 days, 50,000 checks and 8 MiB.
An oversized export is refused rather than silently truncated.

Only rows still retained in the heartbeat table are exported. An empty export
does not prove that a site was up or down. Missing observations, pauses,
retention cleanup and server outages are not converted into uptime. This
first addition is a raw history export, not an SLA or incident-duration report.

## Install this edition

Install a currently supported Node.js release that meets the requirement in
`package.json`, and Git, then run:

```sh
git clone --branch main https://github.com/ub3dqy/uptime-kuma.git
cd uptime-kuma
npm run setup
node server/server.js --host=127.0.0.1 --port=3001
```

Open `http://127.0.0.1:3001` and complete the database and administrator setup.
The example listens on the local machine. For a shared installation, configure
TLS, access controls and a service manager for your environment. Keep the data
directory outside the checkout when replacing application files, and back it
up before upgrades. Restore upgrades on a copy before changing live data.

The fork's `setup` builds its frontend from source. Upstream prebuilt frontend
archives do not contain this edition's additions.

## Validation of the first addition

On 31 October 2026, the nine export backend tests, translation checks and four
Chrome browser scenarios passed. Browser checks cover a real CSV download,
an empty period, a narrow screen and the Russian interface. JavaScript lint,
scoped stylesheet checks and the production frontend build completed without
errors. Existing upstream lint and build warnings remain.

The export was exercised with SQLite on Windows. MariaDB, Docker deployment,
the complete upstream test suite and a live server installation have not been
validated for this edition. The inherited dependency findings in
[the deployment review](SECURITY-BASELINE.md) remain open.

## Development and scope

Run the relevant backend and browser tests and build the frontend before
publishing changes. This fork receives its own changes; submitting work to the
upstream repository requires a separate decision and its contribution rules.

Next planned milestones are period summaries with explicit missing-data
handling, client groups, and printable reports. They are not included in the
first CSV export.
