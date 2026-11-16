// Listen/close helpers shared by the mock upstreams and the test gateway.

import { once } from "node:events";
import type { Server } from "node:http";
import { createServer } from "node:http";

/** Listen on an ephemeral loopback port; resolves to the base URL. */
export async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`unexpected server address: ${String(address)}`);
  }
  return `http://127.0.0.1:${address.port}`;
}

/** Stop listening and drop every open connection, keep-alive included. */
export async function closeServer(server: Server): Promise<void> {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

/** A loopback port with nothing listening on it (connections are refused). */
export async function freePort(): Promise<number> {
  const server = createServer();
  const url = await listen(server);
  await closeServer(server);
  return Number(new URL(url).port);
}
