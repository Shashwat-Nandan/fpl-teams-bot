'use strict';

const fs = require('fs');
const path = require('path');

class Logger {
  constructor(logFile) {
    if (logFile) {
      const dir = path.dirname(logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(logFile, { flags: 'a' });
    }
  }

  _write(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    // eslint-disable-next-line no-console
    console.log(line);
    if (this.stream) this.stream.write(line + '\n');
  }

  info(msg) { this._write('INFO', msg); }
  warn(msg) { this._write('WARN', msg); }
  error(msg) { this._write('ERROR', msg); }

  close() {
    if (this.stream) this.stream.end();
  }
}

module.exports = Logger;
