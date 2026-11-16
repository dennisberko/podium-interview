// GET /health — always served by the gateway itself, before route matching,
// so no config (not even a route at "/health") can shadow or break it.

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError, sendJson } from "./http.ts";

export const HEALTH_PATH = "/health";

export type HealthHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** `startedAt` is a `performance.now()` timestamp (monotonic, unaffected by clock changes). */
export function createHealthHandler(
  startedAt = performance.now(),
): HealthHandler {
  return (req, res) => {
    if (req.method !== "GET") {
      sendError(res, {
        status: 405,
        error: "method_not_allowed",
        headers: { allow: "GET" },
      });
      return;
    }
    sendJson(res, {
      status: 200,
      body: {
        status: "healthy",
        uptime_seconds: Math.floor((performance.now() - startedAt) / 1000),
      },
      headers: { "cache-control": "no-store" },
    });
  };
}
