import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { rawRequest } from "./harness/client.ts";
import { startGateway } from "./harness/gateway.ts";
import { hang, refusedUrl, startUpstream } from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

describe("upstream failures", () => {
  it("returns 502 when the upstream refuses connections", async (t) => {
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${await refusedUrl()}" }
      `,
    );

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "bad_gateway" });
  });

  it("returns 502 when the upstream drops the connection before responding", async (t) => {
    const upstream = await startUpstream(t, (req) => {
      req.socket.destroy();
    });
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${upstream.url}" }
      `,
    );

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "bad_gateway" });
  });

  it("returns 504 when the upstream exceeds the route timeout", async (t) => {
    const upstream = await startUpstream(t, hang);
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream:
              url: "${upstream.url}"
              timeout: "100ms"
      `,
    );

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: "gateway_timeout" });
  });

  it("applies global_timeout when the route sets none", async (t) => {
    const upstream = await startUpstream(t, hang);
    const gw = await startGateway(
      t,
      yaml`
        gateway:
          port: 8080
          global_timeout: "100ms"
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${upstream.url}" }
      `,
    );

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 504);
  });

  it("keeps serving after an upstream failure", async (t) => {
    let calls = 0;
    const upstream = await startUpstream(t, (req, res) => {
      calls += 1;
      if (calls === 1) {
        req.socket.destroy();
        return;
      }
      res.end("recovered");
    });
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${upstream.url}" }
      `,
    );

    const failed = await fetch(`${gw.url}/api`);
    const recovered = await fetch(`${gw.url}/api`);

    assert.equal(failed.status, 502);
    assert.equal(await recovered.text(), "recovered");
  });
});

describe("failures after the response started", () => {
  it("drops the client connection when the upstream dies mid-body", async (t) => {
    const upstream = await startUpstream(t, async (_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      await sleep(20);
      res.socket?.destroy();
    });
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${upstream.url}" }
      `,
    );

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 200);
    await assert.rejects(res.text());
  });

  it("enforces the timeout until the last body byte", async (t) => {
    const upstream = await startUpstream(t, (_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
    });
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream:
              url: "${upstream.url}"
              timeout: "100ms"
      `,
    );

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 200);
    await assert.rejects(res.text());
  });
});

describe("client behavior", () => {
  it("aborts the upstream request when the client disconnects", async (t) => {
    const received = Promise.withResolvers<void>();
    const upstreamClosed = Promise.withResolvers<void>();
    const upstream = await startUpstream(t, async (_req, res) => {
      received.resolve();
      await once(res, "close");
      upstreamClosed.resolve();
    });
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${upstream.url}" }
      `,
    );
    const controller = new AbortController();

    const pending = fetch(`${gw.url}/api`, { signal: controller.signal });
    await received.promise;
    controller.abort();

    await assert.rejects(pending, { name: "AbortError" });
    await upstreamClosed.promise;
  });

  it("returns 400 for a request target that isn't a valid URL", async (t) => {
    const gw = await startGateway(t, yaml`routes: []`);

    const res = await rawRequest(gw.url, { method: "OPTIONS", path: "*" });

    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "bad_request" });
  });
});
