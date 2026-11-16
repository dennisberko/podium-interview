import assert from "node:assert/strict";
import { buffer } from "node:stream/consumers";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { rawRequest } from "./harness/client.ts";
import type { TestGateway } from "./harness/gateway.ts";
import { startGateway } from "./harness/gateway.ts";
import type { UpstreamHandler } from "./harness/upstream.ts";
import {
  echo,
  echoed,
  parseEchoed,
  startUpstream,
} from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

const EIGHT_MIB = 8 * 1024 * 1024;

/** Gateway with a single route at /api accepting every method, to `handler`. */
async function gatewayTo(
  t: TestContext,
  handler: UpstreamHandler,
): Promise<TestGateway> {
  const upstream = await startUpstream(t, handler);
  return startGateway(
    t,
    yaml`
      routes:
        - path: /api
          methods: [GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS]
          upstream: { url: "${upstream.url}" }
    `,
  );
}

describe("request forwarding", () => {
  it("forwards method, path, query and body", async (t) => {
    const gw = await gatewayTo(t, echo);

    const seen = await echoed(
      await fetch(`${gw.url}/api/users?page=2`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    );

    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/users?page=2");
    assert.equal(seen.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(seen.body), { name: "Ada" });
  });

  it("forwards every configured method", async (t) => {
    const gw = await gatewayTo(t, echo);
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

    const seen = await Promise.all(
      methods.map(async (method) =>
        echoed(await fetch(`${gw.url}/api`, { method })),
      ),
    );

    assert.deepEqual(
      seen.map((request) => request.method),
      methods,
    );
  });

  it("sends no body for a bodiless GET", async (t) => {
    const gw = await gatewayTo(t, echo);

    const seen = await echoed(await fetch(`${gw.url}/api`));

    assert.equal(seen.body, "");
    assert.equal(seen.headers["transfer-encoding"], undefined);
  });

  it("re-chunks a chunked request body", async (t) => {
    const gw = await gatewayTo(t, echo);

    const res = await rawRequest(gw.url, {
      method: "POST",
      path: "/api",
      body: ["first,", "second,", "third"],
    });

    const seen = parseEchoed(res.body);
    assert.equal(seen.headers["transfer-encoding"], "chunked");
    assert.equal(seen.body, "first,second,third");
  });

  it("streams a large request body", async (t) => {
    const gw = await gatewayTo(t, async (req, res) => {
      const body = await buffer(req);
      res.end(String(body.length));
    });

    const res = await fetch(`${gw.url}/api`, {
      method: "POST",
      body: Buffer.alloc(EIGHT_MIB, "a"),
    });

    assert.equal(await res.text(), String(EIGHT_MIB));
  });
});

describe("response relaying", () => {
  it("relays status, reason phrase, headers and body", async (t) => {
    const gw = await gatewayTo(t, (_req, res) => {
      res.writeHead(201, "Made It", { "x-upstream": "yes" });
      res.end("created");
    });

    const res = await fetch(`${gw.url}/api`, { method: "POST" });

    assert.equal(res.status, 201);
    assert.equal(res.statusText, "Made It");
    assert.equal(res.headers.get("x-upstream"), "yes");
    assert.equal(await res.text(), "created");
  });

  it("relays upstream errors unchanged", async (t) => {
    const gw = await gatewayTo(t, (_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("upstream is sad");
    });

    const res = await fetch(`${gw.url}/api`);

    assert.equal(res.status, 503);
    assert.equal(await res.text(), "upstream is sad");
  });

  it("keeps repeated Set-Cookie headers separate", async (t) => {
    const gw = await gatewayTo(t, (_req, res) => {
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.end();
    });

    const res = await fetch(`${gw.url}/api`);

    assert.deepEqual(res.headers.getSetCookie(), [
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });

  it("streams a large response body", async (t) => {
    const gw = await gatewayTo(t, (_req, res) => {
      res.end(Buffer.alloc(EIGHT_MIB, "b"));
    });

    const res = await fetch(`${gw.url}/api`);

    const body = await res.arrayBuffer();
    assert.equal(body.byteLength, EIGHT_MIB);
  });
});
