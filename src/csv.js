'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { PartitionedWriter } = require('./partition');

const CSV_CODECS = ['GZIP', 'UNCOMPRESSED'];
const COLUMNS = [
  'entry_id',
  'player_name',
  'team_name',
  'rank',
  'last_updated',
];
const HEADER = COLUMNS.join(',') + '\n';

// Flush to the stream in chunks rather than per row; one write() per row on a
// 12.7M-row export is dominated by stream bookkeeping.
const FLUSH_BYTES = 1 << 20;

/**
 * RFC 4180 quoting.
 *
 * Text columns are *always* quoted, which is what makes NULL unambiguous
 * under Postgres COPY ... WITH (FORMAT csv): there an unquoted empty field is
 * NULL and a quoted one ("") is the empty string. `rank` is the only nullable
 * column here, and it is written unquoted-empty so it lands as NULL rather
 * than failing an integer cast.
 */
function quote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Writes rows as CSV, optionally gzipped, with the same rollover and abort
 * semantics as the parquet writer.
 *
 * Every part file carries its own header row, so each one can be loaded on
 * its own with `COPY ... WITH (FORMAT csv, HEADER true)` without the consumer
 * having to care which part it is.
 */
class PartitionedCsvWriter extends PartitionedWriter {
  constructor(opts) {
    const compression = opts.compression ?? 'GZIP';
    if (!CSV_CODECS.includes(compression)) {
      throw new Error(
        `Unsupported CSV compression: ${compression} ` +
          `(expected ${CSV_CODECS.join(', ')})`
      );
    }
    const gzip = compression === 'GZIP';
    super({ ...opts, ext: gzip ? '.csv.gz' : '.csv' });
    this.compression = compression;
    this.gzip = gzip;
    this.header = opts.header ?? true;

    this._file = null;
    this._sink = null;
    this._buf = [];
    this._bufBytes = 0;
    this._error = null;
  }

  async _createSink(filePath) {
    this._error = null;
    this._buf = [];
    this._bufBytes = 0;

    this._file = fs.createWriteStream(filePath);
    if (this.gzip) {
      const gz = zlib.createGzip({ level: 6 });
      gz.pipe(this._file);
      this._sink = gz;
    } else {
      this._sink = this._file;
    }

    // A stream error surfaces asynchronously; capture the first one and
    // rethrow it at close, so a failed write can never be mistaken for a
    // complete file.
    const capture = (e) => {
      this._error = this._error ?? e;
    };
    this._file.on('error', capture);
    if (this._sink !== this._file) this._sink.on('error', capture);

    if (this.header) this._buffer(HEADER);
  }

  _buffer(text) {
    this._buf.push(text);
    this._bufBytes += text.length;
  }

  async _flush() {
    if (this._buf.length === 0) return;
    const chunk = this._buf.join('');
    this._buf = [];
    this._bufBytes = 0;
    if (this._error) throw this._error;
    // Respect backpressure — without this a fast SQLite scan outruns gzip and
    // the whole export buffers in memory.
    if (!this._sink.write(chunk)) {
      await new Promise((resolve, reject) => {
        const onDrain = () => {
          this._sink.removeListener('error', onError);
          resolve();
        };
        const onError = (e) => {
          this._sink.removeListener('drain', onDrain);
          reject(e);
        };
        this._sink.once('drain', onDrain);
        this._sink.once('error', onError);
      });
    }
  }

  async _writeRow(row) {
    this._buffer(
      row.entry_id +
        ',' +
        quote(row.player_name) +
        ',' +
        quote(row.team_name) +
        ',' +
        (row.rank == null ? '' : row.rank) +
        ',' +
        new Date(row.last_updated * 1000).toISOString() +
        '\n'
    );
    if (this._bufBytes >= FLUSH_BYTES) await this._flush();
  }

  async _closeSink() {
    const sink = this._sink;
    const file = this._file;
    if (!sink) return;

    try {
      await this._flush();
    } finally {
      this._sink = null;
      this._file = null;
      // Wait for 'close' on the *file* stream rather than 'finish' on the
      // gzip: the size read by _closePart is only final once the fd is
      // closed. Ending it in a finally means a failed flush still releases
      // the descriptor — abort() relies on that to be able to delete the file.
      await new Promise((resolve, reject) => {
        file.once('close', resolve);
        file.once('error', reject);
        sink.end();
      });
    }
    if (this._error) throw this._error;
  }
}

/** Maps a `managers` row to its CSV representation (timestamps stay seconds). */
function toCsvRow(r) {
  return {
    entry_id: r.entry_id,
    player_name: r.player_name,
    team_name: r.team_name,
    rank: r.rank ?? null,
    last_updated: r.last_updated,
  };
}

module.exports = {
  CSV_CODECS,
  COLUMNS,
  HEADER,
  PartitionedCsvWriter,
  toCsvRow,
  quote,
};
