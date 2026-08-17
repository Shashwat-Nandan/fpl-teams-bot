'use strict';

const fs = require('fs');

/**
 * Exclusive, stale-tolerant single-instance lock.
 *
 * O_EXCL creation is the exclusion; the PID inside is only there so a lock
 * left behind by a `kill -9` can be told apart from a live one and reclaimed.
 * Returns a release function that is safe to call more than once.
 *
 * `busyExitCode` distinguishes the two reasons a second instance might start:
 *
 *   - The exporter passes 1. Two concurrent exports of one dataset would pick
 *     the same timestamped base name and race the watermark, so it is a
 *     misconfiguration worth surfacing.
 *   - The backfiller passes 0. It is on an hourly timer while a full sweep can
 *     run for hours, so ticks overlapping a run in progress are the expected
 *     case, not a fault — exiting non-zero would cry wolf every hour.
 */
function acquireLock(lockPath, opts = {}) {
  const label = opts.label ?? lockPath;
  const busyExitCode = opts.busyExitCode ?? 1;

  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = readLockPid(lockPath);
    if (holder !== null && isAlive(holder)) {
      console.error(
        `Another ${label} is already running (pid ${holder}, lock ` +
          `${lockPath}). Refusing to run two at once.`
      );
      process.exit(busyExitCode);
    }
    // Stale lock from a kill -9: reclaim it.
    console.error(`Removing stale ${label} lock ${lockPath}.`);
    fs.rmSync(lockPath, { force: true });
    fd = fs.openSync(lockPath, 'wx');
  }
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* best effort */
    }
  };
}

function readLockPid(lockPath) {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

module.exports = { acquireLock, readLockPid, isAlive };
