// Time source for everything time-based in the gateway (uptime, rate limit
// windows and retry backoff today; breaker cooldowns later). Injected so tests
// can control time instead of sleeping.

import { setTimeout as delay } from "node:timers/promises";

/** Monotonic milliseconds; only differences between readings are meaningful. */
export interface Clock {
  now: () => number;
}

export const systemClock: Clock = { now: () => performance.now() };

/**
 * Wait `ms`, or reject early once `signal` aborts. Injected separately from
 * `Clock` so tests can make backoff waits instant.
 */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const systemSleep: Sleep = async (ms, signal) =>
  delay(ms, undefined, { signal });
