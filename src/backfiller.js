'use strict';

const ENTRY_URL = (id) => `https://fantasy.premierleague.com/api/entry/${id}/`;

/**
 * Fills gaps left behind by the league crawler.
 *
 * The league crawler scans pages of standings sorted by rank. When ranks
 * shift mid-crawl (e.g. across a gameweek), managers whose rank improves
 * into already-crawled pages are silently skipped. Entry IDs are immutable,
 * so this backfiller iterates the missing IDs in [1, max(entry_id)] and
 * fetches each via the /api/entry/{id}/ endpoint:
 *
 *   - 200 → upsert into `managers`
 *   - 404 → record in `dead_entries` so we don't re-probe
 *
 * Resumable: on each run we recompute the gap set from the DB itself, so
 * killing the process at any point loses at most one in-flight request.
 */
class Backfiller {
  constructor(opts = {}) {
    this.upperBound = opts.upperBound ?? null;
    this.maxIds = opts.maxIds ?? Infinity;
    this.checkpointLogEvery = opts.checkpointLogEvery ?? 100;
    this.db = opts.db;
    this.fetcher = opts.fetcher;
    this.logger = opts.logger;
    this.stopRequested = false;
  }

  async run() {
    const upper = this.upperBound ?? this.db.getMaxEntryId();
    if (!upper) {
      this.logger.info('Empty managers table; nothing to backfill.');
      return { probed: 0, found: 0, dead: 0 };
    }

    this.logger.info(`Computing missing entry IDs in [1, ${upper}]...`);
    const t0 = Date.now();
    const missing = this.db.getMissingEntryIds(upper);
    this.logger.info(
      `Found ${missing.length} missing entry IDs ` +
        `(scan took ${((Date.now() - t0) / 1000).toFixed(1)}s).`
    );
    if (missing.length === 0) return { probed: 0, found: 0, dead: 0 };

    const limit = Math.min(missing.length, this.maxIds);
    let probed = 0;
    let found = 0;
    let dead = 0;
    const startedAt = Date.now();

    for (let i = 0; i < limit && !this.stopRequested; i++) {
      const id = missing[i];
      const url = ENTRY_URL(id);

      let data;
      try {
        data = await this.fetcher.fetchJson(url);
      } catch (e) {
        if (e.status === 404) {
          this.db.markDead(id, 404);
          dead++;
          probed++;
          this._maybeLog(probed, found, dead, limit, startedAt);
          continue;
        }
        if (e.status && e.status >= 400 && e.status < 500) {
          this.logger.warn(
            `entry ${id}: HTTP ${e.status} (marking dead, will skip on re-run)`
          );
          this.db.markDead(id, e.status);
          dead++;
          probed++;
          this._maybeLog(probed, found, dead, limit, startedAt);
          continue;
        }
        this.logger.error(`Fatal error on entry ${id}: ${e.message}`);
        throw e;
      }

      try {
        this.db.upsertFromEntry(data);
        found++;
      } catch (e) {
        this.logger.warn(`entry ${id}: upsert failed — ${e.message}`);
      }
      probed++;
      this._maybeLog(probed, found, dead, limit, startedAt);
    }

    const duration = (Date.now() - startedAt) / 1000;
    const total = this.db.count();
    this.logger.info(
      `Backfill run finished. Probed: ${probed}. Found: ${found}. ` +
        `Dead (404 etc.): ${dead}. Duration: ${duration.toFixed(1)}s. ` +
        `DB total: ${total}.`
    );
    return { probed, found, dead };
  }

  _maybeLog(probed, found, dead, limit, startedAt) {
    if (probed % this.checkpointLogEvery !== 0 && probed !== limit) return;
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = elapsed > 0 ? probed / elapsed : 0;
    const remaining = limit - probed;
    const etaH = rate > 0 ? remaining / rate / 3600 : 0;
    this.logger.info(
      `Probed ${probed}/${limit} (found=${found}, dead=${dead}). ` +
        `Rate: ${rate.toFixed(2)}/s. ETA: ${etaH.toFixed(1)}h.`
    );
  }

  stop() {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.logger.info(
      'Stop requested. Finishing in-flight request then exiting cleanly...'
    );
  }
}

module.exports = Backfiller;
