// Pipeline stage for `auth` (type `api_key`).
//
// The request must carry the configured header with exactly one of the
// configured keys: case-sensitive, no trimming. A repeated header arrives
// comma-joined ("k1, k2") and so never matches.
// Missing or wrong key: 401 { "error": "unauthorized" } (one response for both,
// so callers can't tell which), and the request never reaches the upstream.
// Accepted: the key header is removed, so the upstream never sees credentials.
//
// Keys are compared as SHA-256 digests with `timingSafeEqual`, against every
// configured key, so response time doesn't reveal how much of a key matched.

import { createHash, timingSafeEqual } from "node:crypto";
import type { RouteConfig } from "../config.ts";
import { errorResponse } from "../http.ts";
import type { Middleware } from "../pipeline/context.ts";

function digest(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

function matchesAny(presented: string, keys: readonly Buffer[]): boolean {
  const candidate = digest(presented);
  // No early exit: always compare against every key.
  return keys.reduce(
    (matched, key) => timingSafeEqual(candidate, key) || matched,
    false,
  );
}

export function createAuthStage(route: RouteConfig): Middleware | undefined {
  const config = route.auth;
  if (!config) {
    return undefined;
  }
  // Incoming header names are lowercase.
  const header = config.header.toLowerCase();
  const keys = config.keys.map(digest);

  return async (ctx, next) => {
    const { [header]: presented, ...headers } = ctx.request.headers;
    if (typeof presented !== "string" || !matchesAny(presented, keys)) {
      return errorResponse({ status: 401, error: "unauthorized" });
    }
    ctx.request = { ...ctx.request, headers };
    return next();
  };
}
