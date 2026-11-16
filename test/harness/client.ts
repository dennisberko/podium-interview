// Low-level HTTP client for requests `fetch` can't make: raw request targets
// ("/a/../b", "*"), hop-by-hop headers, and explicitly chunked bodies.
// Everything else in the tests uses the global `fetch`.

import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
} from "node:http";
import { request } from "node:http";
import { text } from "node:stream/consumers";

export interface RawRequestOptions {
  method?: string;
  /** Request target, sent verbatim. */
  path: string;
  headers?: OutgoingHttpHeaders;
  /**
   * Written one chunk at a time. Without a content-length header, Node sends
   * the body with chunked transfer encoding (for POST/PUT/PATCH).
   */
  body?: string[];
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export async function rawRequest(
  baseUrl: string,
  { method = "GET", path, headers = {}, body = [] }: RawRequestOptions,
): Promise<RawResponse> {
  const { hostname, port } = new URL(baseUrl);
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      { hostname, port, method, path, headers, agent: false },
      resolve,
    );
    req.on("error", reject);
    for (const chunk of body) {
      req.write(chunk);
    }
    req.end();
  });
  return {
    status: res.statusCode ?? 0,
    headers: res.headers,
    body: await text(res),
  };
}
