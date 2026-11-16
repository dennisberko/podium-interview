// The gateway's HTTP server. Builds per-instance state (uptime clock, later
// rate limiters / breakers / balancers) from a resolved config and dispatches
// each request: built-in endpoints first, then configured routes.

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { GatewayConfig } from "./config.ts";
import { createHealthHandler, HEALTH_PATH } from "./health.ts";
import { sendError } from "./http.ts";

/** Path portion of the request target, or `undefined` if it can't be parsed. */
function requestPath(req: IncomingMessage): string | undefined {
  // Base is only used to parse origin-form targets ("/a?b"); host is irrelevant.
  return URL.parse(req.url ?? "", "http://gateway.invalid")?.pathname;
}

export function createGateway(_config: GatewayConfig): Server {
  const health = createHealthHandler();

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = requestPath(req);
    if (path === undefined) {
      sendError(res, { status: 400, error: "bad_request" });
      return;
    }
    if (path === HEALTH_PATH) {
      health(req, res);
      return;
    }
    // Route matching and proxying come next
    sendError(res, { status: 404, error: "not_found" });
  }

  return createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      console.error("unhandled error while handling request", err);
      if (res.headersSent) {
        res.destroy();
      } else {
        sendError(res, { status: 500, error: "internal_error" });
      }
    }
  });
}
