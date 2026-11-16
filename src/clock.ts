// Time source for everything time-based in the gateway (uptime and rate limit
// windows today; breaker cooldowns and backoff later). Injected so tests can
// control time instead of sleeping.

/** Monotonic milliseconds; only differences between readings are meaningful. */
export interface Clock {
  now: () => number;
}

export const systemClock: Clock = { now: () => performance.now() };
