// Specs for `retry`.
// Waits go through an injected `sleep` that records each delay and returns at
// once, so backoff is checked without real waiting. The mock upstream answers
// a scripted list of statuses (then 200) and records every request it gets.

import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Sleep } from "../src/clock.ts";
import { MAX_BODY_BYTES } from "../src/retry/stage.ts";
import { rawRequest } from "./harness/client.ts";
import type { TestGateway } from "./harness/gateway.ts";
import { startGateway } from "./harness/gateway.ts";
import { hang, refusedUrl, startUpstream } from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

const RETRY_5XX = `{ attempts: 3, backoff: fixed, initial_delay: "1s", on: [502, 503, 504] }`;

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Harness {
  gw: TestGateway;
  /** Every request the upstream received, in order. */
  requests: Recorded[];
  /** Every backoff wait the gateway asked for, in ms. */
  waits: number[];
}

interface RouteOptions {
  upstreamUrl: string;
  /** Flow-style `retry` value; omitted means the route has no retry. */
  retry?: string;
  /** Route `upstream.timeout`, e.g. "100ms". */
  timeout?: string;
}

/** One /api route (GET, POST, PUT) in front of `upstreamUrl`. */
function routeConfig({ upstreamUrl, retry, timeout }: RouteOptions): string {
  const upstream =
    timeout === undefined
      ? `{ url: "${upstreamUrl}" }`
      : `{ url: "${upstreamUrl}", timeout: "${timeout}" }`;
  const retryLine = retry === undefined ? "" : `retry: ${retry}`;
  return yaml`
    routes:
      - path: /api
        methods: [GET, POST, PUT]
        upstream: ${upstream}
        ${retryLine}
  `;
}

/** A `sleep` that records each wait and returns immediately. */
function recordingSleep(waits: number[]): Sleep {
  return async (ms) => {
    waits.push(ms);
  };
}

interface StartOptions {
  /** Statuses for the upstream's 1st, 2nd, ... response; 200 after that. */
  statuses?: readonly number[];
  retry?: string;
}

async function start(
  t: TestContext,
  { statuses = [], retry = RETRY_5XX }: StartOptions = {},
): Promise<Harness> {
  const requests: Recorded[] = [];
  const upstream = await startUpstream(t, async (req, res) => {
    const body = await text(req);
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
    });
    res.writeHead(statuses[requests.length - 1] ?? 200, {
      "content-type": "text/plain",
    });
    res.end(`try ${requests.length}`);
  });
  const waits: number[] = [];
  const gw = await startGateway(
    t,
    routeConfig({ upstreamUrl: upstream.url, retry }),
    { sleep: recordingSleep(waits) },
  );
  return { gw, requests, waits };
}

interface Reply {
  status: number;
  body: string;
}

async function get(gw: TestGateway, path = "/api"): Promise<Reply> {
  const res = await fetch(`${gw.url}${path}`);
  return { status: res.status, body: await res.text() };
}

async function statusOf(gw: TestGateway): Promise<number> {
  const { status } = await get(gw);
  return status;
}

describe("retry: when", () => {
  it("retries when the upstream answers a status listed in `on`", async (t) => {
    const { gw, requests } = await start(t, { statuses: [503] });

    assert.deepEqual(await get(gw), { status: 200, body: "try 2" });
    assert.equal(requests.length, 2);
  });

  it("does not retry statuses not listed in `on`", async (t) => {
    const { gw, requests, waits } = await start(t, { statuses: [500] });

    assert.deepEqual(await get(gw), { status: 500, body: "try 1" });
    assert.equal(requests.length, 1);
    assert.deepEqual(waits, []);
  });

  it("stops after `attempts` total tries and relays the last response", async (t) => {
    const { gw, requests } = await start(t, {
      statuses: [503, 502, 504, 503],
    });

    // `attempts: 3` is three tries in total, not three retries.
    assert.deepEqual(await get(gw), { status: 504, body: "try 3" });
    assert.equal(requests.length, 3);
  });

  it("relays the first successful response and stops retrying", async (t) => {
    const { gw, requests } = await start(t, { statuses: [503, 201, 503] });

    assert.deepEqual(await get(gw), { status: 201, body: "try 2" });
    assert.equal(requests.length, 2);
  });

  it("retries connection errors as 502 when 502 is listed", async (t) => {
    const waits: number[] = [];
    const gw = await startGateway(
      t,
      routeConfig({ upstreamUrl: await refusedUrl(), retry: RETRY_5XX }),
      { sleep: recordingSleep(waits) },
    );

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "bad_gateway" });
    assert.equal(waits.length, 2, "three tries, so two waits");
  });

  it("does not retry connection errors when 502 is not listed", async (t) => {
    const waits: number[] = [];
    const gw = await startGateway(
      t,
      routeConfig({
        upstreamUrl: await refusedUrl(),
        retry: `{ attempts: 3, backoff: fixed, initial_delay: "1s", on: [503] }`,
      }),
      { sleep: recordingSleep(waits) },
    );

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 502);
    await res.arrayBuffer();
    assert.deepEqual(waits, []);
  });

  it("retries timeouts as 504 when 504 is listed", async (t) => {
    let hits = 0;
    const upstream = await startUpstream(t, () => {
      hits += 1;
      hang();
    });
    const gw = await startGateway(
      t,
      routeConfig({
        upstreamUrl: upstream.url,
        retry: RETRY_5XX,
        timeout: "100ms",
      }),
      { sleep: recordingSleep([]) },
    );

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: "gateway_timeout" });
    assert.equal(hits, 3);
  });

  it("retries every configured method, POST included", async (t) => {
    const { gw, requests } = await start(t, { statuses: [503] });

    const res = await fetch(`${gw.url}/api`, { method: "POST", body: "x" });

    assert.equal(res.status, 200);
    await res.arrayBuffer();
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["POST", "POST"],
    );
  });

  it.todo(
    "does not retry responses the gateway made itself (open circuit breaker 503)",
  );
});

describe("retry: backoff", () => {
  it("fixed backoff waits initial_delay between every attempt", async (t) => {
    const { gw, waits } = await start(t, {
      statuses: [503, 503, 503],
      retry: `{ attempts: 4, backoff: fixed, initial_delay: "250ms", on: [503] }`,
    });

    assert.equal(await statusOf(gw), 200);
    assert.deepEqual(waits, [250, 250, 250]);
  });

  it("exponential backoff doubles the delay each attempt (1s, 2s, 4s)", async (t) => {
    const { gw, waits } = await start(t, {
      statuses: [503, 503, 503],
      retry: `{ attempts: 4, backoff: exponential, initial_delay: "1s", on: [503] }`,
    });

    assert.equal(await statusOf(gw), 200);
    assert.deepEqual(waits, [1000, 2000, 4000]);
  });

  it("waits go through the injected sleep, with none after the last try", async (t) => {
    // An hour-long backoff that finishes instantly proves no real timer runs.
    const { gw, waits } = await start(t, {
      statuses: [503, 503, 503],
      retry: `{ attempts: 3, backoff: exponential, initial_delay: "1h", on: [503] }`,
    });

    assert.equal(await statusOf(gw), 503);
    assert.deepEqual(waits, [3_600_000, 7_200_000]);
  });
});

describe("retry: requests and timeouts", () => {
  it("replays the same method, path, query, headers and body on each attempt", async (t) => {
    const { gw, requests } = await start(t, { statuses: [503, 502] });

    const res = await fetch(`${gw.url}/api/items?page=2`, {
      method: "PUT",
      headers: { "content-type": "text/plain", "x-request-tag": "abc" },
      body: "payload",
    });

    assert.equal(res.status, 200);
    await res.arrayBuffer();
    assert.equal(requests.length, 3);
    const sent = requests.map(({ method, url, headers, body }) => ({
      method,
      url,
      body,
      contentType: headers["content-type"],
      contentLength: headers["content-length"],
      tag: headers["x-request-tag"],
    }));
    const expected = {
      method: "PUT",
      url: "/api/items?page=2",
      body: "payload",
      contentType: "text/plain",
      contentLength: "7",
      tag: "abc",
    };
    assert.deepEqual(sent, [expected, expected, expected]);
  });

  it("replays a chunked body in full, with a content-length", async (t) => {
    const { gw, requests } = await start(t, { statuses: [503] });

    const res = await rawRequest(gw.url, {
      method: "POST",
      path: "/api",
      body: ["hello ", "world"],
    });

    assert.equal(res.status, 200);
    assert.equal(requests.length, 2);
    for (const { body, headers } of requests) {
      assert.equal(body, "hello world");
      assert.equal(headers["content-length"], "11");
      assert.equal(headers["transfer-encoding"], undefined);
    }
  });

  it("forwards a request without a body without adding content-length", async (t) => {
    const { gw, requests } = await start(t, { statuses: [503] });

    assert.equal(await statusOf(gw), 200);
    assert.equal(requests.length, 2);
    for (const { headers } of requests) {
      assert.equal(headers["content-length"], undefined);
      assert.equal(headers["transfer-encoding"], undefined);
    }
  });

  it("applies the route timeout to each attempt on its own", async (t) => {
    let hits = 0;
    const upstream = await startUpstream(t, async (_req, res) => {
      hits += 1;
      if (hits === 1) {
        hang();
        return;
      }
      // With one deadline across all tries, the first try's 100ms would
      // leave nothing for this one.
      await delay(60);
      res.end("slow but in time");
    });
    const gw = await startGateway(
      t,
      routeConfig({
        upstreamUrl: upstream.url,
        retry: RETRY_5XX,
        timeout: "100ms",
      }),
      { sleep: recordingSleep([]) },
    );

    assert.deepEqual(await get(gw), {
      status: 200,
      body: "slow but in time",
    });
    assert.equal(hits, 2);
  });

  it("client disconnect cancels pending retries", async (t) => {
    let hits = 0;
    const upstream = await startUpstream(t, (_req, res) => {
      hits += 1;
      res.writeHead(503).end();
    });
    const waiting = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    // Blocks until the client disconnects, like the real sleep.
    const sleep: Sleep = async (_ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            reject(new Error("aborted"));
          },
          { once: true },
        );
        waiting.resolve();
      });
    const gw = await startGateway(
      t,
      routeConfig({ upstreamUrl: upstream.url, retry: RETRY_5XX }),
      { sleep },
    );
    const controller = new AbortController();

    const pending = fetch(`${gw.url}/api`, { signal: controller.signal });
    await waiting.promise;
    controller.abort();

    await assert.rejects(pending, { name: "AbortError" });
    await cancelled.promise;
    await delay(50);
    assert.equal(hits, 1);
  });

  it("routes without retry make exactly one upstream attempt", async (t) => {
    let hits = 0;
    const upstream = await startUpstream(t, (_req, res) => {
      hits += 1;
      res.writeHead(503).end();
    });
    const gw = await startGateway(
      t,
      routeConfig({ upstreamUrl: upstream.url }),
    );

    assert.equal(await statusOf(gw), 503);
    assert.equal(hits, 1);
  });
});

describe("retry: request body limit", () => {
  it("forwards a body of exactly the limit", async (t) => {
    const { gw, requests } = await start(t);

    const res = await fetch(`${gw.url}/api`, {
      method: "POST",
      body: new Uint8Array(MAX_BODY_BYTES),
    });

    assert.equal(res.status, 200);
    await res.arrayBuffer();
    assert.equal(requests[0]?.body.length, MAX_BODY_BYTES);
  });

  it("answers 413 when Content-Length is over the limit, without calling the upstream", async (t) => {
    const { gw, requests } = await start(t);

    const res = await fetch(`${gw.url}/api`, {
      method: "POST",
      body: new Uint8Array(MAX_BODY_BYTES + 1),
    });

    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "payload_too_large" });
    assert.equal(requests.length, 0);
  });

  it("answers 413 when a chunked body grows over the limit", async (t) => {
    const { gw, requests } = await start(t);
    const megabyte = "a".repeat(1024 * 1024);
    const chunks = Array.from(
      { length: MAX_BODY_BYTES / megabyte.length + 1 },
      () => megabyte,
    );

    const res = await rawRequest(gw.url, {
      method: "POST",
      path: "/api",
      body: chunks,
    });

    assert.equal(res.status, 413);
    assert.deepEqual(JSON.parse(res.body), { error: "payload_too_large" });
    assert.equal(requests.length, 0);
  });
});
