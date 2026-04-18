'use strict';

const LEAGUE_URL = (leagueId, page) =>
  `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=${page}`;

/**
 * Crawls a classic FPL league's standings, page by page, upserting
 * {entry_id, player_name, team_name, rank} into the DB.
 *
 * Defaults target league 314 (Overall) which contains all active FPL managers.
 *
 * Resumable via the `crawl_state` table: `last_completed_page` is updated
 * after every successful page. If the crawler is restarted against the same
 * league, it picks up from `last_completed_page + 1`.
 */
class Crawler {
  constructor(opts = {}) {
    this.leagueId = opts.leagueId ?? 314;
    this.startPage = opts.startPage ?? 1;
    this.maxPages = opts.maxPages ?? Infinity;
    this.checkpointLogEvery = opts.checkpointLogEvery ?? 10;
    this.db = opts.db;
    this.fetcher = opts.fetcher;
    this.logger = opts.logger;
    this.stopRequested = false;
  }

  _resolveStartPage() {
    const savedLeague = this.db.getState('league_id');
    const savedPage = parseInt(
      this.db.getState('last_completed_page') || '0',
      10
    );

    // Only resume if the saved checkpoint matches the requested league and
    // the caller didn't explicitly pass a start page past it.
    if (
      savedLeague === String(this.leagueId) &&
      savedPage >= this.startPage
    ) {
      const resumeFrom = savedPage + 1;
      this.logger.info(
        `Resuming league ${this.leagueId} from page ${resumeFrom} (last completed: ${savedPage})`
      );
      return resumeFrom;
    }

    this.db.setState('league_id', this.leagueId);
    this.logger.info(
      `Starting crawl of league ${this.leagueId} from page ${this.startPage}`
    );
    return this.startPage;
  }

  async run() {
    let page = this._resolveStartPage();
    const endPage = page + this.maxPages - 1;

    const startedAt = Date.now();
    let pagesThisRun = 0;
    let entriesThisRun = 0;
    let hasNext = true;

    while (hasNext && page <= endPage && !this.stopRequested) {
      const url = LEAGUE_URL(this.leagueId, page);

      let data;
      try {
        data = await this.fetcher.fetchJson(url);
      } catch (e) {
        if (e.status === 404) {
          this.logger.info(
            `404 on page ${page} — likely past the end of the league. Stopping.`
          );
          break;
        }
        this.logger.error(`Fatal error on page ${page}: ${e.message}`);
        throw e;
      }

      const standings = data?.standings;
      if (!standings || !Array.isArray(standings.results)) {
        this.logger.error(
          `Unexpected response shape on page ${page}. Stopping.`
        );
        break;
      }

      const results = standings.results;
      if (results.length > 0) {
        this.db.upsertBatch(results);
        entriesThisRun += results.length;
      }

      hasNext = !!standings.has_next;
      this.db.setState('last_completed_page', page);
      pagesThisRun++;

      if (
        pagesThisRun % this.checkpointLogEvery === 0 ||
        !hasNext ||
        page === endPage
      ) {
        const total = this.db.count();
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = elapsed > 0 ? pagesThisRun / elapsed : 0;
        this.logger.info(
          `Page ${page} done (+${results.length}). ` +
            `Run total: ${entriesThisRun}. DB total: ${total}. ` +
            `Rate: ${rate.toFixed(2)} pages/s. has_next=${hasNext}`
        );
      }

      page++;
    }

    const duration = (Date.now() - startedAt) / 1000;
    const finished = !hasNext;
    this.logger.info(
      `Run finished. Pages crawled: ${pagesThisRun}. Entries upserted: ${entriesThisRun}. ` +
        `Duration: ${duration.toFixed(1)}s. DB total: ${this.db.count()}. ` +
        `League fully crawled: ${finished}.`
    );

    return { pagesThisRun, entriesThisRun, finished };
  }

  stop() {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.logger.info(
      'Stop requested. Finishing in-flight page then exiting cleanly...'
    );
  }
}

module.exports = Crawler;
