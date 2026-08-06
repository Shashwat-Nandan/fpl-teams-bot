'use strict';

const fs = require('fs');
const path = require('path');
const parquet = require('@dsnp/parquetjs');

const CODECS = ['UNCOMPRESSED', 'SNAPPY', 'GZIP'];

/**
 * Parquet schema for the managers dataset.
 *
 * `last_updated` is written as TIMESTAMP_MILLIS so it lands as a real
 * timestamp in Postgres / DuckDB / Spark rather than a bare integer. The
 * export watermark stored in SQLite stays in unix *seconds* — the conversion
 * happens here and only here.
 *
 * NOTE: parquet compression is a *per-column* property. Passing
 * `{compression}` to ParquetWriter.openFile() is silently ignored, so the
 * codec has to be baked into the schema, which is why this is a function
 * rather than a constant.
 */
function managersSchema(compression = 'GZIP') {
  if (!CODECS.includes(compression)) {
    throw new Error(
      `Unsupported compression: ${compression} (expected ${CODECS.join(', ')})`
    );
  }
  return new parquet.ParquetSchema({
    entry_id: { type: 'INT32', compression },
    player_name: { type: 'UTF8', compression },
    team_name: { type: 'UTF8', compression },
    rank: { type: 'INT32', optional: true, compression },
    last_updated: { type: 'TIMESTAMP_MILLIS', compression },
  });
}

/**
 * Writes rows to one or more parquet files, rolling over to a new part file
 * every `rowsPerFile` rows.
 *
 * Two output shapes, chosen by the caller via `singleFile`:
 *   - singleFile: true  → ./<base>.parquet, but only until the first
 *                         rollover; after that it transparently becomes a
 *                         part directory, so an unexpectedly large delta
 *                         never produces one enormous file.
 *   - singleFile: false → ./<base>/part-0000.parquet, part-0001.parquet, …
 */
class PartitionedParquetWriter {
  constructor(opts) {
    this.baseDir = opts.baseDir;
    this.baseName = opts.baseName;
    this.rowsPerFile = opts.rowsPerFile ?? 2_000_000;
    this.compression = opts.compression ?? 'GZIP';
    this.rowGroupSize = opts.rowGroupSize ?? 50_000;
    this.singleFile = opts.singleFile ?? false;
    this.schema = opts.schema ?? managersSchema(this.compression);
    this.onRollover = opts.onRollover ?? (() => {});

    this.files = [];
    this.totalRows = 0;
    this._writer = null;
    this._rowsInPart = 0;
    this._partIndex = 0;
    this._currentPath = null;
    this._dirCreated = false;
  }

  get _partDir() {
    return path.join(this.baseDir, this.baseName);
  }

  _nextPath() {
    // A single-file export that outgrows rowsPerFile gets promoted to a part
    // directory; the first file is moved in so the layout stays consistent.
    if (this.singleFile && this._partIndex === 0) {
      return path.join(this.baseDir, `${this.baseName}.parquet`);
    }
    if (this.singleFile && this._partIndex === 1) this._promoteToDirectory();

    if (!this._dirCreated) {
      fs.mkdirSync(this._partDir, { recursive: true });
      this._dirCreated = true;
    }
    const part = String(this._partIndex).padStart(4, '0');
    return path.join(this._partDir, `part-${part}.parquet`);
  }

  _promoteToDirectory() {
    fs.mkdirSync(this._partDir, { recursive: true });
    this._dirCreated = true;
    const first = this.files[0];
    const moved = path.join(this._partDir, 'part-0000.parquet');
    fs.renameSync(first.path, moved);
    first.path = moved;
    this.singleFile = false;
  }

  async _openPart() {
    this._currentPath = this._nextPath();
    fs.mkdirSync(path.dirname(this._currentPath), { recursive: true });
    // Compression lives on the schema's columns, not here.
    this._writer = await parquet.ParquetWriter.openFile(
      this.schema,
      this._currentPath,
      { rowGroupSize: this.rowGroupSize }
    );
    this._rowsInPart = 0;
  }

  async _closePart() {
    if (!this._writer) return;
    await this._writer.close();
    const bytes = fs.statSync(this._currentPath).size;
    this.files.push({
      path: this._currentPath,
      rows: this._rowsInPart,
      bytes,
    });
    this._writer = null;
    this._partIndex++;
  }

  async appendRow(row) {
    if (!this._writer) await this._openPart();
    await this._writer.appendRow(row);
    this._rowsInPart++;
    this.totalRows++;
    if (this._rowsInPart >= this.rowsPerFile) {
      await this._closePart();
      this.onRollover(this.files[this.files.length - 1], this.totalRows);
    }
  }

  /** Closes the in-flight part and returns the list of files written. */
  async close() {
    await this._closePart();
    return this.files;
  }

  /**
   * Deletes everything written so far. Used to clean up after a failed run so
   * a half-written export is never mistaken for a complete one.
   */
  async abort() {
    try {
      if (this._writer) await this._writer.close();
    } catch {
      /* the file is being discarded anyway */
    }
    this._writer = null;
    const paths = this.files.map((f) => f.path);
    if (this._currentPath) paths.push(this._currentPath);
    for (const p of paths) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
    if (this._dirCreated) {
      try {
        fs.rmSync(this._partDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/** Maps a `managers` row to its parquet representation. */
function toParquetRow(r) {
  return {
    entry_id: r.entry_id,
    player_name: r.player_name,
    team_name: r.team_name,
    rank: r.rank ?? null,
    last_updated: new Date(r.last_updated * 1000),
  };
}

module.exports = {
  CODECS,
  managersSchema,
  PartitionedParquetWriter,
  toParquetRow,
};
