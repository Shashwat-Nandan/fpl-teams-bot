'use strict';

/**
 * Tests for concurrent probing and the shared rate gate.
 *
 * A serial sweep of 3.2M entry IDs spends nearly all of its time idle: each
 * request costs ~40ms of network, so one-at-a-time with a 1s delay ran at
 * 0.8/s and would have taken 46 days. Probing concurrently behind a global
 * rate gate does the same work in hours.
 *
 * What has to hold for that to be safe:
 *
 *   - The gate must space out request *starts* globally. The original
 *     throttle compared against a timestamp it only wrote after sleeping, so
 *     concurrent callers all read the same stale value and fired at once —
 *     the rate limit silently evaporated the moment anything ran in parallel.
 *   - A 429 must slow the whole fleet, not just the request that got it.
 *   - Every ID must still be probed exactly once, with no gaps or repeats
 *     across batch boundaries.
 *   - --max-ids must remain an exact ceiling, not "give or take a batch".
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FPLDatabase = require('./src/db');
const Fetcher = require('./src/fetcher');
const Backfiller = require('./src/backfiller');

const QUIET = { info() {}, warn() {}, error() {} };

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-throughput-test-'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------- 1. the rate gate holds under concurrency ----------
  {
    const starts = [];
    const origFetch = global.fetch;
    global.fetch = async () => {
      starts.push(Date.now());
      await sleep(30); // network latency, deliberately > the spacing
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
      };
    };

    const SPACING = 20;
    const N = 15;
    const fetcher = new Fetcher({
      minDelayMs: SPACING,
      maxJitterMs: 0,
      logger: QUIET,
    });
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: N }, () =>
        fetcher.fetchJson('https://example.test/x')
      )
    );
    const elapsed = Date.now() - t0;
    global.fetch = origFetch;

    assert.strictEqual(
      starts.length,
      N,
      'every request should have been issued'
    );
    starts.sort((a, b) => a - b);

    // The whole point: N requests cannot all leave in the first instant.
    // Serialised sleeps alone would take N*30ms; the gate should dominate.
    assert.ok(
      elapsed >= SPACING * (N - 1),
      `expected >= ${SPACING * (N - 1)}ms for ${N} requests at ${SPACING}ms ` +
        `spacing, took ${elapsed}ms — the rate gate is not holding`
    );

    // Requests must be spread out, not merely slow in aggregate. Asserting on
    // every individual gap would be flaky: the gate fixes slot times up
    // front, so an event-loop stall lets several expired sleeps fire together
    // and then the run catches up — a short burst with the average rate still
    // correct. The median gap is the robust form of the same claim, and it
    // still fails loudly on the old throttle, which put 14 of these 15 starts
    // into a single millisecond (median gap 0).
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    assert.ok(
      median >= SPACING * 0.5,
      `median gap between request starts was ${median}ms at ${SPACING}ms ` +
        `spacing — requests are clumping (gaps: ${gaps.join(',')})`
    );

    // Concurrency must still be real: 15 requests of 30ms each, serialised,
    // would take 450ms. Behind the gate they overlap.
    assert.ok(
      elapsed < SPACING * N + 30 * 3,
      `expected requests to overlap, took ${elapsed}ms (serial would be ~450ms)`
    );
  }

  // ---------- 2. a 429 holds back every worker, not just its own ----------
  {
    let served = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      served++;
      // Only the very first response is a 429.
      if (served === 1) {
        return {
          status: 429,
          headers: { get: () => null },
          json: async () => ({}),
        };
      }
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
      };
    };

    const fetcher = new Fetcher({
      minDelayMs: 1,
      maxJitterMs: 0,
      maxRetries: 3,
      logger: QUIET,
    });
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        fetcher.fetchJson('https://example.test/x')
      )
    );
    const elapsed = Date.now() - t0;
    global.fetch = origFetch;

    assert.strictEqual(fetcher.rateLimitHits, 1, 'the 429 should be counted');
    // _backoffMs(0) is 1000ms, and it is applied to the shared gate, so the
    // whole batch is held — not just the request that was rejected.
    assert.ok(
      elapsed >= 900,
      `expected the fleet to be held ~1s by one 429, finished in ${elapsed}ms`
    );
  }

  // ---------- 3. concurrent sweep covers every ID exactly once ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'a.db'));
    const TOTAL = 200;
    const seen = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: TOTAL };
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
        seen.push(id);
        // Uneven latency, so workers finish out of order and steal work.
        await sleep(id % 7);
        inFlight--;
        if (id % 5 === 0) {
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

    const CONC = 12;
    const r = await new Backfiller({
      db,
      fetcher,
      logger: QUIET,
      concurrency: CONC,
      batchSize: 30, // several batch refills mid-sweep
    }).run();

    assert.ok(maxInFlight > 1, 'requests should actually have overlapped');
    assert.ok(
      maxInFlight <= CONC,
      `in-flight requests peaked at ${maxInFlight}, above the cap of ${CONC}`
    );
    assert.strictEqual(r.probed, TOTAL, 'every ID probed');
    assert.strictEqual(
      new Set(seen).size,
      TOTAL,
      'IDs must not be probed twice — workers are double-claiming'
    );
    assert.deepStrictEqual(
      [...seen].sort((a, b) => a - b),
      Array.from({ length: TOTAL }, (_, i) => i + 1),
      'the sweep must cover 1..N with no gaps across batch boundaries'
    );
    assert.strictEqual(r.dead, 40, 'every fifth ID 404s');
    assert.strictEqual(db.count(), TOTAL - 40);

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 4. --max-ids is an exact ceiling under concurrency ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'b.db'));
    let requests = 0;
    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: 500 };
        requests++;
        const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
        await sleep(5);
        return {
          id,
          player_first_name: 'P',
          player_last_name: String(id),
          name: `T${id}`,
          summary_overall_rank: null,
        };
      },
    };

    const r = await new Backfiller({
      db,
      fetcher,
      logger: QUIET,
      concurrency: 16,
      maxIds: 10,
    }).run();

    assert.strictEqual(r.probed, 10, `--max-ids 10 probed ${r.probed}`);
    assert.strictEqual(
      requests,
      10,
      `${requests} requests issued for --max-ids 10 — idle workers over-claimed`
    );
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 5. a fatal error aborts the run and propagates ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'c.db'));
    let issued = 0;
    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: 500 };
        issued++;
        const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
        await sleep(2);
        if (id === 20) throw new Error('Max retries exceeded');
        return {
          id,
          player_first_name: 'P',
          player_last_name: String(id),
          name: `T${id}`,
          summary_overall_rank: null,
        };
      },
    };

    await assert.rejects(
      () =>
        new Backfiller({
          db,
          fetcher,
          logger: QUIET,
          concurrency: 8,
          batchSize: 50,
        }).run(),
      /Max retries exceeded/,
      'an unrecoverable error must surface, not be swallowed by the pool'
    );
    assert.ok(
      issued < 500,
      `the run should have stopped early, but issued ${issued} requests`
    );
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 6. stop() drains the pool without losing work ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'd.db'));
    let backfiller;
    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: 400 };
        const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
        await sleep(1);
        if (id === 25) backfiller.stop();
        return {
          id,
          player_first_name: 'P',
          player_last_name: String(id),
          name: `T${id}`,
          summary_overall_rank: null,
        };
      },
    };

    backfiller = new Backfiller({
      db,
      fetcher,
      logger: QUIET,
      concurrency: 8,
      batchSize: 50,
    });
    const r = await backfiller.run();

    assert.ok(r.probed < 400, 'stop() should have cut the run short');
    assert.strictEqual(
      db.count(),
      r.probed,
      'every ID probed before stopping must have been persisted'
    );

    // Whatever was skipped is still a gap, so a re-run finishes the job.
    const rest = await new Backfiller({
      db,
      fetcher: {
        fetchJson: async (url) => {
          if (url.includes('bootstrap-static')) return { total_players: 400 };
          const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
          return {
            id,
            player_first_name: 'P',
            player_last_name: String(id),
            name: `T${id}`,
            summary_overall_rank: null,
          };
        },
      },
      logger: QUIET,
      concurrency: 8,
    }).run();
    assert.strictEqual(
      db.count(),
      400,
      `resume left gaps: ${db.count()} of 400 stored after ${rest.probed} more`
    );

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n✅ Concurrent probing verified.');
  console.log('   - Rate gate spaces requests globally under concurrency: ✓');
  console.log('   - A 429 backs off the whole fleet: ✓');
  console.log('   - Concurrent sweep covers 1..N exactly once: ✓');
  console.log('   - In-flight requests stay within --concurrency: ✓');
  console.log('   - --max-ids is an exact ceiling: ✓');
  console.log('   - Fatal errors propagate; stop() resumes cleanly: ✓');
})().catch((e) => {
  console.error('\n❌ Throughput test failed:', e);
  process.exit(1);
});
