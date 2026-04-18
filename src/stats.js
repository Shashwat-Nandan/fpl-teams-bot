#!/usr/bin/env node
'use strict';

/**
 * Show crawl progress stats.
 *
 * Usage: node src/stats.js [db-path]
 */

const path = require('path');
const fs = require('fs');
const FPLDatabase = require('./db');

function main() {
  const dbPath = process.argv[2] || path.join(process.cwd(), 'data', 'fpl.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found at ${dbPath}`);
    process.exit(1);
  }

  const db = new FPLDatabase(dbPath);

  const total = db.count();
  const leagueId = db.getState('league_id');
  const lastPage = db.getState('last_completed_page');

  const sample = db.db
    .prepare(
      'SELECT entry_id, player_name, team_name, rank FROM managers ORDER BY rank LIMIT 5'
    )
    .all();

  console.log('FPL Crawler Stats');
  console.log('─────────────────');
  console.log(`DB path:             ${dbPath}`);
  console.log(`League ID:           ${leagueId ?? '(none)'}`);
  console.log(`Last completed page: ${lastPage ?? '(none)'}`);
  console.log(`Total managers:      ${total.toLocaleString()}`);
  console.log('');
  console.log('Top 5 by rank:');
  for (const r of sample) {
    console.log(
      `  #${r.rank}  ${r.entry_id}  ${r.player_name}  —  "${r.team_name}"`
    );
  }

  db.close();
}

main();
