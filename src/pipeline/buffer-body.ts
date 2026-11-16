// Reads a streamed request body into memory, for stages that need all of it
// (retry replays it on every attempt).
//
// Bodies over `maxBytes` are refused rather than buffered, so one client can't
// make the gateway hold an unbounded upload in memory. A Content-Length over
// the cap is refused before buffering anything.
//
// Before a refusal, the rest of the upload is read and dropped, up to another
// `maxBytes`. Node closes the connection after answering a request it hasn't
// fully read, and closing a socket with upload bytes still unread resets it:
// a client that is still sending could then lose the 413 to EPIPE/ECONNRESET.
// Uploads too big to drain within that allowance are still cut off.

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

/** Reads and drops the rest of the body, stopping after `budget` bytes. */
async function drain(stream: Readable, budget: number): Promise<void> {
  let total = 0;
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    total += Buffer.isBuffer(chunk) ? chunk.length : String(chunk).length;
    if (total > budget) {
      return;
    }
  }
}

/**
 * Reads the body into memory. Returns `undefined` when it is bigger than
 * `maxBytes`, after draining up to another `maxBytes` of it.
 */
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
      break;
    }
    chunks.push(data);
  }
  if (total > maxBytes) {
    await drain(stream, 2 * maxBytes - total);
    return undefined;
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
  const declared = declaredLength(headers) ?? 0;
  try {
    if (declared > maxBytes) {
      if (declared <= 2 * maxBytes) {
        await drain(body.stream, maxBytes);
      }
      return { kind: "too_large" };
    }
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
