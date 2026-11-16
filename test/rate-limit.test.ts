// Specs for `rate_limit` / `global_rate_limit` (not implemented yet).
// Drive time with fakeClock() and client identity with the `clientIp` option.

import { describe, it } from "node:test";

describe("rate limiting: fixed_window", () => {
  it.todo("allows `requests` requests per window, then answers 429");
  it.todo("resets the count at the window boundary");
  it.todo(
    "a burst at the end of one window and the start of the next both pass",
  );
});

describe("rate limiting: sliding_window", () => {
  it.todo("counts requests in the trailing `window`, not calendar windows");
  it.todo("a burst straddling a window boundary is still limited");
  it.todo("capacity frees up gradually as old requests age out");
});

describe("rate limiting: buckets", () => {
  it.todo("per: ip keeps a separate bucket per client IP (via clientIp)");
  it.todo("per: global shares one bucket across all clients");
  it.todo("each route has its own buckets");
  it.todo(
    "routes with the same path but different methods do not share buckets",
  );
});

describe("rate limiting: config resolution", () => {
  it.todo("a route's rate_limit overrides global_rate_limit");
  it.todo("a route without rate_limit inherits global_rate_limit");
  it.todo("no limit applies when neither is configured");
});

describe("rate limiting: responses", () => {
  it.todo("429 body is { error: 'rate_limited' } JSON");
  it.todo("429 includes Retry-After with seconds until capacity frees up");
  it.todo("rejected requests never reach the upstream");
  it.todo("/health is never rate limited");
  it.todo("404 and 405 responses do not consume quota");
});
