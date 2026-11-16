# Uptime Kuma · ub3dqy edition

Monitor client websites on your own server, see when they were down, and share a printable report for each client.

[Try the preview](https://github.com/ub3dqy/uptime-kuma/releases/tag/v2.5.8-ub3dqy.preview.2) · [Product overview](README.en.md) · [Русская версия](FORK.ru.md)

This independent preview is based on Uptime Kuma 2.5.8, originally created by Louis Lam and contributors. It is maintained by Dima Mak / ub3dqy and uses the MIT license.

## Installation

Use this preview for an independent trial with a fresh data volume. The ready-to-run archive requires Docker with Linux x86-64 containers. Docker Desktop users can run it with the Linux engine. The setup below uses SQLite.

1. Download `kuma-preview-linux-amd64.tar.gz` and `SHA256SUMS.txt` from the [preview release](https://github.com/ub3dqy/uptime-kuma/releases/tag/v2.5.8-ub3dqy.preview.2). Compare the archive’s SHA-256 with the published value. Run `sha256sum kuma-preview-linux-amd64.tar.gz` on Linux or `Get-FileHash .\kuma-preview-linux-amd64.tar.gz` in PowerShell.
2. In the download directory, run:

   ```sh
   docker load -i kuma-preview-linux-amd64.tar.gz
   docker run --pull=never -d --name uptime-kuma-preview -p 127.0.0.1:3001:3001 -v uptime-kuma-preview-data:/app/data ub3dqy/uptime-kuma:2.5.8-ub3dqy.preview.2
   ```

3. Open <http://127.0.0.1:3001>, select **SQLite**, and create an administrator account. For a remote host, forward the port with `ssh -N -L 3001:127.0.0.1:3001 user@server`. If 3001 is taken on the Docker host, change the first 3001 in the run command and use the chosen port in the browser.
4. Add two HTTP(S) monitors. Open **Reports**, name your group, choose both monitors, and save it. With some checks recorded, choose a period and click **Open period report**. Choose **Print / save PDF** to save a copy in your browser.

The report is based on retained observations. Pick a recent period for the first run. The report shows how much of the period was observed, and labels any time without data.

Use `docker stop uptime-kuma-preview` to stop and `docker start uptime-kuma-preview` to resume. The named volume preserves the data between starts. Keep a separate copy of the volume before trying an update. New preview builds are listed under [Releases](https://github.com/ub3dqy/uptime-kuma/releases).

JSONata expression checks are disabled in the ready-to-run preview, including checks that use saved expressions. Use plain HTTP(S) checks for the trial.

**Build from source.** Use Node.js 24.22.3 LTS or later in the 24.x series and npm 12.2.1. Clone `v2.5.8-ub3dqy.preview.2`, then run `npm run setup` from the checkout. Start with `UPTIME_KUMA_DISABLE_JSONATA=1 node server/server.js --host=127.0.0.1 --port=3001` in a POSIX shell. In PowerShell set `$env:UPTIME_KUMA_DISABLE_JSONATA = '1'` before the same `node` command.

[Report a bug](https://github.com/ub3dqy/uptime-kuma/issues/new?template=bug_report.yml) · [Suggest an improvement](https://github.com/ub3dqy/uptime-kuma/issues/new?template=feature_request.yml)

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

## Validation of the first addition

Security changes of 1 November 2026 affect upgrades:

- SFTP requires a trusted `SHA256:...` server host-key fingerprint obtained
  through a trusted channel. Existing monitors without it refuse authentication.
  The first network response is never trusted automatically.
- HTTP monitor responses are limited to 10 MiB after decompression. Larger
  bodies fail the check even when response saving is disabled.
- Every HTTP authentication attempt, including successful ones, consumes the
  instance-wide allowance: 20 per minute for passwords and 60 for API keys.
- RADIUS responses must have a valid authenticator and Message-Authenticator.
  A legacy server without that protection will no longer produce an UP result.
- The corrected legacy migration preserves Kafka TLS. Settings already lost by
  an earlier migration cannot be reconstructed automatically; compare a backup.

On 31 October 2026 the dependency tree was refreshed against current stable releases.
Both the complete tree and production-only tree report zero npm advisories.
Backend, browser, database and TLS results and platform limits are recorded in
[the dependency review](SECURITY-BASELINE.md). Clean installation on Windows and
the Linux/amd64 Docker release have passed local acceptance. A live server
installation has not been qualified.

## Period summaries

Use **Calculate summary** beside the CSV button. The UTC range is half-open,
limited to 31 days and 50,000 saved checks, and cannot end in the future.
Access is authenticated and owner-scoped, with one summary per account at a time.
Messages, stored response bodies and monitor configuration are never included.

The summary shows UP, DOWN, PENDING and MAINTENANCE counts and estimated time,
unknown time, observation coverage and successful-response mean, minimum,
maximum and nearest-rank p95. Zero-millisecond responses are valid samples.

Time is estimated between adjacent saved checks in the same uninterrupted run.
The earlier state is carried forward for at most its recorded check interval;
the remaining gap is unknown. Pauses, restarts and configuration edits break a
run. There is no extrapolation after the final saved check. One neighboring row
on either side clips the selected period without entering its counts or latency
statistics. Unknown states provide no time coverage.

Availability is UP time divided by UP + DOWN time. PENDING, MAINTENANCE and
unknown time are excluded. Always read this with observation coverage, which
includes all four recognized states over the full period. A 100% result with low
coverage does not establish 100% availability for the full period. No accounted
UP or DOWN time yields no availability percentage.

New heartbeats save the effective interval and a private run identifier. Old
rows intentionally remain without those fields: their counts and response
samples are usable, but their time remains unknown. Today's settings cannot
reconstruct historical schedules, deleted history, missed-run counts or the
cause of a gap. These sampled estimates do not establish contractual SLA.

The existing daily cleanup removes non-important rows older than 24 hours,
retaining the most recent 100 rows per monitor. Older ranges can therefore have
low coverage even after this update. This feature leaves retention unchanged and
does not reconstruct missing observations from old aggregate statistics, which
do not preserve trustworthy gap boundaries. Incomplete percentages near 100%
are displayed as less than 100%, so rounding cannot conceal a small gap.

## Client groups and printable reports

Open **Reports** in the desktop header or the mobile settings menu. Create a
named group and select individual owned checks. One check may belong to several
clients. Upstream monitor groups remain unchanged; their descendants are not
expanded automatically. These groups organize this account's checks and do not
create client accounts or grant access.

For a saved group, select a UTC period and **Open period report**. The aggregate
adds monitor-time: three checks over one day have a three-day denominator.
Availability uses summed UP / (UP + DOWN) time, rather than an average of
per-monitor percentages. Coverage and unknown time remain explicit. Response
statistics, including p95, are shown separately for each check.

**Print / save PDF** opens the browser print dialog. The standalone report prints
the client name, UTC period, preparation time, membership revision, totals and
per-check results without application navigation or controls. Check names are
included; inspect the document before sharing. The report URL requires login
and is not a public sharing link. The printed snapshot stays unchanged after
later membership edits.

Reports use current saved membership, not historical client assignments. A
membership revision prevents stale editors from silently overwriting changes;
stale report URLs require refreshing the client list. If saving loses its
acknowledgement, refresh before retrying. Deleting a group preserves its checks
and history. Deleting a monitor removes its memberships through foreign keys.

Limits are 100 clients per account, 100 checks per client, 31 days and a single
50,000-row in-period history budget for the entire report. Exceeding a limit
fails the whole report, with no partial result. Empty clients have no availability
percentage. Messages, settings, credentials and saved response bodies are not
included. The existing history retention and missing-data limitations still apply.

## Development and scope

Run the relevant backend and browser tests and build the frontend before
publishing changes. This fork receives its own changes; submitting work to the
upstream repository requires a separate decision and its contribution rules.

Client groups and printable reports are implemented. A sustained trial on the
chosen permanent server remains separate deployment qualification.
