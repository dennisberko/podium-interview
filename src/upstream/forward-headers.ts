// Header rewriting between client <-> gateway <-> upstream.
//
// Hop-by-hop headers describe a single connection, so a proxy must not forward
// them (RFC 9110 §7.6.1). That includes any header the sender listed in its own
// `Connection` header.

import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
} from "node:http";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection ?? "";
  return new Set(
    value
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function withoutHopByHop(
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const listed = connectionTokens(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && !listed.has(name)) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Headers for the upstream request: end-to-end headers plus X-Forwarded-*.
 * `Host` is left as the client sent it; the upstream client sets it per target.
 */
export function forwardedRequestHeaders(
  req: IncomingMessage,
): OutgoingHttpHeaders {
  const headers = withoutHopByHop(req.headers);

  const priorFor = req.headers["x-forwarded-for"];
  const clientIp = req.socket.remoteAddress;
  headers["x-forwarded-for"] = [priorFor, clientIp].filter(Boolean).join(", ");
  // The gateway itself only terminates plain HTTP.
  headers["x-forwarded-proto"] = "http";
  if (req.headers.host !== undefined) {
    headers["x-forwarded-host"] = req.headers.host;
  }
  // A body without Content-Length arrived chunked; ask Node to re-chunk it upstream.
  if (req.headers["transfer-encoding"] !== undefined) {
    headers["transfer-encoding"] = "chunked";
  }
  return headers;
}
