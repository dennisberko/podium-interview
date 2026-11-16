import type { Clock } from "../../src/clock.ts";

/** A clock that only moves when the test calls `advance`. */
export interface FakeClock extends Clock {
  advance: (ms: number) => void;
}

export function fakeClock(startMs = 0): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}
