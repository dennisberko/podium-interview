// Specs for `auth: { type: api_key }`.

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { rawRequest } from "./harness/client.ts";
import type { TestGateway } from "./harness/gateway.ts";
import { startGateway } from "./harness/gateway.ts";
import { echo, echoed, startUpstream } from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

const KEY_A = "sk_test_alpha";
const KEY_B = "sk_test_bravo";

interface Harness {
  gw: TestGateway;
  /** Requests that reached the upstream so far. */
  upstreamHits: () => number;
}

/** Gateway in front of an `echo` upstream that counts its requests. */
async function start(
  t: TestContext,
  config: (upstreamUrl: string) => string,
): Promise<Harness> {
  let hits = 0;
  const upstream = await startUpstream(t, async (req, res) => {
    hits += 1;
    await echo(req, res);
  });
  const gw = await startGateway(t, config(upstream.url));
  return { gw, upstreamHits: () => hits };
}

/** GET+POST /api protected by X-API-Key, plus an open GET /open. */
function protectedRoute(upstreamUrl: string): string {
  return yaml`
    routes:
      - path: /api
        methods: [GET, POST]
        upstream: { url: "${upstreamUrl}" }
        auth:
          type: api_key
          header: X-API-Key
          keys: ["${KEY_A}", "${KEY_B}"]
      - path: /open
        methods: [GET]
        upstream: { url: "${upstreamUrl}" }
  `;
}

async function statusOf(
  gw: TestGateway,
  {
    path = "/api",
    headers = {},
  }: { path?: string; headers?: HeadersInit } = {},
): Promise<number> {
  const res = await fetch(`${gw.url}${path}`, { headers });
  // Drain the body so the connection is released.
  await res.arrayBuffer();
  return res.status;
}

describe("api_key auth", () => {
  it("forwards requests carrying any listed key in the configured header", async (t) => {
    const { gw } = await start(t, protectedRoute);

    assert.equal(await statusOf(gw, { headers: { "X-API-Key": KEY_A } }), 200);
    assert.equal(await statusOf(gw, { headers: { "X-API-Key": KEY_B } }), 200);
  });

  it("answers 401 { error: 'unauthorized' } when the header is missing", async (t) => {
    const { gw } = await start(t, protectedRoute);

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 401);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  it("answers the same 401 when the key is not listed", async (t) => {
    const { gw } = await start(t, protectedRoute);

    const res = await fetch(`${gw.url}/api`, {
      headers: { "X-API-Key": "sk_test_wrong" },
    });

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  it("matches the header name case-insensitively and the key exactly", async (t) => {
    const { gw } = await start(t, protectedRoute);

    assert.equal(await statusOf(gw, { headers: { "x-api-key": KEY_A } }), 200);
    assert.equal(await statusOf(gw, { headers: { "X-API-KEY": KEY_A } }), 200);
    assert.equal(
      await statusOf(gw, { headers: { "X-API-Key": KEY_A.toUpperCase() } }),
      401,
    );
    assert.equal(
      await statusOf(gw, { headers: { "X-API-Key": `${KEY_A}x` } }),
      401,
    );
    assert.equal(
      await statusOf(gw, { headers: { "X-API-Key": KEY_A.slice(0, -1) } }),
      401,
    );
  });

  it("rejects the header sent twice, even with two valid keys", async (t) => {
    const { gw } = await start(t, protectedRoute);

    const res = await rawRequest(gw.url, {
      path: "/api",
      headers: { "x-api-key": [KEY_A, KEY_B] },
    });

    assert.equal(res.status, 401);
  });

  it("rejected requests never reach the upstream", async (t) => {
    const { gw, upstreamHits } = await start(t, protectedRoute);

    await statusOf(gw);
    await statusOf(gw, { headers: { "X-API-Key": "sk_test_wrong" } });
    assert.equal(upstreamHits(), 0);

    await statusOf(gw, { headers: { "X-API-Key": KEY_A } });
    assert.equal(upstreamHits(), 1);
  });

  it("strips the API key header before forwarding upstream", async (t) => {
    const { gw } = await start(t, protectedRoute);

    const seen = await echoed(
      await fetch(`${gw.url}/api`, {
        headers: { "X-API-Key": KEY_A, "x-custom": "kept" },
      }),
    );

    assert.equal(seen.headers["x-api-key"], undefined);
    assert.equal(seen.headers["x-custom"], "kept");
  });

  it("routes without auth accept requests without a key", async (t) => {
    const { gw } = await start(t, protectedRoute);

    assert.equal(await statusOf(gw, { path: "/open" }), 200);
  });

  it("routes without auth forward an API key header untouched", async (t) => {
    const { gw } = await start(t, protectedRoute);

    const seen = await echoed(
      await fetch(`${gw.url}/open`, { headers: { "X-API-Key": "anything" } }),
    );

    assert.equal(seen.headers["x-api-key"], "anything");
  });

  it("/health never requires a key", async (t) => {
    const { gw } = await start(
      t,
      (url) => yaml`
        routes:
          - path: /
            methods: [GET]
            upstream: { url: "${url}" }
            auth: { type: api_key, header: X-API-Key, keys: ["${KEY_A}"] }
      `,
    );

    assert.equal(await statusOf(gw, { path: "/anything" }), 401);
    assert.equal(await statusOf(gw, { path: "/health" }), 200);
  });

  it("404 and 405 are answered before auth", async (t) => {
    const { gw } = await start(t, protectedRoute);

    assert.equal(await statusOf(gw, { path: "/missing" }), 404);
    const res = await fetch(`${gw.url}/api`, { method: "DELETE" });
    await res.arrayBuffer();
    assert.equal(res.status, 405);
  });

  it("auth runs before rate limiting (unauthenticated traffic doesn't use quota)", async (t) => {
    const { gw } = await start(
      t,
      (url) => yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${url}" }
            auth: { type: api_key, header: X-API-Key, keys: ["${KEY_A}"] }
            rate_limit: { requests: 1, window: "60s", strategy: fixed_window, per: global }
      `,
    );

    assert.equal(await statusOf(gw), 401);
    assert.equal(await statusOf(gw), 401);
    assert.equal(await statusOf(gw, { headers: { "X-API-Key": KEY_A } }), 200);
    assert.equal(await statusOf(gw, { headers: { "X-API-Key": KEY_A } }), 429);
  });
});
