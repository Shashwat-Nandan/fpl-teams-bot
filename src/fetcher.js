'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polite HTTP fetcher for the FPL API.
 *
 * Rate limiting: enforces a minimum delay between successive requests, plus
 * a small random jitter so we don't hammer the API in perfectly periodic bursts.
 *
 * Retries: on 429 (respecting Retry-After), 5xx, and network errors. 4xx other
 * than 429 are considered non-retryable and surfaced to the caller.
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
    this.lastRequestAt = 0;
  }

  async _throttle() {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    const jitter = Math.random() * this.maxJitterMs;
    const wait = Math.max(0, this.minDelayMs + jitter - elapsed);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
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
          const retryAfterHeader = res.headers.get('retry-after');
          const retryAfterSec = parseInt(retryAfterHeader || '0', 10);
          const wait =
            retryAfterSec > 0 ? retryAfterSec * 1000 : this._backoffMs(attempt);
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
