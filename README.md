# FPL Manager Crawler

Builds a searchable directory of every active Fantasy Premier League manager by crawling the Overall league (ID `314`) via the public FPL API. Captures exactly the three fields needed for your signup flow:

- `entry_id` — the FPL team ID
- `player_name` — the manager's real name (e.g. "Shashwat X")
- `team_name` — the FPL team name (e.g. "Ditto FC")

Plus `rank` (overall rank) for disambiguation in search results.

## Why this approach

FPL has no public search endpoint. The Overall league `314` is the only practical source that lists every active manager, paginated 50 per page. Iterating pages is cheaper and more reliable than brute-forcing sequential `entry/{id}/` lookups (which would need ~13M requests vs. ~260k pages here).

**Except before the first gameweek**, when league standings don't exist at all — see below.

## Seasons

Two facts drive everything here, both verified against the live API:

1. **FPL reassigns entry IDs from 1 every season.** Entry `3027768` was "Erik Ibsen" in 2025-26; in 2026-27 it is "Philip Sander". IDs are dense from 1 to `bootstrap-static.total_players`, and everything above that 404s.
2. **Classic-league standings do not exist until the first gameweek is scored.** Pre-season, `leagues-classic/314/standings/` returns `results: []` with `has_next: false`. (League `315` is "StarHub League", not Overall — Overall is always `314`.)

Because of (1), **seasons cannot share a database**: re-crawling into last season's file would UPSERT one manager's row on top of another's, and every ID above the new season's ceiling would linger forever as a manager who no longer exists. Each season gets its own file, named from `SEASON` in `src/season.js`:

```
data/fpl.db            # 2025-26, archived — reachable with --db
data/fpl-2026-27.db    # current season (the default for every command)
```

Bump `SEASON` once a year. Last season's file is untouched.

### Collecting before the season starts

Because of (2), the league crawler simply cannot run pre-season. It detects this and refuses to checkpoint:

```
[WARN] League 314 returned no standings at all. Classic league standings do not
       exist until the first gameweek has been scored, so this is expected
       pre-season. Not checkpointing — re-run once GW1 is scored.
```

That guard matters: without it the crawler recorded `last_completed_page = 1` against an empty league and the real post-GW1 crawl would resume at page 2, permanently skipping the top 50 managers.

The entry endpoint **does** work pre-season, so `src/backfill.js` is the only way to collect managers before GW1. It takes its ceiling from `bootstrap-static.total_players` (no longer from `MAX(entry_id)`, which is 0 on a fresh DB), so it sweeps `1..N` on an empty database and picks up a higher ceiling every re-run as registrations climb:

```bash
node src/backfill.js > /dev/null 2>&1 &
```

Be realistic about the arithmetic: at the default ~1.25 s/request, 3.2M registered teams is **~46 days**, and registrations keep growing until the GW1 deadline (2025-26 finished with 13.08M IDs issued, and the count was climbing ~60k/day in early August). A pre-season sweep produces a large but **incomplete** snapshot. The league crawl after GW1 remains the only way to get a complete list quickly — roughly 5 days for the full population.

`rank` is `null` for every manager pre-season, since no gameweek has been scored. Rank-based disambiguation in search only starts working after GW1.

## Quick start

```bash
# Requires Node.js >= 18
npm install

# Smoke test: crawl 3 pages (~150 managers, ~5 seconds)
npm run test-run

# Check what we got
npm run stats

# PRE-SEASON (before GW1 is scored): standings don't exist, so sweep entry
# IDs instead. This is the only way to collect managers before the season.
node src/backfill.js > /dev/null 2>&1 &

# ONCE GW1 IS SCORED: full crawl — run in background, will take many hours
node src/index.js > /dev/null 2>&1 &

# Then backfill managers missed during the crawl (rank shifts mid-scan).
# See "Backfilling missed managers" below.
node src/backfill.js > /dev/null 2>&1 &

# Export to Parquet — full the first time, incremental every time after
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

## Backfilling missed managers

The league crawler scans pages of standings sorted by rank. When ranks shift mid-crawl (e.g. across a gameweek, or during a multi-day pause), managers whose rank improves into already-crawled pages get silently skipped. On a multi-day full run this can leave **~1–2% of active managers missing** from the DB.

`src/backfill.js` fixes this by probing entry IDs directly via `/api/entry/{id}/`. Entry IDs are immutable *within a season* (they are reassigned between seasons — see [Seasons](#seasons)), so this side-steps the moving-target problem entirely:

- 200 → upsert `{id, player_first_name + player_last_name, name, summary_overall_rank}` into `managers`.
- 404 → record in `dead_entries` so re-runs skip it.

It has two jobs now: filling post-crawl gaps, and acting as the **only** collection method before GW1, when standings don't exist.

```bash
# Smoke test: probe 5 missing IDs.
npm run backfill-test

# Full backfill (run in background — typically a few days for ~360k gaps).
node src/backfill.js > /dev/null 2>&1 &

# Tail progress.
tail -f logs/backfill.log
```

The backfill is resumable: the gap set is recomputed from the DB on each run (`[1, total_players] − managers − dead_entries`), in bounded chunks rather than one big array, so an empty-DB sweep of millions of IDs doesn't materialise them all up front. Killing the process at any point loses at most one in-flight request.

CLI options mirror the crawler's where they overlap:

```
--upper-bound <n>     Highest entry_id to probe (default: total_players)
--max-ids <n>         Max IDs to probe in this run (default: unlimited)
--delay-ms <n>        Min delay between requests in ms (default: 1000)
--jitter-ms <n>       Max additional random jitter in ms (default: 500)
--max-retries <n>     Max retries per request (default: 5)
--db <path>           SQLite DB path (default: ./data/fpl-<season>.db)
--log <path>          Log file path (default: ./logs/backfill.log)
--no-log-file         Log to stdout only
--user-agent <s>      Override User-Agent header
```

Default delay is 1000ms (vs 1500ms for the crawler) since per-entry calls are lighter — bump `--delay-ms` if you see sustained 429s.

## CLI options

```
--league <id>         League ID to crawl (default: 314 = Overall)
--start-page <n>      Start page (default: 1, or resumes from checkpoint)
--max-pages <n>       Max pages this run (default: unlimited)
--delay-ms <n>        Min delay between requests in ms (default: 1500)
--jitter-ms <n>       Max additional random jitter in ms (default: 500)
--max-retries <n>     Max retries per request (default: 5)
--db <path>           SQLite DB path (default: ./data/fpl-<season>.db)
--log <path>          Log file path (default: ./logs/crawler.log)
--no-log-file         Log to stdout only
--user-agent <s>      Override User-Agent header
```

Exporter (`src/export.js`):

```
--out-dir <path>       Output directory (default: ./data/parquet)
--db <path>            SQLite DB path (default: ./data/fpl-<season>.db)
--full                 Force a full re-export and re-baseline the watermark
--delta                Force an incremental export
--since <ts>           Override the watermark (unix seconds or ISO-8601)
--rows-per-file <n>    Rows per parquet part file (default: 2000000)
--compression <c>      GZIP | SNAPPY | UNCOMPRESSED (default: GZIP)
--lag-seconds <n>      Hold the newest n seconds back from export (default: 1)
--dry-run              Report what would be exported; write nothing
--status               Print watermark + recent export history, then exit
--dataset <name>       Watermark key, to feed several targets independently
--log <path>           Log file path (default: ./logs/export.log)
--no-log-file          Log to stdout only
```

## Data model

```sql
CREATE TABLE managers (
  entry_id      INTEGER PRIMARY KEY,
  player_name   TEXT NOT NULL,
  team_name     TEXT NOT NULL,
  rank          INTEGER,
  last_updated  INTEGER NOT NULL    -- unix seconds; only moves on a *content* change
);
CREATE INDEX idx_player_name ON managers(player_name COLLATE NOCASE);
CREATE INDEX idx_team_name   ON managers(team_name   COLLATE NOCASE);
CREATE INDEX idx_last_updated ON managers(last_updated);   -- built on first export

-- Used by the backfiller to remember entry_ids that returned 404, so we
-- don't re-probe them on subsequent runs.
CREATE TABLE dead_entries (
  entry_id   INTEGER PRIMARY KEY,
  status     INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- Incremental export watermark (one row per dataset) + run history.
CREATE TABLE export_state (
  dataset     TEXT PRIMARY KEY,
  watermark   INTEGER NOT NULL,
  last_kind   TEXT NOT NULL,
  last_run_at INTEGER NOT NULL
);
CREATE TABLE export_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dataset TEXT NOT NULL, kind TEXT NOT NULL,
  watermark_from INTEGER NOT NULL, watermark_to INTEGER NOT NULL,
  rows INTEGER NOT NULL, files TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL
);
```

Conflicts on `entry_id` are UPSERTed, so re-crawls refresh names/ranks for existing managers.

**`last_updated` is a change marker, not a "last seen" timestamp.** A re-crawl that finds a manager unchanged leaves it alone, and a **rank-only** change refreshes `rank` but deliberately does *not* bump `last_updated`. Ranks churn for nearly every one of the ~12.7M managers after each gameweek, so if rank counted as a change, every "incremental" export would be a full one. Only `player_name` / `team_name` changes — the fields the search actually uses — mark a row dirty.

> **Consequence for `rank` downstream.** Because a rank change never dirties a row, it is never carried by a delta. `rank` stays fresh in SQLite but the copy in Postgres freezes at whatever the last full snapshot recorded, for every manager whose name and team never change — which is nearly all of them. That is the right trade if `rank` is only a disambiguator in search results, which is what it is here. If you ever need `rank` to be accurate downstream, schedule a periodic `npm run export-full` (weekly is plenty) to re-baseline it; a delta run will never fix it.

## Exporting to Parquet (full, then incremental)

```bash
npm run export          # first run: FULL snapshot; every run after: delta only
npm run export-status   # where the watermark sits + recent run history
npm run export-dry-run  # what the next run would do, writes nothing
npm run export-full     # force a re-baseline
```

Output under `./data/parquet`:

```
data/parquet/
  managers_full_20260806T091600Z/
    part-0000.parquet          # 2M rows each by default (--rows-per-file)
    part-0001.parquet
    ...
  managers_delta_20260807T020000Z.parquet    # only what changed
  managers_delta_20260808T020000Z.parquet
```

A full pass is always split into part files; a delta is a single file unless it outgrows `--rows-per-file`, in which case it becomes a part directory too.

Rows are emitted in `last_updated` order, **not** sorted by `entry_id`. Sorting would force SQLite to materialise the whole range in a temp B-tree before the first row came out (a ~70s stall and a multi-GB temp file on a full pass); unordered, it streams straight off the index. Consumers UPSERT on `entry_id`, so order doesn't matter to them.

Parquet schema:

| column         | parquet type      | notes                          |
| -------------- | ----------------- | ------------------------------ |
| `entry_id`     | `INT32`           | FPL team ID, the primary key   |
| `player_name`  | `UTF8`            |                                |
| `team_name`    | `UTF8`            |                                |
| `rank`         | `INT32` (nullable)| overall rank at export time    |
| `last_updated` | `TIMESTAMP_MILLIS`| when the row's content changed |

### Compression

Parquet compression is a **per-column** property — passing a codec to the writer's options is silently ignored, so `src/parquet.js` bakes it into the schema. Head-to-head on 300k real rows from this dataset:

| codec           | size/row | write rate |
| --------------- | -------- | ---------- |
| `UNCOMPRESSED`  | 49.5 B   | 62k rows/s |
| `SNAPPY`        | 38.4 B   | 55k rows/s |
| `GZIP` (default)| 26.2 B   | 52k rows/s |

`GZIP` is the default because these files exist to be shipped and imported once; switch to `--compression SNAPPY` if you query the parquet in place and want faster decompression.

### Measured full pass

An actual `--full` run over the real 12.7M-row table:

```
full export complete: 12,741,486 rows in 7 file(s), 243.6 MB, 416s
  part-0000.parquet   2,000,000 rows   38.8 MB
  ...
  part-0006.parquet     741,486 rows   13.9 MB
```

~30.5k rows/s, **243.6 MB vs the old CSV's 536 MB** (compression improves over the sample benchmark because full 2M-row parts give the encoder much more to work with). A delta run over the same table finishes in about a second.

### How incremental works

The watermark lives in SQLite (`export_state.watermark`), not on disk, so the parquet directory can be moved or cleared without losing your place. Each run:

1. opens a **read transaction**, so the watermark read and the row scan share one consistent snapshot even while the crawler is writing;
2. takes `hi = MAX(last_updated)`, capped at `now - 1 - lagSeconds`;
3. exports rows in `(lo, hi]`, where `lo` is the stored watermark;
4. advances the watermark to `hi` — only after every file is closed **and** the run has been recorded.

An export is all-or-nothing. If a run crashes, is killed, or fails to record itself, every file it wrote is deleted and the watermark stays put, so the next run cleanly redoes the range. That deliberately throws away parts that had already finished — half a run left on disk would be indistinguishable from a complete one to the `managers_full_*/part-*.parquet` glob consumers are told to use.

**Why the upper bound lags.** `last_updated` has only 1-second resolution and the crawler stamps its timestamp at the start of a transaction rather than at commit, so a batch stamped second `T` can commit just after an exporter snapshot that already passed `T`. Holding `hi` back by `--lag-seconds` (default 1) gives such a transaction time to land before its second is ever declared done. An earlier design rewound the *lower* bound instead, which closed the same hole but re-emitted the boundary second on every run — an idle database grew one duplicate delta file every night, forever.

Deltas are still **at-least-once** overall: a crash between writing the files and recording the run replays that range. Apply them downstream as an **UPSERT on `entry_id`**, never a blind INSERT.

Only one export per dataset can run at a time, enforced by a `.{dataset}.export.lock` file in the output directory (stale locks from a `kill -9` are detected via the recorded PID and reclaimed). Without it, two runs would pick the same timestamped base name and truncate each other's parquet.

### The one-time index build

The first real export builds `idx_last_updated` over the whole `managers` table. This **takes SQLite's write lock for the duration** — about a minute on 12.7M rows, and it adds ~171 MB to the DB. A crawler writing to the same database will block until it finishes, which is why `FPLDatabase` sets `busy_timeout` to 10 minutes; with SQLite's 5-second default the crawler would die with `SQLITE_BUSY` mid-crawl instead of waiting.

`--dry-run` never builds the index (it is documented as having no side effects), so a dry run on a DB that lacks it falls back to a slower full table scan and says so.

## Importing to Supabase / Postgres

```sql
CREATE TABLE fpl_managers (
  entry_id     INTEGER PRIMARY KEY,
  player_name  TEXT NOT NULL,
  team_name    TEXT NOT NULL,
  rank         INTEGER,
  last_updated TIMESTAMPTZ NOT NULL
);

-- Trigram indexes for fuzzy name search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_fpl_player_trgm ON fpl_managers USING gin (player_name gin_trgm_ops);
CREATE INDEX idx_fpl_team_trgm   ON fpl_managers USING gin (team_name   gin_trgm_ops);
```

Load the parquet files with whatever your stack prefers. With DuckDB (no server needed, reads the whole directory at once):

```sql
INSTALL postgres; LOAD postgres;
ATTACH 'postgresql://…' AS pg (TYPE postgres);

-- Initial load from the full snapshot.
INSERT INTO pg.fpl_managers
SELECT * FROM read_parquet('data/parquet/managers_full_*/part-*.parquet');
```

Then replay each delta idempotently:

```sql
INSERT INTO pg.fpl_managers
SELECT * FROM read_parquet('data/parquet/managers_delta_20260807T020000Z.parquet')
ON CONFLICT (entry_id) DO UPDATE SET
  player_name  = EXCLUDED.player_name,
  team_name    = EXCLUDED.team_name,
  rank         = EXCLUDED.rank,
  last_updated = EXCLUDED.last_updated;
```

Because every row carries its own `last_updated`, deltas can be replayed in any order and re-applied safely.

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

# ...then ship only what changed. The first run emits a full snapshot,
# every run after that emits a delta.
0 3 * * *  cd /opt/fpl-crawler && node src/export.js >> logs/cron.log 2>&1
```

The exporter is safe to run while the crawler is still going — it reads from a consistent snapshot, and anything written after that snapshot is simply picked up by the next run. The one exception is the **first** export, which builds `idx_last_updated` and holds the write lock while it does (see above) — the crawler will stall for the length of that build rather than fail, thanks to the raised `busy_timeout`. Run the first export when the crawler is idle if you'd rather avoid the stall entirely.

## Files

```
src/
  index.js      Crawler CLI entry point
  crawler.js    League-pages crawl loop + checkpointing
  backfill.js   Backfiller CLI entry point
  backfiller.js Probes /api/entry/{id}/ for IDs missed by the crawler
  fetcher.js    HTTP with rate limit + retries
  season.js     Season constant + per-season DB path
  db.js         SQLite schema + prepared statements
  logger.js     Timestamped logger
  export.js     Parquet export CLI (full first, incremental after)
  exporter.js   Watermark resolution + streaming export loop
  parquet.js    Parquet schema + partitioned/rolling writer
  stats.js      Progress stats
```
