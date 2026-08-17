#!/usr/bin/env node
'use strict';

const path = require('path');
const { defaultDbPath } = require('./season');
const FPLDatabase = require('./db');
const Fetcher = require('./fetcher');
const Logger = require('./logger');
const Backfiller = require('./backfiller');
const { acquireLock } = require('./lock');

function printHelp() {
  console.log(`
FPL Entry Backfiller

Probes /api/entry/{id}/ for entry IDs missing from the managers table,
filling gaps left behind by the league crawler (which can miss managers
whose ranks shifted into already-crawled pages mid-crawl).

Usage: node src/backfill.js [options]

Options:
  --upper-bound <n>     Highest entry_id to probe (default: total_players from
                        bootstrap-static, i.e. every registered team)
  --max-ids <n>         Max IDs to probe in this run (default: unlimited)
  --rate <n>            Target requests per second (default: 100). The API
                        starts returning 429s above ~150/s.
  --concurrency <n>     Requests in flight at once (default: 16). Hides network
                        latency; the rate above is what bounds throughput.
  --max-consecutive-failures <n>
                        Stop the run after this many unreachable IDs in a row
                        with no success between (default: 25). Isolated
                        failures are deferred to a later run, never fatal.
  --delay-ms <n>        Min delay between requests in ms. Overrides --rate.
  --jitter-ms <n>       Max additional random jitter in ms
  --max-retries <n>     Max retries per request (default: 5)
  --db <path>           SQLite DB path (default: ./data/fpl-<season>.db)
  --log <path>          Log file path (default: ./logs/backfill.log)
  --no-log-file         Log to stdout only
  --user-agent <s>      Override User-Agent header
  -h, --help            Show this help

Examples:
  # Smoke test: probe 5 missing IDs.
  node src/backfill.js --max-ids 5

  # Full backfill, run in background (~9h for a full 3.2M sweep).
  node src/backfill.js > /dev/null 2>&1 &

  # Back off if the API starts pushing back.
  node src/backfill.js --rate 50

  # Re-run after kill — picks up automatically (gaps are recomputed from DB).
`);
}

const DEFAULT_RATE = 100;

/**
 * Split a target request rate into a minimum spacing plus jitter averaging to
 * the same thing, so a fleet of workers doesn't fire in lockstep.
 */
function spacingForRate(rate) {
  const avg = 1000 / rate;
  return { minDelayMs: avg * 0.8, maxJitterMs: avg * 0.4 };
}

function parseArgs(argv) {
  const opts = {
    upperBound: null,
    maxIds: Infinity,
    ...spacingForRate(DEFAULT_RATE),
    concurrency: 16,
    maxConsecutiveFailures: 25,
    maxRetries: 5,
    dbPath: defaultDbPath(),
    logFile: path.join(process.cwd(), 'logs', 'backfill.log'),
    userAgent: undefined,
  };

  let rate = null;
  const explicit = {};

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
      case '--rate':         rate = parseFloat(next()); break;
      case '--concurrency':  opts.concurrency = parseInt(next(), 10); break;
      case '--max-consecutive-failures':
        opts.maxConsecutiveFailures = parseInt(next(), 10); break;
      case '--delay-ms':     explicit.minDelayMs = parseInt(next(), 10); break;
      case '--jitter-ms':    explicit.maxJitterMs = parseInt(next(), 10); break;
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

  if (rate !== null) {
    if (!Number.isFinite(rate) || rate <= 0) {
      console.error('--rate must be a positive number of requests per second.');
      process.exit(2);
    }
    Object.assign(opts, spacingForRate(rate));
  }
  // Applied last so --delay-ms/--jitter-ms win regardless of argument order.
  Object.assign(opts, explicit);

  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    console.error('--concurrency must be a positive integer.');
    process.exit(2);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);

  // One sweep per database. Without this, an hourly timer firing while a
  // multi-hour sweep is still running would probe every gap twice and double
  // the request rate straight into the 429s measured above ~150/s.
  const release = acquireLock(
    path.join(
      path.dirname(opts.dbPath),
      `.${path.basename(opts.dbPath)}.backfill.lock`
    ),
    { label: 'backfill', busyExitCode: 0 }
  );

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
    concurrency: opts.concurrency,
    maxConsecutiveFailures: opts.maxConsecutiveFailures,
    db,
    fetcher,
    logger,
  });

  const effectiveRate = 1000 / (opts.minDelayMs + opts.maxJitterMs / 2);
  logger.info(
    `Backfill config: upperBound=${opts.upperBound ?? 'auto'} ` +
      `maxIds=${opts.maxIds} rate=~${effectiveRate.toFixed(0)}/s ` +
      `concurrency=${opts.concurrency} delayMs=${opts.minDelayMs} ` +
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
    release();
    db.close();
    logger.close();
  }
}

main();
