// Time source for everything time-based in the gateway (uptime, rate limit
// windows, retry backoff and health-check rounds today; breaker cooldowns
// later). Injected so tests can control time instead of sleeping.

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

/**
 * Run `task` right away, then again `ms` after each run finishes, until the
 * returned function is called. Runs never overlap. `task` must not reject.
 * Injected so tests can trigger health-check rounds instead of waiting.
 */
export type Every = (ms: number, task: () => Promise<void>) => () => void;

function logTaskFailure(err: unknown): void {
  console.error("scheduled task failed", err);
}

export const systemEvery: Every = (ms, task) => {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined = undefined;
  const run = async (): Promise<void> => {
    await task().catch(logTaskFailure);
    if (!stopped) {
      // Background work must not keep the process alive on its own.
      timer = setTimeout(() => {
        run().catch(logTaskFailure);
      }, ms).unref();
    }
  };
  run().catch(logTaskFailure);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
