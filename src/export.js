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
  --db <path>            SQLite DB path (default: ./data/fpl.db)
  --full                 Force a full re-export and re-baseline the watermark
  --delta                Force an incremental export (fails-safe to full if
                         no previous export exists)
  --since <ts>           Override the watermark. Unix seconds or ISO-8601.
  --rows-per-file <n>    Rows per parquet part file (default: 2000000)
  --compression <c>      GZIP | SNAPPY | UNCOMPRESSED (default: GZIP —
                         ~26 B/row vs 38 for SNAPPY on real data, at ~6%
                         lower write throughput)
  --overlap-seconds <n>  Rewind the watermark by n seconds so a crawler write
                         that straddles the boundary can't be missed
                         (default: 1). Deltas are at-least-once — apply them
                         downstream as an UPSERT on entry_id.
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

function parseSince(v) {
  if (/^\d+$/.test(v)) return parseInt(v, 10);
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
    dbPath: path.join(process.cwd(), 'data', 'fpl.db'),
    mode: 'auto',
    since: null,
    rowsPerFile: 2_000_000,
    compression: 'GZIP',
    overlapSeconds: 1,
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
      case '--overlap-seconds': opts.overlapSeconds = parseInt(next(), 10); break;
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
  if (!Number.isInteger(opts.overlapSeconds) || opts.overlapSeconds < 0) {
    console.error('--overlap-seconds must be a non-negative integer');
    process.exit(2);
  }
  return opts;
}

function printStatus(db, dataset) {
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

  const pending = db.countInRange(state.watermark, db.getMaxLastUpdated());
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
      printStatus(db, opts.dataset);
    } finally {
      db.close();
    }
    return;
  }

  fs.mkdirSync(opts.outDir, { recursive: true });

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
    overlapSeconds: opts.overlapSeconds,
    dryRun: opts.dryRun,
  });

  logger.info(
    `Export config: db=${opts.dbPath} outDir=${opts.outDir} ` +
      `mode=${opts.mode} rowsPerFile=${opts.rowsPerFile} ` +
      `compression=${opts.compression} dataset=${opts.dataset}` +
      (opts.dryRun ? ' [dry-run]' : '')
  );

  const shutdown = (sig) => {
    logger.info(`Received ${sig}.`);
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
    db.close();
    logger.close();
  }
}

main();
