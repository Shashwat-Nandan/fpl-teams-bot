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
