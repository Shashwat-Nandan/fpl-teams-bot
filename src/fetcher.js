'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polite HTTP fetcher for the FPL API.
 *
 * Rate limiting: a shared slot reservation enforces a global request rate of
 * roughly 1000/(minDelayMs + jitter/2) per second across every caller sharing
 * this instance. Callers may run concurrently — the gate spaces out request
 * *starts*, so N workers overlap network latency without exceeding the rate.
 *
 * Measured against the live API (2026-08-07, sustained 90s windows):
 *
 *     rate      429s
 *     20/s      0.0%
 *     50/s      0.0%
 *    100/s      0.0%
 *    150/s      1.0%   (creeping upwards — a bucket draining)
 *    200/s     14.6%
 *
 * 429 responses carry no Retry-After header, so the backoff below is what
 * governs recovery. The knee sits just under 150/s; defaults target 100/s.
 *
 * Retries: on 429 (respecting Retry-After when present), 5xx, and network
 * errors. 4xx other than 429 are non-retryable and surfaced to the caller.
 */
class Fetcher {
  constructor(opts = {}) {
    this.minDelayMs = opts.minDelayMs ?? 1500;
    this.maxJitterMs = opts.maxJitterMs ?? 500;
    this.maxRetries = opts.maxRetries ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.userAgent =
      opts.userAgent ??
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    this.logger = opts.logger ?? null;
    // Earliest wall-clock time the next request may start. Reserving a slot
    // both reads and advances this, which is why it must happen with no await
    // in between — see _reserveSlot.
    this.nextSlotAt = 0;
    this.rateLimitHits = 0;
  }

  /**
   * Claim the next request slot and return how long to wait for it.
   *
   * This is deliberately synchronous. JS runs it to completion without
   * interleaving, so concurrent callers each walk `nextSlotAt` forward by one
   * spacing and get distinct slots. The previous implementation compared
   * against a `lastRequestAt` that it only updated *after* sleeping, so N
   * concurrent callers all measured the same stale timestamp and fired
   * together — the rate limit held only while requests were serialized.
   */
  _reserveSlot() {
    const spacing = this.minDelayMs + Math.random() * this.maxJitterMs;
    const now = Date.now();
    const at = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = at + spacing;
    return at - now;
  }

  /**
   * Push every reserved slot back, so a 429 slows down all in-flight workers
   * rather than only the one that happened to receive it. Without this, a
   * concurrent fleet keeps issuing at the same rate while individual workers
   * back off, and the rate limiter never gets the pause it asked for.
   */
  _delayAllSlots(ms) {
    this.nextSlotAt = Math.max(this.nextSlotAt, Date.now() + ms);
  }

  async _throttle() {
    const wait = this._reserveSlot();
    if (wait > 0) await sleep(wait);
  }

  _backoffMs(attempt) {
    // Exponential backoff capped at 60s. attempt is 0-indexed.
    return Math.min(60000, 1000 * Math.pow(2, attempt));
  }

  async fetchJson(url) {
    let attempt = 0;
    let lastError;
    let lastStatus;

    while (attempt <= this.maxRetries) {
      await this._throttle();

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://fantasy.premierleague.com/',
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutHandle);

        if (res.status === 200) {
          return await res.json();
        }

        if (res.status === 429) {
          lastStatus = 429;
          this.rateLimitHits++;
          const retryAfterHeader = res.headers.get('retry-after');
          const retryAfterSec = parseInt(retryAfterHeader || '0', 10);
          const wait =
            retryAfterSec > 0 ? retryAfterSec * 1000 : this._backoffMs(attempt);
          // Hold back every other worker too, not just this request.
          this._delayAllSlots(wait);
          this.logger?.warn(
            `429 Too Many Requests on ${url}. Waiting ${wait}ms (attempt ${attempt + 1})`
          );
          await sleep(wait);
          attempt++;
          continue;
        }

        if (res.status >= 500 && res.status < 600) {
          lastStatus = res.status;
          const wait = this._backoffMs(attempt);
          this.logger?.warn(
            `HTTP ${res.status} on ${url}. Retrying in ${wait}ms (attempt ${attempt + 1})`
          );
          await sleep(wait);
          attempt++;
          continue;
        }

        // Other 4xx (e.g. 404 past end of league) — non-retryable.
        const err = new Error(`HTTP ${res.status} on ${url}`);
        err.status = res.status;
        throw err;
      } catch (e) {
        clearTimeout(timeoutHandle);

        // Non-retryable HTTP error — surface to caller.
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
          throw e;
        }

        // Network errors, timeouts, aborts — retry with backoff.
        lastError = e;
        const wait = this._backoffMs(attempt);
        this.logger?.warn(
          `Network error on ${url}: ${e.message}. Retrying in ${wait}ms (attempt ${attempt + 1})`
        );
        await sleep(wait);
        attempt++;
      }
    }

    const parts = [`Max retries (${this.maxRetries}) exceeded for ${url}`];
    if (lastStatus) parts.push(`last status: ${lastStatus}`);
    if (lastError) parts.push(`last error: ${lastError.message}`);
    throw new Error(parts.join('. '));
  }
}

module.exports = Fetcher;
