'use strict';

/**
 * End-to-end test for the parquet export pipeline.
 *
 * Unlike test-smoke.js this uses the *real* better-sqlite3 and writes real
 * parquet files to a temp dir, then reads them back. It verifies:
 *
 *   - First run is a FULL export; every row lands in parquet with the right
 *     values and types.
 *   - A rank-only change does NOT dirty the row (no delta rows produced).
 *   - A name/team change DOES, and shows up in the next delta.
 *   - A brand new manager shows up in the next delta.
 *   - The watermark advances and is persisted across process boundaries.
 *   - --full re-baselines and re-exports everything.
 *   - Part-file rollover at --rows-per-file.
 *   - A failed export leaves no partial files and does not move the watermark.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const parquet = require('@dsnp/parquetjs');

const FPLDatabase = require('./src/db');
const Logger = require('./src/logger');
const Exporter = require('./src/exporter');

const QUIET = { info() {}, warn() {}, error() {} };
const logger = process.env.VERBOSE ? new Logger(null) : QUIET;

/** Reads every row out of a full/delta export result. */
async function readRows(files) {
  const rows = [];
  for (const f of files) {
    const reader = await parquet.ParquetReader.openFile(f.path);
    const cursor = reader.getCursor();
    let r;
    while ((r = await cursor.next())) rows.push(r);
    await reader.close();
  }
  return rows.sort((a, b) => a.entry_id - b.entry_id);
}

function mkManager(entry, playerName, teamName, rank) {
  return { entry, player_name: playerName, entry_name: teamName, rank };
}

function newExporter(db, outDir, extra = {}) {
  return new Exporter({ db, logger, outDir, ...extra });
}

/**
 * `last_updated` has 1-second resolution and the exporter deliberately
 * ignores the second currently in progress, so tests must let the clock tick
 * before asserting on a freshly written row.
 */
function tick(seconds = 2) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    /* busy-wait: keeps the test synchronous and deterministic */
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-export-test-'));
  const dbPath = path.join(tmp, 'fpl.db');
  const outDir = path.join(tmp, 'parquet');

  // ---------- seed ----------
  let db = new FPLDatabase(dbPath);
  db.upsertBatch([
    mkManager(1001, 'Harry Kane', 'Spurs 4 Life', 1),
    mkManager(1002, 'Alice Zhang', 'Xi Jinping FC', 2),
    mkManager(1003, 'Shashwat Kumar', 'Ditto FC', 3),
  ]);
  tick();

  // ---------- 1. first run = full ----------
  const full = await newExporter(db, outDir).run();
  assert.strictEqual(full.kind, 'full', 'first run should be a full export');
  assert.strictEqual(full.rows, 3, 'full export should contain all 3 rows');

  let rows = await readRows(full.files);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[2].entry_id, 1003);
  assert.strictEqual(rows[2].player_name, 'Shashwat Kumar');
  assert.strictEqual(rows[2].team_name, 'Ditto FC');
  assert.strictEqual(rows[2].rank, 3);
  assert.ok(
    rows[2].last_updated instanceof Date,
    'last_updated should decode as a Date (TIMESTAMP_MILLIS)'
  );

  // Full export is partitioned into a directory.
  assert.ok(
    full.files[0].path.includes('managers_full_'),
    `unexpected full export path: ${full.files[0].path}`
  );

  // ---------- 2. no changes → empty delta ----------
  const noop = await newExporter(db, outDir, { overlapSeconds: 0 }).run();
  assert.strictEqual(noop.kind, 'delta', 'second run should be incremental');
  assert.strictEqual(noop.rows, 0, 'no changes should produce no delta rows');
  assert.strictEqual(noop.files.length, 0, 'no changes should write no files');

  // ---------- 3. rank-only change must NOT dirty the row ----------
  tick();
  db.upsertBatch([
    mkManager(1001, 'Harry Kane', 'Spurs 4 Life', 42), // rank 1 -> 42
    mkManager(1002, 'Alice Zhang', 'Xi Jinping FC', 7), // rank 2 -> 7
  ]);
  tick();

  const rankOnly = await newExporter(db, outDir, { overlapSeconds: 0 }).run();
  assert.strictEqual(
    rankOnly.rows,
    0,
    'a rank-only change must not produce delta rows'
  );
  // ...but the rank itself must still be refreshed in SQLite.
  const kane = db.db
    .prepare('SELECT rank FROM managers WHERE entry_id = 1001')
    .get();
  assert.strictEqual(kane.rank, 42, 'rank should still refresh in the DB');

  // ---------- 4. name/team change + new manager → delta ----------
  tick();
  db.upsertBatch([
    mkManager(1002, 'Alice Zhang', 'Renamed FC', 7), // team renamed
    mkManager(1004, 'New Manager', 'Fresh Team', 9), // brand new
  ]);
  tick();

  const delta = await newExporter(db, outDir, { overlapSeconds: 0 }).run();
  assert.strictEqual(delta.kind, 'delta');
  assert.strictEqual(delta.rows, 2, `expected 2 delta rows, got ${delta.rows}`);
  assert.strictEqual(delta.files.length, 1, 'small delta should be one file');
  assert.ok(
    delta.files[0].path.endsWith('.parquet') &&
      path.basename(delta.files[0].path).startsWith('managers_delta_'),
    `unexpected delta path: ${delta.files[0].path}`
  );

  rows = await readRows(delta.files);
  assert.deepStrictEqual(
    rows.map((r) => r.entry_id),
    [1002, 1004]
  );
  assert.strictEqual(rows[0].team_name, 'Renamed FC');
  assert.strictEqual(rows[1].player_name, 'New Manager');

  // ---------- 5. watermark survives a reopen ----------
  const watermark = db.getExportState('managers').watermark;
  db.close();
  db = new FPLDatabase(dbPath);
  assert.strictEqual(
    db.getExportState('managers').watermark,
    watermark,
    'watermark should persist across connections'
  );
  const afterReopen = await newExporter(db, outDir, { overlapSeconds: 0 }).run();
  assert.strictEqual(afterReopen.rows, 0, 'reopened DB should have no backlog');

  // ---------- 6. overlap re-emits the boundary second (at-least-once) ----------
  const overlapped = await newExporter(db, outDir, { overlapSeconds: 60 }).run();
  assert.ok(
    overlapped.rows >= 2,
    `overlap should re-emit boundary rows, got ${overlapped.rows}`
  );

  // ---------- 7. --full re-baselines ----------
  const refull = await newExporter(db, outDir, { mode: 'full' }).run();
  assert.strictEqual(refull.kind, 'full');
  assert.strictEqual(refull.rows, 4, 'full re-export should contain all 4 rows');

  // ---------- 8. part-file rollover ----------
  tick();
  const many = [];
  for (let i = 5000; i < 5025; i++) {
    many.push(mkManager(i, `Player ${i}`, `Team ${i}`, i));
  }
  db.upsertBatch(many);
  tick();

  const rolled = await newExporter(db, outDir, {
    overlapSeconds: 0,
    rowsPerFile: 10,
  }).run();
  assert.strictEqual(rolled.rows, 25);
  assert.strictEqual(
    rolled.files.length,
    3,
    `expected 3 part files at 10 rows each, got ${rolled.files.length}`
  );
  // Oversized "single file" delta gets promoted to a part directory.
  assert.ok(
    rolled.files.every((f) => /part-\d{4}\.parquet$/.test(f.path)),
    'rolled-over delta should become part files'
  );
  rows = await readRows(rolled.files);
  assert.strictEqual(rows.length, 25);
  assert.strictEqual(rows[0].entry_id, 5000);

  // ---------- 9. dry-run writes nothing and doesn't move the watermark ----------
  tick();
  db.upsertBatch([mkManager(6001, 'Dry Run', 'No Write FC', 1)]);
  tick();

  const before = db.getExportState('managers').watermark;
  const filesBefore = fs.readdirSync(outDir).length;
  const dry = await newExporter(db, outDir, {
    overlapSeconds: 0,
    dryRun: true,
  }).run();
  assert.strictEqual(dry.rows, 1, 'dry run should report the pending row');
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(
    db.getExportState('managers').watermark,
    before,
    'dry run must not advance the watermark'
  );
  assert.strictEqual(
    fs.readdirSync(outDir).length,
    filesBefore,
    'dry run must not write files'
  );

  // ---------- 10. failure leaves no partial output, watermark unmoved ----------
  const failing = newExporter(db, outDir, { overlapSeconds: 0, rowsPerFile: 1 });
  // Wrap the real DB, but make the row scan blow up partway through so we can
  // observe cleanup. Methods are listed explicitly because spreading a class
  // instance would not carry its prototype methods across.
  failing.db = {
    ensureLastUpdatedIndex: () => false,
    beginRead: () => db.beginRead(),
    endRead: () => db.endRead(),
    getExportState: (d) => db.getExportState(d),
    getMaxLastUpdated: () => db.getMaxLastUpdated(),
    countInRange: (a, b) => db.countInRange(a, b),
    recordExport: (r) => db.recordExport(r),
    iterateRange: function* () {
      yield {
        entry_id: 7001,
        player_name: 'Ok',
        team_name: 'Ok',
        rank: 1,
        last_updated: Math.floor(Date.now() / 1000),
      };
      throw new Error('simulated read failure');
    },
  };
  const wmBefore = db.getExportState('managers').watermark;
  const dirBefore = fs.readdirSync(outDir).sort();
  await assert.rejects(
    () => failing.run(),
    /simulated read failure/,
    'exporter should surface read failures'
  );
  assert.strictEqual(
    db.getExportState('managers').watermark,
    wmBefore,
    'failed export must not advance the watermark'
  );
  assert.deepStrictEqual(
    fs.readdirSync(outDir).sort(),
    dirBefore,
    'failed export must leave no partial files behind'
  );

  // ---------- 11. --compression is actually applied ----------
  // Parquet compression is a per-column schema property; passing it to
  // ParquetWriter.openFile() is silently ignored. Guard against a regression
  // that would leave every export uncompressed without any error.
  const { managersSchema } = require('./src/parquet');
  for (const codec of ['UNCOMPRESSED', 'SNAPPY', 'GZIP']) {
    const schema = managersSchema(codec);
    for (const [name, field] of Object.entries(schema.fields)) {
      assert.strictEqual(
        field.compression,
        codec,
        `column ${name} should carry compression=${codec}`
      );
    }
  }
  assert.throws(
    () => managersSchema('BROTLI_MAYBE'),
    /Unsupported compression/,
    'unknown codecs should be rejected, not silently ignored'
  );

  // And prove it end-to-end: GZIP output must be materially smaller.
  const sizes = {};
  for (const codec of ['UNCOMPRESSED', 'GZIP']) {
    const bulk = [];
    for (let i = 90000; i < 95000; i++) {
      bulk.push(mkManager(i, `Repeating Player Name ${i % 500}`, `Team ${i % 500}`, i));
    }
    tick();
    db.upsertBatch(bulk);
    tick();
    const out = await newExporter(db, outDir, {
      overlapSeconds: 0,
      mode: 'full',
      compression: codec,
    }).run();
    sizes[codec] = out.files.reduce((a, f) => a + f.bytes, 0);
  }
  assert.ok(
    sizes.GZIP < sizes.UNCOMPRESSED * 0.8,
    `GZIP (${sizes.GZIP}B) should be well under UNCOMPRESSED (${sizes.UNCOMPRESSED}B) — ` +
      'compression is not reaching the writer'
  );

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n✅ Parquet export pipeline verified end-to-end.');
  console.log('   - Full export on first run: ✓');
  console.log('   - Incremental (delta) on subsequent runs: ✓');
  console.log('   - Rank-only churn does not dirty rows: ✓');
  console.log('   - Name/team change + new manager appear in delta: ✓');
  console.log('   - Watermark persisted across connections: ✓');
  console.log('   - Overlap makes deltas at-least-once: ✓');
  console.log('   - --full re-baseline: ✓');
  console.log('   - Part-file rollover: ✓');
  console.log('   - --dry-run is side-effect free: ✓');
  console.log('   - Failure leaves no partial files / watermark: ✓');
  console.log('   - --compression reaches the columns and shrinks output: ✓');
})().catch((e) => {
  console.error('\n❌ Export test failed:', e);
  process.exit(1);
});
