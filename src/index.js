#!/usr/bin/env node
'use strict';

const path = require('path');
const FPLDatabase = require('./db');
const Fetcher = require('./fetcher');
const Logger = require('./logger');
const Crawler = require('./crawler');

function printHelp() {
  console.log(`
FPL Manager Crawler

Crawls a classic FPL league's standings and stores
{entry_id, player_name, team_name, rank} into SQLite.

Usage: node src/index.js [options]

Options:
  --league <id>         League ID to crawl (default: 314 = Overall)
  --start-page <n>      Start page (default: 1, or resumes from checkpoint)
  --max-pages <n>       Max pages this run (default: unlimited)
  --delay-ms <n>        Min delay between requests in ms (default: 1500)
  --jitter-ms <n>       Max additional random jitter in ms (default: 500)
  --max-retries <n>     Max retries per request (default: 5)
  --db <path>           SQLite DB path (default: ./data/fpl.db)
  --log <path>          Log file path (default: ./logs/crawler.log)
  --no-log-file         Log to stdout only
  --user-agent <s>      Override User-Agent header
  -h, --help            Show this help

Examples:
  # Test run of 3 pages (~150 managers) against the Overall league.
  node src/index.js --max-pages 3

  # Slow-and-safe full crawl, 2s delay between requests.
  node src/index.js --delay-ms 2000

  # Resume is automatic — re-running the same command picks up where it left off.
`);
}

function parseArgs(argv) {
  const opts = {
    leagueId: 314,
    startPage: 1,
    maxPages: Infinity,
    minDelayMs: 1500,
    maxJitterMs: 500,
    maxRetries: 5,
    dbPath: path.join(process.cwd(), 'data', 'fpl.db'),
    logFile: path.join(process.cwd(), 'logs', 'crawler.log'),
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
      case '--league':       opts.leagueId = parseInt(next(), 10); break;
      case '--start-page':   opts.startPage = parseInt(next(), 10); break;
      case '--max-pages':    opts.maxPages = parseInt(next(), 10); break;
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
  const crawler = new Crawler({
    leagueId: opts.leagueId,
    startPage: opts.startPage,
    maxPages: opts.maxPages,
    db,
    fetcher,
    logger,
  });

  logger.info(
    `Config: league=${opts.leagueId} startPage=${opts.startPage} ` +
      `maxPages=${opts.maxPages} delayMs=${opts.minDelayMs} ` +
      `jitterMs=${opts.maxJitterMs} db=${opts.dbPath}`
  );

  const shutdown = (sig) => {
    logger.info(`Received ${sig}.`);
    crawler.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await crawler.run();
  } catch (e) {
    logger.error(`Crawler failed: ${e.message}`);
    if (e.stack) logger.error(e.stack);
    process.exitCode = 1;
  } finally {
    db.close();
    logger.close();
  }
}

main();
