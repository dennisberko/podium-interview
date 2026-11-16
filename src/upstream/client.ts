// One HTTP exchange with one upstream target.
//
// Resolves as soon as the upstream's status and headers arrive; the body then
// streams through `GatewayResponse.body`. Rejects with a typed `UpstreamError`
// if no response arrives:
//   - "connection": unreachable / refused / reset before a response
//   - "timeout":    nothing within `timeoutMs`
//   - "aborted":    the client disconnected, so we gave up
//
// `timeoutMs` is a deadline for the whole exchange, from send to last response
// byte. If it fires mid-body the body stream errors, which drops the client
// connection (the status line is already sent by then).

import type {
  ClientRequest,
  OutgoingHttpHeaders,
  RequestOptions,
} from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  Body,
  GatewayResponse,
  UpstreamRequest,
} from "../pipeline/context.ts";
import { withoutHopByHop } from "./forward-headers.ts";

export type UpstreamErrorKind = "connection" | "timeout" | "aborted";

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;

  constructor({
    kind,
    message,
    cause,
  }: {
    kind: UpstreamErrorKind;
    message: string;
    cause?: unknown;
  }) {
    super(message, { cause });
    this.name = "UpstreamError";
    this.kind = kind;
  }
}

export interface UpstreamCall {
  /** Full upstream URL: target base + request path + query. */
  url: URL;
  request: UpstreamRequest;
  timeoutMs: number;
  signal: AbortSignal;
}

function openUpstream(url: URL, options: RequestOptions): ClientRequest {
  return url.protocol === "https:"
    ? httpsRequest(url, options)
    : httpRequest(url, options);
}

function outgoingHeaders(
  { headers, body }: UpstreamRequest,
  url: URL,
): OutgoingHttpHeaders {
  if (body.kind === "stream") {
    return { ...headers, host: url.host };
  }
  // A request that arrived without a body stays without one.
  if (
    body.data.length === 0 &&
    headers["content-length"] === undefined &&
    headers["transfer-encoding"] === undefined
  ) {
    return { ...headers, host: url.host };
  }
  // A buffered body has a known length; don't claim it's chunked.
  const { "transfer-encoding": _chunked, ...rest } = headers;
  return { ...rest, host: url.host, "content-length": body.data.length };
}

function sendBody(upstreamReq: ClientRequest, body: Body): void {
  if (body.kind === "buffered") {
    upstreamReq.end(body.data);
    return;
  }
  // The client's upload failed (usually: it disconnected mid-body).
  body.stream.once("error", (cause) => upstreamReq.destroy(cause));
  // `pipe` (not `pipeline`): an upstream failure must not destroy the client
  // socket before the gateway can answer 502/504.
  body.stream.pipe(upstreamReq);
}

/** Connection errors (e.g. ECONNREFUSED on every resolved address) can have an empty message. */
function describeError(err: Error): string {
  const code = "code" in err && typeof err.code === "string" ? err.code : "";
  return err.message || code || err.name;
}

export async function callUpstream({
  url,
  request,
  timeoutMs,
  signal,
}: UpstreamCall): Promise<GatewayResponse> {
  const failed = (reason: string): string =>
    `upstream ${request.method} ${url.href} failed: ${reason}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const upstreamReq = openUpstream(url, {
      method: request.method,
      headers: outgoingHeaders(request, url),
    });

    const deadline = setTimeout(() => {
      const message = failed(`timed out after ${timeoutMs}ms`);
      upstreamReq.destroy(new UpstreamError({ kind: "timeout", message }));
    }, timeoutMs);
    const onAbort = (): void => {
      const message = failed("client disconnected");
      upstreamReq.destroy(new UpstreamError({ kind: "aborted", message }));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    upstreamReq.on("error", (err) => {
      clearTimeout(deadline);
      // The signal can outlive this call (health checks share one across
      // every probe), so a failed call must not leave its listener behind.
      signal.removeEventListener("abort", onAbort);
      const error =
        err instanceof UpstreamError
          ? err
          : new UpstreamError({
              kind: "connection",
              message: failed(describeError(err)),
              cause: err,
            });
      if (settled) {
        // Failed mid-body: the response stream errors too, which drops the
        // client connection. Nothing to reject, so just record it.
        console.error(error.message);
        return;
      }
      settled = true;
      reject(error);
    });

    upstreamReq.once("response", (upstreamRes) => {
      settled = true;
      upstreamRes.once("close", () => {
        clearTimeout(deadline);
        signal.removeEventListener("abort", onAbort);
      });
      resolve({
        source: "upstream",
        status: upstreamRes.statusCode ?? 502,
        statusMessage: upstreamRes.statusMessage,
        headers: withoutHopByHop(upstreamRes.headers),
        body: { kind: "stream", stream: upstreamRes },
      });
    });

    if (signal.aborted) {
      onAbort();
      return;
    }
    sendBody(upstreamReq, request.body);
  });
}
