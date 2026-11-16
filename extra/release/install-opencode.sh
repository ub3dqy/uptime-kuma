#!/bin/sh
set -eu

version=1.19.5
checksum=588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a
archive=opencode-linux-x64.tar.gz
work=$(mktemp -d)
trap 'rm -f -- "$work/$archive" "$work/opencode"; rmdir -- "$work"' EXIT

curl --fail --silent --show-error --location --max-time 120 \
    "https://github.com/anomalyco/opencode/releases/download/v$version/$archive" -o "$work/$archive"
printf '%s  %s\n' "$checksum" "$work/$archive" | sha256sum --check
tar -xzf "$work/$archive" -C "$work" -- opencode

bindir="${RUNNER_TEMP:?This installer runs on the GitHub runner}/uptime-kuma-release-bin"
install -d "$bindir"
install -m 0755 "$work/opencode" "$bindir/opencode"
printf '%s\n' "$bindir" >> "${GITHUB_PATH:?The GitHub runner must provide GITHUB_PATH}"
