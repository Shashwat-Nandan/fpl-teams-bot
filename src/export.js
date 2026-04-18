#!/usr/bin/env node
'use strict';

/**
 * Export the managers table to CSV for easy import into Postgres / Supabase.
 *
 * Usage:
 *   node src/export.js [db-path] [output-csv-path]
 *
 * Defaults:
 *   db-path:          ./data/fpl.db
 *   output-csv-path:  ./data/fpl_managers.csv
 *
 * Postgres import example:
 *   CREATE TABLE fpl_managers (
 *     entry_id    INTEGER PRIMARY KEY,
 *     player_name TEXT NOT NULL,
 *     team_name   TEXT NOT NULL,
 *     rank        INTEGER
 *   );
 *   \COPY fpl_managers FROM 'fpl_managers.csv' WITH (FORMAT csv, HEADER true);
 */

const fs = require('fs');
const path = require('path');
const FPLDatabase = require('./db');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function main() {
  const dbPath = process.argv[2] || path.join(process.cwd(), 'data', 'fpl.db');
  const outPath =
    process.argv[3] || path.join(process.cwd(), 'data', 'fpl_managers.csv');

  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found at ${dbPath}`);
    process.exit(1);
  }

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const db = new FPLDatabase(dbPath);
  const stmt = db.db.prepare(
    'SELECT entry_id, player_name, team_name, rank FROM managers ORDER BY rank'
  );

  const out = fs.createWriteStream(outPath);
  out.write('entry_id,player_name,team_name,rank\n');

  let count = 0;
  for (const r of stmt.iterate()) {
    out.write(
      [
        r.entry_id,
        csvEscape(r.player_name),
        csvEscape(r.team_name),
        r.rank ?? '',
      ].join(',') + '\n'
    );
    count++;
  }

  out.end(() => {
    console.log(`Exported ${count} managers to ${outPath}`);
    db.close();
  });
}

main();
