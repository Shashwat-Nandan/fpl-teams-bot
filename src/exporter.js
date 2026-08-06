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
 *   2. reads hi = MAX(last_updated), clamped to now-1 so the second that is
 *      still in progress is never exported half-finished;
 *   3. exports rows in (lo, hi], where lo is the stored watermark rewound by
 *      `overlapSeconds`;
 *   4. advances the watermark to hi — only after every file is closed.
 *
 * A crash mid-run leaves the watermark untouched and the partial files
 * deleted, so the next run simply redoes the same range.
 *
 * Why the overlap: `last_updated` only has 1-second resolution, and the
 * crawler stamps `now` at the top of its transaction rather than at commit.
 * A batch that stamps second T but commits just after the exporter's snapshot
 * would be invisible to this run and excluded from the next one by a strict
 * `> T`. Rewinding the lower bound by one second closes that hole, at the
 * price of re-emitting the boundary second's rows. Deltas are therefore
 * AT-LEAST-ONCE: apply them downstream as an UPSERT on entry_id, never as a
 * blind INSERT. Set overlapSeconds to 0 for exactly-once-ish behaviour if you
 * know nothing is writing concurrently.
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
    this.overlapSeconds = opts.overlapSeconds ?? 1;
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
      const lo = Math.max(0, state.watermark - this.overlapSeconds);
      return {
        kind: 'delta',
        lo,
        reason:
          `resuming from watermark ${state.watermark} (${fmtTs(state.watermark)})` +
          (this.overlapSeconds
            ? `, rewound ${this.overlapSeconds}s for safe overlap`
            : ''),
      };
    }
    throw new Error(`Unknown export mode: ${this.mode}`);
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

  async run() {
    const built = this.db.ensureLastUpdatedIndex();
    if (built) {
      this.logger.info('Built idx_last_updated (one-time, first export only).');
    }

    const startedAt = nowSec();
    this.db.beginRead();

    let writer = null;
    try {
      const { kind, lo, reason } = this._resolveRange();
      // Clamp to the last fully-elapsed second: rows can still be committed
      // into the current one after our snapshot was taken.
      const hi = Math.min(this.db.getMaxLastUpdated(), startedAt - 1);
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
      writer = null;
      const finishedAt = nowSec();

      this.db.endRead();
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
      // Discard partial output and leave the watermark where it was, so the
      // next run cleanly redoes this range.
      if (writer) {
        this.logger.warn('Export failed — removing partial output.');
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
