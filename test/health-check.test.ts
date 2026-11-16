// Specs for per-route upstream `health_check`.
// Rounds are driven by a hand-ticked `every` (the first round runs when the
// gateway starts listening; `tick()` runs the next one). Whether a target is
// healthy shows up as whether it still gets traffic.

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import type { ManualEvery } from "./harness/every.ts";
import { manualEvery } from "./harness/every.ts";
import type { TestGateway } from "./harness/gateway.ts";
import { startGateway } from "./harness/gateway.ts";
import type { Target } from "./harness/targets.ts";
import { HEALTH_PATH, servedBy, startTargets } from "./harness/targets.ts";
import { refusedUrl } from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

interface CheckOptions {
  threshold?: number;
  interval?: string;
  /** Route `upstream.timeout`. */
  timeout?: string;
  /** Target URLs; defaults to each target's own URL. */
  urls?: readonly string[];
}

/** One GET /api route, round robin over `targets`, with a health check. */
function checkedRoute(
  targets: readonly Target[],
  { threshold = 1, interval = "30s", timeout = "30s", urls }: CheckOptions = {},
): string {
  const list = (urls ?? targets.map(({ url }) => url))
    .map((url) => `{ url: "${url}" }`)
    .join(", ");
  return yaml`
    routes:
      - path: /api
        methods: [GET]
        upstream:
          targets: [${list}]
          balance: round_robin
          timeout: "${timeout}"
        health_check:
          path: "${HEALTH_PATH}"
          interval: "${interval}"
          unhealthy_threshold: ${threshold}
  `;
}

interface Harness {
  gw: TestGateway;
  every: ManualEvery;
  a: Target;
  b: Target;
}

/** Targets A and B behind a checked route; A's health is set before start. */
async function start(
  t: TestContext,
  {
    health = 200,
    ...options
  }: CheckOptions & { health?: Target["health"] } = {},
): Promise<Harness> {
  const [a, b] = await startTargets(t, ["A", "B"]);
  if (!a || !b) {
    throw new Error("targets did not start");
  }
  a.health = health;
  const every = manualEvery();
  const gw = await startGateway(t, checkedRoute([a, b], options), {
    every: every.every,
  });
  return { gw, every, a, b };
}

/** Which targets served two requests in a row (round robin), sorted. */
async function inRotation(gw: TestGateway): Promise<string[]> {
  const bodies = await servedBy(gw, 2);
  return bodies.toSorted();
}

describe("upstream health checks: probing", () => {
  it("probes GET <target><health_check.path> on every target each `interval`", async (t) => {
    const { every, a, b } = await start(t);
    await every.settled();

    assert.deepEqual(every.live(), [30_000]);
    assert.deepEqual(a.probes, [`GET ${HEALTH_PATH}`]);
    assert.deepEqual(b.probes, [`GET ${HEALTH_PATH}`]);

    await every.tick();
    assert.equal(a.probes.length, 2);
    assert.equal(b.probes.length, 2);
  });

  it("appends the path to a target's base path", async (t) => {
    const [a] = await startTargets(t, ["A"]);
    if (!a) {
      throw new Error("target did not start");
    }
    const every = manualEvery();
    await startGateway(t, checkedRoute([a], { urls: [`${a.url}/base/`] }), {
      every: every.every,
    });
    await every.settled();

    assert.deepEqual(a.probes, [`GET /base${HEALTH_PATH}`]);
  });

  it("routes without health_check never probe", async (t) => {
    const [a] = await startTargets(t, ["A"]);
    const every = manualEvery();
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${a?.url ?? ""}" }
      `,
      { every: every.every },
    );

    assert.deepEqual(await servedBy(gw, 2), ["A", "A"]);
    assert.deepEqual(every.live(), []);
    assert.deepEqual(a?.probes, []);
  });

  it("stops probing, and aborts probes in flight, when the gateway closes", async (t) => {
    const { gw, every } = await start(t, { health: "hang" });
    assert.deepEqual(every.live(), [30_000]);

    await gw.close();

    assert.deepEqual(every.live(), []);
    // The hanging probe has a 30s timeout; this only resolves because it was aborted.
    await every.settled();
  });
});

describe("upstream health checks: marking", () => {
  it("targets start healthy before the first probe", async (t) => {
    // A's probe never answers, so the first round is still running.
    const { gw } = await start(t, { health: "hang" });

    assert.deepEqual(await inRotation(gw), ["A", "B"]);
  });

  it("marks a target unhealthy after `unhealthy_threshold` consecutive failures", async (t) => {
    const { gw, every } = await start(t, { health: 500, threshold: 3 });
    await every.settled();
    await every.tick();
    assert.deepEqual(await inRotation(gw), ["A", "B"], "2 failures: healthy");

    await every.tick();
    assert.deepEqual(await inRotation(gw), ["B", "B"], "3 failures: unhealthy");
  });

  it("a success resets the consecutive failure count", async (t) => {
    const { gw, every, a } = await start(t, { health: 500, threshold: 2 });
    await every.settled();
    a.health = 200;
    await every.tick();
    a.health = 500;
    await every.tick();

    assert.deepEqual(await inRotation(gw), ["A", "B"]);
  });

  it("an unhealthy target becomes healthy again after one successful probe", async (t) => {
    const { gw, every, a } = await start(t, { health: 500 });
    await every.settled();
    assert.deepEqual(await inRotation(gw), ["B", "B"]);

    a.health = 200;
    await every.tick();
    assert.deepEqual(await inRotation(gw), ["A", "B"]);
  });
});

describe("upstream health checks: what fails", () => {
  it("non-2xx responses count as failures", async (t) => {
    const { gw, every } = await start(t, { health: 301 });
    await every.settled();

    assert.deepEqual(await inRotation(gw), ["B", "B"]);
  });

  it("connection errors count as failures", async (t) => {
    const [b] = await startTargets(t, ["B"]);
    if (!b) {
      throw new Error("target did not start");
    }
    const every = manualEvery();
    const gw = await startGateway(
      t,
      checkedRoute([b], { urls: [await refusedUrl(), b.url] }),
      { every: every.every },
    );
    await every.settled();

    assert.deepEqual(await servedBy(gw, 2), ["B", "B"]);
  });

  it("no answer within the route timeout counts as a failure", async (t) => {
    const { gw, every } = await start(t, { health: "hang", timeout: "50ms" });
    await every.settled();

    assert.deepEqual(await inRotation(gw), ["B", "B"]);
  });

  it("the probe timeout is capped at `interval`", async (t) => {
    const { gw, every } = await start(t, {
      health: "hang",
      timeout: "30s",
      interval: "50ms",
    });
    await every.settled();

    assert.deepEqual(await inRotation(gw), ["B", "B"]);
  });
});
