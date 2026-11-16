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
//
// The upstream call picks a target per try (see load-balancing/balancer.ts),
// so a retried request moves on to the next healthy target.

import { createAuthStage } from "../auth/stage.ts";
import type { RouteConfig } from "../config.ts";
import { errorResponse } from "../http.ts";
import type { TargetHealth } from "../load-balancing/balancer.ts";
import { createBalancer } from "../load-balancing/balancer.ts";
import { createRateLimitStage } from "../rate-limit/stage.ts";
import { createRetryStage } from "../retry/stage.ts";
import { callUpstream } from "../upstream/client.ts";
import { upstreamUrl } from "../upstream/url.ts";
import { compose } from "./compose.ts";
import type { Handler, Middleware, StageDeps } from "./context.ts";

type StageFactory = (
  route: RouteConfig,
  deps: StageDeps,
) => Middleware | undefined;

// Transforms are not built yet; they will go between rate limit and retry.
const STAGES: readonly StageFactory[] = [
  createAuthStage,
  createRateLimitStage,
  createRetryStage,
];

/**
 * The innermost stage: send the request to the next healthy target. With no
 * healthy target left it answers 503 { "error": "no_healthy_upstream" } itself,
 * which retry never retries.
 */
function createUpstreamHandler(
  route: RouteConfig,
  health: TargetHealth,
): Handler {
  const bases = route.upstream.targets.map(({ url }) => new URL(url));
  const pick = createBalancer(route.upstream, health);
  return async (ctx) => {
    const index = pick();
    const base = index === undefined ? undefined : bases[index];
    if (!base) {
      return errorResponse({ status: 503, error: "no_healthy_upstream" });
    }
    return callUpstream({
      url: upstreamUrl(base, ctx.request),
      request: ctx.request,
      timeoutMs: route.timeout_ms,
      signal: ctx.signal,
    });
  };
}

export function buildRouteHandler(
  route: RouteConfig,
  deps: StageDeps,
  health: TargetHealth,
): Handler {
  const stages = STAGES.map((create) => create(route, deps)).filter(
    (stage) => stage !== undefined,
  );
  return compose(stages, createUpstreamHandler(route, health));
}
