// The edge of the pipeline: turns its result into bytes on the client socket.
//
// Errors thrown by any stage end up in `sendFailure`, the one place that maps
// failures to status codes:
//   UpstreamError "timeout"     -> 504 { "error": "gateway_timeout" }
//   UpstreamError "connection"  -> 502 { "error": "bad_gateway" }
//   UpstreamError "aborted"     -> nothing (the client is gone)
//   anything else               -> 500 { "error": "internal_error" }
// If the response has already started, the connection is dropped instead.

import type { ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import { sendError } from "../http.ts";
import { UnreachableCaseError } from "../unreachable.ts";
import { UpstreamError } from "../upstream/client.ts";
import type { GatewayResponse } from "./context.ts";

export function writeResponse(
  res: ServerResponse,
  { status, statusMessage, headers, body }: GatewayResponse,
): void {
  if (res.destroyed) {
    if (body.kind === "stream") {
      body.stream.destroy();
    }
    return;
  }
  res.writeHead(status, statusMessage, headers);
  if (body.kind === "buffered") {
    res.end(body.data);
    return;
  }
  // Errors on either side destroy both streams; nothing else to do here.
  pipeline(body.stream, res, () => undefined);
}

function sendUpstreamFailure(res: ServerResponse, err: UpstreamError): void {
  switch (err.kind) {
    case "timeout": {
      sendError(res, { status: 504, error: "gateway_timeout" });
      return;
    }
    case "connection": {
      sendError(res, { status: 502, error: "bad_gateway" });
      return;
    }
    case "aborted": {
      res.destroy();
      return;
    }
    default: {
      throw new UnreachableCaseError(err.kind);
    }
  }
}

export function sendFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof UpstreamError) {
    console.error(err.message);
  } else {
    console.error("unhandled error while handling request", err);
  }
  if (res.headersSent || res.destroyed) {
    res.destroy();
  } else if (err instanceof UpstreamError) {
    sendUpstreamFailure(res, err);
  } else {
    sendError(res, { status: 500, error: "internal_error" });
  }
}

/** Run a route pipeline and send its response (or its failure) to the client. */
export async function respond(
  res: ServerResponse,
  run: () => Promise<GatewayResponse>,
): Promise<void> {
  try {
    writeResponse(res, await run());
  } catch (err) {
    sendFailure(res, err);
  }
}
