// Builds each route's request pipeline once, at startup. This is the one place
// that decides which stages a route gets and in what order.
//
// Each feature is a factory `(route) => Middleware | undefined`, returning
// `undefined` when the route doesn't configure it, so a route's pipeline only
// contains what its config asks for. Stage state (rate-limit counters, breaker
// state, ...) lives in the factory's closure and is shared by that route's
// requests.
//
// Planned order, outermost first:
//   auth -> rate limit -> response transform -> request transform
//     -> retry -> circuit breaker -> [upstream call]

import type { RouteConfig } from "../config.ts";
import { callUpstream } from "../upstream/client.ts";
import { compose } from "./compose.ts";
import type { Handler, Middleware, UpstreamRequest } from "./context.ts";

type StageFactory = (route: RouteConfig) => Middleware | undefined;

const STAGES: readonly StageFactory[] = [];

/** Upstream URL = target base URL (+ any base path) + request path + query. */
function upstreamUrl(base: URL, { path, search }: UpstreamRequest): URL {
  const url = new URL(base);
  url.pathname = base.pathname.replace(/\/+$/, "") + path;
  url.search = search;
  return url;
}

/** The innermost stage: send the request to the route's upstream. */
function createUpstreamHandler(route: RouteConfig): Handler {
  // Load balancing replaces this: for now every route uses its first target.
  const [target] = route.upstream.targets;
  if (!target) {
    throw new Error(`route ${route.path} has no upstream targets`);
  }
  const base = new URL(target.url);
  return async (ctx) =>
    callUpstream({
      url: upstreamUrl(base, ctx.request),
      request: ctx.request,
      timeoutMs: route.timeout_ms,
      signal: ctx.signal,
    });
}

export function buildRouteHandler(route: RouteConfig): Handler {
  const stages = STAGES.map((create) => create(route)).filter(
    (stage) => stage !== undefined,
  );
  return compose(stages, createUpstreamHandler(route));
}
