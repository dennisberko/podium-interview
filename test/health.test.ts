import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeClock } from "./harness/clock.ts";
import { startGateway } from "./harness/gateway.ts";
import { startUpstream } from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

describe("GET /health", () => {
  it("reports healthy as uncached JSON", async (t) => {
    const gw = await startGateway(t, yaml`routes: []`, {
      clock: fakeClock(),
    });

    const res = await fetch(`${gw.url}/health`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), {
      status: "healthy",
      uptime_seconds: 0,
    });
  });

  it("counts whole seconds of uptime since the gateway started", async (t) => {
    const clock = fakeClock(1_000_000);
    const gw = await startGateway(t, yaml`routes: []`, { clock });

    clock.advance(61_999);
    const res = await fetch(`${gw.url}/health`);

    assert.deepEqual(await res.json(), {
      status: "healthy",
      uptime_seconds: 61,
    });
  });

  it("ignores the query string", async (t) => {
    const gw = await startGateway(t, yaml`routes: []`);
    const res = await fetch(`${gw.url}/health?verbose=1`);
    assert.equal(res.status, 200);
  });

  it("rejects other methods with 405", async (t) => {
    const gw = await startGateway(t, yaml`routes: []`);

    const res = await fetch(`${gw.url}/health`, { method: "POST" });

    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET");
    assert.deepEqual(await res.json(), { error: "method_not_allowed" });
  });
});

describe("/health vs configured routes", () => {
  // AGENTS.md open question: a route at /health is accepted by config today
  // and silently shadowed. If that becomes a startup error, replace these.
  it("is answered by the gateway even when a route claims /health", async (t) => {
    let upstreamHits = 0;
    const upstream = await startUpstream(t, (_req, res) => {
      upstreamHits += 1;
      res.end("upstream");
    });
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /health
            methods: [GET]
            upstream:
              url: "${upstream.url}"
      `,
    );

    const res = await fetch(`${gw.url}/health`);

    const body = await res.json();
    assert.equal(body.status, "healthy");
    assert.equal(upstreamHits, 0);
  });

  it("is not captured by a catch-all / route", async (t) => {
    const upstream = await startUpstream(t, (_req, res) => {
      res.end("upstream");
    });
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /
            methods: [GET]
            upstream:
              url: "${upstream.url}"
      `,
    );

    const res = await fetch(`${gw.url}/health`);

    const body = await res.json();
    assert.equal(body.status, "healthy");
  });

  it("reserves only the exact path; /health/... is routed normally", async (t) => {
    const upstream = await startUpstream(t, (_req, res) => {
      res.end("upstream");
    });
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /health
            methods: [GET]
            upstream:
              url: "${upstream.url}"
      `,
    );

    const res = await fetch(`${gw.url}/health/details`);

    assert.equal(await res.text(), "upstream");
  });
});
