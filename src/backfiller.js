'use strict';

const ENTRY_URL = (id) => `https://fantasy.premierleague.com/api/entry/${id}/`;
const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';

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
    this.batchSize = opts.batchSize ?? 5000;
    this.db = opts.db;
    this.fetcher = opts.fetcher;
    this.logger = opts.logger;
    this.stopRequested = false;
  }

  /**
   * How many entry IDs exist right now.
   *
   * `bootstrap-static.total_players` is the count of registered teams, and
   * because FPL issues entry IDs densely from 1 each season it is also the
   * highest live ID (verified pre-season 2026-27: IDs 1..3,171,844 all
   * resolve, everything above 404s).
   *
   * This matters most before the first gameweek: league standings do not
   * exist yet, so `MAX(entry_id)` on a fresh database is 0 and deriving the
   * bound from the DB would make the backfiller a no-op exactly when it is
   * the only way to enumerate managers. Registrations also keep climbing
   * until the GW1 deadline, so re-running picks up a higher ceiling for free.
   */
  async _resolveUpperBound() {
    if (this.upperBound) return this.upperBound;

    try {
      const boot = await this.fetcher.fetchJson(BOOTSTRAP_URL);
      const total = boot?.total_players;
      if (Number.isInteger(total) && total > 0) {
        this.logger.info(
          `Upper bound ${total.toLocaleString()} from bootstrap-static ` +
            '(total_players).'
        );
        // A crawl may already have stored an ID above it; never go backwards.
        return Math.max(total, this.db.getMaxEntryId() ?? 0);
      }
      this.logger.warn('bootstrap-static had no usable total_players.');
    } catch (e) {
      this.logger.warn(`Could not read bootstrap-static: ${e.message}`);
    }

    const fromDb = this.db.getMaxEntryId();
    if (fromDb) {
      this.logger.info(`Falling back to MAX(entry_id) = ${fromDb}.`);
      return fromDb;
    }
    return null;
  }

  async run() {
    const upper = await this._resolveUpperBound();
    if (!upper) {
      this.logger.error(
        'No upper bound: bootstrap-static was unreachable and the managers ' +
          'table is empty. Pass --upper-bound <n> to sweep explicitly.'
      );
      return { probed: 0, found: 0, dead: 0 };
    }

    const estimated = this.db.countMissingEntryIds(upper);
    this.logger.info(
      `Sweeping [1, ${upper.toLocaleString()}] — ` +
        `~${estimated.toLocaleString()} IDs not yet stored.`
    );
    if (estimated === 0) return { probed: 0, found: 0, dead: 0 };

    const limit = Math.min(estimated, this.maxIds);
    let probed = 0;
    let found = 0;
    let dead = 0;
    const startedAt = Date.now();

    let cursor = 0;
    let batch = this.db.getMissingEntryIdsAfter(cursor, upper, this.batchSize);

    while (batch.length > 0 && probed < limit && !this.stopRequested) {
      for (const id of batch) {
        if (this.stopRequested || probed >= limit) break;
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
      // Every ID in the batch is now either stored or marked dead, so the
      // next batch starts after the last one we looked at.
      cursor = batch[batch.length - 1];
      batch =
        probed < limit && !this.stopRequested
          ? this.db.getMissingEntryIdsAfter(cursor, upper, this.batchSize)
          : [];
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
