// Behavior of the two rate limiting algorithms, tested through decisions only:
// given requests at these times, which are allowed and how long to wait.
//
// Besides hand-picked timelines, each strategy is checked against its
// definition on a long pseudo-random timeline over several keys:
//   fixed_window   — a request is allowed iff fewer than `requests` requests
//                    of its key were allowed earlier in the same clock-aligned
//                    window [k*w, (k+1)*w).
//   sliding_window — a request at t is allowed iff fewer than `requests`
//                    requests of its key were allowed in (t - w, t].

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeClock } from "../../test/harness/clock.ts";
import type { FakeClock } from "../../test/harness/clock.ts";
import type { RateLimitConfig } from "../config.ts";
import type { Decision } from "./limiter.ts";
import { createRateLimiter } from "./limiter.ts";

type Strategy = RateLimitConfig["strategy"];

const WINDOW = 1000;
const REQUESTS = 3;

interface TestLimiter {
  clock: FakeClock;
  /** Take one request for `key` at the current time. */
  take: (key?: string) => Decision;
  /** Take `count` requests at the current time; how many were allowed. */
  burst: (count: number, key?: string) => number;
  /** Move the clock to an absolute time. */
  at: (ms: number) => void;
}

function limiter(strategy: Strategy): TestLimiter {
  const clock = fakeClock();
  const rateLimiter = createRateLimiter(
    { requests: REQUESTS, window: WINDOW, strategy, per: "ip" },
    clock,
  );
  const take = (key = "a"): Decision => rateLimiter.take(key);
  return {
    clock,
    take,
    burst: (count, key) =>
      Array.from({ length: count }, () => take(key)).filter((d) => d.allowed)
        .length,
    at: (ms) => clock.advance(ms - clock.now()),
  };
}

function retryAfter(decision: Decision): number {
  assert.equal(decision.allowed, false, "expected a rejection");
  return decision.allowed ? Number.NaN : decision.retryAfterMs;
}

// ── Definition checks on a pseudo-random timeline ───────────────────────────

interface Outcome {
  at: number;
  key: string;
  allowed: boolean;
}

/** Park–Miller PRNG: deterministic, so a failure is reproducible. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

/** Mostly short gaps and same-instant bursts; now and then a pause longer than a window. */
function nextGap(random: () => number): number {
  const roll = random();
  if (roll < 0.3) {
    return 0;
  }
  return roll < 0.95 ? Math.floor(random() * 250) : 1500;
}

/**
 * 300 requests from three keys over a few dozen windows: every key is often
 * limited, and the long pauses leave keys idle so cleanup runs mid-timeline.
 */
function simulate(strategy: Strategy, seed: number): Outcome[] {
  const { clock, take } = limiter(strategy);
  const random = prng(seed);
  const keys = ["a", "b", "c"];
  const outcomes: Outcome[] = [];
  for (let i = 0; i < 300; i++) {
    clock.advance(nextGap(random));
    const key = keys[Math.floor(random() * keys.length)] ?? "a";
    outcomes.push({ at: clock.now(), key, allowed: take(key).allowed });
  }
  return outcomes;
}

/** Allowed requests of the same key, earlier in the timeline, that `isCounted` accepts. */
function allowedBefore(
  outcomes: readonly Outcome[],
  index: number,
  isCounted: (at: number) => boolean,
): number {
  const { key } = outcomes[index] ?? { key: "" };
  return outcomes
    .slice(0, index)
    .filter((o) => o.allowed && o.key === key && isCounted(o.at)).length;
}

function assertMatchesDefinition(
  outcomes: readonly Outcome[],
  countsAgainst: (requestAt: number, earlierAt: number) => boolean,
): void {
  outcomes.forEach((outcome, index) => {
    const used = allowedBefore(outcomes, index, (at) =>
      countsAgainst(outcome.at, at),
    );
    assert.equal(
      outcome.allowed,
      used < REQUESTS,
      `request #${index} (${outcome.key} at ${outcome.at}ms) had ${used} counted requests`,
    );
  });
  const allowed = outcomes.filter((o) => o.allowed).length;
  assert.ok(allowed > 0 && allowed < outcomes.length, "timeline too easy");
}

const SEEDS = [1, 42, 2024, 99_991];

// ── fixed_window ────────────────────────────────────────────────────────────

describe("fixed_window", () => {
  it("allows `requests` requests in a window, then rejects", () => {
    const { burst } = limiter("fixed_window");
    assert.equal(burst(REQUESTS + 2), REQUESTS);
  });

  it("rejects until the window boundary, then allows a full window again", () => {
    const { burst, at, take } = limiter("fixed_window");
    burst(REQUESTS);
    at(999);
    assert.equal(take().allowed, false);
    at(1000);
    assert.equal(burst(REQUESTS + 1), REQUESTS);
  });

  it("aligns windows to the clock, not to the first request", () => {
    const { burst, at } = limiter("fixed_window");
    at(900);
    assert.equal(burst(REQUESTS + 1), REQUESTS);
    // Only 100ms after the first request, but a new window has started.
    at(1000);
    assert.equal(burst(REQUESTS), REQUESTS);
  });

  it("lets a burst at the end of one window and the start of the next both pass", () => {
    const { burst, at } = limiter("fixed_window");
    at(999);
    assert.equal(burst(REQUESTS), REQUESTS);
    at(1000);
    assert.equal(burst(REQUESTS), REQUESTS);
  });

  it("retryAfterMs is the time left in the current window", () => {
    const { burst, at, take } = limiter("fixed_window");
    at(2100);
    burst(REQUESTS);
    at(2250);
    assert.equal(retryAfter(take()), 750);
    at(2999);
    assert.equal(retryAfter(take()), 1);
  });

  it("does not carry unused capacity into the next window", () => {
    const { burst, at } = limiter("fixed_window");
    burst(1);
    at(1000);
    assert.equal(burst(REQUESTS + 2), REQUESTS);
  });

  it("does not count rejected requests", () => {
    const { burst, at } = limiter("fixed_window");
    burst(REQUESTS);
    at(500);
    burst(10);
    at(1000);
    assert.equal(burst(REQUESTS), REQUESTS);
  });

  it("limits each key independently", () => {
    const { burst } = limiter("fixed_window");
    assert.equal(burst(REQUESTS + 1, "a"), REQUESTS);
    assert.equal(burst(REQUESTS + 1, "b"), REQUESTS);
  });

  it("matches its definition on random timelines", () => {
    for (const seed of SEEDS) {
      assertMatchesDefinition(
        simulate("fixed_window", seed),
        (requestAt, earlierAt) =>
          Math.floor(earlierAt / WINDOW) === Math.floor(requestAt / WINDOW),
      );
    }
  });
});

// ── sliding_window ──────────────────────────────────────────────────────────

describe("sliding_window", () => {
  it("allows `requests` requests in a window, then rejects", () => {
    const { burst } = limiter("sliding_window");
    assert.equal(burst(REQUESTS + 2), REQUESTS);
  });

  it("counts a request for exactly `window` ms after it arrived", () => {
    const { burst, at, take } = limiter("sliding_window");
    at(500);
    burst(REQUESTS);
    at(1499);
    assert.equal(take().allowed, false);
    at(1500);
    assert.equal(burst(REQUESTS + 1), REQUESTS);
  });

  it("limits a burst that straddles a clock-aligned boundary", () => {
    const { burst, at } = limiter("sliding_window");
    at(999);
    assert.equal(burst(REQUESTS), REQUESTS);
    at(1000);
    assert.equal(burst(REQUESTS), 0);
  });

  it("frees capacity one request at a time as old requests age out", () => {
    const { take, at } = limiter("sliding_window");
    for (const time of [0, 300, 600]) {
      at(time);
      assert.equal(take().allowed, true);
    }
    at(1000);
    assert.equal(take().allowed, true, "the 0ms request aged out");
    assert.equal(retryAfter(take()), 300, "next slot: 300ms request at 1300");
    at(1300);
    assert.equal(take().allowed, true);
    assert.equal(retryAfter(take()), 300, "next slot: 600ms request at 1600");
  });

  it("allows a request exactly retryAfterMs after a rejection", () => {
    const { burst, at, take } = limiter("sliding_window");
    at(100);
    burst(1);
    at(450);
    burst(REQUESTS - 1);
    at(700);
    const wait = retryAfter(take());
    assert.equal(wait, 400);
    at(700 + wait - 1);
    assert.equal(take().allowed, false);
    at(700 + wait);
    assert.equal(take().allowed, true);
  });

  it("does not count rejected requests", () => {
    const { burst, at } = limiter("sliding_window");
    burst(REQUESTS);
    at(900);
    burst(10);
    at(1000);
    assert.equal(burst(REQUESTS), REQUESTS);
  });

  it("limits each key independently", () => {
    const { burst } = limiter("sliding_window");
    assert.equal(burst(REQUESTS + 1, "a"), REQUESTS);
    assert.equal(burst(REQUESTS + 1, "b"), REQUESTS);
  });

  it("still remembers a busy key after another key's request triggers cleanup", () => {
    const clock = fakeClock();
    const { take } = createRateLimiter(
      { requests: 1, window: WINDOW, strategy: "sliding_window", per: "ip" },
      clock,
    );
    clock.advance(600);
    assert.equal(take("busy").allowed, true);
    // Cleanup is due a window after creation; "other" triggers it while
    // "busy" still has a request counting until 1600.
    clock.advance(500);
    assert.equal(take("other").allowed, true);
    assert.equal(take("busy").allowed, false);
  });

  it("matches its definition on random timelines", () => {
    for (const seed of SEEDS) {
      assertMatchesDefinition(
        simulate("sliding_window", seed),
        (requestAt, earlierAt) => earlierAt > requestAt - WINDOW,
      );
    }
  });
});
