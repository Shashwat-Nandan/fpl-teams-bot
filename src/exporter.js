'use strict';

const fs = require('fs');
const path = require('path');
const { PartitionedParquetWriter, toParquetRow } = require('./parquet');

/**
 * Exports the `managers` table to parquet, full the first time and
 * incremental (delta) thereafter.
 *
 * How "incremental" is defined
 * ----------------------------
 * `managers.last_updated` only moves when a row's player_name or team_name
 * actually changed (see the UPSERT in db.js) — a rank-only refresh does not
 * dirty the row. A delta run therefore exports exactly the managers whose
 * searchable content is new or changed since the last successful export.
 *
 * Watermarks
 * ----------
 * State lives in `export_state.watermark` (unix seconds). Each run:
 *
 *   1. opens a read transaction, so the watermark read and the row scan see
 *      one consistent snapshot even while the crawler is writing;
 *   2. computes hi = MAX(last_updated), capped at `now - 1 - lagSeconds`;
 *   3. exports rows in (lo, hi], where lo is the stored watermark;
 *   4. advances the watermark to hi — only after every file is closed AND the
 *      run has been recorded.
 *
 * A crash mid-run leaves the watermark untouched and the partial files
 * deleted, so the next run simply redoes the same range.
 *
 * Why hi lags instead of lo rewinding
 * -----------------------------------
 * `last_updated` only has 1-second resolution, and the crawler stamps `now`
 * at the top of its transaction rather than at commit. A batch that stamps
 * second T but commits just after the exporter's snapshot would be invisible
 * to this run, and a strict `> T` would exclude it from the next one too.
 *
 * The fix is to hold the *upper* bound back rather than to rewind the lower
 * one: a second is only eligible for export once it is `lagSeconds` in the
 * past, which gives any transaction that stamped it that long to commit. An
 * earlier version rewound `lo` instead, which closed the same hole but
 * re-emitted the boundary second on every run — so an idle database produced
 * a duplicate delta file every single night, forever. Lagging `hi` closes the
 * hole with no duplicates and makes "nothing changed" genuinely export
 * nothing.
 *
 * Deltas are still AT-LEAST-ONCE overall, because a crash between writing the
 * files and recording the run makes the next run redo the range. Apply them
 * downstream as an UPSERT on entry_id, never as a blind INSERT.
 */
class Exporter {
  constructor(opts = {}) {
    this.db = opts.db;
    this.logger = opts.logger;
    this.dataset = opts.dataset ?? 'managers';
    this.outDir = opts.outDir;
    this.rowsPerFile = opts.rowsPerFile ?? 2_000_000;
    this.compression = opts.compression ?? 'GZIP';
    this.mode = opts.mode ?? 'auto'; // 'auto' | 'full' | 'delta'
    this.since = opts.since ?? null; // explicit watermark override
    this.lagSeconds = opts.lagSeconds ?? 1;
    this.dryRun = opts.dryRun ?? false;
    this.progressEvery = opts.progressEvery ?? 500_000;
    this.stopRequested = false;
  }

  /** Decides full vs delta and the lower watermark bound. */
  _resolveRange() {
    const state = this.db.getExportState(this.dataset);

    if (this.mode === 'full') {
      return { kind: 'full', lo: 0, reason: '--full requested' };
    }
    if (this.since != null) {
      return {
        kind: 'delta',
        lo: this.since,
        reason: `--since ${this.since} requested`,
      };
    }
    if (!state) {
      return {
        kind: 'full',
        lo: 0,
        reason: 'no previous export recorded — this is the first pass',
      };
    }
    if (this.mode === 'delta' || this.mode === 'auto') {
      return {
        kind: 'delta',
        lo: state.watermark,
        reason: `resuming from watermark ${state.watermark} (${fmtTs(
          state.watermark
        )})`,
      };
    }
    throw new Error(`Unknown export mode: ${this.mode}`);
  }

  /**
   * The newest second eligible for export. Held `lagSeconds` behind the clock
   * so a transaction that stamped that second has time to commit before we
   * declare it done — see the class comment.
   */
  _upperBound(startedAt) {
    return Math.min(
      this.db.getMaxLastUpdated(),
      startedAt - 1 - this.lagSeconds
    );
  }

  /**
   * Names are stamped to the second, so two exports inside the same second
   * would otherwise silently overwrite each other. Suffix on collision.
   */
  _uniqueBaseName(kind, startedAt) {
    const base = `${this.dataset}_${kind}_${tsStamp(startedAt)}`;
    const taken = (name) =>
      fs.existsSync(path.join(this.outDir, name)) ||
      fs.existsSync(path.join(this.outDir, `${name}.parquet`));
    if (!taken(base)) return base;
    for (let n = 1; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken(candidate)) return candidate;
    }
  }

  /**
   * Builds idx_last_updated if missing. This takes SQLite's write lock for as
   * long as the build runs (minutes on a 12M-row table), which will stall —
   * and, without a generous busy_timeout, kill — a concurrently running
   * crawler. So it is announced loudly, and skipped entirely for --dry-run,
   * which is documented as having no side effects.
   */
  _ensureIndex() {
    if (this.db.hasLastUpdatedIndex()) return;

    if (this.dryRun) {
      this.logger.warn(
        'idx_last_updated is missing. --dry-run will not build it (the build ' +
          'takes SQLite\'s write lock); the scan below falls back to a full ' +
          'table scan and the real run will build it.'
      );
      return;
    }

    this.logger.info(
      'Building idx_last_updated — one-time, and it holds SQLite\'s write ' +
        'lock until it finishes (minutes on a large table). A crawler running ' +
        'against this DB will block until it completes.'
    );
    const t0 = Date.now();
    this.db.buildLastUpdatedIndex();
    this.logger.info(
      `Built idx_last_updated in ${((Date.now() - t0) / 1000).toFixed(1)}s.`
    );
  }

  async run() {
    this._ensureIndex();

    const startedAt = nowSec();
    this.db.beginRead();

    let writer = null;
    let committed = false;
    try {
      const { kind, lo, reason } = this._resolveRange();
      const hi = this._upperBound(startedAt);
      this.logger.info(`Export mode: ${kind} — ${reason}`);

      if (hi <= lo) {
        this.logger.info(
          `Nothing to export: no rows changed since ${fmtTs(lo)}.`
        );
        this.db.endRead();
        return { kind, rows: 0, files: [], watermarkFrom: lo, watermarkTo: lo };
      }

      this.logger.info(
        `Range: last_updated in (${lo}, ${hi}] — (${fmtTs(lo)} → ${fmtTs(hi)}]`
      );

      if (this.dryRun) {
        const count = this.db.countInRange(lo, hi);
        this.logger.info(
          `[dry-run] ${count.toLocaleString()} rows would be exported ` +
            `across ~${Math.max(1, Math.ceil(count / this.rowsPerFile))} file(s). ` +
            'Watermark NOT advanced.'
        );
        this.db.endRead();
        return { kind, rows: count, files: [], watermarkFrom: lo, watermarkTo: hi, dryRun: true };
      }

      const baseName = this._uniqueBaseName(kind, startedAt);
      writer = new PartitionedParquetWriter({
        baseDir: this.outDir,
        baseName,
        rowsPerFile: this.rowsPerFile,
        compression: this.compression,
        // A full pass is always partitioned; a delta is a single file unless
        // it grows past rowsPerFile.
        singleFile: kind === 'delta',
        onRollover: (file, total) =>
          this.logger.info(
            `Wrote ${path.basename(file.path)} ` +
              `(${file.rows.toLocaleString()} rows, ${fmtBytes(file.bytes)}). ` +
              `Total so far: ${total.toLocaleString()}.`
          ),
      });

      const t0 = Date.now();
      let rows = 0;
      const iter = this.db.iterateRange(lo, hi);
      try {
        for (const r of iter) {
          await writer.appendRow(toParquetRow(r));
          rows++;
          if (rows % this.progressEvery === 0) {
            const elapsed = (Date.now() - t0) / 1000;
            this.logger.info(
              `${rows.toLocaleString()} rows exported ` +
                `(${Math.round(rows / elapsed).toLocaleString()} rows/s).`
            );
          }
          if (this.stopRequested) {
            throw new Error('Export aborted by signal before completion');
          }
        }
      } finally {
        // better-sqlite3 refuses to COMMIT while a statement is still live.
        if (typeof iter.return === 'function') iter.return();
      }

      const files = await writer.close();
      const finishedAt = nowSec();

      this.db.endRead();
      // `writer` stays non-null until this succeeds. recordExport is what makes
      // the run real — if it throws (SQLITE_BUSY behind a crawler write, disk
      // full), the watermark does not move, so the files on disk belong to no
      // recorded run and the next export would write the same range again.
      // Leaving them would double-load the documented `managers_full_*` glob.
      this.db.recordExport({
        dataset: this.dataset,
        kind,
        watermarkFrom: lo,
        watermarkTo: hi,
        rows,
        files: files.map((f) => ({
          path: path.relative(process.cwd(), f.path),
          rows: f.rows,
          bytes: f.bytes,
        })),
        startedAt,
        finishedAt,
      });
      committed = true;
      writer = null;

      const bytes = files.reduce((a, f) => a + f.bytes, 0);
      const elapsed = Math.max(1, finishedAt - startedAt);
      this.logger.info(
        `${kind} export complete: ${rows.toLocaleString()} rows in ` +
          `${files.length} file(s), ${fmtBytes(bytes)}, ${elapsed}s. ` +
          `Watermark advanced to ${hi} (${fmtTs(hi)}).`
      );
      for (const f of files) {
        this.logger.info(
          `  ${path.relative(process.cwd(), f.path)}  ` +
            `${f.rows.toLocaleString()} rows  ${fmtBytes(f.bytes)}`
        );
      }

      return { kind, rows, files, watermarkFrom: lo, watermarkTo: hi };
    } catch (e) {
      // Discard output and leave the watermark where it was, so the next run
      // cleanly redoes this range. This deliberately also throws away parts
      // that finished cleanly: an export is all-or-nothing, and half a run
      // left on disk would be indistinguishable from a complete one to the
      // `managers_full_*/part-*.parquet` glob consumers are told to use.
      if (writer && !committed) {
        this.logger.warn('Export failed — removing this run\'s output.');
        await writer.abort();
      }
      this.db.endRead();
      throw e;
    }
  }

  stop() {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.logger.info(
      'Stop requested. Partial parquet output will be discarded and the ' +
        'watermark left unchanged.'
    );
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function fmtTs(sec) {
  if (!sec) return 'epoch';
  return new Date(sec * 1000).toISOString();
}

function tsStamp(sec) {
  return new Date(sec * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

module.exports = Exporter;
module.exports.fmtBytes = fmtBytes;
module.exports.fmtTs = fmtTs;
