// Pipeline stage for `rate_limit` (or the inherited `global_rate_limit`).
//
// Each route gets its own limiter, so routes never share quota. Within a route
// the bucket key is the client IP (`per: ip`, IPv6 by /64; see ip-key.ts) or one
// shared key (`per: global`).
// Over the limit: 429 { "error": "rate_limited" } with Retry-After in whole
// seconds, and the request never reaches the upstream.

import type { RateLimitConfig, RouteConfig } from "../config.ts";
import { errorResponse } from "../http.ts";
import type {
  Middleware,
  RequestContext,
  StageDeps,
} from "../pipeline/context.ts";
import { UnreachableCaseError } from "../unreachable.ts";
import { ipBucketKey } from "./ip-key.ts";
import { createRateLimiter } from "./limiter.ts";

type KeyOf = (ctx: RequestContext) => string;

const GLOBAL_KEY = "global";

function bucketKey(per: RateLimitConfig["per"]): KeyOf {
  switch (per) {
    case "ip": {
      return (ctx) => ipBucketKey(ctx.clientIp);
    }
    case "global": {
      return () => GLOBAL_KEY;
    }
    default: {
      throw new UnreachableCaseError(per);
    }
  }
}

/** Retry-After is whole seconds; round up so a client that waits gets in. */
function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export function createRateLimitStage(
  route: RouteConfig,
  { clock }: StageDeps,
): Middleware | undefined {
  const config = route.rate_limit;
  if (!config) {
    return undefined;
  }
  const limiter = createRateLimiter(config, clock);
  const keyOf = bucketKey(config.per);

  return async (ctx, next) => {
    const decision = limiter.take(keyOf(ctx));
    if (decision.allowed) {
      return next();
    }
    return errorResponse({
      status: 429,
      error: "rate_limited",
      headers: {
        "retry-after": String(retryAfterSeconds(decision.retryAfterMs)),
      },
    });
  };
}
