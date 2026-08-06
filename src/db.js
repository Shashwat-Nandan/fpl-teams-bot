'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class FPLDatabase {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    // WAL gives us concurrent reads while crawler writes, and is much faster.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS managers (
        entry_id      INTEGER PRIMARY KEY,
        player_name   TEXT NOT NULL,
        team_name     TEXT NOT NULL,
        rank          INTEGER,
        last_updated  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_player_name
        ON managers(player_name COLLATE NOCASE);

      CREATE INDEX IF NOT EXISTS idx_team_name
        ON managers(team_name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS crawl_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dead_entries (
        entry_id   INTEGER PRIMARY KEY,
        status     INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
      );

      -- Watermark for incremental (delta) exports. One row per dataset.
      CREATE TABLE IF NOT EXISTS export_state (
        dataset     TEXT PRIMARY KEY,
        watermark   INTEGER NOT NULL,   -- highest managers.last_updated exported
        last_kind   TEXT NOT NULL,      -- 'full' | 'delta'
        last_run_at INTEGER NOT NULL
      );

      -- Append-only history of export runs, for auditing / replay.
      CREATE TABLE IF NOT EXISTS export_runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset        TEXT NOT NULL,
        kind           TEXT NOT NULL,
        watermark_from INTEGER NOT NULL,
        watermark_to   INTEGER NOT NULL,
        rows           INTEGER NOT NULL,
        files          TEXT NOT NULL,   -- JSON array of {path, rows, bytes}
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER NOT NULL
      );
    `);
  }

  _prepareStatements() {
    // `last_updated` is the watermark that drives incremental exports, so it
    // must only move when the row's *content* actually changed. `rank` churns
    // for nearly every manager after each gameweek, so a rank-only change
    // refreshes the column but deliberately leaves `last_updated` alone —
    // otherwise every delta export would degenerate into a full one.
    //
    // In SQLite's DO UPDATE, all right-hand sides are evaluated against the
    // pre-update row, so `managers.player_name` below is the *old* value.
    this.upsertManagerStmt = this.db.prepare(`
      INSERT INTO managers (entry_id, player_name, team_name, rank, last_updated)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        player_name  = excluded.player_name,
        team_name    = excluded.team_name,
        rank         = excluded.rank,
        last_updated = CASE
          WHEN managers.player_name IS NOT excluded.player_name
            OR managers.team_name   IS NOT excluded.team_name
          THEN excluded.last_updated
          ELSE managers.last_updated
        END
    `);

    this.getStateStmt = this.db.prepare(
      'SELECT value FROM crawl_state WHERE key = ?'
    );

    this.setStateStmt = this.db.prepare(`
      INSERT INTO crawl_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    this.countStmt = this.db.prepare('SELECT COUNT(*) AS count FROM managers');

    this.markDeadStmt = this.db.prepare(`
      INSERT INTO dead_entries (entry_id, status, last_seen)
      VALUES (?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        status    = excluded.status,
        last_seen = excluded.last_seen
    `);

    this.maxEntryIdStmt = this.db.prepare(
      'SELECT MAX(entry_id) AS max FROM managers'
    );
  }

  /**
   * Upsert a single manager from the /api/entry/{id}/ endpoint shape.
   */
  upsertFromEntry(data) {
    const first = (data.player_first_name ?? '').trim();
    const last = (data.player_last_name ?? '').trim();
    const playerName = `${first} ${last}`.trim();
    const teamName = (data.name ?? '').trim();
    if (!playerName || !teamName || !Number.isInteger(data.id)) {
      throw new Error(
        `Malformed entry payload: id=${data.id} name=${data.name} ` +
          `first=${data.player_first_name} last=${data.player_last_name}`
      );
    }
    const now = Math.floor(Date.now() / 1000);
    this.upsertManagerStmt.run(
      data.id,
      playerName,
      teamName,
      data.summary_overall_rank ?? null,
      now
    );
  }

  /**
   * Record an entry_id we've confirmed doesn't exist (e.g. 404) so re-runs
   * skip it instead of probing again.
   */
  markDead(entryId, status) {
    this.markDeadStmt.run(entryId, status, Math.floor(Date.now() / 1000));
  }

  getMaxEntryId() {
    return this.maxEntryIdStmt.get().max;
  }

  /**
   * Returns a sorted array of entry_ids in [1, upperBound] that are present
   * in neither `managers` nor `dead_entries`. Streams managers in sorted
   * order to find gaps in a single pass; dead_entries is kept in a Set in
   * memory (typically small).
   */
  getMissingEntryIds(upperBound) {
    if (!Number.isInteger(upperBound) || upperBound < 1) return [];

    const dead = new Set(
      this.db
        .prepare('SELECT entry_id FROM dead_entries WHERE entry_id <= ?')
        .all(upperBound)
        .map((r) => r.entry_id)
    );

    const stmt = this.db.prepare(
      'SELECT entry_id FROM managers WHERE entry_id <= ? ORDER BY entry_id'
    );

    const missing = [];
    let prev = 0;
    for (const row of stmt.iterate(upperBound)) {
      for (let id = prev + 1; id < row.entry_id; id++) {
        if (!dead.has(id)) missing.push(id);
      }
      prev = row.entry_id;
    }
    for (let id = prev + 1; id <= upperBound; id++) {
      if (!dead.has(id)) missing.push(id);
    }
    return missing;
  }

  /**
   * Upsert a batch of standings results in a single transaction.
   * Each entry is the raw object from standings.results in the FPL API.
   */
  upsertBatch(entries) {
    const now = Math.floor(Date.now() / 1000);
    const tx = this.db.transaction((batch) => {
      for (const e of batch) {
        this.upsertManagerStmt.run(
          e.entry,          // FPL team ID
          e.player_name,    // manager's real name
          e.entry_name,     // team name
          e.rank ?? null,
          now
        );
      }
    });
    tx(entries);
  }

  // ---------------------------------------------------------------------
  // Export support
  //
  // These statements are prepared lazily: only `src/export.js` needs them,
  // and the crawler/backfiller shouldn't pay for parsing them at startup.
  // ---------------------------------------------------------------------

  _exportStmts() {
    if (this._export) return this._export;
    this._export = {
      maxLastUpdated: this.db.prepare(
        'SELECT MAX(last_updated) AS max FROM managers'
      ),
      countRange: this.db.prepare(
        'SELECT COUNT(*) AS count FROM managers WHERE last_updated > ? AND last_updated <= ?'
      ),
      // Deliberately unordered. Adding `ORDER BY entry_id` makes SQLite
      // materialise the whole range in a temp B-tree before yielding the
      // first row ("USE TEMP B-TREE FOR ORDER BY") — on a full export that
      // is a ~70s stall and a multi-GB temp file before a single byte of
      // parquet is written. Unordered, it streams straight off
      // idx_last_updated. Consumers UPSERT on entry_id, so order is
      // irrelevant to them.
      selectRange: this.db.prepare(`
        SELECT entry_id, player_name, team_name, rank, last_updated
        FROM managers
        WHERE last_updated > ? AND last_updated <= ?
      `),
      getExportState: this.db.prepare(
        'SELECT * FROM export_state WHERE dataset = ?'
      ),
      setExportState: this.db.prepare(`
        INSERT INTO export_state (dataset, watermark, last_kind, last_run_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(dataset) DO UPDATE SET
          watermark   = excluded.watermark,
          last_kind   = excluded.last_kind,
          last_run_at = excluded.last_run_at
      `),
      insertExportRun: this.db.prepare(`
        INSERT INTO export_runs
          (dataset, kind, watermark_from, watermark_to, rows, files, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      recentRuns: this.db.prepare(
        'SELECT * FROM export_runs WHERE dataset = ? ORDER BY id DESC LIMIT ?'
      ),
    };
    return this._export;
  }

  /**
   * Delta exports scan `WHERE last_updated > ? AND last_updated <= ?`, which
   * is a full table scan without this index. Created on demand (the first
   * export pays for it) so crawler startup is never blocked by an index build
   * over millions of rows. Returns true if it actually built the index.
   */
  ensureLastUpdatedIndex() {
    const existing = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
      .get('idx_last_updated');
    if (existing) return false;
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_last_updated ON managers(last_updated)'
    );
    return true;
  }

  /**
   * Open a read transaction so that the watermark read and the row scan that
   * follows it see one consistent snapshot. Without this, a row committed by
   * a concurrently running crawler between the two could be skipped forever.
   *
   * The caller MUST fully drain (or close) any iterator before endRead().
   */
  beginRead() {
    this.db.exec('BEGIN DEFERRED');
  }

  endRead() {
    if (this.db.inTransaction) this.db.exec('COMMIT');
  }

  getMaxLastUpdated() {
    return this._exportStmts().maxLastUpdated.get().max ?? 0;
  }

  countInRange(lo, hi) {
    return this._exportStmts().countRange.get(lo, hi).count;
  }

  /** Streaming iterator over the managers changed in (lo, hi]. */
  iterateRange(lo, hi) {
    return this._exportStmts().selectRange.iterate(lo, hi);
  }

  getExportState(dataset) {
    return this._exportStmts().getExportState.get(dataset) ?? null;
  }

  getRecentExportRuns(dataset, limit = 10) {
    return this._exportStmts().recentRuns.all(dataset, limit);
  }

  /**
   * Commit an export: append the run to history and advance the watermark,
   * atomically, so a crash can never leave the watermark ahead of the data.
   */
  recordExport(run) {
    const s = this._exportStmts();
    const tx = this.db.transaction((r) => {
      s.insertExportRun.run(
        r.dataset,
        r.kind,
        r.watermarkFrom,
        r.watermarkTo,
        r.rows,
        JSON.stringify(r.files),
        r.startedAt,
        r.finishedAt
      );
      s.setExportState.run(r.dataset, r.watermarkTo, r.kind, r.finishedAt);
    });
    tx(run);
  }

  getState(key) {
    const row = this.getStateStmt.get(key);
    return row ? row.value : null;
  }

  setState(key, value) {
    this.setStateStmt.run(key, String(value));
  }

  count() {
    return this.countStmt.get().count;
  }

  close() {
    this.db.close();
  }
}

module.exports = FPLDatabase;
