#!/usr/bin/env node
'use strict';

/**
 * Export the managers table to Parquet — full on the first run, incremental
 * (only changed/new managers) on every run after that.
 *
 * Usage:
 *   node src/export.js [options]
 *
 * Layout under --out-dir (default ./data/parquet):
 *   managers_full_20260806T091600Z/part-0000.parquet, part-0001.parquet, …
 *   managers_delta_20260807T020000Z.parquet
 *   managers_delta_20260808T020000Z.parquet
 *
 * Postgres / Supabase import (via DuckDB):
 *   CREATE TABLE fpl_managers (
 *     entry_id     INTEGER PRIMARY KEY,
 *     player_name  TEXT NOT NULL,
 *     team_name    TEXT NOT NULL,
 *     rank         INTEGER,
 *     last_updated TIMESTAMPTZ NOT NULL
 *   );
 *   -- then COPY each parquet file in and UPSERT on entry_id; deltas replay
 *   -- in any order because every row carries its own last_updated.
 */

const path = require('path');
const fs = require('fs');
const { defaultDbPath } = require('./season');
const FPLDatabase = require('./db');
const Logger = require('./logger');
const Exporter = require('./exporter');
const { fmtBytes, fmtTs } = require('./exporter');
const { CODECS } = require('./parquet');

function printHelp() {
  console.log(`
FPL Parquet Exporter

Exports {entry_id, player_name, team_name, rank, last_updated} to Parquet.
The first run writes a full snapshot; every run after that writes only the
managers whose name or team name changed since the previous export.

Usage: node src/export.js [options]

Options:
  --out-dir <path>       Output directory (default: ./data/parquet)
  --db <path>            SQLite DB path (default: ./data/fpl-<season>.db)
  --full                 Force a full re-export and re-baseline the watermark
  --delta                Force an incremental export (fails-safe to full if
                         no previous export exists)
  --since <ts>           Override the watermark. Unix seconds or ISO-8601.
  --rows-per-file <n>    Rows per parquet part file (default: 2000000)
  --compression <c>      GZIP | SNAPPY | UNCOMPRESSED (default: GZIP —
                         ~26 B/row vs 38 for SNAPPY on real data, at ~6%
                         lower write throughput)
  --lag-seconds <n>      Hold the newest n seconds back from export, giving a
                         crawler transaction that stamped that second time to
                         commit (default: 1). Apply deltas downstream as an
                         UPSERT on entry_id — a crash between writing files
                         and recording the run replays the range.
  --dry-run              Report what would be exported; write nothing and
                         leave the watermark untouched
  --status               Print watermark + recent export history, then exit
  --dataset <name>       Watermark key, for exporting to several targets
                         independently (default: managers)
  --log <path>           Log file path (default: ./logs/export.log)
  --no-log-file          Log to stdout only
  -h, --help             Show this help

Examples:
  # First pass — full snapshot, partitioned into ~2M-row files.
  node src/export.js

  # Every run after that — only what changed.
  node src/export.js

  # See where the watermark sits before committing to a run.
  node src/export.js --status
  node src/export.js --dry-run

  # Re-baseline from scratch (e.g. after changing the schema downstream).
  node src/export.js --full

  # Nightly incremental, after the crawler has refreshed the DB.
  0 3 * * *  cd /opt/fpl-crawler && node src/export.js >> logs/cron.log 2>&1
`);
}

// Plausible unix-second range: 2001-09-09 .. 2033-05-18. Anything all-digit
// outside it is far more likely a mistake (a bare year, or a 13-digit
// millisecond timestamp) than a real timestamp, and guessing silently turns
// `--since 2026` into 1970 — which re-exports the entire table as a "delta".
const MIN_PLAUSIBLE_SECONDS = 1_000_000_000;
const MAX_PLAUSIBLE_SECONDS = 2_000_000_000;

function parseSince(v) {
  if (/^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    if (n >= MIN_PLAUSIBLE_SECONDS && n <= MAX_PLAUSIBLE_SECONDS) return n;
    const hint =
      n > MAX_PLAUSIBLE_SECONDS
        ? ' (looks like milliseconds — divide by 1000)'
        : ' (looks like a year — pass a full date, e.g. 2026-05-09)';
    console.error(
      `Invalid --since value: ${v}${hint}. Expected unix seconds in ` +
        `[${MIN_PLAUSIBLE_SECONDS}, ${MAX_PLAUSIBLE_SECONDS}] or an ISO-8601 date.`
    );
    process.exit(2);
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) {
    console.error(`Invalid --since value: ${v} (expected unix seconds or ISO-8601)`);
    process.exit(2);
  }
  return Math.floor(ms / 1000);
}

function parseArgs(argv) {
  const opts = {
    outDir: path.join(process.cwd(), 'data', 'parquet'),
    dbPath: defaultDbPath(),
    mode: 'auto',
    since: null,
    rowsPerFile: 2_000_000,
    compression: 'GZIP',
    lagSeconds: 1,
    dryRun: false,
    status: false,
    dataset: 'managers',
    logFile: path.join(process.cwd(), 'logs', 'export.log'),
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`Missing value for ${a}`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case '--out-dir':       opts.outDir = path.resolve(next()); break;
      case '--db':            opts.dbPath = next(); break;
      case '--full':          opts.mode = 'full'; break;
      case '--delta':         opts.mode = 'delta'; break;
      case '--since':         opts.since = parseSince(next()); break;
      case '--rows-per-file': opts.rowsPerFile = parseInt(next(), 10); break;
      case '--compression':   opts.compression = next().toUpperCase(); break;
      case '--lag-seconds':   opts.lagSeconds = parseInt(next(), 10); break;
      case '--dry-run':       opts.dryRun = true; break;
      case '--status':        opts.status = true; break;
      case '--dataset':       opts.dataset = next(); break;
      case '--log':           opts.logFile = next(); break;
      case '--no-log-file':   opts.logFile = null; break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        printHelp();
        process.exit(2);
    }
  }

  if (!CODECS.includes(opts.compression)) {
    console.error(
      `Invalid --compression: ${opts.compression} (expected one of ${CODECS.join(', ')})`
    );
    process.exit(2);
  }
  if (!Number.isInteger(opts.rowsPerFile) || opts.rowsPerFile < 1) {
    console.error('--rows-per-file must be a positive integer');
    process.exit(2);
  }
  if (!Number.isInteger(opts.lagSeconds) || opts.lagSeconds < 0) {
    console.error('--lag-seconds must be a non-negative integer');
    process.exit(2);
  }
  // The dataset name becomes a path segment under --out-dir and is fed to a
  // recursive rmSync on failure, so anything that could escape the output
  // directory (`..`, a slash, a leading dash) is rejected outright.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts.dataset)) {
    console.error(
      `Invalid --dataset: ${opts.dataset} ` +
        '(letters, digits, underscore and hyphen only; must start alphanumeric)'
    );
    process.exit(2);
  }
  return opts;
}

function printStatus(db, dataset, lagSeconds) {
  const state = db.getExportState(dataset);
  console.log(`Export status — dataset "${dataset}"`);
  console.log('─────────────────────────────────');
  if (!state) {
    console.log('No export recorded yet. The next run will be a FULL export.');
    return;
  }
  console.log(`Watermark:      ${state.watermark} (${fmtTs(state.watermark)})`);
  console.log(`Last run kind:  ${state.last_kind}`);
  console.log(`Last run at:    ${fmtTs(state.last_run_at)}`);

  // Must use the same bounds the next run would, or this number contradicts
  // what actually happens when you run it.
  const hi = Math.min(
    db.getMaxLastUpdated(),
    Math.floor(Date.now() / 1000) - 1 - lagSeconds
  );
  const pending =
    hi > state.watermark ? db.countInRange(state.watermark, hi) : 0;
  console.log(`Pending rows:   ${pending.toLocaleString()}`);
  console.log('');
  console.log('Recent runs:');
  for (const r of db.getRecentExportRuns(dataset, 10)) {
    const files = JSON.parse(r.files);
    const bytes = files.reduce((a, f) => a + f.bytes, 0);
    console.log(
      `  ${fmtTs(r.finished_at)}  ${r.kind.padEnd(5)}  ` +
        `${String(r.rows).padStart(12)} rows  ` +
        `${String(files.length).padStart(3)} file(s)  ${fmtBytes(bytes)}`
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!fs.existsSync(opts.dbPath)) {
    console.error(`DB not found at ${opts.dbPath}`);
    process.exit(1);
  }

  const db = new FPLDatabase(opts.dbPath);

  if (opts.status) {
    try {
      printStatus(db, opts.dataset, opts.lagSeconds);
    } finally {
      db.close();
    }
    return;
  }

  fs.mkdirSync(opts.outDir, { recursive: true });

  // Two exports of the same dataset would pick the same timestamped base name
  // and truncate each other's parquet, and both would race the watermark. An
  // exclusive lock file is cheaper and more honest than trying to make the
  // name collision check atomic.
  const release = opts.dryRun ? () => {} : acquireLock(opts.outDir, opts.dataset);

  const logger = new Logger(opts.logFile);
  const exporter = new Exporter({
    db,
    logger,
    dataset: opts.dataset,
    outDir: opts.outDir,
    rowsPerFile: opts.rowsPerFile,
    compression: opts.compression,
    mode: opts.mode,
    since: opts.since,
    lagSeconds: opts.lagSeconds,
    dryRun: opts.dryRun,
  });

  logger.info(
    `Export config: db=${opts.dbPath} outDir=${opts.outDir} ` +
      `mode=${opts.mode} rowsPerFile=${opts.rowsPerFile} ` +
      `compression=${opts.compression} lagSeconds=${opts.lagSeconds} ` +
      `dataset=${opts.dataset}` +
      (opts.dryRun ? ' [dry-run]' : '')
  );

  // Registering a handler removes Node's default terminate-on-signal, so a
  // second signal must force the exit — otherwise Ctrl-C is a no-op during
  // the synchronous stretches (CREATE INDEX, the gzip flush in close()) where
  // the event loop never turns and the handler cannot run at all.
  let signalled = false;
  const shutdown = (sig) => {
    if (signalled) {
      logger.warn(`Received ${sig} again — exiting now.`);
      logger.warn(
        'Partial parquet files may be left behind; the watermark is unchanged.'
      );
      release();
      process.exit(130);
    }
    signalled = true;
    logger.info(`Received ${sig}. Send it again to force an immediate exit.`);
    exporter.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await exporter.run();
  } catch (e) {
    logger.error(`Export failed: ${e.message}`);
    if (e.stack) logger.error(e.stack);
    process.exitCode = 1;
  } finally {
    release();
    db.close();
    logger.close();
  }
}

/**
 * Exclusive, stale-tolerant lock for one (out-dir, dataset) pair.
 * Returns a release function that is safe to call more than once.
 */
function acquireLock(outDir, dataset) {
  const lockPath = path.join(outDir, `.${dataset}.export.lock`);
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = readLockPid(lockPath);
    if (holder !== null && isAlive(holder)) {
      console.error(
        `Another export of "${dataset}" is already running (pid ${holder}, ` +
          `lock ${lockPath}). Refusing to run two at once.`
      );
      process.exit(1);
    }
    // Stale lock from a kill -9: reclaim it.
    console.error(`Removing stale export lock ${lockPath}.`);
    fs.rmSync(lockPath, { force: true });
    fd = fs.openSync(lockPath, 'wx');
  }
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* best effort */
    }
  };
}

function readLockPid(lockPath) {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

main();
