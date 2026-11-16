// Mock upstream servers. Each test passes a plain Node request handler; the
// server listens on an ephemeral 127.0.0.1 port and closes when the test ends.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import { z } from "zod";
import { closeServer, freePort, listen } from "./server.ts";

export type UpstreamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface Upstream {
  /** Base URL, e.g. "http://127.0.0.1:54321". */
  url: string;
}

export async function startUpstream(
  t: TestContext,
  handler: UpstreamHandler,
): Promise<Upstream> {
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error("mock upstream handler failed", err);
      res.destroy();
    }
  });
  const url = await listen(server);
  t.after(async () => closeServer(server));
  return { url };
}

/** Base URL of a port nothing listens on, for "upstream down" tests. */
export async function refusedUrl(): Promise<string> {
  return `http://127.0.0.1:${await freePort()}`;
}

/** Handler that never responds (until the connection is closed). */
export function hang(): void {
  // Intentionally leaves the request open.
}

const EchoedRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  body: z.string(),
});

/** What an upstream running `echo` received. */
export type EchoedRequest = z.infer<typeof EchoedRequestSchema>;

/** Handler that answers 200 with the request it received, as JSON. */
export async function echo(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await text(req);
  const payload = JSON.stringify({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(payload);
}

export function parseEchoed(json: string): EchoedRequest {
  return EchoedRequestSchema.parse(JSON.parse(json));
}

/** Parse a response that `echo` produced, after it passed through the gateway. */
export async function echoed(res: Response): Promise<EchoedRequest> {
  return parseEchoed(await res.text());
}
