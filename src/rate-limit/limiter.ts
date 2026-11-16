// Counts requests per key and decides whether one more fits in the limit.
// Pure bookkeeping: no HTTP, time comes from the injected clock.
//
// Strategies:
//   fixed_window   — windows aligned to the clock (0..w, w..2w, ...); the
//                    count resets at each boundary, so a burst at the end of
//                    one window and the start of the next can both pass.
//   sliding_window — exact log of request times; a request counts against the
//                    limit for `window` ms after it arrived, so capacity frees
//                    up one request at a time as old ones age out.
//                    Memory is up to `requests` timestamps per key.
//
// Only allowed requests are counted; rejections don't extend the wait.

import type { Clock } from "../clock.ts";
import type { RateLimitConfig } from "../config.ts";
import { UnreachableCaseError } from "../unreachable.ts";

export type Decision =
  | { allowed: true }
  | {
      allowed: false;
      /** Time until the next request for this key would be allowed. */
      retryAfterMs: number;
    };

export interface RateLimiter {
  /** Count one request for `key` if it fits, otherwise reject it. */
  take: (key: string) => Decision;
}

/** One key's state. */
interface Bucket {
  take: (now: number) => Decision;
  /** True when forgetting this bucket would not change any future decision. */
  isIdle: (now: number) => boolean;
}

type BucketFactory = (config: RateLimitConfig) => Bucket;

function fixedWindowBucket({ requests, window }: RateLimitConfig): Bucket {
  let windowStart = Number.NEGATIVE_INFINITY;
  let count = 0;
  return {
    take: (now) => {
      const currentStart = Math.floor(now / window) * window;
      if (currentStart !== windowStart) {
        windowStart = currentStart;
        count = 0;
      }
      if (count >= requests) {
        return { allowed: false, retryAfterMs: windowStart + window - now };
      }
      count += 1;
      return { allowed: true };
    },
    isIdle: (now) => now >= windowStart + window,
  };
}

function slidingWindowBucket({ requests, window }: RateLimitConfig): Bucket {
  /** Arrival times of the counted requests, oldest first. */
  const hits: number[] = [];

  /** A request at time t counts during (t, t + window]. */
  function expire(now: number): void {
    const firstLive = hits.findIndex((hit) => hit > now - window);
    hits.splice(0, firstLive === -1 ? hits.length : firstLive);
  }

  return {
    take: (now) => {
      expire(now);
      const [oldest] = hits;
      if (oldest !== undefined && hits.length >= requests) {
        return { allowed: false, retryAfterMs: oldest + window - now };
      }
      hits.push(now);
      return { allowed: true };
    },
    isIdle: (now) => {
      const newest = hits.at(-1);
      return newest === undefined || newest <= now - window;
    },
  };
}

function bucketFactory(strategy: RateLimitConfig["strategy"]): BucketFactory {
  switch (strategy) {
    case "fixed_window": {
      return fixedWindowBucket;
    }
    case "sliding_window": {
      return slidingWindowBucket;
    }
    default: {
      throw new UnreachableCaseError(strategy);
    }
  }
}

export function createRateLimiter(
  config: RateLimitConfig,
  clock: Clock,
): RateLimiter {
  const newBucket = bucketFactory(config.strategy);
  const buckets = new Map<string, Bucket>();
  let nextSweepAt = clock.now() + config.window;

  /**
   * Per-IP buckets would otherwise pile up forever. At most once per window,
   * drop the ones that no longer hold anything; amortized O(1) per request.
   */
  function sweep(now: number): void {
    if (now < nextSweepAt) {
      return;
    }
    for (const [key, bucket] of buckets) {
      if (bucket.isIdle(now)) {
        buckets.delete(key);
      }
    }
    nextSweepAt = now + config.window;
  }

  return {
    take: (key) => {
      const now = clock.now();
      sweep(now);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = newBucket(config);
        buckets.set(key, bucket);
      }
      return bucket.take(now);
    },
  };
}
