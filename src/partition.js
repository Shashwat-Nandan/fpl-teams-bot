'use strict';

const fs = require('fs');
const path = require('path');

/**
 * File-rolling logic shared by every export format.
 *
 * Two output shapes, chosen by the caller via `singleFile`:
 *   - singleFile: true  → ./<base><ext>, but only until the first rollover;
 *                         after that it transparently becomes a part
 *                         directory, so an unexpectedly large delta never
 *                         produces one enormous file.
 *   - singleFile: false → ./<base>/part-0000<ext>, part-0001<ext>, …
 *
 * Subclasses implement three hooks — `_createSink`, `_writeRow`, `_closeSink`
 * — and inherit rollover, promotion, and abort cleanup. Those are subtle
 * enough (a promoted first file has to be *moved* into the new directory, and
 * abort has to remove a directory it may have created) that having two copies
 * of them drift apart is a real risk.
 */
class PartitionedWriter {
  constructor(opts) {
    this.baseDir = opts.baseDir;
    this.baseName = opts.baseName;
    this.ext = opts.ext;
    this.rowsPerFile = opts.rowsPerFile ?? 2_000_000;
    this.singleFile = opts.singleFile ?? false;
    this.onRollover = opts.onRollover ?? (() => {});

    this.files = [];
    this.totalRows = 0;
    // Files written alongside the data (the manifest) that must also be
    // removed if the run is discarded.
    this.extraFiles = [];
    this._sinkOpen = false;
    this._rowsInPart = 0;
    this._partIndex = 0;
    this._currentPath = null;
    this._dirCreated = false;
  }

  get _partDir() {
    return path.join(this.baseDir, this.baseName);
  }

  _nextPath() {
    if (this.singleFile && this._partIndex === 0) {
      return path.join(this.baseDir, `${this.baseName}${this.ext}`);
    }
    if (this.singleFile && this._partIndex === 1) this._promoteToDirectory();

    if (!this._dirCreated) {
      fs.mkdirSync(this._partDir, { recursive: true });
      this._dirCreated = true;
    }
    const part = String(this._partIndex).padStart(4, '0');
    return path.join(this._partDir, `part-${part}${this.ext}`);
  }

  _promoteToDirectory() {
    fs.mkdirSync(this._partDir, { recursive: true });
    this._dirCreated = true;
    const first = this.files[0];
    const moved = path.join(this._partDir, `part-0000${this.ext}`);
    fs.renameSync(first.path, moved);
    first.path = moved;
    this.singleFile = false;
  }

  async _openPart() {
    this._currentPath = this._nextPath();
    fs.mkdirSync(path.dirname(this._currentPath), { recursive: true });
    await this._createSink(this._currentPath);
    this._sinkOpen = true;
    this._rowsInPart = 0;
  }

  async _closePart() {
    if (!this._sinkOpen) return;
    await this._closeSink();
    this._sinkOpen = false;
    this.files.push({
      path: this._currentPath,
      rows: this._rowsInPart,
      bytes: fs.statSync(this._currentPath).size,
    });
    this._partIndex++;
  }

  async appendRow(row) {
    if (!this._sinkOpen) await this._openPart();
    await this._writeRow(row);
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

  /** Register a file (the manifest) for removal if the run is aborted. */
  track(filePath) {
    this.extraFiles.push(filePath);
  }

  /**
   * Deletes everything written so far. Used to clean up after a failed run so
   * a half-written export is never mistaken for a complete one.
   */
  async abort() {
    try {
      if (this._sinkOpen) await this._closeSink();
    } catch {
      /* the file is being discarded anyway */
    }
    this._sinkOpen = false;

    const paths = [...this.files.map((f) => f.path), ...this.extraFiles];
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

  // ---- hooks ----
  /* eslint-disable no-unused-vars */
  async _createSink(filePath) {
    throw new Error('_createSink not implemented');
  }
  async _writeRow(row) {
    throw new Error('_writeRow not implemented');
  }
  async _closeSink() {
    throw new Error('_closeSink not implemented');
  }
  /* eslint-enable no-unused-vars */
}

module.exports = { PartitionedWriter };
