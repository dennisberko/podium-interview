// Reads a streamed request body into memory, for stages that need all of it
// (retry replays it on every attempt).
//
// Bodies over `maxBytes` are refused rather than buffered, so one client can't
// make the gateway hold an unbounded upload in memory. A Content-Length over
// the cap is refused before reading anything.

import type { OutgoingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import { UpstreamError } from "../upstream/client.ts";
import type { Body } from "./context.ts";

export type BufferResult =
  | { kind: "buffered"; body: Extract<Body, { kind: "buffered" }> }
  | { kind: "too_large" };

function declaredLength(headers: OutgoingHttpHeaders): number | undefined {
  const value = headers["content-length"];
  const length = Number(value);
  return value === undefined || !Number.isFinite(length) ? undefined : length;
}

async function readUpTo(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  // Leaving the loop early must not destroy the client socket: the gateway
  // still has to answer 413 on it.
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += data.length;
    if (total > maxBytes) {
      return undefined;
    }
    chunks.push(data);
  }
  return Buffer.concat(chunks, total);
}

export async function bufferBody({
  body,
  headers,
  maxBytes,
  signal,
}: {
  body: Body;
  headers: OutgoingHttpHeaders;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<BufferResult> {
  if (body.kind === "buffered") {
    return body.data.length > maxBytes
      ? { kind: "too_large" }
      : { kind: "buffered", body };
  }
  if ((declaredLength(headers) ?? 0) > maxBytes) {
    return { kind: "too_large" };
  }
  try {
    const data = await readUpTo(body.stream, maxBytes);
    return data === undefined
      ? { kind: "too_large" }
      : { kind: "buffered", body: { kind: "buffered", data } };
  } catch (cause) {
    // The upload failed part way, which means the client went away.
    throw new UpstreamError({
      kind: "aborted",
      message: signal.aborted
        ? "client disconnected while sending the request body"
        : "reading the request body failed",
      cause,
    });
  }
}
