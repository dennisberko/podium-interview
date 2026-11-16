// The gateway's HTTP server. At startup it builds the router and one pipeline
// per route (see pipeline/build.ts). Per request:
//
//   parse target -> /health -> route lookup (404 / 405) -> route pipeline -> respond

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Clock, Sleep } from "./clock.ts";
import { systemClock, systemSleep } from "./clock.ts";
import type { GatewayConfig, RouteConfig } from "./config.ts";
import { createHealthHandler, HEALTH_PATH } from "./health.ts";
import { sendError } from "./http.ts";
import { buildRouteHandler } from "./pipeline/build.ts";
import type { Handler, RequestContext } from "./pipeline/context.ts";
import { respond, sendFailure } from "./pipeline/respond.ts";
import type { RouteLookup } from "./router.ts";
import { createRouter } from "./router.ts";
import { UnreachableCaseError } from "./unreachable.ts";
import { forwardedRequestHeaders } from "./upstream/forward-headers.ts";

interface RequestTarget {
  /** Normalized path ("/a/../b" -> "/b"), still percent-encoded. */
  path: string;
  /** Query string including the leading "?", or "". */
  search: string;
}

/** Parse the request target, or `undefined` if it isn't a valid URL. */
function parseTarget(req: IncomingMessage): RequestTarget | undefined {
  const raw = req.url ?? "";
  // Origin-form ("/a?b") is resolved against a dummy origin; prefixing instead of
  // passing it as a base keeps "//x" a path rather than a protocol-relative URL.
  const url = URL.parse(
    raw.startsWith("/") ? `http://gateway.invalid${raw}` : raw,
  );
  return url ? { path: url.pathname, search: url.search } : undefined;
}

function createContext(
  req: IncomingMessage,
  res: ServerResponse,
  {
    route,
    path,
    search,
    clientIp,
  }: { route: RouteConfig; path: string; search: string; clientIp: string },
): RequestContext {
  const controller = new AbortController();
  // `close` before the response finished means the client went away.
  res.once("close", () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  return {
    route,
    clientIp,
    receivedAt: new Date(),
    signal: controller.signal,
    request: {
      method: req.method ?? "GET",
      path,
      search,
      headers: forwardedRequestHeaders(req),
      body: { kind: "stream", stream: req },
    },
  };
}

/** Seams for tests; production uses the defaults. */
export interface GatewayOptions {
  /** Drives /health uptime and rate limit windows. Defaults to `performance.now()`. */
  clock?: Clock;
  /** Waits between retry attempts. Defaults to a real timer. */
  sleep?: Sleep;
  /**
   * Becomes `ctx.clientIp`, the key for per-IP features such as rate limiting.
   * Defaults to the socket's remote address.
   */
  clientIp?: (req: IncomingMessage) => string;
}

function socketClientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "";
}

export function createGateway(
  config: GatewayConfig,
  options: GatewayOptions = {},
): Server {
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? systemSleep;
  const health = createHealthHandler(clock);
  const clientIpOf = options.clientIp ?? socketClientIp;
  const router = createRouter(config.routes);
  const pipelines = new Map<RouteConfig, Handler>(
    config.routes.map((route) => [
      route,
      buildRouteHandler(route, { clock, sleep }),
    ]),
  );

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    { lookup, search }: { lookup: RouteLookup; search: string },
  ): Promise<void> {
    switch (lookup.kind) {
      case "not_found": {
        sendError(res, { status: 404, error: "not_found" });
        return;
      }
      case "method_not_allowed": {
        sendError(res, {
          status: 405,
          error: "method_not_allowed",
          headers: { allow: lookup.allow.join(", ") },
        });
        return;
      }
      case "matched": {
        const { route, upstreamPath } = lookup;
        const pipeline = pipelines.get(route);
        if (!pipeline) {
          throw new Error(`no pipeline built for route ${route.path}`);
        }
        const ctx = createContext(req, res, {
          route,
          path: upstreamPath,
          search,
          clientIp: clientIpOf(req),
        });
        await respond(res, async () => pipeline(ctx));
        return;
      }
      default: {
        throw new UnreachableCaseError(lookup);
      }
    }
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const target = parseTarget(req);
    if (!target) {
      sendError(res, { status: 400, error: "bad_request" });
      return;
    }
    if (target.path === HEALTH_PATH) {
      health(req, res);
      return;
    }
    await dispatch(req, res, {
      lookup: router(target.path, req.method ?? ""),
      search: target.search,
    });
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => sendFailure(res, err));
  });
}
