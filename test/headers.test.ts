import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { rawRequest } from "./harness/client.ts";
import type { TestGateway } from "./harness/gateway.ts";
import { startGateway } from "./harness/gateway.ts";
import type { Upstream, UpstreamHandler } from "./harness/upstream.ts";
import {
  echo,
  echoed,
  parseEchoed,
  startUpstream,
} from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

async function gatewayTo(
  t: TestContext,
  handler: UpstreamHandler,
): Promise<TestGateway & { upstream: Upstream }> {
  const upstream = await startUpstream(t, handler);
  const gw = await startGateway(
    t,
    yaml`
      routes:
        - path: /api
          methods: [GET]
          upstream: { url: "${upstream.url}" }
    `,
  );
  return { ...gw, upstream };
}

describe("forwarding headers", () => {
  it("sets Host to the upstream and X-Forwarded-Host to the original", async (t) => {
    const gw = await gatewayTo(t, echo);

    const seen = await echoed(await fetch(`${gw.url}/api`));

    assert.equal(seen.headers["host"], new URL(gw.upstream.url).host);
    assert.equal(seen.headers["x-forwarded-host"], new URL(gw.url).host);
  });

  it("sets X-Forwarded-For to the client address and X-Forwarded-Proto to http", async (t) => {
    const gw = await gatewayTo(t, echo);

    const seen = await echoed(await fetch(`${gw.url}/api`));

    assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1");
    assert.equal(seen.headers["x-forwarded-proto"], "http");
  });

  it("appends the client to an existing X-Forwarded-For chain", async (t) => {
    const gw = await gatewayTo(t, echo);

    const seen = await echoed(
      await fetch(`${gw.url}/api`, {
        headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      }),
    );

    assert.equal(
      seen.headers["x-forwarded-for"],
      "203.0.113.9, 10.0.0.1, 127.0.0.1",
    );
  });

  it("passes end-to-end request headers through", async (t) => {
    const gw = await gatewayTo(t, echo);

    const seen = await echoed(
      await fetch(`${gw.url}/api`, {
        headers: {
          authorization: "Bearer token",
          cookie: "session=1",
          "x-custom": "kept",
        },
      }),
    );

    assert.equal(seen.headers["authorization"], "Bearer token");
    assert.equal(seen.headers["cookie"], "session=1");
    assert.equal(seen.headers["x-custom"], "kept");
  });
});

describe("hop-by-hop headers", () => {
  it("strips them from the request, including ones named in Connection", async (t) => {
    const gw = await gatewayTo(t, echo);

    const res = await rawRequest(gw.url, {
      path: "/api",
      headers: {
        connection: "close, x-hop-listed",
        "x-hop-listed": "secret",
        "keep-alive": "timeout=5",
        te: "trailers",
        "proxy-authorization": "Basic Zm9vOmJhcg==",
        "x-end-to-end": "kept",
      },
    });

    const { headers } = parseEchoed(res.body);
    assert.equal(headers["x-hop-listed"], undefined);
    assert.equal(headers["keep-alive"], undefined);
    assert.equal(headers["te"], undefined);
    assert.equal(headers["proxy-authorization"], undefined);
    assert.equal(headers["x-end-to-end"], "kept");
  });

  it("strips them from the response, including ones named in Connection", async (t) => {
    const gw = await gatewayTo(t, (_req, res) => {
      res.writeHead(200, {
        connection: "x-up-hop",
        "x-up-hop": "secret",
        "proxy-authenticate": "Basic",
        "x-kept": "yes",
      });
      res.end();
    });

    const res = await rawRequest(gw.url, { path: "/api" });

    assert.equal(res.headers["x-up-hop"], undefined);
    assert.equal(res.headers["proxy-authenticate"], undefined);
    assert.equal(res.headers["x-kept"], "yes");
  });
});
