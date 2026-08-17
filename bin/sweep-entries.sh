#!/usr/bin/env bash
#
# Probe entry IDs that are not in the database yet.
#
# Intended to run from cron, hourly. Registrations arrive continuously until
# the GW1 deadline, so a sweep that ran once and stopped leaves the directory
# drifting further behind every hour. When there is nothing to do this exits in
# about a second — one bootstrap-static request plus a gap count — so running
# it often is close to free.
#
# WHY A WRAPPER RATHER THAN A CRON LINE
# ------------------------------------
# src/backfill.js derives its default database and log paths from
# process.cwd(). Cron starts in $HOME, so a bare `node .../src/backfill.js`
# entry would quietly read and write /root/data/... instead of the repo's.
# Resolving the repo from BASH_SOURCE removes the question entirely, the same
# way ship-exports.sh does.
#
# Concurrent runs are prevented by src/backfill.js itself, which takes an
# O_EXCL lock next to the database and exits 0 — not an error — when a sweep is
# already in progress. An hourly tick landing on top of a multi-hour sweep is
# the expected case, so it must not page anyone.
#
# CONFIGURATION (environment, or a .env at the repo root)
#   SWEEP_ARGS   extra args for src/backfill.js (e.g. --rate 50)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# shellcheck source=/dev/null
[ -f .env ] && set -a && . ./.env && set +a

mkdir -p logs
# shellcheck disable=SC2086
exec node src/backfill.js ${SWEEP_ARGS:-}
