#!/usr/bin/env node
'use strict';

const path = require('path');
const FPLDatabase = require('./db');
const Fetcher = require('./fetcher');
const Logger = require('./logger');
const Backfiller = require('./backfiller');

function printHelp() {
  console.log(`
FPL Entry Backfiller

Probes /api/entry/{id}/ for entry IDs missing from the managers table,
filling gaps left behind by the league crawler (which can miss managers
whose ranks shifted into already-crawled pages mid-crawl).

Usage: node src/backfill.js [options]

Options:
  --upper-bound <n>     Highest entry_id to probe (default: max(entry_id) in DB)
  --max-ids <n>         Max IDs to probe in this run (default: unlimited)
  --delay-ms <n>        Min delay between requests in ms (default: 1000)
  --jitter-ms <n>       Max additional random jitter in ms (default: 500)
  --max-retries <n>     Max retries per request (default: 5)
  --db <path>           SQLite DB path (default: ./data/fpl.db)
  --log <path>          Log file path (default: ./logs/backfill.log)
  --no-log-file         Log to stdout only
  --user-agent <s>      Override User-Agent header
  -h, --help            Show this help

Examples:
  # Smoke test: probe 5 missing IDs.
  node src/backfill.js --max-ids 5

  # Full backfill, run in background.
  node src/backfill.js > /dev/null 2>&1 &

  # Re-run after kill — picks up automatically (gaps are recomputed from DB).
`);
}

function parseArgs(argv) {
  const opts = {
    upperBound: null,
    maxIds: Infinity,
    minDelayMs: 1000,
    maxJitterMs: 500,
    maxRetries: 5,
    dbPath: path.join(process.cwd(), 'data', 'fpl.db'),
    logFile: path.join(process.cwd(), 'logs', 'backfill.log'),
    userAgent: undefined,
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
      case '--upper-bound':  opts.upperBound = parseInt(next(), 10); break;
      case '--max-ids':      opts.maxIds = parseInt(next(), 10); break;
      case '--delay-ms':     opts.minDelayMs = parseInt(next(), 10); break;
      case '--jitter-ms':    opts.maxJitterMs = parseInt(next(), 10); break;
      case '--max-retries':  opts.maxRetries = parseInt(next(), 10); break;
      case '--db':           opts.dbPath = next(); break;
      case '--log':          opts.logFile = next(); break;
      case '--no-log-file':  opts.logFile = null; break;
      case '--user-agent':   opts.userAgent = next(); break;
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
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const logger = new Logger(opts.logFile);
  const db = new FPLDatabase(opts.dbPath);
  const fetcher = new Fetcher({
    minDelayMs: opts.minDelayMs,
    maxJitterMs: opts.maxJitterMs,
    maxRetries: opts.maxRetries,
    userAgent: opts.userAgent,
    logger,
  });
  const backfiller = new Backfiller({
    upperBound: opts.upperBound,
    maxIds: opts.maxIds,
    db,
    fetcher,
    logger,
  });

  logger.info(
    `Backfill config: upperBound=${opts.upperBound ?? 'auto'} ` +
      `maxIds=${opts.maxIds} delayMs=${opts.minDelayMs} ` +
      `jitterMs=${opts.maxJitterMs} db=${opts.dbPath}`
  );

  const shutdown = (sig) => {
    logger.info(`Received ${sig}.`);
    backfiller.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await backfiller.run();
  } catch (e) {
    logger.error(`Backfill failed: ${e.message}`);
    if (e.stack) logger.error(e.stack);
    process.exitCode = 1;
  } finally {
    db.close();
    logger.close();
  }
}

main();
