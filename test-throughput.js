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
 *
 * The sweep also has to survive the network being imperfect. A 4xx is a
 * verdict about an entry and is recorded as dead; anything else is a statement
 * about the network and is deferred, leaving the ID a gap for a later run.
 * Rethrowing instead used to abort the whole sweep — two entries that hit 503
 * on 2026-05-09 killed a run that had already probed hundreds of thousands of
 * IDs. Only *consecutive* failures, meaning the endpoint has stopped answering
 * altogether, should stop a run.
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

  // ---------- 5. scattered failures are deferred, not fatal ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'c.db'));
    const TOTAL = 300;
    // Every 10th ID is unreachable — spread out, so no run of them is ever
    // consecutive. Two such IDs killed an entire real sweep on 2026-05-09.
    const unreachable = new Set(
      Array.from({ length: TOTAL }, (_, i) => i + 1).filter(
        (id) => id % 10 === 0
      )
    );
    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: TOTAL };
        const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
        if (unreachable.has(id)) throw new Error('Max retries exceeded');
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
      concurrency: 8,
      batchSize: 40,
    }).run();

    assert.strictEqual(r.failed, 30, 'every 10th ID should be deferred');
    assert.strictEqual(r.found, 270, 'the other 270 must still be collected');
    assert.strictEqual(
      db.count(),
      270,
      'a scattering of failures must not stop the sweep'
    );
    // Deferred IDs are NOT dead. Marking them would permanently skip a real
    // manager over one bad minute, and no later run would ever retry them.
    assert.strictEqual(
      db.db.prepare('SELECT COUNT(*) c FROM dead_entries').get().c,
      0,
      'an unreachable ID must never be recorded as dead'
    );

    // Because a gap is defined by absence, the retry needs no extra state:
    // the next run simply finds them missing again.
    unreachable.clear();
    const retry = await new Backfiller({
      db,
      fetcher,
      logger: QUIET,
      concurrency: 8,
    }).run();
    assert.strictEqual(
      retry.found,
      30,
      'the next run retries what was deferred'
    );
    assert.strictEqual(
      db.count(),
      TOTAL,
      'no ID is lost to a transient failure'
    );

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 5b. a sustained outage does stop the run ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'c2.db'));
    let issued = 0;
    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: 5000 };
        issued++;
        throw new Error('connect ECONNREFUSED');
      },
    };

    await assert.rejects(
      () =>
        new Backfiller({
          db,
          fetcher,
          logger: QUIET,
          concurrency: 4,
          batchSize: 500,
          maxConsecutiveFailures: 10,
        }).run(),
      /consecutive failures/,
      'an endpoint answering nothing must stop the run, not be retried forever'
    );
    // concurrency workers may be mid-flight when the threshold trips, so allow
    // a small overshoot — but it must be bounded, not thousands.
    assert.ok(
      issued < 10 + 4 * 2,
      `should have stopped near the threshold, issued ${issued}`
    );
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 5c. the counter measures CONSECUTIVE failures ----------
  {
    const tmp = mkTmp();
    const db = new FPLDatabase(path.join(tmp, 'c3.db'));
    const TOTAL = 200;
    const fetcher = {
      fetchJson: async (url) => {
        if (url.includes('bootstrap-static')) return { total_players: TOTAL };
        const id = parseInt(url.match(/entry\/(\d+)/)[1], 10);
        // Long runs of failures, but always broken by a success before the
        // threshold. A counter that never reset would abort here.
        if (id % 10 !== 0) throw new Error('Max retries exceeded');
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
      concurrency: 1, // serial, so "consecutive" is unambiguous
      maxConsecutiveFailures: 12,
    }).run();

    assert.strictEqual(r.found, 20, 'the reachable IDs are still collected');
    assert.strictEqual(
      r.failed,
      180,
      'a success must reset the counter, or 9-in-a-row would trip a 12 threshold'
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
  console.log('   - Scattered failures are deferred, never fatal: ✓');
  console.log('   - Deferred IDs stay gaps, retried by the next run: ✓');
  console.log('   - A sustained outage does stop the run: ✓');
  console.log('   - A success resets the consecutive-failure counter: ✓');
  console.log('   - stop() resumes cleanly: ✓');
})().catch((e) => {
  console.error('\n❌ Throughput test failed:', e);
  process.exit(1);
});
