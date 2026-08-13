#!/usr/bin/env bash
#
# Export the managers table and ship the result to the consuming server.
#
# Intended to run from cron every 12 hours. The first run produces a full
# snapshot; every run after that produces only what changed.
#
# WHY THIS SYNCS RATHER THAN MOVES
# --------------------------------
# The export watermark advances as soon as a file is written *locally*. If we
# moved (or deleted) files after transferring them, a failed transfer would
# lose those rows permanently: the next export starts from the advanced
# watermark and never revisits the range. Nothing downstream would notice —
# those managers would simply be missing until someone ran --full.
#
# So the export directory is treated as append-only local state and rsynced in
# full each time. rsync skips what is already on the far side, so re-syncing
# costs almost nothing, and a transfer that failed last tick is simply retried
# this tick. Delivery can fail as often as it likes without corrupting the
# producer's bookkeeping.
#
# ORDERING
# --------
# Data files are synced before manifests, in two passes. A manifest is the
# signal that a run is complete and loadable, so it must never appear on the
# far side before the files it names. rsync writes to a temporary name and
# renames on completion, so a file that is visible under its final name is
# always whole.
#
# CONFIGURATION (environment, or a .env beside this script's repo root)
#   SHIP_REMOTE       user@host:/path/to/landing/dir      (required)
#                     Quote it in .env if the path starts with `~`: bash
#                     expands a tilde following a colon using the LOCAL home,
#                     so host:~/data silently becomes host:/root/data.
#   SHIP_SSH_KEY      path to the private key             (default: ssh's own)
#   SHIP_SSH_PORT     ssh port                            (default: 22)
#   EXPORT_FORMAT     csv | parquet                       (default: csv)
#   EXPORT_ARGS       extra args passed to src/export.js  (default: empty)
#   RETAIN_DAYS       delete local exports older than this, 0 to keep forever
#                                                         (default: 30)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# shellcheck source=/dev/null
[ -f .env ] && set -a && . ./.env && set +a

OUT_DIR="${OUT_DIR:-$REPO_DIR/data/export}"
EXPORT_FORMAT="${EXPORT_FORMAT:-csv}"
EXPORT_ARGS="${EXPORT_ARGS:-}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
SHIP_SSH_PORT="${SHIP_SSH_PORT:-22}"
LOG_DIR="$REPO_DIR/logs"
LOCK_FILE="$LOG_DIR/ship-exports.lock"

mkdir -p "$OUT_DIR" "$LOG_DIR"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

[ -n "${SHIP_REMOTE:-}" ] || die "SHIP_REMOTE is not set (user@host:/path)."

# Cron can overlap when a full export runs long. Never run two at once: the
# exporter has its own lock, but a second shipper would rsync a directory
# being written into.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another ship-exports run holds $LOCK_FILE — exiting."
  exit 0
fi

SSH_CMD="ssh -p $SHIP_SSH_PORT -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
[ -n "${SHIP_SSH_KEY:-}" ] && SSH_CMD="$SSH_CMD -i $SHIP_SSH_KEY"

log "Exporting (format=$EXPORT_FORMAT) to $OUT_DIR"
# shellcheck disable=SC2086
node src/export.js --format "$EXPORT_FORMAT" --out-dir "$OUT_DIR" $EXPORT_ARGS

# Sync even when the export produced nothing new: a previous run's files may
# still be undelivered, and this is what makes a failed transfer self-heal.
RSYNC_BASE=(rsync --archive --compress --partial --human-readable
            --rsh "$SSH_CMD")

log "Syncing data files to $SHIP_REMOTE"
"${RSYNC_BASE[@]}" --exclude '*.manifest.json' --exclude '.*' \
  "$OUT_DIR/" "$SHIP_REMOTE/"

log "Syncing manifests to $SHIP_REMOTE"
"${RSYNC_BASE[@]}" --include '*.manifest.json' --include '*/' \
  --exclude '*' --prune-empty-dirs \
  "$OUT_DIR/" "$SHIP_REMOTE/"

if [ "$RETAIN_DAYS" -gt 0 ]; then
  # Safe only because every tick re-syncs everything still present: anything
  # older than RETAIN_DAYS has been offered to the remote on every run since
  # it was written.
  log "Pruning local exports older than $RETAIN_DAYS days"
  find "$OUT_DIR" -mindepth 1 -maxdepth 1 -mtime "+$RETAIN_DAYS" \
    -exec rm -rf {} +
fi

log "Done."
