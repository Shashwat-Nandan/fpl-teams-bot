'use strict';

const parquet = require('@dsnp/parquetjs');
const { PartitionedWriter } = require('./partition');

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
 * Writes rows to one or more parquet files. Rollover, promotion of a
 * single-file delta to a part directory, and abort cleanup all live in
 * PartitionedWriter; this only knows how to open, feed and close a parquet
 * file.
 */
class PartitionedParquetWriter extends PartitionedWriter {
  constructor(opts) {
    super({ ...opts, ext: '.parquet' });
    this.compression = opts.compression ?? 'GZIP';
    this.rowGroupSize = opts.rowGroupSize ?? 50_000;
    this.schema = opts.schema ?? managersSchema(this.compression);
    this._writer = null;
  }

  async _createSink(filePath) {
    // Compression lives on the schema's columns, not here.
    this._writer = await parquet.ParquetWriter.openFile(this.schema, filePath, {
      rowGroupSize: this.rowGroupSize,
    });
  }

  async _writeRow(row) {
    await this._writer.appendRow(row);
  }

  async _closeSink() {
    const w = this._writer;
    this._writer = null;
    if (w) await w.close();
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
