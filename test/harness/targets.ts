// Named mock upstream targets for load-balancing and health-check tests.
// Each answers normal requests with its own name, so a test can see which
// target served a request, and answers health probes (any path ending in
// HEALTH_PATH) with a status the test can change at any time.

import type { TestContext } from "node:test";
import type { TestGateway } from "./gateway.ts";
import { hang, startUpstream } from "./upstream.ts";

export const HEALTH_PATH = "/healthz";

export interface Target {
  name: string;
  url: string;
  /** What the next health probe gets: a status, or no answer at all. */
  health: number | "hang";
  /** Status for normal requests. */
  status: number;
  /** "METHOD url" of every health probe received, in order. */
  probes: string[];
  /** Normal (non-probe) requests received. */
  hits: number;
}

export async function startTarget(
  t: TestContext,
  name: string,
): Promise<Target> {
  const target: Target = {
    name,
    url: "",
    health: 200,
    status: 200,
    probes: [],
    hits: 0,
  };
  const upstream = await startUpstream(t, (req, res) => {
    const url = req.url ?? "";
    if (url.endsWith(HEALTH_PATH)) {
      target.probes.push(`${req.method ?? ""} ${url}`);
      if (target.health === "hang") {
        hang();
        return;
      }
      res.writeHead(target.health).end();
      return;
    }
    target.hits += 1;
    res.writeHead(target.status, { "content-type": "text/plain" });
    res.end(name);
  });
  target.url = upstream.url;
  return target;
}

export async function startTargets(
  t: TestContext,
  names: readonly string[],
): Promise<Target[]> {
  return Promise.all(names.map(async (name) => startTarget(t, name)));
}

/**
 * Send `count` GET requests one after another (the order of picks is what's
 * under test) and return the body of each reply.
 */
export async function servedBy(
  gw: TestGateway,
  count: number,
  path = "/api",
): Promise<string[]> {
  if (count <= 0) {
    return [];
  }
  const res = await fetch(`${gw.url}${path}`);
  const body = await res.text();
  return [body, ...(await servedBy(gw, count - 1, path))];
}
