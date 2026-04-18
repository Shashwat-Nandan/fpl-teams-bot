# FPL Manager Crawler

Builds a searchable directory of every active Fantasy Premier League manager by crawling the Overall league (ID `314`) via the public FPL API. Captures exactly the three fields needed for your signup flow:

- `entry_id` — the FPL team ID
- `player_name` — the manager's real name (e.g. "Shashwat X")
- `team_name` — the FPL team name (e.g. "Ditto FC")

Plus `rank` (overall rank) for disambiguation in search results.

## Why this approach

FPL has no public search endpoint. The Overall league `314` is the only practical source that lists every active manager, paginated 50 per page. Iterating pages is cheaper and more reliable than brute-forcing sequential `entry/{id}/` lookups (which would need ~11M requests vs. ~220k pages here).

## Quick start

```bash
# Requires Node.js >= 18
npm install

# Smoke test: crawl 3 pages (~150 managers, ~5 seconds)
npm run test-run

# Check what we got
npm run stats

# Full crawl — run in background, will take many hours
node src/index.js > /dev/null 2>&1 &

# Export to CSV for Supabase / Postgres import
npm run export
```

## How rate limiting works

Built to be a good citizen on an unofficial API.

| Layer              | Default        | Configurable via        |
| ------------------ | -------------- | ----------------------- |
| Min delay          | 1500 ms        | `--delay-ms`            |
| Random jitter      | 0–500 ms       | `--jitter-ms`           |
| Max retries        | 5              | `--max-retries`         |
| Retry backoff      | exponential, capped 60s | —              |
| 429 `Retry-After`  | respected      | —                       |
| Timeout            | 30 s           | —                       |
| Concurrency        | 1 (serial)     | —                       |

Effective pace: ~30–40 requests/minute, ~1,500–2,000 managers/minute. A full crawl of ~11M managers takes ~5–7 days on defaults. Bump `--delay-ms` down to 1000 to roughly halve that if you're comfortable.

### If you hit 429s

The fetcher automatically respects `Retry-After`. If you see sustained 429s in the log, bump the delay:

```bash
node src/index.js --delay-ms 3000
```

## Resumability

Progress is checkpointed to SQLite after every successful page. Kill with Ctrl+C and re-run the same command — the crawler picks up from `last_completed_page + 1`. Graceful shutdown finishes the in-flight page first so no work is wasted.

State is keyed by `league_id`, so if you switch leagues (`--league 323` for Second Chance, for example) the state for that league is tracked separately.

## CLI options

```
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
```

## Data model

```sql
CREATE TABLE managers (
  entry_id      INTEGER PRIMARY KEY,
  player_name   TEXT NOT NULL,
  team_name     TEXT NOT NULL,
  rank          INTEGER,
  last_updated  INTEGER NOT NULL    -- unix seconds
);
CREATE INDEX idx_player_name ON managers(player_name COLLATE NOCASE);
CREATE INDEX idx_team_name   ON managers(team_name   COLLATE NOCASE);
```

Conflicts on `entry_id` are UPSERTed, so re-crawls refresh names/ranks for existing managers.

## Importing to Supabase / Postgres

```bash
npm run export   # writes ./data/fpl_managers.csv
```

Then in Postgres:

```sql
CREATE TABLE fpl_managers (
  entry_id    INTEGER PRIMARY KEY,
  player_name TEXT NOT NULL,
  team_name   TEXT NOT NULL,
  rank        INTEGER
);

\COPY fpl_managers FROM 'fpl_managers.csv' WITH (FORMAT csv, HEADER true);

-- Trigram indexes for fuzzy name search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_fpl_player_trgm ON fpl_managers USING gin (player_name gin_trgm_ops);
CREATE INDEX idx_fpl_team_trgm   ON fpl_managers USING gin (team_name   gin_trgm_ops);
```

Search API query shape:

```sql
SELECT entry_id, player_name, team_name, rank
FROM fpl_managers
WHERE player_name ILIKE $1 || '%'
   OR team_name   ILIKE $1 || '%'
ORDER BY rank
LIMIT 20;
```

## Running on your Contabo server

```bash
# One-shot full crawl in a detached screen session
screen -dmS fpl-crawler bash -c 'cd /opt/fpl-crawler && node src/index.js'

# Nightly incremental refresh (new managers have higher ranks, so crawl
# strategy for incremental updates is to re-crawl the whole thing — the
# UPSERT makes this cheap for existing rows)
0 2 * * *  cd /opt/fpl-crawler && node src/index.js >> logs/cron.log 2>&1
```

## Files

```
src/
  index.js      CLI entry point
  crawler.js    Crawl loop + checkpointing
  fetcher.js    HTTP with rate limit + retries
  db.js         SQLite schema + prepared statements
  logger.js     Timestamped logger
  export.js     CSV export utility
  stats.js      Progress stats
```
