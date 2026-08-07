'use strict';

/**
 * Tests for the pre-season / new-season behaviour.
 *
 * FPL reassigns entry IDs from 1 each season and classic-league standings do
 * not exist until the first gameweek has been scored. Together that means:
 *
 *   - The crawler must NOT checkpoint an unpopulated league. It used to
 *     report "League fully crawled: true" against an empty league 314 and
 *     record last_completed_page=1, so the real crawl after GW1 would resume
 *     at page 2 and permanently skip the top 50 managers.
 *   - The backfiller must be able to sweep a completely empty database,
 *     taking its ceiling from bootstrap-static's total_players rather than
 *     MAX(entry_id) — which is 0 before any crawl has ever run.
 *   - Chunked gap iteration must survive the caller writing to `managers` as
 *     it consumes IDs (better-sqlite3 refuses to run a statement while an
 *     iterator over the same connection is open).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FPLDatabase = require('./src/db');
const Crawler = require('./src/crawler');
const Backfiller = require('./src/backfiller');

const QUIET = { info() {}, warn() {}, error() {} };

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-season-test-'));
}

(async () => {
  // ---------- 1. crawler must not checkpoint an empty league ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'a.db'));
    const emptyLeague = {
      fetchJson: async () => ({
        league: { id: 314, name: 'Overall' },
        standings: { has_next: false, results: [] },
      }),
    };
    const crawler = new Crawler({
      leagueId: 314,
      db,
      fetcher: emptyLeague,
      logger: QUIET,
    });
    const r = await crawler.run();

    assert.strictEqual(r.entriesThisRun, 0);
    assert.strictEqual(
      r.finished,
      false,
      'an unpopulated league must not report itself fully crawled'
    );
    assert.strictEqual(
      db.getState('last_completed_page'),
      null,
      'an empty page must never be checkpointed — the post-GW1 run would skip it'
    );
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 2. a later populated crawl starts from page 1 ----------
  {
    const tmp = mkTmp();
    const dbPath = path.join(tmp, 'b.db');

    // Pre-season attempt against the empty league.
    let db = new FPLDatabase(dbPath);
    await new Crawler({
      leagueId: 314,
      db,
      fetcher: { fetchJson: async () => ({ standings: { has_next: false, results: [] } }) },
      logger: QUIET,
    }).run();
    db.close();

    // Now GW1 has been scored and standings exist.
    db = new FPLDatabase(dbPath);
    const pages = {
      1: { has_next: true, results: [{ entry: 11, player_name: 'A One', entry_name: 'T1', rank: 1 }] },
      2: { has_next: false, results: [{ entry: 22, player_name: 'B Two', entry_name: 'T2', rank: 2 }] },
    };
    const seen = [];
    const real = await new Crawler({
      leagueId: 314,
      db,
      logger: QUIET,
      fetcher: {
        fetchJson: async (url) => {
          const p = parseInt(url.match(/page_standings=(\d+)/)[1], 10);
          seen.push(p);
          return { standings: pages[p] ?? { has_next: false, results: [] } };
        },
      },
    }).run();

    assert.deepStrictEqual(
      seen,
      [1, 2],
      'the post-GW1 crawl must start at page 1, not resume past it'
    );
    assert.strictEqual(real.entriesThisRun, 2);
    assert.strictEqual(db.count(), 2, 'the top-of-table page must not be skipped');
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 3. backfiller sweeps a completely empty DB ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'c.db'));
    assert.strictEqual(db.getMaxEntryId(), null, 'fresh DB has no entries');

    const TOTAL = 25;
    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: TOTAL };
        const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
        if (id > TOTAL) {
          const e = new Error('Not Found');
          e.status = 404;
          throw e;
        }
        return {
          id,
          player_first_name: 'Player',
          player_last_name: `#${id}`,
          name: `Team ${id}`,
          summary_overall_rank: null, // null pre-season, as the real API returns
        };
      },
    };

    // batchSize smaller than the population, to exercise chunk refills while
    // the loop is writing to the very table the chunk query reads.
    const r = await new Backfiller({
      db,
      fetcher,
      logger: QUIET,
      batchSize: 4,
    }).run();

    assert.strictEqual(r.found, TOTAL, `expected ${TOTAL} found, got ${r.found}`);
    assert.strictEqual(db.count(), TOTAL, 'every registered ID should be stored');
    const ids = db.db
      .prepare('SELECT entry_id FROM managers ORDER BY entry_id')
      .all()
      .map((x) => x.entry_id);
    assert.deepStrictEqual(
      ids,
      Array.from({ length: TOTAL }, (_, i) => i + 1),
      'the sweep must cover 1..N with no gaps across chunk boundaries'
    );
    // Pre-season ranks are null and must survive the round trip.
    assert.strictEqual(
      db.db.prepare('SELECT rank FROM managers WHERE entry_id = 1').get().rank,
      null
    );

    // Re-running is a no-op: nothing left to sweep.
    const again = await new Backfiller({ db, fetcher, logger: QUIET }).run();
    assert.strictEqual(again.probed, 0, 'a completed sweep should re-run as a no-op');

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 4. a growing ceiling is picked up on re-run ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'd.db'));
    let total = 5;
    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: total };
        const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
        return {
          id,
          player_first_name: 'P',
          player_last_name: String(id),
          name: `T${id}`,
          summary_overall_rank: null,
        };
      },
    };

    await new Backfiller({ db, fetcher, logger: QUIET }).run();
    assert.strictEqual(db.count(), 5);

    // Registrations keep climbing until the GW1 deadline.
    total = 9;
    const second = await new Backfiller({ db, fetcher, logger: QUIET }).run();
    assert.strictEqual(second.found, 4, 'only the newly registered IDs should be probed');
    assert.strictEqual(db.count(), 9);

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 5. dead entries are not re-probed ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'e.db'));
    const probed = [];
    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: 6 };
        const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
        probed.push(id);
        if (id % 2 === 0) {
          const e = new Error('Not Found');
          e.status = 404;
          throw e;
        }
        return {
          id,
          player_first_name: 'P',
          player_last_name: String(id),
          name: `T${id}`,
          summary_overall_rank: null,
        };
      },
    };

    await new Backfiller({ db, fetcher, logger: QUIET, batchSize: 2 }).run();
    assert.deepStrictEqual(probed, [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(db.count(), 3, 'three odd IDs stored');

    probed.length = 0;
    await new Backfiller({ db, fetcher, logger: QUIET, batchSize: 2 }).run();
    assert.deepStrictEqual(probed, [], '404s must be remembered, not re-probed');

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n✅ New-season behaviour verified.');
  console.log('   - Empty league is not checkpointed as fully crawled: ✓');
  console.log('   - Post-GW1 crawl still starts at page 1: ✓');
  console.log('   - Backfiller sweeps an empty DB via total_players: ✓');
  console.log('   - Chunked sweep covers 1..N while writing as it goes: ✓');
  console.log('   - Growing registration ceiling picked up on re-run: ✓');
  console.log('   - Dead entries remembered across runs: ✓');
})().catch((e) => {
  console.error('\n❌ Season test failed:', e);
  process.exit(1);
});
