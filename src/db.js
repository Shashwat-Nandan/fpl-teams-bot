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
    `);
  }

  _prepareStatements() {
    this.upsertManagerStmt = this.db.prepare(`
      INSERT INTO managers (entry_id, player_name, team_name, rank, last_updated)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        player_name  = excluded.player_name,
        team_name    = excluded.team_name,
        rank         = excluded.rank,
        last_updated = excluded.last_updated
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
