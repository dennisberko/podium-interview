// Specs for multiple `upstream.targets` and `balance`.
// Each target answers with its own name, so the reply bodies show which
// target served each request. Health is driven by a hand-ticked `every`.

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import type { Sleep } from "../src/clock.ts";
import { ConfigError, parseConfig } from "../src/config.ts";
import type { GatewayOptions } from "../src/gateway.ts";
import type { ManualEvery } from "./harness/every.ts";
import { manualEvery } from "./harness/every.ts";
import type { TestGateway } from "./harness/gateway.ts";
import { startGateway } from "./harness/gateway.ts";
import type { Target } from "./harness/targets.ts";
import { HEALTH_PATH, servedBy, startTargets } from "./harness/targets.ts";
import { yaml } from "./harness/yaml.ts";

const HEALTH_CHECK = `{ path: "${HEALTH_PATH}", interval: "30s", unhealthy_threshold: 1 }`;

/** Flow-style target list; a weight of `undefined` leaves `weight` out. */
function targetList(
  targets: readonly Target[],
  weights: readonly (number | undefined)[] = [],
): string {
  const entries = targets.map(({ url }, i) => {
    const weight = weights[i];
    return weight === undefined
      ? `{ url: "${url}" }`
      : `{ url: "${url}", weight: ${weight} }`;
  });
  return `[${entries.join(", ")}]`;
}

interface RouteOptions {
  balance?: "round_robin" | "weighted_round_robin";
  weights?: readonly (number | undefined)[];
  /** Extra route keys, one per line, e.g. `health_check: {...}`. */
  extra?: string;
}

/** One GET /api route balanced across `targets`. */
function balancedRoute(
  targets: readonly Target[],
  { balance = "round_robin", weights, extra = "" }: RouteOptions = {},
): string {
  return yaml`
    routes:
      - path: /api
        methods: [GET]
        upstream:
          targets: ${targetList(targets, weights)}
          balance: ${balance}
        ${extra}
  `;
}

interface Harness {
  gw: TestGateway;
  every: ManualEvery;
}

async function start(
  t: TestContext,
  config: string,
  options: GatewayOptions = {},
): Promise<Harness> {
  const every = manualEvery();
  const gw = await startGateway(t, config, { every: every.every, ...options });
  // Let the first health-check round (if any) finish.
  await every.settled();
  return { gw, every };
}

function count(bodies: readonly string[], name: string): number {
  return bodies.filter((body) => body === name).length;
}

describe("load balancing: rotation", () => {
  it("round_robin cycles through targets in config order", async (t) => {
    const targets = await startTargets(t, ["A", "B", "C"]);
    const { gw } = await start(t, balancedRoute(targets));

    assert.deepEqual(await servedBy(gw, 6), ["A", "B", "C", "A", "B", "C"]);
  });

  it("weighted_round_robin sends 3:1 traffic for weights 3 and 1", async (t) => {
    const targets = await startTargets(t, ["A", "B"]);
    const { gw } = await start(
      t,
      balancedRoute(targets, {
        balance: "weighted_round_robin",
        weights: [3, 1],
      }),
    );

    const bodies = await servedBy(gw, 40);
    assert.equal(count(bodies, "A"), 30);
    assert.equal(count(bodies, "B"), 10);
  });

  it("weighted_round_robin interleaves targets instead of sending bursts", async (t) => {
    const targets = await startTargets(t, ["A", "B"]);
    const { gw } = await start(
      t,
      balancedRoute(targets, {
        balance: "weighted_round_robin",
        weights: [3, 1],
      }),
    );

    assert.deepEqual(await servedBy(gw, 8), [
      "A",
      "A",
      "B",
      "A",
      "A",
      "A",
      "B",
      "A",
    ]);
  });

  it("targets without a weight count as weight 1", async (t) => {
    const targets = await startTargets(t, ["A", "B"]);
    const { gw } = await start(
      t,
      balancedRoute(targets, {
        balance: "weighted_round_robin",
        weights: [2, undefined],
      }),
    );

    assert.deepEqual(await servedBy(gw, 6), ["A", "B", "A", "A", "B", "A"]);
  });

  it("a single `url` upstream always uses that target", async (t) => {
    const [a] = await startTargets(t, ["A"]);
    const { gw } = await start(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${a?.url ?? ""}" }
      `,
    );

    assert.deepEqual(await servedBy(gw, 3), ["A", "A", "A"]);
  });

  it("each route keeps its own rotation", async (t) => {
    const targets = await startTargets(t, ["A", "B"]);
    const list = targetList(targets);
    const { gw } = await start(
      t,
      yaml`
        routes:
          - path: /one
            methods: [GET]
            upstream: { targets: ${list}, balance: round_robin }
          - path: /two
            methods: [GET]
            upstream: { targets: ${list}, balance: round_robin }
      `,
    );

    assert.deepEqual(await servedBy(gw, 1, "/one"), ["A"]);
    assert.deepEqual(await servedBy(gw, 1, "/two"), ["A"]);
    assert.deepEqual(await servedBy(gw, 1, "/one"), ["B"]);
    assert.deepEqual(await servedBy(gw, 1, "/two"), ["B"]);
  });
});

describe("load balancing: config", () => {
  const routeWith = (balance: string, weight: number): string => yaml`
    gateway: { port: 8080, global_timeout: "30s" }
    routes:
      - path: /api
        methods: [GET]
        upstream:
          targets:
            - { url: "http://localhost:3003", weight: ${weight} }
            - { url: "http://localhost:3004" }
          balance: ${balance}
  `;

  it("rejects a weight other than 1 under round_robin", () => {
    assert.throws(
      () => parseConfig(routeWith("round_robin", 3)),
      (err: unknown) =>
        err instanceof ConfigError &&
        err.problems.length === 1 &&
        /routes\.0\.upstream\.targets\.0\.weight: weight 3 has no effect with balance "round_robin"/.test(
          err.problems[0] ?? "",
        ),
    );
  });

  it("accepts weight 1 under round_robin", () => {
    assert.doesNotThrow(() => parseConfig(routeWith("round_robin", 1)));
  });

  it("accepts any weight under weighted_round_robin", () => {
    assert.doesNotThrow(() =>
      parseConfig(routeWith("weighted_round_robin", 3)),
    );
  });
});

describe("load balancing: health", () => {
  it("skips targets marked unhealthy by health checks", async (t) => {
    const targets = await startTargets(t, ["A", "B", "C"]);
    const [a] = targets;
    if (a) {
      a.health = 500;
    }
    const { gw } = await start(
      t,
      balancedRoute(targets, { extra: `health_check: ${HEALTH_CHECK}` }),
    );

    assert.deepEqual(await servedBy(gw, 4), ["B", "C", "B", "C"]);
    assert.equal(a?.hits, 0);
  });

  it("shares traffic among the healthy targets by their weights", async (t) => {
    const targets = await startTargets(t, ["A", "B", "C"]);
    const [a] = targets;
    if (a) {
      a.health = 500;
    }
    const { gw } = await start(
      t,
      balancedRoute(targets, {
        balance: "weighted_round_robin",
        weights: [5, 2, 1],
        extra: `health_check: ${HEALTH_CHECK}`,
      }),
    );

    assert.deepEqual(await servedBy(gw, 6), ["B", "C", "B", "B", "C", "B"]);
  });

  it("returns 503 when every target is unhealthy", async (t) => {
    const targets = await startTargets(t, ["A", "B"]);
    for (const target of targets) {
      target.health = 500;
    }
    const { gw } = await start(
      t,
      balancedRoute(targets, { extra: `health_check: ${HEALTH_CHECK}` }),
    );

    const res = await fetch(`${gw.url}/api`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "no_healthy_upstream" });
    assert.deepEqual(
      targets.map(({ hits }) => hits),
      [0, 0],
    );
  });
});

/** A `sleep` that records each wait and returns immediately. */
function instantSleep(waits: number[]): Sleep {
  return async (ms) => {
    waits.push(ms);
  };
}

describe("load balancing: retry", () => {
  const RETRY = `retry: { attempts: 2, backoff: fixed, initial_delay: "1s", on: [503] }`;

  it("a retried request moves on to the next target", async (t) => {
    const targets = await startTargets(t, ["A", "B"]);
    const [a, b] = targets;
    if (a) {
      a.status = 503;
    }
    const { gw } = await start(t, balancedRoute(targets, { extra: RETRY }), {
      sleep: instantSleep([]),
    });

    assert.deepEqual(await servedBy(gw, 1), ["B"]);
    assert.equal(a?.hits, 1);
    assert.equal(b?.hits, 1);
  });

  it("does not retry the gateway's own no_healthy_upstream 503", async (t) => {
    const targets = await startTargets(t, ["A", "B"]);
    for (const target of targets) {
      target.health = 500;
    }
    const waits: number[] = [];
    const { gw } = await start(
      t,
      balancedRoute(targets, {
        extra: `${RETRY}\n        health_check: ${HEALTH_CHECK}`,
      }),
      { sleep: instantSleep(waits) },
    );

    const res = await fetch(`${gw.url}/api`);
    assert.equal(res.status, 503);
    assert.deepEqual(waits, []);
  });
});
