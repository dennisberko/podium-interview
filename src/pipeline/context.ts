// Types shared by every pipeline stage.
//
// A route's pipeline is a chain of middleware ending in the upstream call.
// Middleware never writes to the client socket: it returns a `GatewayResponse`
// (or throws), so outer layers can inspect and change what inner layers did —
// retry looks at the status, the circuit breaker records the outcome, the
// response transform rewrites the body. Only `gateway.ts` writes to the client.

import type { OutgoingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import type { Clock } from "../clock.ts";
import type { RouteConfig } from "../config.ts";

/**
 * Bodies stay streams unless a stage needs the whole thing (retry replay,
 * body mapping, envelope); that stage buffers it.
 */
export type Body =
  | { kind: "stream"; stream: Readable }
  | { kind: "buffered"; data: Buffer };

/** What will be sent upstream. Stages may rewrite any of it. */
export interface UpstreamRequest {
  method: string;
  /** Path after routing (`strip_prefix` applied), starts with "/". */
  path: string;
  /** Query string including the leading "?", or "". */
  search: string;
  /** End-to-end headers plus X-Forwarded-*; `Host` is set per target. */
  headers: OutgoingHttpHeaders;
  body: Body;
}

export interface RequestContext {
  readonly route: RouteConfig;
  readonly clientIp: string;
  /** When the gateway received the request (`$request_time`). */
  readonly receivedAt: Date;
  /** Aborted when the client disconnects; pass it to anything that waits. */
  readonly signal: AbortSignal;
  request: UpstreamRequest;
}

export interface GatewayResponse {
  status: number;
  statusMessage?: string | undefined;
  headers: OutgoingHttpHeaders;
  body: Body;
}

export type Handler = (ctx: RequestContext) => Promise<GatewayResponse>;

/** Shared services a stage factory may use when it builds a route's stage. */
export interface StageDeps {
  /** Time source for windows, cooldowns and backoff. */
  clock: Clock;
}

export type Middleware = (
  ctx: RequestContext,
  next: () => Promise<GatewayResponse>,
) => Promise<GatewayResponse>;
