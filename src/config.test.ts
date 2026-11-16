import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RouteConfig } from "./config.ts";
import { ConfigError, loadConfig, parseConfig } from "./config.ts";

function routeByPath(path: string): RouteConfig {
  const route = loadConfig().routes.find((r) => r.path === path);
  assert.ok(route, `route ${path} missing`);
  return route;
}

/** Runs parseConfig and returns the ConfigError's problem lines. */
function problems(text: string): string[] {
  try {
    parseConfig(text);
  } catch (err) {
    assert.ok(err instanceof ConfigError, String(err));
    return err.problems;
  }
  assert.fail("expected parseConfig to throw");
}

function minimal(...routes: string[]): string {
  return `gateway:
  port: 8080
  global_timeout: "30s"
routes:
${routes.join("")}`;
}

const basicRoute = `  - path: "/a"
    methods: ["GET"]
    upstream:
      url: "http://localhost:3001"
`;

describe("example gateway.yaml", () => {
  it("loads", () => {
    const config = loadConfig();
    assert.equal(config.port, 8080);
    assert.equal(config.routes.length, 5);
  });

  it("keeps `on:` as a key (no YAML 1.1 boolean coercion)", () => {
    assert.deepEqual(routeByPath("/api/orders").retry?.on, [502, 503, 504]);
  });

  it("converts durations to milliseconds", () => {
    const orders = routeByPath("/api/orders");
    assert.equal(orders.timeout_ms, 5000);
    assert.equal(orders.retry?.initial_delay, 1000);
    assert.equal(orders.rate_limit?.window, 10_000);
  });

  it("normalizes a single url into one round-robin target", () => {
    assert.deepEqual(routeByPath("/api/users").upstream, {
      targets: [{ url: "http://localhost:3001", weight: 1 }],
      balance: "round_robin",
    });
  });

  it("keeps weighted targets", () => {
    assert.deepEqual(routeByPath("/api/products").upstream, {
      targets: [
        { url: "http://localhost:3003", weight: 3 },
        { url: "http://localhost:3004", weight: 1 },
      ],
      balance: "weighted_round_robin",
    });
  });

  it("inherits global timeout and rate limit when a route has none", () => {
    const legacy = routeByPath("/api/legacy");
    assert.equal(legacy.timeout_ms, 30_000);
    assert.deepEqual(legacy.rate_limit, {
      requests: 100,
      window: 60_000,
      strategy: "fixed_window",
      per: "ip",
    });
  });

  it("route overrides win over globals", () => {
    assert.equal(routeByPath("/api/users").rate_limit?.requests, 30);
  });

  it("parses transforms and placeholders", () => {
    const legacy = routeByPath("/api/legacy");
    assert.deepEqual(legacy.request_transform?.headers?.remove, [
      "X-Debug",
      "X-Internal",
    ]);
    assert.equal(
      legacy.request_transform?.body?.mapping["meta.source"],
      "$literal:gateway",
    );
    assert.deepEqual(legacy.response_transform?.body?.envelope, {
      data: "$body",
      gateway_metadata: {
        served_at: "$response_time",
        route: "$route_path",
      },
    });
  });
});

describe("validation errors", () => {
  it("rejects unknown keys and points at the line", () => {
    const [problem, ...rest] = problems(
      minimal(basicRoute, `    rate_limt:\n      requests: 5\n`),
    );
    assert.equal(rest.length, 0);
    assert.match(problem ?? "", /^gateway\.yaml:5:5 routes\.0: .*rate_limt/);
  });

  it("rejects bad enum values with line and column", () => {
    const [problem] = problems(
      minimal(
        basicRoute,
        `    retry:
      attempts: 3
      backoff: "linear"
      initial_delay: "1s"
      on: [502]
`,
      ),
    );
    assert.match(
      problem ?? "",
      /^gateway\.yaml:11:16 routes\.0\.retry\.backoff:/,
    );
  });

  it("rejects malformed durations", () => {
    const [problem] = problems(
      minimal(basicRoute).replace('"30s"', '"30 sec"'),
    );
    assert.match(
      problem ?? "",
      /gateway\.global_timeout: invalid duration "30 sec"/,
    );
  });

  it("accepts ms, s, m and h", () => {
    for (const [text, ms] of [
      ["250ms", 250],
      ["2s", 2000],
      ["3m", 180_000],
      ["1h", 3_600_000],
    ] as const) {
      const config = parseConfig(
        minimal(basicRoute).replace('"30s"', `"${text}"`),
      );
      assert.equal(config.routes[0]?.timeout_ms, ms);
    }
  });

  it("rejects unknown placeholders", () => {
    const [problem] = problems(
      minimal(
        basicRoute,
        `    request_transform:
      headers:
        add:
          X-Start: "$reqest_time"
`,
      ),
    );
    assert.match(problem ?? "", /unknown placeholder "\$reqest_time"/);
  });

  it("rejects unknown placeholders inside nested envelopes", () => {
    const [problem, ...rest] = problems(
      minimal(
        basicRoute,
        `    response_transform:
      body:
        envelope:
          meta:
            at: "$respnse_time"
`,
      ),
    );
    assert.equal(rest.length, 0);
    assert.match(
      problem ?? "",
      /routes\.0\.response_transform\.body\.envelope\.meta\.at: unknown placeholder/,
    );
  });

  it("rejects duplicate route paths", () => {
    const [problem] = problems(minimal(basicRoute, basicRoute));
    assert.match(problem ?? "", /routes\.1\.path: duplicate route path "\/a"/);
  });

  it("points a missing key at its parent", () => {
    const [problem] = problems(
      minimal(`  - path: "/a"\n    upstream:\n      url: "http://x"\n`),
    );
    assert.match(problem ?? "", /^gateway\.yaml:5:5 routes\.0\.methods:/);
  });

  it("reports YAML syntax errors", () => {
    const [problem] = problems("gateway:\n  port: [8080\n");
    assert.match(problem ?? "", /^gateway\.yaml: /);
  });

  it("rejects non-http upstream urls", () => {
    const [problem] = problems(
      minimal(basicRoute.replace("http://localhost:3001", "ftp://host")),
    );
    assert.match(problem ?? "", /:8:12 routes\.0\.upstream\.url: Invalid URL/);
  });
});
