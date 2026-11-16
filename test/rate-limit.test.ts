// Specs for `rate_limit` / `global_rate_limit`.
// Time comes from fakeClock() (which starts at 0, so fixed windows are
// [0, w), [w, 2w), ...) and client identity from the `clientIp` option.

import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import type { FakeClock } from "./harness/clock.ts";
import { fakeClock } from "./harness/clock.ts";
import type { TestGateway } from "./harness/gateway.ts";
import { startGateway } from "./harness/gateway.ts";
import { startUpstream } from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

const CLIENT_IP_HEADER = "x-test-client-ip";
const CLIENT_A = "198.51.100.1";
const CLIENT_B = "198.51.100.2";

interface Harness {
  gw: TestGateway;
  clock: FakeClock;
  /** Requests that reached the upstream so far. */
  upstreamHits: () => number;
}

/** Tests choose the client IP with a header instead of real sockets. */
function clientIpFromHeader(req: IncomingMessage): string {
  const value = req.headers[CLIENT_IP_HEADER];
  return typeof value === "string" ? value : CLIENT_A;
}

/** Gateway (fake clock) in front of an upstream that counts its requests. */
async function start(
  t: TestContext,
  config: (upstreamUrl: string) => string,
): Promise<Harness> {
  let hits = 0;
  const upstream = await startUpstream(t, (_req, res) => {
    hits += 1;
    res.end("ok");
  });
  const clock = fakeClock();
  const gw = await startGateway(t, config(upstream.url), {
    clock,
    clientIp: clientIpFromHeader,
  });
  return { gw, clock, upstreamHits: () => hits };
}

/** One GET /api route with the given flow-style `rate_limit`. */
function limitedRoute(rateLimit: string): (upstreamUrl: string) => string {
  return (upstreamUrl) => yaml`
    routes:
      - path: /api
        methods: [GET]
        upstream: { url: "${upstreamUrl}" }
        rate_limit: ${rateLimit}
  `;
}

interface SendOptions {
  path?: string;
  method?: string;
  ip?: string;
}

async function send(
  gw: TestGateway,
  { path = "/api", method = "GET", ip = CLIENT_A }: SendOptions = {},
): Promise<Response> {
  return fetch(`${gw.url}${path}`, {
    method,
    headers: { [CLIENT_IP_HEADER]: ip },
  });
}

async function statusOf(
  gw: TestGateway,
  options: SendOptions = {},
): Promise<number> {
  const res = await send(gw, options);
  // Drain the body so the connection is released.
  await res.arrayBuffer();
  return res.status;
}

/** Send `count` requests one after another; resolves to their statuses. */
async function statuses(
  gw: TestGateway,
  count: number,
  options: SendOptions = {},
): Promise<number[]> {
  return Array.from({ length: count }).reduce<Promise<number[]>>(
    async (previous) => [...(await previous), await statusOf(gw, options)],
    Promise.resolve([]),
  );
}

describe("rate limiting: fixed_window", () => {
  const FIXED = `{ requests: 2, window: "10s", strategy: fixed_window, per: ip }`;

  it("allows `requests` requests per window, then answers 429", async (t) => {
    const { gw } = await start(
      t,
      limitedRoute(
        `{ requests: 3, window: "10s", strategy: fixed_window, per: ip }`,
      ),
    );

    assert.deepEqual(await statuses(gw, 4), [200, 200, 200, 429]);
  });

  it("resets the count at the window boundary", async (t) => {
    const { gw, clock } = await start(t, limitedRoute(FIXED));
    assert.deepEqual(await statuses(gw, 3), [200, 200, 429]);

    clock.advance(9999);
    assert.equal(await statusOf(gw), 429);

    clock.advance(1);
    assert.deepEqual(await statuses(gw, 3), [200, 200, 429]);
  });

  it("a burst at the end of one window and the start of the next both pass", async (t) => {
    const { gw, clock } = await start(t, limitedRoute(FIXED));

    clock.advance(9000);
    assert.deepEqual(await statuses(gw, 2), [200, 200]);
    clock.advance(1000);
    assert.deepEqual(await statuses(gw, 2), [200, 200]);
  });
});

describe("rate limiting: sliding_window", () => {
  const SLIDING = `{ requests: 2, window: "10s", strategy: sliding_window, per: ip }`;

  it("counts requests in the trailing `window`, not calendar windows", async (t) => {
    const { gw, clock } = await start(t, limitedRoute(SLIDING));

    clock.advance(5000);
    assert.deepEqual(await statuses(gw, 2), [200, 200]);

    // A fixed window would have reset at 10s; these still count until 15s.
    clock.advance(9999);
    assert.equal(await statusOf(gw), 429);
    clock.advance(1);
    assert.equal(await statusOf(gw), 200);
  });

  it("a burst straddling a window boundary is still limited", async (t) => {
    const { gw, clock } = await start(t, limitedRoute(SLIDING));

    clock.advance(9500);
    assert.equal(await statusOf(gw), 200);
    clock.advance(1000);
    assert.deepEqual(await statuses(gw, 2), [200, 429]);
  });

  it("capacity frees up gradually as old requests age out", async (t) => {
    const { gw, clock } = await start(t, limitedRoute(SLIDING));

    assert.equal(await statusOf(gw), 200);
    clock.advance(4000);
    assert.equal(await statusOf(gw), 200);

    // At 10s only the first request has aged out: room for exactly one more,
    // and the next slot opens when the 4s request ages out at 14s.
    clock.advance(6000);
    assert.equal(await statusOf(gw), 200);
    const res = await send(gw);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "4");
  });
});

describe("rate limiting: buckets", () => {
  it("per: ip keeps a separate bucket per client IP (via clientIp)", async (t) => {
    const { gw } = await start(
      t,
      limitedRoute(
        `{ requests: 1, window: "60s", strategy: fixed_window, per: ip }`,
      ),
    );

    assert.equal(await statusOf(gw, { ip: CLIENT_A }), 200);
    assert.equal(await statusOf(gw, { ip: CLIENT_A }), 429);
    assert.equal(await statusOf(gw, { ip: CLIENT_B }), 200);
  });

  it("per: global shares one bucket across all clients", async (t) => {
    const { gw } = await start(
      t,
      limitedRoute(
        `{ requests: 1, window: "60s", strategy: sliding_window, per: global }`,
      ),
    );

    assert.equal(await statusOf(gw, { ip: CLIENT_A }), 200);
    assert.equal(await statusOf(gw, { ip: CLIENT_B }), 429);
  });

  it("each route has its own buckets", async (t) => {
    const { gw } = await start(
      t,
      (url) => yaml`
        gateway:
          port: 8080
          global_timeout: "30s"
          global_rate_limit: { requests: 1, window: "60s", strategy: fixed_window, per: global }
        routes:
          - path: /a
            methods: [GET]
            upstream: { url: "${url}" }
          - path: /b
            methods: [GET]
            upstream: { url: "${url}" }
      `,
    );

    assert.equal(await statusOf(gw, { path: "/a" }), 200);
    assert.equal(await statusOf(gw, { path: "/b" }), 200);
    assert.equal(await statusOf(gw, { path: "/a" }), 429);
    assert.equal(await statusOf(gw, { path: "/b" }), 429);
  });

  it("routes with the same path but different methods do not share buckets", async (t) => {
    const { gw } = await start(
      t,
      (url) => yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${url}" }
            rate_limit: { requests: 1, window: "60s", strategy: fixed_window, per: ip }
          - path: /api
            methods: [POST]
            upstream: { url: "${url}" }
            rate_limit: { requests: 1, window: "60s", strategy: fixed_window, per: ip }
      `,
    );

    assert.equal(await statusOf(gw, { method: "GET" }), 200);
    assert.equal(await statusOf(gw, { method: "POST" }), 200);
    assert.equal(await statusOf(gw, { method: "GET" }), 429);
    assert.equal(await statusOf(gw, { method: "POST" }), 429);
  });
});

/** Config with a 1-request global limit and the given route body. */
function withGlobalLimit(routeLines: string): (url: string) => string {
  return (url) => yaml`
    gateway:
      port: 8080
      global_timeout: "30s"
      global_rate_limit: { requests: 1, window: "60s", strategy: fixed_window, per: ip }
    routes:
      - path: /api
        methods: [GET]
        upstream: { url: "${url}" }
        ${routeLines}
  `;
}

describe("rate limiting: config resolution", () => {
  it("a route's rate_limit overrides global_rate_limit", async (t) => {
    const { gw } = await start(
      t,
      withGlobalLimit(
        `rate_limit: { requests: 3, window: "60s", strategy: fixed_window, per: ip }`,
      ),
    );

    assert.deepEqual(await statuses(gw, 4), [200, 200, 200, 429]);
  });

  it("a route without rate_limit inherits global_rate_limit", async (t) => {
    const { gw } = await start(t, withGlobalLimit(""));

    assert.deepEqual(await statuses(gw, 2), [200, 429]);
  });

  it("no limit applies when neither is configured", async (t) => {
    const { gw } = await start(
      t,
      (url) => yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${url}" }
      `,
    );

    const results = await statuses(gw, 20);
    assert.ok(
      results.every((status) => status === 200),
      String(results),
    );
  });
});

describe("rate limiting: responses", () => {
  const ONE_PER_TEN_SECONDS = `{ requests: 1, window: "10s", strategy: fixed_window, per: ip }`;

  it("429 body is { error: 'rate_limited' } JSON", async (t) => {
    const { gw } = await start(t, limitedRoute(ONE_PER_TEN_SECONDS));
    await statusOf(gw);

    const res = await send(gw);

    assert.equal(res.status, 429);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await res.json(), { error: "rate_limited" });
  });

  it("429 includes Retry-After with seconds until capacity frees up", async (t) => {
    const { gw, clock } = await start(t, limitedRoute(ONE_PER_TEN_SECONDS));
    await statusOf(gw);

    // 7.5s left in the window, rounded up so a client that waits gets in.
    clock.advance(2500);
    const res = await send(gw);
    await res.arrayBuffer();
    assert.equal(res.headers.get("retry-after"), "8");

    // Never 0, even with less than a second left.
    clock.advance(7400);
    const almost = await send(gw);
    await almost.arrayBuffer();
    assert.equal(almost.headers.get("retry-after"), "1");
  });

  it("rejected requests never reach the upstream", async (t) => {
    const { gw, upstreamHits } = await start(
      t,
      limitedRoute(ONE_PER_TEN_SECONDS),
    );

    assert.deepEqual(await statuses(gw, 3), [200, 429, 429]);
    assert.equal(upstreamHits(), 1);
  });

  it("/health is never rate limited", async (t) => {
    const { gw } = await start(
      t,
      (url) => yaml`
        gateway:
          port: 8080
          global_timeout: "30s"
          global_rate_limit: { requests: 1, window: "60s", strategy: fixed_window, per: global }
        routes:
          - path: /
            methods: [GET]
            upstream: { url: "${url}" }
      `,
    );

    assert.deepEqual(await statuses(gw, 2), [200, 429]);
    assert.deepEqual(
      await statuses(gw, 3, { path: "/health" }),
      [200, 200, 200],
    );
  });

  it("404 and 405 responses do not consume quota", async (t) => {
    const { gw } = await start(t, withGlobalLimit(""));

    assert.deepEqual(await statuses(gw, 2, { path: "/missing" }), [404, 404]);
    assert.deepEqual(await statuses(gw, 2, { method: "POST" }), [405, 405]);
    assert.equal(await statusOf(gw), 200);
  });
});
