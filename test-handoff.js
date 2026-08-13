'use strict';

/**
 * Tests for the cross-server handoff: CSV output and the run manifest.
 *
 * The manifest is the delivery contract. A shipper syncs data files first and
 * manifests second, so a manifest appearing on the far side means every file
 * it names is there in full. That only holds if:
 *
 *   - the manifest is written after every data file is closed, and
 *   - a run that fails to commit leaves no manifest behind, ever — otherwise
 *     the consumer loads a run the producer has already disowned and will
 *     re-export later under a different name.
 *
 * CSV correctness matters for the same reason: these files are loaded with a
 * bare `COPY ... WITH (FORMAT csv, HEADER true)`, so quoting has to be exactly
 * right for names containing commas, quotes and newlines — FPL team names
 * contain all three — and a NULL rank has to be distinguishable from an empty
 * string.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const FPLDatabase = require('./src/db');
const Exporter = require('./src/exporter');
const { SEASON } = require('./src/season');

const QUIET = { info() {}, warn() {}, error() {} };

function mkManager(entry, playerName, teamName, rank) {
  return { entry, player_name: playerName, entry_name: teamName, rank };
}

function tick(seconds = 2) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    /* busy-wait, as in test-export.js */
  }
}

/**
 * A deliberately independent RFC 4180 parser — reusing the writer's own
 * escaping to read its output back would test nothing.
 *
 * Returns { header, rows } where each row is an array of
 * { value, quoted } so NULL (unquoted empty) stays distinguishable from the
 * empty string (`""`), which is the whole point of the quoting rule.
 */
function parseCsv(text) {
  const records = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let record = [];
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      record.push({ value: field, quoted });
      field = '';
      quoted = false;
      i++;
      continue;
    }
    if (c === '\n') {
      record.push({ value: field, quoted });
      records.push(record);
      record = [];
      field = '';
      quoted = false;
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || quoted || record.length) {
    record.push({ value: field, quoted });
    records.push(record);
  }
  return {
    header: records[0].map((f) => f.value),
    rows: records.slice(1),
  };
}

function readCsvFile(filePath) {
  const raw = fs.readFileSync(filePath);
  const text = filePath.endsWith('.gz')
    ? zlib.gunzipSync(raw).toString('utf8')
    : raw.toString('utf8');
  return parseCsv(text);
}

function sha256(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function readManifest(result) {
  return JSON.parse(fs.readFileSync(result.manifest, 'utf8'));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-handoff-test-'));

  // Names that break naive CSV writers. All three shapes occur in real FPL
  // team names.
  const NASTY_TEAM = 'Ditto, "FC"\nUnited';
  const NASTY_NAME = 'O\'Brien, "Jr"';

  // ---------- 1. CSV round trip, quoting, and NULL rank ----------
  {
    const dbPath = path.join(tmp, 'a.db');
    const outDir = path.join(tmp, 'a-out');
    const db = new FPLDatabase(dbPath);
    db.upsertBatch([
      mkManager(1001, 'Harry Kane', 'Spurs 4 Life', 1),
      mkManager(1002, NASTY_NAME, NASTY_TEAM, null),
    ]);
    tick();

    const res = await new Exporter({
      db,
      logger: QUIET,
      outDir,
      format: 'csv',
      compression: 'UNCOMPRESSED',
    }).run();

    assert.strictEqual(res.kind, 'full');
    assert.strictEqual(res.rows, 2);
    assert.ok(
      res.files[0].path.endsWith('.csv'),
      `expected a .csv file, got ${res.files[0].path}`
    );

    const { header, rows } = readCsvFile(res.files[0].path);
    assert.deepStrictEqual(header, [
      'entry_id',
      'player_name',
      'team_name',
      'rank',
      'last_updated',
    ]);
    assert.strictEqual(
      rows.length,
      2,
      'both rows should survive the round trip'
    );

    const byId = new Map(rows.map((r) => [r[0].value, r]));
    const nasty = byId.get('1002');
    assert.strictEqual(
      nasty[1].value,
      NASTY_NAME,
      'a name with a comma and quotes must round trip exactly'
    );
    assert.strictEqual(
      nasty[2].value,
      NASTY_TEAM,
      'a team name with an embedded newline must round trip exactly'
    );

    // The NULL/empty-string distinction Postgres COPY relies on.
    assert.strictEqual(nasty[3].value, '', 'a null rank is an empty field');
    assert.strictEqual(
      nasty[3].quoted,
      false,
      'a null rank must be UNQUOTED empty, or COPY reads it as an empty string'
    );
    assert.strictEqual(byId.get('1001')[3].value, '1');
    assert.strictEqual(
      byId.get('1001')[1].quoted,
      true,
      'text columns must always be quoted so "" stays distinct from NULL'
    );

    // last_updated must be a timestamp Postgres can parse, not a unix int.
    const ts = byId.get('1001')[4].value;
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts),
      `last_updated should be ISO-8601, got ${ts}`
    );
    assert.ok(!Number.isNaN(Date.parse(ts)));

    db.close();
  }

  // ---------- 2. gzip is real, and every part carries its own header ----------
  {
    const dbPath = path.join(tmp, 'b.db');
    const outDir = path.join(tmp, 'b-out');
    const db = new FPLDatabase(dbPath);
    db.upsertBatch(
      Array.from({ length: 25 }, (_, i) =>
        mkManager(2000 + i, `Player ${i}`, `Team ${i}`, i + 1)
      )
    );
    tick();

    const res = await new Exporter({
      db,
      logger: QUIET,
      outDir,
      format: 'csv',
      rowsPerFile: 10,
    }).run();

    assert.strictEqual(res.files.length, 3, '25 rows at 10/file = 3 parts');
    for (const f of res.files) {
      assert.ok(f.path.endsWith('.csv.gz'), `expected .csv.gz, got ${f.path}`);
      // Gzip magic — proves the bytes are actually compressed, not just named.
      const magic = fs.readFileSync(f.path).subarray(0, 2);
      assert.deepStrictEqual([...magic], [0x1f, 0x8b], 'not a gzip stream');
    }

    let total = 0;
    for (const f of res.files) {
      const { header, rows } = readCsvFile(f.path);
      assert.strictEqual(
        header[0],
        'entry_id',
        'every part needs its own header to be independently COPY-able'
      );
      total += rows.length;
    }
    assert.strictEqual(total, 25, 'no rows lost across part boundaries');
    db.close();
  }

  // ---------- 3. the manifest describes the run accurately ----------
  {
    const dbPath = path.join(tmp, 'c.db');
    const outDir = path.join(tmp, 'c-out');
    const db = new FPLDatabase(dbPath);
    db.upsertBatch([
      mkManager(3001, 'A One', 'T1', 1),
      mkManager(3002, 'B Two', 'T2', 2),
    ]);
    tick();

    const full = await new Exporter({
      db,
      logger: QUIET,
      outDir,
      format: 'csv',
    }).run();

    const m = readManifest(full);
    assert.strictEqual(m.dataset, 'managers');
    assert.strictEqual(m.season, SEASON);
    assert.strictEqual(m.kind, 'full');
    assert.strictEqual(m.format, 'csv');
    assert.strictEqual(m.rows, 2);
    assert.strictEqual(m.watermark_from, 0, 'a full pass starts from epoch');
    assert.strictEqual(m.watermark_to, full.watermarkTo);
    assert.strictEqual(m.files.length, full.files.length);

    for (const entry of m.files) {
      const resolved = path.join(outDir, entry.name);
      assert.ok(
        fs.existsSync(resolved),
        `manifest names ${entry.name}, which does not exist under the export root`
      );
      assert.ok(
        !path.isAbsolute(entry.name),
        'manifest paths must be relative so they resolve after an rsync'
      );
      assert.strictEqual(
        entry.bytes,
        fs.statSync(resolved).size,
        'manifest byte count must match the file on disk'
      );
      assert.strictEqual(
        entry.sha256,
        sha256(resolved),
        'manifest checksum must match the file on disk'
      );
    }

    // A delta run picks up exactly where the full one stopped, so a consumer
    // applying manifests in watermark order has no gap between them.
    tick();
    db.upsertBatch([mkManager(3003, 'C Three', 'T3', 3)]);
    tick();
    const delta = await new Exporter({
      db,
      logger: QUIET,
      outDir,
      format: 'csv',
    }).run();

    const dm = readManifest(delta);
    assert.strictEqual(dm.kind, 'delta');
    assert.strictEqual(dm.rows, 1);
    assert.strictEqual(
      dm.watermark_from,
      m.watermark_to,
      "delta must resume exactly at the previous run's upper bound — a gap here is silent data loss"
    );
    const { rows: deltaRows } = readCsvFile(
      path.join(outDir, dm.files[0].name)
    );
    assert.strictEqual(deltaRows.length, 1);
    assert.strictEqual(deltaRows[0][0].value, '3003');

    db.close();
  }

  // ---------- 4. a failed run leaves no manifest and no files ----------
  {
    const dbPath = path.join(tmp, 'd.db');
    const outDir = path.join(tmp, 'd-out');
    const db = new FPLDatabase(dbPath);
    db.upsertBatch([mkManager(4001, 'A One', 'T1', 1)]);
    tick();

    // Fail at the point the run is recorded — files and manifest are already
    // on disk by then, which is exactly the dangerous case.
    const failing = Object.create(db);
    failing.recordExport = () => {
      throw new Error('simulated SQLITE_BUSY');
    };

    await assert.rejects(
      () =>
        new Exporter({
          db: failing,
          logger: QUIET,
          outDir,
          format: 'csv',
        }).run(),
      /simulated SQLITE_BUSY/
    );

    const left = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
    assert.deepStrictEqual(
      left.filter((f) => !f.startsWith('.')),
      [],
      `a failed run must leave nothing behind, found: ${left.join(', ')}`
    );

    // And the watermark never moved, so the range is re-exported next time.
    assert.strictEqual(
      db.getExportState('managers'),
      null,
      'a failed run must not record a watermark'
    );

    const retry = await new Exporter({
      db,
      logger: QUIET,
      outDir,
      format: 'csv',
    }).run();
    assert.strictEqual(retry.kind, 'full');
    assert.strictEqual(retry.rows, 1, 'the retry re-exports the same range');
    assert.ok(fs.existsSync(retry.manifest));
    db.close();
  }

  // ---------- 5. parquet still gets a manifest, and keeps its layout ----------
  {
    const dbPath = path.join(tmp, 'e.db');
    const outDir = path.join(tmp, 'e-out');
    const db = new FPLDatabase(dbPath);
    db.upsertBatch([mkManager(5001, 'A One', 'T1', 1)]);
    tick();

    const res = await new Exporter({ db, logger: QUIET, outDir }).run();
    assert.ok(
      res.files[0].path.endsWith('.parquet'),
      'parquet must remain the default format'
    );
    const m = readManifest(res);
    assert.strictEqual(m.format, 'parquet');
    assert.strictEqual(m.compression, 'GZIP');
    assert.strictEqual(m.files[0].sha256, sha256(res.files[0].path));
    db.close();
  }

  // ---------- 6. a delta that outgrows rowsPerFile is promoted cleanly ----------
  {
    const dbPath = path.join(tmp, 'f.db');
    const outDir = path.join(tmp, 'f-out');
    const db = new FPLDatabase(dbPath);
    db.upsertBatch([mkManager(6001, 'Seed', 'T', 1)]);
    tick();
    await new Exporter({ db, logger: QUIET, outDir, format: 'csv' }).run();

    tick();
    db.upsertBatch(
      Array.from({ length: 7 }, (_, i) =>
        mkManager(6100 + i, `New ${i}`, `NT ${i}`, i)
      )
    );
    tick();

    const delta = await new Exporter({
      db,
      logger: QUIET,
      outDir,
      format: 'csv',
      rowsPerFile: 3,
    }).run();

    assert.ok(delta.files.length > 1, 'the delta should have rolled over');
    for (const f of delta.files) {
      assert.ok(
        f.path.includes(`${path.sep}managers_delta_`),
        `a promoted delta must live in its own part directory: ${f.path}`
      );
      assert.ok(
        fs.existsSync(f.path),
        `${f.path} should exist after promotion`
      );
    }
    // The manifest must name the files at their *final* locations, not where
    // the first part was originally written.
    const m = readManifest(delta);
    for (const entry of m.files) {
      assert.ok(
        fs.existsSync(path.join(outDir, entry.name)),
        `manifest points at a moved file: ${entry.name}`
      );
    }
    const seen = new Set();
    for (const entry of m.files) {
      for (const row of readCsvFile(path.join(outDir, entry.name)).rows) {
        seen.add(row[0].value);
      }
    }
    assert.strictEqual(seen.size, 7, 'every changed row survives promotion');
    db.close();
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n✅ Cross-server handoff verified.');
  console.log('   - CSV quoting survives commas, quotes and newlines: ✓');
  console.log('   - NULL rank stays distinct from the empty string: ✓');
  console.log('   - Every gzipped part carries its own header: ✓');
  console.log('   - Manifest checksums/sizes match what is on disk: ✓');
  console.log('   - Delta manifests chain with no watermark gap: ✓');
  console.log('   - A failed run leaves no manifest to mislead a consumer: ✓');
  console.log('   - Parquet layout and default are unchanged: ✓');
})().catch((e) => {
  console.error('\n❌ Handoff test failed:', e);
  process.exit(1);
});
