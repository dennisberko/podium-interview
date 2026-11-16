// Specs for `circuit_breaker` (not implemented yet).
// Drive window and cooldown with the injected clock.

import { describe, it } from "node:test";

describe("circuit breaker: tripping", () => {
  it.todo("trips after `threshold` failures within `window`");
  it.todo("failures older than `window` don't count toward the threshold");
  it.todo(
    "decide: which failures count (5xx, 502 connection errors, 504 timeouts)",
  );
  it.todo("successes while closed don't trip it");
});

describe("circuit breaker: open", () => {
  it.todo(
    "answers 503 { error: 'service_unavailable', retry_after } without calling upstream",
  );
  it.todo("retry_after is whole seconds left in the cooldown, counting down");
});

describe("circuit breaker: recovery", () => {
  it.todo("after `cooldown`, lets one trial request through (half-open)");
  it.todo("a successful trial closes the breaker and clears the failure count");
  it.todo("a failed trial reopens the breaker for another cooldown");
  it.todo("concurrent requests during half-open still get 503");
  it.todo("each route has its own breaker");
});
