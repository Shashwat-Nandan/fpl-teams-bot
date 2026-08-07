'use strict';

const path = require('path');

/**
 * FPL reassigns entry IDs from 1 at the start of every season, so a given
 * entry_id refers to a *different manager* each year — entry 3027768 was
 * "Erik Ibsen" in 2025-26 and "Philip Sander" in 2026-27. Seasons therefore
 * cannot share a database: re-crawling into last season's file would UPSERT
 * one manager's row on top of another's, and every ID above the new season's
 * ceiling would linger forever as a manager who no longer exists.
 *
 * Each season gets its own file. Bump SEASON once a year; last season's file
 * stays put as an archive and is still reachable with `--db`.
 */
const SEASON = '2026-27';

function defaultDbPath(season = SEASON) {
  return path.join(process.cwd(), 'data', `fpl-${season}.db`);
}

module.exports = { SEASON, defaultDbPath };
