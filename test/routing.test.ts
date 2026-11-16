import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rawRequest } from "./harness/client.ts";
import { startGateway } from "./harness/gateway.ts";
import type { UpstreamHandler } from "./harness/upstream.ts";
import {
  echo,
  echoed,
  parseEchoed,
  startUpstream,
} from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

/** Upstream handler that answers with a fixed name, to tell upstreams apart. */
function says(name: string): UpstreamHandler {
  return (_req, res) => {
    res.end(name);
  };
}

async function textOf(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
  return res.text();
}

describe("route matching", () => {
  it("picks the longest matching prefix regardless of config order", async (t) => {
    const api = await startUpstream(t, says("api"));
    const users = await startUpstream(t, says("users"));
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${api.url}" }
          - path: /api/users
            methods: [GET]
            upstream: { url: "${users.url}" }
      `,
    );

    assert.equal(await textOf(`${gw.url}/api/users/42`), "users");
    assert.equal(await textOf(`${gw.url}/api/users`), "users");
    assert.equal(await textOf(`${gw.url}/api/orders`), "api");
  });

  it("matches prefixes only on whole path segments", async (t) => {
    const users = await startUpstream(t, says("users"));
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/users
            methods: [GET]
            upstream: { url: "${users.url}" }
      `,
    );

    const res = await fetch(`${gw.url}/api/usersX`);

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });

  it("treats a trailing slash in the configured path as absent", async (t) => {
    const users = await startUpstream(t, says("users"));
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/users/
            methods: [GET]
            upstream: { url: "${users.url}" }
      `,
    );

    assert.equal(await textOf(`${gw.url}/api/users`), "users");
    assert.equal(await textOf(`${gw.url}/api/users/`), "users");
  });

  it("lets a / route catch every path", async (t) => {
    const root = await startUpstream(t, says("root"));
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /
            methods: [GET]
            upstream: { url: "${root.url}" }
      `,
    );

    assert.equal(await textOf(`${gw.url}/anything/at/all`), "root");
  });

  it("returns 404 when no route matches", async (t) => {
    const gw = await startGateway(t, yaml`routes: []`);

    const res = await fetch(`${gw.url}/nope`);

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });

  // AGENTS.md open question: paths are case sensitive today.
  it("matches paths case-sensitively", async (t) => {
    const users = await startUpstream(t, says("users"));
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/users
            methods: [GET]
            upstream: { url: "${users.url}" }
      `,
    );

    const res = await fetch(`${gw.url}/API/users`);

    assert.equal(res.status, 404);
  });

  it("resolves dot segments before matching and forwarding", async (t) => {
    const users = await startUpstream(t, echo);
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/users
            methods: [GET]
            upstream: { url: "${users.url}" }
      `,
    );

    const res = await rawRequest(gw.url, { path: "/api/other/../users/1" });

    assert.equal(res.status, 200);
    assert.equal(parseEchoed(res.body).url, "/api/users/1");
  });
});

describe("method matching", () => {
  it("returns 405 with an Allow header for unlisted methods", async (t) => {
    const users = await startUpstream(t, says("users"));
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/users
            methods: [GET, POST]
            upstream: { url: "${users.url}" }
      `,
    );

    const res = await fetch(`${gw.url}/api/users`, { method: "DELETE" });

    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, POST, HEAD");
    assert.deepEqual(await res.json(), { error: "method_not_allowed" });
  });

  it("serves HEAD from the GET route", async (t) => {
    const upstream = await startUpstream(t, (req, res) => {
      res.setHeader("x-seen-method", req.method ?? "");
      res.end("body");
    });
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/users
            methods: [GET]
            upstream: { url: "${upstream.url}" }
      `,
    );

    const res = await fetch(`${gw.url}/api/users`, { method: "HEAD" });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-seen-method"), "HEAD");
    assert.equal(await res.text(), "");
  });

  it("routes one path to different upstreams by method", async (t) => {
    const reader = await startUpstream(t, says("reader"));
    const writer = await startUpstream(t, says("writer"));
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/items
            methods: [GET]
            upstream: { url: "${reader.url}" }
          - path: /api/items
            methods: [POST]
            upstream: { url: "${writer.url}" }
      `,
    );

    assert.equal(await textOf(`${gw.url}/api/items`), "reader");
    assert.equal(
      await textOf(`${gw.url}/api/items`, { method: "POST" }),
      "writer",
    );
    const res = await fetch(`${gw.url}/api/items`, { method: "PUT" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, POST, HEAD");
  });

  it("does not fall back to a shorter prefix when the method doesn't match", async (t) => {
    const api = await startUpstream(t, says("api"));
    const users = await startUpstream(t, says("users"));
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api
            methods: [GET, POST]
            upstream: { url: "${api.url}" }
          - path: /api/users
            methods: [GET]
            upstream: { url: "${users.url}" }
      `,
    );

    const res = await fetch(`${gw.url}/api/users`, { method: "POST" });

    assert.equal(res.status, 405);
  });
});

describe("strip_prefix", () => {
  it("forwards the full path and query when false", async (t) => {
    const upstream = await startUpstream(t, echo);
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/users
            methods: [GET]
            strip_prefix: false
            upstream: { url: "${upstream.url}" }
      `,
    );

    const seen = await echoed(await fetch(`${gw.url}/api/users/7?x=1&y=%20`));

    assert.equal(seen.url, "/api/users/7?x=1&y=%20");
  });

  it("removes the route prefix when true", async (t) => {
    const upstream = await startUpstream(t, echo);
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/products
            methods: [GET]
            strip_prefix: true
            upstream: { url: "${upstream.url}" }
      `,
    );

    const nested = await echoed(await fetch(`${gw.url}/api/products/123?x=1`));
    const exact = await echoed(await fetch(`${gw.url}/api/products`));

    assert.equal(nested.url, "/123?x=1");
    assert.equal(exact.url, "/");
  });

  it("appends the forwarded path to an upstream base path", async (t) => {
    const upstream = await startUpstream(t, echo);
    const gw = await startGateway(
      t,
      yaml`
        routes:
          - path: /api/legacy
            methods: [GET]
            strip_prefix: true
            upstream: { url: "${upstream.url}/v2/" }
      `,
    );

    const seen = await echoed(await fetch(`${gw.url}/api/legacy/data`));

    assert.equal(seen.url, "/v2/data");
  });
});
